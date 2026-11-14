import { ensureAuditWorkflow } from './execution-workflow.js'
import { placement } from './placement.js'
import { deliverStageFork } from './stage-fork-delivery.js'
import { currentExecutionWorkspaceTasks } from './owned-execution-workspaces.js'
import { executionWorkflowPayload } from './root-execution.js'
import { canonicalJson, sha256 } from './canonical.js'
import { CloudflareRunStore, stateWriter } from './cloudflare-storage.js'
import { CommandCustodyCollector } from './command-custody.js'
import type { RunState } from './contracts.js'
import type { Env } from './env.js'
import { ExecutionAuthorityStore } from './execution-authority.js'
import { RunMachine } from './machine.js'
import { RunCommandJournal, type RunOperation } from './run-command-journal.js'
import { assertRunControlDelivery, type RunControlDeliveryMarker, type ExecutionControlDeliveryMarker } from './run-control-delivery.js'
import { reconcileRunControls, settleTerminalAdmissionControls } from './run-control-reconcile.js'
import { localRuntimeRelease, RuntimeRouter, sameRuntimeRelease } from './runtime-release.js'

/** The current app executes only its selected owner. Historical replacement
 * states remain with their pinned app; they are never reconstructed here. */
export async function assertExecutionOwner(state: RunState, env: Env): Promise<void> {
  if (state.executionAuthority === undefined) throw new Error('execution ownership belongs to its historical app version')
  const current = await new ExecutionAuthorityStore(env.INDEX).current(state.rootRunId)
  if (canonicalJson(current) !== canonicalJson(state.executionAuthority)) {
    throw new Error('execution ownership differs; use its historical app version')
  }
}

/** Shared by Workflow completion and command delivery after Workflow death. */
export async function settleCancelledExecution(state: RunState, env: Env) {
  const proof = await new CommandCustodyCollector(env).acknowledgeCancellation(state)
  const authority = new ExecutionAuthorityStore(env.INDEX)
  await authority.fence(state.executionAuthority!, proof.operation.commandDigest)
  await authority.retire(state.executionAuthority!, proof.proofDigest)
  await settleTerminalAdmissionControls(state, new RunCommandJournal(env.INDEX, state.rootRunId))
  return { mode: 'command-cancelled' as const, workspaceKeys: proof.workspaceKeys,
    activeWorkspaceKeys: [] as string[], retainedWorkspaceKeys: [] as string[], proofDigest: proof.proofDigest }
}

const terminal = (operation: RunOperation) => ['applied', 'rejected', 'failed'].includes(operation.status)
const needsCleanup = (operation: RunOperation) => operation.command.action === 'cancel' && operation.status === 'applied'

async function deliveryOwner(marker: ExecutionControlDeliveryMarker, store: CloudflareRunStore, index: D1Database) {
  const authority = await new ExecutionAuthorityStore(index).current(marker.auditId)
  if (authority === null) throw new Error('command delivery owner is missing')
  const operation = await new RunCommandJournal(index, marker.auditId).get(marker.commandId)
  if (operation === null) throw new Error('command delivery decision is missing')
  // Commands remain attached to their admitted execution, including after a fork.
  if (canonicalJson(marker.authority) !== canonicalJson(authority)
    || operation.commandDigest !== marker.commandDigest || operation.command.expectedRevision !== marker.expectedRevision
    || canonicalJson(operation.admittedAuthority) !== canonicalJson(authority)
    || operation.source !== undefined && canonicalJson(operation.source.authority) !== canonicalJson(authority)) {
    throw new Error('command delivery cannot change execution owner or decision')
  }
  const state = await store.getState(authority.executionId), route = await store.runRuntime(state.runId)
  if (state.rootRunId !== marker.auditId || state.experimentId !== marker.experimentId
    || canonicalJson(state.executionAuthority) !== canonicalJson(authority)
    || state.runtimeRelease === undefined || route === null || !sameRuntimeRelease(route, state.runtimeRelease)
    || await sha256(state.runtimeRelease) !== authority.runtimeDigest) throw new Error('command delivery does not match the recorded execution owner')
  return { state, runtime: state.runtimeRelease, authority, operation }
}

async function reconcileStoredControls(state: RunState, env: Env, store: CloudflareRunStore): Promise<RunState> {
  const release = await store.getRelease(state.releaseDigest)
  const machine = await RunMachine.fromState(release.body.definition, state, digest => store.getRelease(digest), store.executionSources())
  await reconcileRunControls({ machine, journal: new RunCommandJournal(env.INDEX, state.rootRunId),
    persist: await stateWriter(store, state), native: new CommandCustodyCollector(env) })
  return machine.snapshot()
}

/** Failure is preserved for a subsequent command; legacy disposal must not race
 * evidence collection or destroy a session that a replacement may need. */
export async function settleControlledFailure(runId: string, env: Env) {
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const state = await store.getState(runId)
  if (state.executionAuthority === undefined || state.runtimeRelease === undefined
    || !sameRuntimeRelease(state.runtimeRelease, localRuntimeRelease(env))
    || !['failed', 'stopped'].includes(state.status)) throw new Error('failed control cleanup source differs')
  const selected = await reconcileStoredControls(state, env, store)
  await assertExecutionOwner(selected, env)
  if (selected.journal.at(-2)?.type === 'run.cancelled') return settleCancelledExecution(selected, env)
  if (selected.status !== 'failed') throw new Error('failed control cleanup did not select a failed or canceled state')
  const records = await currentExecutionWorkspaceTasks(selected, store)
  const workspaces = [...new Set(records.map(record => record.workspaceKey))].sort()
  return { mode: 'controlled-failure-retained' as const, workspaceKeys: workspaces,
    activeWorkspaceKeys: [...new Set(records.filter(record => record.active || record.admitted).map(record => record.workspaceKey))].sort(),
    retainedWorkspaceKeys: workspaces, physicalZeroVerified: false as const }
}

/** A bounded call to the same reconciler, never a wave/model executor. */
export async function reconcileDeliveredRunControl(value: unknown, env: Env): Promise<{ markerDigest: string; settled: boolean }> {
  assertRunControlDelivery(value)
  if ('kind' in value) return { markerDigest: await sha256(value), settled: await deliverStageFork(value, env) }
  const marker = value, local = localRuntimeRelease(env)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const { state, runtime, authority, operation } = await deliveryOwner(marker, store, env.INDEX)
  if (!sameRuntimeRelease(runtime, local)) throw new Error('command delivery runtime identity differs')
  if (!['pause', 'continue', 'cancel'].includes(operation.command.action)) {
    throw new Error('command execution belongs to its historical app version')
  }
  const authorities = new ExecutionAuthorityStore(env.INDEX)
  if (canonicalJson(await authorities.current(marker.auditId)) !== canonicalJson(authority)) {
    throw new Error('command delivery execution has been replaced')
  }
  const journal = new RunCommandJournal(env.INDEX, marker.auditId)
  if (state.status === 'running' || state.status === 'failed') await authorities.assertActive(authority)
  const reconciled = await reconcileStoredControls(state, env, store)
  if (reconciled.journal.at(-2)?.type === 'run.cancelled') {
    await settleCancelledExecution(reconciled, env)
    const archived = await store.retiredRunWorkflow(reconciled.runId)
    let workflow = archived?.workflow
    if (workflow === undefined) {
      let instance
      try {
        instance = await env.AUDIT_WORKFLOW.get(reconciled.runId)
        workflow = await instance.status()
      } catch {
        const payload = await executionWorkflowPayload(reconciled, store)
        // An unavailable read is not absence proof. Deterministic create/get can
        // only ensure the original Workflow, whose cancelled bootstrap does no model work.
        await ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
        instance = await env.AUDIT_WORKFLOW.get(reconciled.runId)
        workflow = await instance.status()
      }
      if (instance.id !== reconciled.runId) throw new Error('cancelled Workflow identity differs')
      if (!['complete', 'errored', 'terminated'].includes((workflow as { status: string }).status)) {
        return { markerDigest: await sha256(marker), settled: false }
      }
    }
    await store.archiveCancelledRunAndReleaseLease(reconciled.runId, workflow)
  }
  const selected = await journal.get(marker.commandId)
  return { markerDigest: await sha256(marker), settled: selected !== null && terminal(selected) }
}

/** Resolve only the pinned owner; an unavailable/replaced runtime stays pending.
 * An empty journal read is not evidence that a delayed admission failed. */
export async function deliverRunControl(marker: RunControlDeliveryMarker, env: Env): Promise<boolean> {
  assertRunControlDelivery(marker)
  if ('kind' in marker) return deliverStageFork(marker, env)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  await store.ensureSchema()
  const journal = new RunCommandJournal(env.INDEX, marker.auditId)
  const operation = await journal.get(marker.commandId)
  if (operation === null) return journal.admissionImpossible(marker.commandId, marker.expectedRevision, marker.authority)
  // Another immutable decision owns this ID: this marked admission cannot win.
  if (operation.commandDigest !== marker.commandDigest) return true
  if (terminal(operation) && !needsCleanup(operation)) return true
  const { runtime } = await deliveryOwner(marker, store, env.INDEX)
  if (env.ENGINE_ROLE === 'runtime') return (await reconcileDeliveredRunControl(marker, env)).settled
  if (env.ENGINE_ROLE !== 'front-door') throw new Error('command delivery engine role is invalid')
  const response = await new RuntimeRouter(env).fetch(runtime, '/internal/runtime/audit-controls/reconcile', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(marker),
  })
  if (!response.ok) throw new Error(`command delivery runtime unavailable: ${response.status}`)
  const result = await response.json<{ markerDigest?: string; settled?: boolean }>()
  if (result.markerDigest !== await sha256(marker) || typeof result.settled !== 'boolean') throw new Error('command delivery acknowledgement differs')
  return result.settled
}
