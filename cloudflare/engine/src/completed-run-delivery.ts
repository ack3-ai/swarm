import { canonicalJson, sha256 } from './canonical.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import type { RunState, RuntimeRelease } from './contracts.js'
import type { Env } from './env.js'
import type { SavedStateReference } from './run-state-pointer.js'
import { assertControlId, assertSavedStateReference } from './run-commands.js'
import { assertLocalRuntime, assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

/** Exact terminal evidence, not an operator command or another configuration. */
export interface CompletedRunDeliveryMarker {
  schemaVersion: 1
  kind: 'completed'
  experimentId: string
  auditId: string
  source: SavedStateReference
  runtimeRelease: RuntimeRelease
}

export function assertCompletedRunDelivery(value: unknown): asserts value is CompletedRunDeliveryMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid completed delivery')
  const marker = value as CompletedRunDeliveryMarker
  if (Object.keys(marker).sort().join(',') !== 'auditId,experimentId,kind,runtimeRelease,schemaVersion,source'
    || marker.schemaVersion !== 1 || marker.kind !== 'completed') throw new TypeError('invalid completed delivery identity')
  assertControlId(marker.experimentId, 'experiment id'); assertControlId(marker.auditId, 'audit id')
  assertSavedStateReference(marker.source); assertRuntimeRelease(marker.runtimeRelease)
}

/** Register before Workflow return; its durable alarm waits for native completion. */
export async function registerCompletedRunDelivery(state: RunState, env: Env): Promise<void> {
  if (state.executionAuthority === undefined) throw new Error('completed delivery belongs to its historical app version')
  if (state.status !== 'completed' || state.runtimeRelease === undefined) throw new Error('completed delivery requires terminal state')
  assertLocalRuntime(env, state.runtimeRelease)
  const marker: CompletedRunDeliveryMarker = { schemaVersion: 1, kind: 'completed', auditId: state.rootRunId,
    experimentId: state.experimentId, source: { runId: state.runId,
      state: { generation: state.stateGeneration, digest: await sha256(state) } }, runtimeRelease: state.runtimeRelease }
  const id = env.COORDINATORS.idFromName(state.experimentId)
  const response = await env.COORDINATORS.get(id).fetch('https://coordinator/completed-executions', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ack3-experiment': state.experimentId }, body: canonicalJson(marker) })
  if (!response.ok || (await response.json<{ markerDigest?: string }>()).markerDigest !== await sha256(marker)) {
    throw new Error('completed delivery registration is unconfirmed')
  }
}

/** No model dispatch or status-GET side effect. A pending native Workflow keeps
 * its lease; a lost archive/release acknowledgement retries this same evidence. */
export async function deliverCompletedRun(marker: CompletedRunDeliveryMarker, env: Env): Promise<boolean> {
  assertCompletedRunDelivery(marker)
  if (env.ENGINE_ROLE !== 'runtime') throw new Error('completed delivery requires its pinned runtime')
  assertLocalRuntime(env, marker.runtimeRelease)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const state = await store.getState(marker.source.runId)
  if (state.status !== 'completed' || state.stateGeneration !== marker.source.state.generation
    || await sha256(state) !== marker.source.state.digest || state.experimentId !== marker.experimentId
    || state.rootRunId !== marker.auditId || state.runtimeRelease === undefined
    || !sameRuntimeRelease(state.runtimeRelease, marker.runtimeRelease)) throw new Error('completed delivery source changed')
  await store.verifyCompletedCleanupProof(state)
  const instance = await env.AUDIT_WORKFLOW.get(state.runId)
  if (instance.id !== state.runId) throw new Error('completed Workflow identity differs')
  const workflow = await instance.status()
  if (workflow.status !== 'complete') return false
  // Preserve the first terminal observation if a previous release acknowledgement was lost.
  const archived = await store.retiredRunWorkflow(state.runId)
  await store.archiveCompletedRunAndReleaseLease(state.runId, archived?.workflow ?? workflow)
  return true
}
