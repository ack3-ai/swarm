import { canonicalJson, sha256 } from './canonical.js'
import type { ExperimentDefinition, RunState, RuntimeRelease } from './contracts.js'
import { discoveryDeadline, type DiscoveryWaits } from './discovery-clock.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import type { ReleaseLoader } from './execution-releases.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import { assertRuntimeRelease } from './runtime-release.js'
import { RunMachine } from './machine.js'
import type { RunOperation } from './run-command-journal.js'
import { assertControlId, assertSavedStateReference, forkBoundary, parseRunCommand, RunCommandRejected, type StageForkCommand } from './run-commands.js'
import { resolveStageForkOrigin } from './stage-fork-origin.js'

/** A new audit, not a transfer of the completed source's executor. */
export interface StageForkDecision {
  experimentId: string
  rejection?: StageForkRejection
}

export type StageForkRejection =
  | { kind: 'runtime-unavailable'; observed: RuntimeRelease | null }
  | { kind: 'child-conflict'; authority: ExecutionAuthority; commandDigest: string }

export function stageForkRejectionDetail(rejection: StageForkRejection) {
  return rejection.kind === 'runtime-unavailable'
    ? { code: 'fork-runtime-unavailable', message: 'Requested fork runtime is absent or differs from its observed identity' }
    : { code: 'fork-child-conflict', message: 'Fork child identity belongs to another execution' }
}

export async function stageForkRejectionDigest(operation: RunOperation, rejection: StageForkRejection) {
  if (operation.command.action !== 'fork' || operation.fork === undefined || operation.prepared === undefined) throw new Error('fork rejection has no preparation')
  if (rejection.kind === 'runtime-unavailable') {
    if (Object.keys(rejection).sort().join(',') !== 'kind,observed') throw new Error('fork runtime rejection is invalid')
    if (rejection.observed !== null) assertRuntimeRelease(rejection.observed)
    if (canonicalJson(rejection.observed) === canonicalJson(operation.command.runtimeRelease)) throw new Error('fork rejection matches its requested runtime')
  } else if (rejection.kind === 'child-conflict') {
    assertExecutionAuthority(rejection.authority)
    if (Object.keys(rejection).sort().join(',') !== 'authority,commandDigest,kind'
      || !/^[a-f0-9]{64}$/.test(rejection.commandDigest) || rejection.commandDigest === operation.commandDigest
      || rejection.authority.executionId !== operation.prepared!.authority.executionId) throw new Error('fork collision identity is invalid')
  } else throw new Error('fork rejection kind is invalid')
  return sha256({ kind: 'fork-publication-rejected', commandDigest: operation.commandDigest,
    prepared: operation.prepared!, rejection })
}

/** Added to the exact minimum in the expired-window refusal; a whole number of minutes. */
const FORK_WINDOW_MARGIN_MS = 15 * 60_000

/** A fork whose boundary is the start of discovery (by stage id or by checkpoint) reruns it
 * with the source's discovery clock. No fork reruns preflight, whose end starts that clock, and
 * a fork from recon restarts the window when recon ends again (`reconDurationMs`). Once the
 * inherited window has ended, the child would admit no research and still run every later
 * stage (E9), so refuse it and say which window gives the fork a full one from now. */
export function assertForkDiscoveryWindow(command: StageForkCommand, definition: ExperimentDefinition,
  child: RunState, inheritedWaits: DiscoveryWaits, now: string): void {
  if (forkBoundary(command).sourceFrontier === true
    || definition.stages[child.cursor.stageIndex]?.kind !== 'discovery') return
  const deadline = discoveryDeadline(definition, child, inheritedWaits), at = Date.parse(now)
  if (!(at >= deadline)) return
  const windowMs = definition.limits.phaseMinutes.discovery * 60_000
  const needed = Math.ceil((at - deadline + 2 * windowMs) / 60_000) * 60_000
  // The minimum is exact only now; publishing the release and sending the fork takes minutes.
  const suggested = needed + FORK_WINDOW_MARGIN_MS
  throw new RunCommandRejected('fork-discovery-window-elapsed', `the source audit's discovery window ended at `
    + `${new Date(deadline).toISOString()}, so a fork from discovery would admit no research; to rerun discovery `
    + `with a full window from now, set limits.maxDiscoveryRuntimeMs to at least ${needed} in the fork's manifest; `
    + `this minimum grows by one minute every minute, so ${suggested} leaves a 15-minute margin `
    + 'for publishing the release and sending the fork')
}

export async function stageForkAuthority(auditId: string, commandDigest: string, runtime: RuntimeRelease) {
  assertControlId(auditId, 'source audit id')
  if (!/^[a-f0-9]{64}$/.test(commandDigest)) throw new TypeError('fork command digest is invalid')
  const runId = `fork-${await sha256({ auditId, commandDigest })}`
  return { auditId: runId, executionId: runId, epoch: 0, runtimeDigest: await sha256(runtime) }
}

export async function stageForkPublicationDigest(operation: RunOperation) {
  return sha256({ kind: 'fork-published', commandDigest: operation.commandDigest, prepared: operation.prepared })
}

/** Small journal envelope validation; byte custody is verified before admission. */
export async function assertStageForkDecision(operation: RunOperation): Promise<void> {
  const command = parseRunCommand(operation.command), fork = operation.fork, prepared = operation.prepared
  if (command.action !== 'fork' || fork === undefined || Object.hasOwn(operation, 'successor')
    || operation.admittedAuthority !== undefined || operation.source !== undefined || Object.hasOwn(operation, 'target')
    || prepared === undefined || operation.nativeEffect !== undefined || Object.hasOwn(operation, 'custodyDigest')
    || Object.hasOwn(operation, 'startup')
    || operation.status !== (fork.rejection !== undefined ? 'rejected' : prepared.activatedAt === undefined ? 'accepted' : 'applied')
    || operation.revision !== command.expectedRevision + 1 || !Number.isFinite(Date.parse(operation.acceptedAt))
    || Object.keys(fork).some(key => !['experimentId', 'rejection'].includes(key))
    || Object.keys(prepared).some(key => !['authority', 'state', 'activatedAt'].includes(key))) throw new Error('fork decision is invalid')
  if (fork.rejection === undefined && operation.receiptDigest !== (prepared.activatedAt === undefined
    ? undefined : await stageForkPublicationDigest(operation))) throw new Error('fork publication receipt differs')
  assertControlId(fork.experimentId, 'experiment id')
  if (prepared.activatedAt !== undefined && (!Number.isFinite(Date.parse(prepared.activatedAt))
    || Date.parse(prepared.activatedAt) < Date.parse(operation.acceptedAt))) throw new Error('fork activation time is invalid')
  assertExecutionAuthority(prepared.authority)
  assertSavedStateReference({ runId: prepared.authority.executionId, state: prepared.state })
  if (canonicalJson(prepared.authority) !== canonicalJson(await stageForkAuthority(operation.auditId, operation.commandDigest, command.runtimeRelease))) {
    throw new Error('fork child identity differs')
  }
  if (fork.rejection !== undefined && (prepared.activatedAt !== undefined
    || canonicalJson(operation.detail) !== canonicalJson(stageForkRejectionDetail(fork.rejection))
    || operation.receiptDigest !== await stageForkRejectionDigest(operation, fork.rejection))) throw new Error('fork rejection receipt differs')
}

/** Check the archive pinned by an already selected journal operation. Admission
 * fully reconstructed this root before its D1 CAS. Later transitions verify the
 * exact same bytes; they do not import and replay the entire source again.
 * Post-admission callers must obtain the operation from the verified journal.
 * The pre-admission path uses this check as part of full reconstruction below. */
export async function loadAdmittedStageFork(operation: RunOperation, loadState: ExecutionSourceLoader): Promise<RunState> {
  await assertStageForkDecision(operation)
  const { command, fork, prepared } = operation
  if (command.action !== 'fork' || fork === undefined || prepared === undefined || operation.commandDigest !== await sha256(command)) throw new Error('fork command differs')
  const state = await loadState(prepared.authority.executionId, prepared.state)
  if (state.runId !== prepared.authority.executionId || state.stateGeneration !== prepared.state.generation
    || await sha256(state) !== prepared.state.digest
    || state.releaseDigest !== command.releaseDigest || state.experimentId !== fork.experimentId
    || canonicalJson(state.forkOrigin?.source) !== canonicalJson(command.source) || state.forkOrigin === undefined || canonicalJson(forkBoundary(state.forkOrigin)) !== canonicalJson(forkBoundary(command))
    || canonicalJson(state.executionAuthority) !== canonicalJson(prepared.authority)
    || canonicalJson(state.runtimeRelease) !== canonicalJson(command.runtimeRelease)) throw new Error('fork prepared state differs')
  return state
}

/** Reconstruct the exact initial root using its pinned import and admission time.
 * A valid later child state or an orphan with extra work cannot be prepared. */
export async function loadPreparedStageFork(operation: RunOperation, loadRelease: ReleaseLoader, loadState: ExecutionSourceLoader): Promise<RunState> {
  const state = await loadAdmittedStageFork(operation, loadState)
  const command = operation.command
  if (command.action !== 'fork') throw new Error('fork command differs')
  const seed = await resolveStageForkOrigin(state, loadRelease, loadState)
  if (seed === undefined || (seed.source.executionAuthority === undefined ? seed.source.runId : seed.source.rootRunId) !== operation.auditId
    || Date.parse(operation.acceptedAt) < Date.parse(seed.source.updatedAt)) throw new Error('fork source audit or time differs')
  assertReleaseEnvironmentMatchesRuntime(seed.release.body, command.runtimeRelease)
  const machine = await RunMachine.fork(seed, state.runId, command.runtimeRelease, loadRelease, loadState, operation.acceptedAt)
  await machine.start(operation.acceptedAt)
  if (canonicalJson(machine.view()) !== canonicalJson(state)) throw new Error('fork preparation changes the imported root')
  return state
}
