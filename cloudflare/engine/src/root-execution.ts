import { canonicalJson, sha256 } from './canonical.js'
import { stateWriter, type CloudflareRunStore } from './cloudflare-storage.js'
import type { RunState } from './contracts.js'
import { assertRemainingProviderCredentials } from './remaining-provider-credentials.js'
import { resolveTargetEnvironment } from './target-environment.js'
import type { AuditWorkflowPayload, Env } from './env.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import { RunMachine } from './machine.js'
import { assertControlId } from './run-commands.js'
import { PermanentRunFailure } from './run-errors.js'
import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

type RootStore = Pick<CloudflareRunStore, 'getRelease' | 'getStateIfPresent' | 'activateRootExecution' | 'putState' | 'executionSources'>

/** The same origin is used by dispatch and Workflow bootstrap. This only loads
 * configuration/state; it never schedules a task or opens a model session. */
async function executionOrigin(payload: Readonly<AuditWorkflowPayload>, store: RootStore,
  initialState?: RunState | null) {
  assertControlId(payload.runId, 'run id'); assertControlId(payload.experimentId, 'experiment id')
  if (payload.mode !== 'start' || !/^[a-f0-9]{64}$/.test(payload.releaseDigest ?? '')
    || Object.keys(payload).some(key => !['mode', 'runId', 'experimentId', 'releaseDigest', 'runtimeRelease'].includes(key))) {
    throw new TypeError('root execution requires its original start payload')
  }
  if (payload.runtimeRelease !== undefined) assertRuntimeRelease(payload.runtimeRelease)
  const release = await store.getRelease(payload.releaseDigest!)
  if (release.body.definition.id !== payload.experimentId) throw new Error('release experiment mismatch')
  assertReleaseEnvironmentMatchesRuntime(release.body, payload.runtimeRelease)
  const existing = initialState === undefined ? await store.getStateIfPresent(payload.runId) : initialState
  if (existing !== null) {
    const origin = existing.releaseDigest
    const runtimeMatches = existing.runtimeRelease === undefined && payload.runtimeRelease === undefined
      || existing.runtimeRelease !== undefined && payload.runtimeRelease !== undefined
        && sameRuntimeRelease(existing.runtimeRelease, payload.runtimeRelease)
    if (existing.schemaVersion !== 3 || existing.runId !== payload.runId || existing.experimentId !== payload.experimentId
      || origin !== release.digest || existing.rootRunId !== payload.runId
      || existing.recoveryEpoch !== 0 || existing.parentRunId !== null || existing.parentCheckpointDigest !== null
      || !runtimeMatches || existing.journal.some(event => event.type === 'run.time-amended')
      || canonicalJson(existing.executionAuthority) !== canonicalJson({
        auditId: payload.runId, executionId: payload.runId, epoch: 0, runtimeDigest: await sha256(payload.runtimeRelease ?? null),
      })) throw new PermanentRunFailure('persisted bootstrap state differs from the requested run identity', 'integrity-failed')
    assertCurrentExecutionFormat(existing)
  }
  return { release, existing }
}

export async function rootExecutionMachine(payload: Readonly<AuditWorkflowPayload>, store: RootStore,
  initialState?: RunState | null): Promise<RunMachine> {
  const { release, existing } = await executionOrigin(payload, store, initialState)
  if (existing !== null) return RunMachine.fromState(release.body.definition, existing,
    digest => store.getRelease(digest), store.executionSources())
  const authority = await store.activateRootExecution(payload.runId, payload.runtimeRelease, payload)
  return RunMachine.create(release.body.definition, release.digest, payload.runId,
    new Date().toISOString(), payload.runtimeRelease, authority)
}

/** Make a root audit addressable before the external Workflow create. Concurrent
 * writers and lost acknowledgements adopt only the matching committed origin. */
export async function materializeRootExecution(payload: Readonly<AuditWorkflowPayload>, store: RootStore): Promise<RunState> {
  const { existing: previous } = await executionOrigin(payload, store)
  // Dispatch adopts selected bytes; only Workflow bootstrap imports saved work.
  if (previous !== null && previous.status !== 'created') {
    await store.executionSources().assertSelected!(previous)
    return previous
  }
  const machine = await rootExecutionMachine(payload, store, previous)
  await machine.start()
  const persist = await stateWriter(store, previous)
  try { await persist(machine.view()) }
  catch (error) {
    const selected = await store.getStateIfPresent(payload.runId)
    if (selected === null) throw error
    await executionOrigin(payload, store, selected)
    await store.executionSources().assertSelected!(selected)
    return selected
  }
  return machine.snapshot()
}

/** Dispatch and cancellation recovery use the selected audit's one immutable identity. */
export async function executionWorkflowPayload(state: RunState, store: RootStore): Promise<AuditWorkflowPayload> {
  await store.executionSources().assertSelected!(state)
  return { mode: 'start', runId: state.runId, experimentId: state.experimentId,
    releaseDigest: state.releaseDigest, ...(state.runtimeRelease === undefined ? {} : { runtimeRelease: state.runtimeRelease }) }
}

/** Readiness failures use the normal run failure and cleanup path for every origin. */
export async function bootstrapExecution(payload: Readonly<AuditWorkflowPayload>,
  store: RootStore & Pick<CloudflareRunStore, 'assertForkDisposition' | 'assertSavedWorkCustody' | 'assertExecutionPublication'>,
  env: Env, initialState?: RunState | null): Promise<RunMachine> {
  const machine = await rootExecutionMachine(payload, store, initialState)
  await store.assertExecutionPublication(machine.view())
  await machine.start()
  if (machine.view().status !== 'running') return machine
  await store.assertForkDisposition(machine.view())
  await store.assertSavedWorkCustody(machine.view())
  try {
    resolveTargetEnvironment(machine.definition.target.runtime.environmentBindings, env)
    await assertRemainingProviderCredentials(machine.definition, machine.view(), env, machine.importedSeed)
  } catch (error) {
    if (!(error instanceof PermanentRunFailure)) throw error
    await machine.fail(error.message)
  }
  return machine
}
