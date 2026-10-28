import type { ExperimentDefinition, RunState, RuntimeRelease, RuntimeTransitionEvidence, SealedCheckpoint } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertRuntimeRelease, inheritedRecoveryDigest, sameRuntimeRelease } from './runtime-release.js'

/** Bind an operator upgrade to the exact, stopped and fully sealed source. */
export async function prepareCheckpointRuntimeTransition(input: {
  definition: ExperimentDefinition
  checkpoint: SealedCheckpoint
  source: RunState
  sourceStateGeneration: number
  sourceStateDigest: string
  targetRuntimeRelease: RuntimeRelease
}): Promise<RuntimeTransitionEvidence> {
  const { definition, checkpoint, source, targetRuntimeRelease } = input
  assertRuntimeRelease(targetRuntimeRelease)
  if (source.status !== 'stopped' || source.waveAdmission != null
    || (source.inFlightAgentAttempts?.length ?? 0) !== 0
    || (source.discoveryScheduler?.admissions.length ?? 0) !== 0
    || source.stateGeneration !== input.sourceStateGeneration || await sha256(source) !== input.sourceStateDigest
    || source.stateGeneration <= checkpoint.body.stateGeneration
    || source.runId !== checkpoint.body.runId || source.experimentId !== definition.id
    || source.releaseDigest !== checkpoint.body.releaseDigest
    || source.definitionDigest !== checkpoint.body.definitionDigest || source.definitionDigest !== await sha256(definition)
    || source.runtimeRelease === undefined || checkpoint.body.runtimeRelease === undefined
    || !sameRuntimeRelease(source.runtimeRelease, checkpoint.body.runtimeRelease)
    || sameRuntimeRelease(source.runtimeRelease, targetRuntimeRelease)
    || canonicalJson(source.checkpoints.at(-1)) !== canonicalJson(checkpoint)
    || await sha256(checkpoint.body) !== checkpoint.digest) {
    throw new Error('runtime transition requires the exact stopped sealed source')
  }
  const pairs = [
    [source.cursor, checkpoint.body.cursor], [source.artifacts, checkpoint.body.acceptedArtifacts],
    [source.rejectedAttempts, checkpoint.body.rejectedAttempts], [source.budget, checkpoint.body.budget],
    [source.waveReceipts, checkpoint.body.waveReceipts], [source.stageEndReceipts, checkpoint.body.stageEndReceipts],
    [source.availabilityBoundaries, checkpoint.body.availabilityBoundaries],
    [source.discoveryScheduler ?? null, checkpoint.body.discoveryScheduler ?? null],
    [source.runtimeTransition ?? null, checkpoint.body.runtimeTransition ?? null],
    [source.rootCreatedAt, checkpoint.body.rootCreatedAt], [source.modelStartedAt, checkpoint.body.modelStartedAt],
    [source.rootRunId, checkpoint.body.rootRunId], [source.recoveryEpoch, checkpoint.body.recoveryEpoch],
    [source.parentCheckpointDigest, checkpoint.body.parentCheckpointDigest],
  ]
  if (pairs.some(([left, right]) => canonicalJson(left) !== canonicalJson(right))
    || await inheritedRecoveryDigest(source) !== await inheritedRecoveryDigest(checkpoint.body)) {
    throw new Error('runtime transition source differs from its sealed frontier')
  }
  return { sourceRunId: source.runId, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: input.sourceStateDigest, checkpointDigest: checkpoint.digest,
    sourceRuntimeRelease: source.runtimeRelease, targetRuntimeRelease,
    inheritedRecoveryDigest: await inheritedRecoveryDigest(checkpoint.body) }
}
