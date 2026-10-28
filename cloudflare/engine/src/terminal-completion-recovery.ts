import type {
  ExperimentDefinition, RunState, RuntimeRelease, SealedCheckpoint, TerminalCompletionRecoveryEvidence,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { sameRuntimeRelease } from './runtime-release.js'
import { audit0RunPolicy } from './runner.js'

export async function prepareTerminalCompletionRecovery(input: {
  definition: ExperimentDefinition
  checkpoint: SealedCheckpoint
  source: RunState
  sourceStateGeneration: number
  sourceStateDigest: string
  targetRuntimeRelease: RuntimeRelease
}): Promise<TerminalCompletionRecoveryEvidence> {
  const { definition, checkpoint, source } = input
  if (source.status !== 'failed' || source.stateGeneration !== input.sourceStateGeneration
    || await sha256(source) !== input.sourceStateDigest || source.runtimeRelease === undefined
    || sameRuntimeRelease(source.runtimeRelease, input.targetRuntimeRelease)
    || source.experimentId !== definition.id || source.definitionDigest !== await sha256(definition)
    || source.releaseDigest !== checkpoint.body.releaseDigest
    || source.cursor.stageIndex !== checkpoint.body.cursor.stageIndex
    || source.cursor.waveIndex !== checkpoint.body.cursor.waveIndex
    || source.waveAdmission !== null || (source.inFlightAgentAttempts ?? []).length !== 0
    || !source.terminalReason?.startsWith('completion contract failed: ')
    || (!source.checkpoints.some(candidate => candidate.digest === checkpoint.digest)
      && source.parentCheckpointDigest !== checkpoint.digest)) {
    throw new Error('terminal completion recovery source is not an exact post-seal completion failure')
  }
  if (await sha256(checkpoint.body) !== checkpoint.digest) throw new Error('checkpoint digest mismatch')
  const stage = definition.stages[source.cursor.stageIndex]
  const wave = stage?.waves[source.cursor.waveIndex]
  const remainingTasks = definition.stages.slice(source.cursor.stageIndex).flatMap((candidate, stageOffset) => (
    candidate.waves.slice(stageOffset === 0 ? source.cursor.waveIndex : 0).flatMap(item => item.tasks)
  ))
  if (stage === undefined || wave === undefined || stage.kind !== 'reporting'
    || wave !== stage.waves.at(-1) || stage !== definition.stages.at(-1)
    || remainingTasks.length === 0 || remainingTasks.some(task => task.providerClass !== 'deterministic')) {
    throw new Error('terminal completion recovery is limited to the final all-deterministic path')
  }
  const inCurrentWave = (value: { stageId: string, waveId: string }) => (
    value.stageId === stage.id && value.waveId === wave.id
  )
  const currentArtifacts = source.artifacts.filter(inCurrentWave)
  if (canonicalJson(currentArtifacts.map(value => value.taskId).toSorted())
      !== canonicalJson(wave.tasks.map(task => task.id).toSorted())
    || currentArtifacts.some(value => value.status !== 'accepted' || value.usage.modelCalls !== 0)
    || source.rejectedAttempts.some(inCurrentWave)
    || source.waveReceipts.filter(receipt => inCurrentWave(receipt)).length !== 1
    || canonicalJson(source.artifacts.filter(value => !inCurrentWave(value))) !== canonicalJson(checkpoint.body.acceptedArtifacts)
    || canonicalJson(source.rejectedAttempts) !== canonicalJson(checkpoint.body.rejectedAttempts)
    || canonicalJson(source.stageEndReceipts) !== canonicalJson(checkpoint.body.stageEndReceipts)
    || canonicalJson(source.waveReceipts.filter(receipt => !inCurrentWave(receipt))) !== canonicalJson(checkpoint.body.waveReceipts)
    || canonicalJson(source.availabilityBoundaries) !== canonicalJson(checkpoint.body.availabilityBoundaries)
    || canonicalJson(source.budget) !== canonicalJson(checkpoint.body.budget)) {
    throw new Error('terminal completion recovery predecessor frontier differs from its checkpoint')
  }
  const completionIssues = audit0RunPolicy.assessCompletion({ definition, state: source })
  if (completionIssues.length > 0) {
    throw new Error(`terminal completion recovery remains invalid: ${completionIssues.join('; ')}`)
  }
  return {
    sourceRunId: source.runId,
    sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: input.sourceStateDigest,
    checkpointDigest: checkpoint.digest,
    sourceRuntimeRelease: source.runtimeRelease,
    targetRuntimeRelease: input.targetRuntimeRelease,
  }
}
