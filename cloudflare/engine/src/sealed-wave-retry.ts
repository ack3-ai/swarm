import type { ExperimentDefinition, RunState, RuntimeRelease, SealedCheckpoint, SealedWaveRetryEvidence } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { sameRuntimeRelease } from './runtime-release.js'

export async function prepareSealedWaveRetry(input: {
  definition: ExperimentDefinition, source: RunState, checkpoint: SealedCheckpoint,
  targetRuntimeRelease: RuntimeRelease, retirementProofDigest?: string | undefined,
}): Promise<SealedWaveRetryEvidence> {
  const { definition, source, checkpoint, targetRuntimeRelease: target, retirementProofDigest } = input
  const stage = definition.stages[source.cursor.stageIndex], wave = stage?.waves[source.cursor.waveIndex]
  const task = wave?.tasks.length === 1 ? wave.tasks[0] : undefined
  if ((stage?.kind !== 'verification' && stage?.kind !== 'reporting')
    || task === undefined || task.optional === true || task.providerClass === 'deterministic'
    || source.status !== 'failed' || (source.inFlightAgentAttempts?.length ?? 0) !== 0
    || source.waveAdmission?.stageId !== stage.id || source.waveAdmission.waveId !== wave!.id
    || !/^[0-9a-f]{64}$/.test(retirementProofDigest ?? '')
    || source.runtimeRelease === undefined || sameRuntimeRelease(source.runtimeRelease, target)
    || source.runtimeRelease.containerImageDigest !== target.containerImageDigest
    || source.cursor.stageIndex !== checkpoint.body.cursor.stageIndex
    || source.cursor.waveIndex !== checkpoint.body.cursor.waveIndex
    || source.rootRunId !== checkpoint.body.rootRunId || source.rootCreatedAt !== checkpoint.body.rootCreatedAt
    || source.modelStartedAt !== checkpoint.body.modelStartedAt || source.releaseDigest !== checkpoint.body.releaseDigest
    || source.definitionDigest !== checkpoint.body.definitionDigest
    || canonicalJson(source.failedWaveRecovery ?? null) !== canonicalJson(checkpoint.body.failedWaveRecovery ?? null)
    || canonicalJson(source.artifacts) !== canonicalJson(checkpoint.body.acceptedArtifacts)
    || canonicalJson(source.stageEndReceipts) !== canonicalJson(checkpoint.body.stageEndReceipts)
    || canonicalJson(source.waveReceipts) !== canonicalJson(checkpoint.body.waveReceipts)
    || canonicalJson(source.availabilityBoundaries) !== canonicalJson(checkpoint.body.availabilityBoundaries)
    || canonicalJson(source.promotedExecutionProofs ?? []) !== canonicalJson(checkpoint.body.promotedExecutionProofs ?? [])) {
    throw new Error('sealed terminal-wave retry lacks a fenced unchanged frontier')
  }
  const rejections = source.rejectedAttempts.filter(value => value.stageId === stage.id
    && value.waveId === wave!.id && value.taskId === task.id
    && (value.repairScopeRunId ?? source.runId) === source.runId).toSorted((a, b) => a.attempt - b.attempt)
  const limit = task.retryPolicy === 'none' ? 1 : task.retryPolicy === 'redirect-then-fresh-replacement' ? 3 : 2
  if (rejections.length !== limit || rejections.some((value, i) => value.attempt !== i + 1
    || value.outputDigest !== null || value.quarantineUri !== null
    || (value.includeDiagnosticsInRepair === true && !(value.diagnostics.length === 1
      && /^sandbox agent process failed \([1-9][0-9]*\) before writing result: result read: file read failed: \/workspace\/private\/agent-result\.json:/.test(value.diagnostics[0]!))))) {
    throw new Error('sealed terminal-wave retry requires exhausted no-output attempts')
  }
  const prior = source.failedWaveRecovery
  let imageAuthorization: SealedWaveRetryEvidence['imageAuthorization']
  if (prior?.sealedWaveRetry?.imageAuthorization !== undefined) {
    imageAuthorization = prior.sealedWaveRetry.imageAuthorization
    if (!sameRuntimeRelease(prior.targetRuntimeRelease, source.runtimeRelease)
      || imageAuthorization.authorizedImageDigest !== source.runtimeRelease.containerImageDigest) {
      throw new Error('inherited terminal-wave image authorization differs from source')
    }
  } else if (prior?.quarantinedRepair?.kind === 'negative-review'
    && prior.quarantinedRepair.stageId === 'negative-review'
    && prior.promotedExecution === undefined && prior.retainedNative === undefined && prior.unobservableNative === undefined
    && prior.sourceRuntimeRelease.containerImageDigest !== prior.targetRuntimeRelease.containerImageDigest
    && sameRuntimeRelease(prior.targetRuntimeRelease, source.runtimeRelease)) {
    imageAuthorization = {
      originalImageDigest: prior.sourceRuntimeRelease.containerImageDigest,
      authorizedImageDigest: prior.targetRuntimeRelease.containerImageDigest,
      sourceRecoveryDigest: await sha256(prior),
    }
  }
  return { stageId: stage.id, waveId: wave!.id, taskId: task.id, retirementProofDigest: retirementProofDigest!,
    ...(imageAuthorization === undefined ? {} : { imageAuthorization }) }
}
