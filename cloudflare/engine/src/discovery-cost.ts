import type { ArtifactRecord, RejectedAttempt, WaveReceipt } from './contracts.js'

export function normalizedCostUsd(value: number): number {
  return Number(value.toFixed(12))
}

export function remainingRecordedCostUsd(maxCostUsd: number, recordedCostUsd: number): number {
  return Math.max(0, normalizedCostUsd(maxCostUsd - recordedCostUsd))
}

export function sealedWaveRecordedCostUsd(
  receipt: Pick<WaveReceipt, 'stageId' | 'waveId' | 'artifactDigests'>,
  artifacts: readonly ArtifactRecord[],
  rejectedAttempts: readonly RejectedAttempt[],
  taskIds?: readonly string[],
): number {
  const sealedDigests = new Set(receipt.artifactDigests)
  const scopedTasks = taskIds === undefined ? null : new Set(taskIds)
  const acceptedIdentities = new Set<string>()
  const rejectedIdentities = new Set<string>()
  let costUsd = 0

  for (const artifact of artifacts) {
    if (artifact.stageId !== receipt.stageId || artifact.waveId !== receipt.waveId
      || !sealedDigests.has(artifact.contentDigest) || (scopedTasks !== null && !scopedTasks.has(artifact.taskId))) continue
    const identity = `${artifact.taskId}\u0000${artifact.contentDigest}`
    if (acceptedIdentities.has(identity)) continue
    acceptedIdentities.add(identity)
    costUsd = normalizedCostUsd(costUsd + artifact.usage.costUsd)
  }

  for (const rejection of rejectedAttempts) {
    if (rejection.stageId !== receipt.stageId || rejection.waveId !== receipt.waveId
      || (scopedTasks !== null && !scopedTasks.has(rejection.taskId))) continue
    const identity = [
      rejection.taskId,
      rejection.attempt,
      rejection.promptDigest,
      rejection.outputDigest ?? '',
    ].join('\u0000')
    if (rejectedIdentities.has(identity)) continue
    rejectedIdentities.add(identity)
    costUsd = normalizedCostUsd(costUsd + rejection.usage.costUsd)
  }

  return costUsd
}
