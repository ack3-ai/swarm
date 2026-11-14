import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import type { CheckpointBody, RunState } from './contracts.js'
import { copyState } from './state-copy.js'

/** Serialize the already validated machine transition; the selected owner binds its seal. */
export function checkpointBody(state: RunState, now: string): CheckpointBody {
  assertCurrentExecutionFormat(state)
  return {
    schemaVersion: 2 as const,
    experimentId: state.experimentId,
    runId: state.runId,
    ...(state.controls === undefined ? {} : { controls: copyState(state.controls) }),
    executionAuthority: copyState(state.executionAuthority),
    ...(state.forkOrigin === undefined ? {} : { forkOrigin: copyState(state.forkOrigin) }),
    stateGeneration: state.stateGeneration,
    rootRunId: state.rootRunId,
    rootCreatedAt: state.rootCreatedAt,
    modelStartedAt: state.modelStartedAt,
    phase: state.phase,
    recoveryEpoch: state.recoveryEpoch,
    parentCheckpointDigest: state.parentCheckpointDigest,
    releaseDigest: state.releaseDigest,
    ...(state.runtimeRelease === undefined ? {} : { runtimeRelease: copyState(state.runtimeRelease) }),
    definitionDigest: state.definitionDigest,
    cursor: copyState(state.cursor),
    acceptedArtifacts: copyState(state.artifacts),
    rejectedAttempts: copyState(state.rejectedAttempts),
    stageEndReceipts: copyState(state.stageEndReceipts),
    waveReceipts: copyState(state.waveReceipts),
    ...(state.discoveryScheduler === undefined
      ? {} : { discoveryScheduler: copyState(state.discoveryScheduler) }),
    availabilityBoundaries: copyState(state.availabilityBoundaries),
    budget: copyState(state.budget),
    journalHead: state.journal.at(-1)!.digest,
    sealedAt: now,
  }
}
