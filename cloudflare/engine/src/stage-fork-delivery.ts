import { canonicalJson, sha256 } from './canonical.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import type { Env, AuditWorkflowPayload } from './env.js'
import type { RuntimeRelease } from './contracts.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import { dispatchAuditWorkflow, reconcileAuditStartup } from './execution-workflow.js'
import { executionWorkflowPayload } from './root-execution.js'
import { RunCommandJournal } from './run-command-journal.js'
import type { StageForkDeliveryMarker } from './run-control-delivery.js'
import { RunCommandConflict } from './run-commands.js'
import { RuntimeIdentityMismatch, RuntimeRouter, sameRuntimeRelease } from './runtime-release.js'
import { loadAdmittedStageFork } from './stage-fork-command.js'
import { assertPreparedExecutionPublication } from './prepared-execution.js'

/** Same delivery alarm, separate immutable source identity. A completed source
 * needs neither a live Workflow nor invented execution authority. */
async function prepareDestination(marker: StageForkDeliveryMarker, env: Env): Promise<boolean | AuditWorkflowPayload> {
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  await store.ensureSchema()
  const journal = new RunCommandJournal(env.INDEX, marker.auditId)
  let operation = await journal.get(marker.commandId)
  if (operation !== null && operation.commandDigest !== marker.commandDigest) return true
  // Registration precedes admission. Its alarm must not import the same large
  // source concurrently with preparation while no command has been selected.
  if (operation === null) return journal.forkAdmissionImpossible(marker.commandId, marker.expectedRevision, marker.source,
    `fork-${await sha256({ auditId: marker.auditId, commandDigest: marker.commandDigest })}`)
  if (operation.command.action !== 'fork' || operation.command.expectedRevision !== marker.expectedRevision
    || canonicalJson(operation.command.source) !== canonicalJson(marker.source)) throw new Error('fork delivery command differs')
  // Source settlement and audit identity were proved before command admission.
  // The experiment routing check needs only its stable index field, not history.
  const source = await env.INDEX.prepare('SELECT experiment_id FROM experiment_runs WHERE run_id = ?1')
    .bind(marker.source.runId).first<{ experiment_id: string }>()
  if (source?.experiment_id !== marker.experimentId) throw new Error('fork delivery source differs')
  const prepared = await loadAdmittedStageFork(operation, store.executionSources())
  await store.assertForkDisposition(prepared)
  if (operation.fork!.rejection !== undefined) return true
  if (operation.prepared!.activatedAt === undefined) {
    if (env.ENGINE_ROLE !== 'front-door') throw new Error('fork activation requires its front-door destination probe')
    const router = new RuntimeRouter(env), expected = operation.command.runtimeRelease
    let observed: RuntimeRelease | null = null
    try {
      if (router.catalog.releases[expected.id] === undefined) throw new RuntimeIdentityMismatch('fork runtime is absent from the catalog')
      observed = await router.resolve(expected.id)
      if (!sameRuntimeRelease(observed, expected)) throw new RuntimeIdentityMismatch('fork runtime identity differs')
    } catch (error) {
      if (!(error instanceof RuntimeIdentityMismatch)) throw error
      operation = await journal.rejectStageFork(marker.commandId, operation.version, { kind: 'runtime-unavailable', observed })
      if (operation.fork!.rejection !== undefined) return true
    }
    if (operation.prepared!.activatedAt === undefined) {
      try { operation = await store.activatePreparedExecution(marker.auditId, marker.commandId, expected) }
      catch (error) {
        if (!(error instanceof RunCommandConflict)) throw error
        // An unrelated root is a durable identity collision. A slot being
        // rotated or a route-only orphan is not proof of a rejected fork.
        const row = await env.INDEX.prepare('SELECT authority_json, command_digest FROM audit_execution_authority WHERE execution_id = ?1')
          .bind(prepared.runId).first<{ authority_json: string; command_digest: string }>()
        if (row === null || row.command_digest === operation.commandDigest) throw error
        const authority = JSON.parse(row.authority_json) as ExecutionAuthority
        assertExecutionAuthority(authority)
        operation = await journal.rejectStageFork(marker.commandId, operation.version,
          { kind: 'child-conflict', authority, commandDigest: row.command_digest })
      }
      if (operation.fork!.rejection !== undefined) return true
    }
  }
  await assertPreparedExecutionPublication(env.INDEX, operation, prepared)
  const selected = await store.getState(prepared.runId)
  return await store.executionBootstrapped(selected) ? true : executionWorkflowPayload(selected, store)
}

export async function deliverStageFork(marker: StageForkDeliveryMarker, env: Env): Promise<boolean> {
  // Release the validated archive before startup reconciliation imports it.
  // Only the small pinned runtime identity crosses this asynchronous boundary.
  const destination = await prepareDestination(marker, env)
  if (typeof destination === 'boolean') return destination
  await dispatchAuditWorkflow(env, destination)
  return reconcileAuditStartup(env, destination)
}
