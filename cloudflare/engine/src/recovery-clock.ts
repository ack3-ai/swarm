import type { ExperimentDefinition, SealedCheckpoint, StageKind } from './contracts.js'

export interface ModelClockAmendment {
  reason: 'operator-resume-after-expired-phase' | 'operator-resume-before-unadmittable-wave'
  phase: StageKind
  previousModelStartedAt: string
  amendedModelStartedAt: string
  amendedAt: string
}

export function expiredResumeClockAmendment(
  definition: ExperimentDefinition,
  checkpoint: SealedCheckpoint,
  now = new Date().toISOString(),
): ModelClockAmendment | null {
  const previousModelStartedAt = checkpoint.body.modelStartedAt
  if (previousModelStartedAt === null) return null
  const nowMs = Date.parse(now)
  const previousMs = Date.parse(previousModelStartedAt)
  if (!Number.isFinite(nowMs) || !Number.isFinite(previousMs)) throw new TypeError('resume clock timestamp is invalid')
  const stage = definition.stages[checkpoint.body.cursor.stageIndex]
  // Only discovery has an operator-owned elapsed-time budget. Completion
  // stages continue durably and therefore have no clock to expire or amend.
  if (stage?.kind !== 'discovery') return null
  const deadlineMs = previousMs + definition.limits.phaseMinutes.discovery * 60_000
  const previousWave = checkpoint.body.waveReceipts.findLast(receipt => receipt.stageId === stage.id)
  const insufficientForCompleteDiscoveryWave = stage.kind === 'discovery'
    && previousWave !== undefined
    && deadlineMs - nowMs < previousWave.durationMs
  if (nowMs < deadlineMs && !insufficientForCompleteDiscoveryWave) return null
  const activeStageMs = checkpoint.body.waveReceipts
    .filter(receipt => receipt.stageId === stage.id)
    .reduce((total, receipt) => total + receipt.durationMs, 0)
  return {
    reason: nowMs >= deadlineMs
      ? 'operator-resume-after-expired-phase'
      : 'operator-resume-before-unadmittable-wave',
    phase: stage.kind,
    previousModelStartedAt,
    amendedModelStartedAt: new Date(nowMs - activeStageMs).toISOString(),
    amendedAt: now,
  }
}
