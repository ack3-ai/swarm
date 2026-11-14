import { copyState } from './state-copy.js'
import { selectedTaskExecutionIds } from './task-occurrences.js'
import type { CloudflareRunStore } from './cloudflare-storage.js'
import type { AgentRequest, InFlightAgentAttempt, RunState, RuntimeRelease } from './contracts.js'
import { RunCommandJournal, type RunOperation } from './run-command-journal.js'
import { ExecutionAuthorityStore } from './execution-authority.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'
import { RunCommandConflict, RunCommandRejected, type RunCommand } from './run-commands.js'
import { assertRecordedTaskAdmission, assertFinishedSelectedTaskAdmission, readSettledFinishedExecution } from './native-launch-authority.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { currentExecutionWorkspaceTasks } from './owned-execution-workspaces.js'
import { groupWorkspaceAllocations } from './execution-workspaces.js'
import { readNativeStoppedActors } from './native-stop-evidence.js'
import { assertRuntimeRelease } from './runtime-release.js'
import { nativeSandboxName } from './native-workspace.js'

type Reads = Pick<CloudflareRunStore, 'getStateAt' | 'getRelease' | 'getAgentDispatch' | 'executionSources'>
type Dispatch = NonNullable<Awaited<ReturnType<Reads['getAgentDispatch']>>>
export interface NativeCommandEvidenceContext { runs: Reads; artifacts: R2Bucket; index: D1Database }
// Shared only within one verification. Every public read starts fresh.
type StopTraversal = Map<string, Promise<Awaited<ReturnType<typeof readNativeStoppedActors>>>>


export function assertWholeExecutionStop(command: RunCommand): void {
  if (command.action !== 'cancel') throw new RunCommandRejected('scope-unavailable',
    'task adjustments require an immutable continuation')
}

export async function readCommandSource(journal: RunCommandJournal, runs: Pick<CloudflareRunStore, 'getStateAt' | 'getRelease' | 'executionSources'>, commandId: string, allowSettled = false) {
  const saved = await journal.get(commandId)
  const operation = saved === null ? null : deepClone(saved)
  if (operation === null || !(operation.status === 'applying' || allowSettled && operation.status === 'applied') || operation.source === undefined) {
    throw new RunCommandConflict('operation-conflict', 'command has no applying source-bound effect')
  }
  if (operation.nativeEffect !== undefined && operation.nativeEffect.kind !== 'revoke-admission') {
    throw new PermanentRunFailure('native command belongs to its historical app version', 'integrity-failed')
  }
  assertWholeExecutionStop(operation.command)
  const { source, command } = operation
  const state = copyState(await runs.getStateAt(source.authority.executionId, source.state))
  if (state.runId !== source.authority.executionId || canonicalJson(source.authority) !== canonicalJson(state.executionAuthority)
    || source.authority.auditId !== state.rootRunId || state.rootRunId !== operation.auditId
    || state.stateGeneration !== source.state.generation || await sha256(state) !== source.state.digest
    || (state.controls?.revision ?? 0) !== command.expectedRevision) {
    throw new PermanentRunFailure('command source state differs from its journal', 'integrity-failed')
  }
  return { operation, state }
}

export async function readCommandDispatchEvidence(input: {
  journal: RunCommandJournal
  runs: Pick<CloudflareRunStore, 'getStateAt' | 'getAgentDispatch' | 'getRelease' | 'executionSources'>
  commandId: string
  dispatchDigest: string
  allowSettled?: boolean
}) {
  const { commandId, dispatchDigest } = input
  const { operation, state } = await readCommandSource(input.journal, input.runs, commandId, input.allowSettled)
  const admissions = state.inFlightAgentAttempts?.filter(value => value.dispatchDigest === dispatchDigest) ?? []
  const finished = state.journal.filter(event => event.type === 'agent.attempt-admitted'
    && (event.payload as InFlightAgentAttempt).dispatchDigest === dispatchDigest)
  if (admissions.length !== 1 && finished.length !== 1) throw new RunCommandConflict('operation-conflict', 'dispatch is not active in this command source')
  const savedDispatch = await input.runs.getAgentDispatch(state.runId, dispatchDigest)
  const dispatch = savedDispatch === null ? null : deepClone(savedDispatch)
  if (dispatch === null) throw new TransientRunFailure('admitted dispatch evidence has not been preserved yet')
  const { request } = dispatch
  if (admissions.length === 1) await assertRecordedTaskAdmission(state, request, digest => input.runs.getRelease(digest), input.runs.executionSources())
  else await assertFinishedSelectedTaskAdmission(state, request, finished[0]!.digest,
    digest => input.runs.getRelease(digest), input.runs.executionSources())
  assertWholeExecutionStop(operation.command)
  if (dispatch.dispatchDigest !== dispatchDigest || await sha256(request) !== dispatchDigest
    || !/^[a-f0-9]{64}$/.test(dispatch.nativeRequestDigest)) {
    throw new PermanentRunFailure('command dispatch native projection differs', 'integrity-failed')
  }
  return { operation, state, dispatch }
}

export interface CancellationDisposition {
  schemaVersion: 1
  kind: 'native-cancellation'
  auditId: string
  commandId: string
  commandDigest: string
  inventoryDigest: string
  physicalProofDigest: string
  dispatchDigest: string
  nativeRequestDigest: string
  taskExecutionId: string
  objectId: string
  custodyDigest: string
  interruptedUsageComplete: false
}

export function cancellationKey(runId: string, requestDigest: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId) || !/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('cancellation identity is invalid')
  return `control/cancellations/${runId}/${requestDigest}.json`
}


/** Read-only command evidence, derived from pinned source state and immutable
 * receipts. No caller-selected actor list, namespace access or native controls.
 * This proves durable consistency, not current publication permission: the
 * writer still checks the operation and predecessor in its publication CAS. */
export class NativeCommandEvidence {
  readonly nativeRequests: Dispatch[] = []
  readonly nativeActors: Array<{ sandboxName: string; objectId: string }> = []
  readonly runtimes: RuntimeRelease[] = []
  constructor(private readonly context: NativeCommandEvidenceContext) {}

  private async runtime(operation: RunOperation, state: RunState) {
    const runtime = state.runtimeRelease
    assertRuntimeRelease(runtime)
    if (await sha256(runtime) !== operation.source!.authority.runtimeDigest) {
      throw new PermanentRunFailure('command observation runtime differs from source', 'integrity-failed')
    }
    this.runtimes.push(deepClone(runtime))
    return runtime
  }

  async dispatch(auditId: string, commandId: string, dispatchDigest: string, allowSettled = false) {
    const result = await readCommandDispatchEvidence({ journal: new RunCommandJournal(this.context.index, auditId),
      runs: this.context.runs, commandId, dispatchDigest, allowSettled })
    this.nativeRequests.push(deepClone(result.dispatch))
    return result
  }

  async finishedDispatch(source: RunState, admissionDigest: string) {
    const { runs, artifacts, index } = this.context
    const closed = await readSettledFinishedExecution(source, admissionDigest, { runs,
      authority: new ExecutionAuthorityStore(index), receipts: new R2AgentExecutionReceiptStore(artifacts) })
    if (closed !== null) this.nativeRequests.push(deepClone(closed.dispatch))
    return closed
  }

  /** Resolve every current allocation from the pinned whole-audit stop source. */
  async allocationDispositions(operation: RunOperation, source: RunState) {
    operation = deepClone(operation); source = copyState(source)
    if (operation.source === undefined || operation.source.state.digest !== await sha256(source)
      || operation.source.state.generation !== source.stateGeneration
      || canonicalJson(operation.source.authority) !== canonicalJson(source.executionAuthority)
      || operation.command.expectedRevision !== (source.controls?.revision ?? 0)) {
      throw new PermanentRunFailure('allocation disposition source differs', 'integrity-failed')
    }
    await this.assertCurrentCommandHistory(source, operation.command.expectedRevision)
    assertWholeExecutionStop(operation.command)
    const groups = await groupWorkspaceAllocations(await currentExecutionWorkspaceTasks(source, this.context.runs), source.runId)
    return { groups }
  }

  private stoppedActors(operation: RunOperation, source: RunState, proofDigest: string,
    traversal: StopTraversal = new Map()) {
    operation = deepClone(operation); source = copyState(source)
    const key = canonicalJson({ operation, source: operation.source, proofDigest })
    let evidence = traversal.get(key)
    if (evidence === undefined) {
      evidence = (async () => {
        const runtime = await this.runtime(operation, source)
        const { groups } = await this.allocationDispositions(operation, source)
        const actors = groups.map(({ workspaceKey, sandboxName, members }) => ({ workspaceKey, sandboxName,
          records: members.map(({ task, ...record }) => ({ ...record, taskId: task.id })) }))
        const result = await readNativeStoppedActors({ artifacts: this.context.artifacts, operation, proofDigest, runtime, actors })
        this.nativeActors.push(...deepClone(result.inventory.actors))
        return result
      })()
      traversal.set(key, evidence)
    }
    return evidence
  }

  async physicalStop(auditId: string, commandId: string, proofDigest: string) {
    const { operation, state } = await readCommandSource(new RunCommandJournal(this.context.index, auditId), this.context.runs, commandId, true)
    const evidence = await this.stoppedActors(operation, state, proofDigest)
    return { operation, source: state, ...evidence }
  }

  async stop(auditId: string, commandId: string, proofDigest: string, traversal: StopTraversal = new Map()) {
    const { runs, index } = this.context
    const { operation, state: source } = await readCommandSource(new RunCommandJournal(index, auditId), runs, commandId, true)
    assertWholeExecutionStop(operation.command)
    if (operation.nativeEffect?.kind !== 'revoke-admission') throw new RunCommandRejected('scope-unavailable', 'stop proof requires native admission revocation')
    const evidence = await this.stoppedActors(operation, source, proofDigest, traversal)
    if (!await this.cancellationClaims(operation, source, traversal)) throw new TransientRunFailure('execution stop has unsettled launch claims')
    return { operation, source, inventoryDigest: operation.nativeEffect.inventoryDigest, proofDigest,
      workspaceKeys: evidence.workspaceKeys, claimsSettled: true as const,
      physicalZeroVerified: true as const }
  }

  async cleanupWorkspaces(state: RunState) {
    await this.assertCurrentCommandHistory(state)
    return currentExecutionWorkspaceTasks(state, this.context.runs)
  }

  async cancellationWinner(request: AgentRequest, nativeRequestDigest: string, winner: string, traversal: StopTraversal = new Map()): Promise<boolean> {
    request = deepClone(request)
    const { artifacts } = this.context
    const object = await artifacts.get(cancellationKey(request.runId, nativeRequestDigest))
    if (object === null) return false
    const content = await object.text(), digest = await sha256(content)
    if (digest !== winner) return false
    let value: CancellationDisposition
    try { value = JSON.parse(content) }
    catch (cause) { throw new PermanentRunFailure('cancellation disposition is invalid', 'integrity-failed', { cause }) }
    if (value === null || typeof value !== 'object' || value.schemaVersion !== 1 || value.kind !== 'native-cancellation'
      || value.auditId !== request.executionAuthority?.auditId || value.nativeRequestDigest !== nativeRequestDigest
      || value.taskExecutionId !== request.taskExecutionId || value.dispatchDigest !== await sha256(request)
      || value.interruptedUsageComplete !== false || canonicalJson(value) !== content
      || object.customMetadata?.sha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
      throw new PermanentRunFailure('cancellation disposition identity differs', 'integrity-failed')
    }
    const { operation, state, dispatch } = await this.dispatch(value.auditId, value.commandId, value.dispatchDigest, true)
    if (operation.command.action !== 'cancel'
      || operation.commandDigest !== value.commandDigest || dispatch.nativeRequestDigest !== nativeRequestDigest
      || operation.nativeEffect?.inventoryDigest !== value.inventoryDigest) {
      throw new PermanentRunFailure('cancellation disposition lacks its command effect', 'integrity-failed')
    }
    // Read only the referenced source/actor evidence here. Calling stop() would
    // recursively revisit this same first-writer cancellation claim.
    const evidence = await this.stoppedActors(operation, state, value.physicalProofDigest, traversal)
    const sandboxName = await nativeSandboxName(request)
    const actors = evidence.inventory.actors.filter(actor => actor.sandboxName === sandboxName)
    const stopped = evidence.proof.stopped.filter(actor => actor.objectId === value.objectId)
    if (actors.length !== 1 || actors[0]!.objectId !== value.objectId || stopped.length !== 1
      || stopped[0]!.custodyDigest !== value.custodyDigest || stopped[0]!.commandDigest !== value.commandDigest) {
      throw new PermanentRunFailure('cancellation actor differs', 'integrity-failed')
    }
    return true
  }

  async unreservedDispatch(operation: RunOperation, admission: InFlightAgentAttempt) {
    operation = deepClone(operation); admission = deepClone(admission)
    const { runs, index } = this.context
    if (!(operation.command.action === 'cancel' && operation.nativeEffect?.kind === 'revoke-admission')
      || admission.execution?.taskExecutionId === undefined) {
      throw new TransientRunFailure('admitted dispatch evidence is unavailable for reserved work')
    }
    const authority = new ExecutionAuthorityStore(index), owner = operation.source!.authority
    if (!await authority.hasTaskLaunch(owner, admission.execution.taskExecutionId)) return
    const source = await runs.getStateAt(owner.executionId, operation.source!.state)
    const historical: string[] = []
    const finished = new Set(source.journal.filter(event => event.type === 'agent.attempt-finished')
      .map(event => (event.payload as { admissionDigest?: string }).admissionDigest))
    for (const event of source.journal) {
      if (event.type !== 'agent.attempt-admitted' || !finished.has(event.digest)) continue
      const prior = event.payload as InFlightAgentAttempt
      if (prior.execution?.taskExecutionId !== admission.execution.taskExecutionId
        || prior.dispatchDigest === undefined || prior.dispatchDigest === admission.dispatchDigest) continue
      const closed = await this.finishedDispatch(source, event.digest)
      if (closed !== null) historical.push(closed.dispatch.nativeRequestDigest)
    }
    if (await authority.hasTaskLaunch(owner, admission.execution.taskExecutionId, historical)) {
      throw new TransientRunFailure('admitted dispatch evidence is unavailable for reserved work')
    }
  }

  async cancellationDispatches(operation: RunOperation, source: RunState) {
    const { runs } = this.context
    const dispatches = new Map<string, Dispatch>()
    for (const admission of source.inFlightAgentAttempts ?? []) {
      if (await runs.getAgentDispatch(source.runId, admission.dispatchDigest!) === null) {
        await this.unreservedDispatch(operation, admission)
        continue
      }
      const { dispatch } = await this.dispatch(operation.auditId, operation.command.id, admission.dispatchDigest!, true)
      dispatches.set(dispatch.nativeRequestDigest, dispatch)
    }
    const selected = new Set(selectedTaskExecutionIds(source))
    for (const event of source.journal) {
      const admission = event.payload as InFlightAgentAttempt
      if (event.type !== 'agent.attempt-admitted' || !selected.has(admission.execution?.taskExecutionId ?? '')
        || admission.dispatchDigest === undefined || source.inFlightAgentAttempts?.some(active => active.dispatchDigest === admission.dispatchDigest)) continue
      const { dispatch } = await this.dispatch(operation.auditId, operation.command.id, admission.dispatchDigest, true)
      dispatches.set(dispatch.nativeRequestDigest, dispatch)
    }
    return dispatches
  }

  async cancellationClaims(operation: RunOperation, source: RunState, traversal: StopTraversal = new Map()): Promise<boolean> {
    operation = deepClone(operation); source = copyState(source)
    const { runs, index, artifacts } = this.context
    const owner = operation.source!.authority, authority = new ExecutionAuthorityStore(index)
    assertWholeExecutionStop(operation.command)
    if ((await authority.pendingLaunches(owner)).length > 0) return false
    const dispatches = await this.cancellationDispatches(operation, source)
    const receipts = new R2AgentExecutionReceiptStore(artifacts)
    for (const dispatch of dispatches.values()) {
      const selected = await authority.observeLaunch(owner, dispatch.request.taskExecutionId!, dispatch.nativeRequestDigest)
      if (selected === null) continue // admission never reserved a launch
      if (selected.receiptDigest === null) return false
      const terminal = await receipts.get(source.runId, dispatch.nativeRequestDigest)
      if (terminal !== null && selected.receiptDigest === await sha256(terminal)) continue
      if (!await this.cancellationWinner(dispatch.request, dispatch.nativeRequestDigest, selected.receiptDigest, traversal)) {
        throw new PermanentRunFailure('cancellation claim has an unverified prior settlement', 'integrity-failed')
      }
    }
    return true
  }

  /** Retired live handoffs belong to their historical app version. */
  async assertCurrentCommandHistory(source: RunState, expectedRevision = source.controls?.revision ?? 0) {
    const journal = new RunCommandJournal(this.context.index, source.rootRunId)
    const revision = source.controls?.revision ?? 0
    if (revision !== expectedRevision) throw new PermanentRunFailure('stop source control revision differs', 'integrity-failed')
    for (let cursor = 1; cursor <= revision; cursor++) {
      const prior = await journal.atRevision(cursor)
      if (prior === null) throw new PermanentRunFailure('consumed command history is missing', 'integrity-failed')
      if (prior.nativeEffect !== undefined && prior.nativeEffect.kind !== 'revoke-admission') {
        throw new PermanentRunFailure('native command belongs to its historical app version', 'integrity-failed')
      }
    }
  }
}
