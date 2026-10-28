import type { RunState, UnobservableNativeRecoveryEvidence } from './contracts.js'

type LostAttempt = Omit<UnobservableNativeRecoveryEvidence, 'fenceProofDigest'>

/** Only the exact admitted attempt named by a terminal custody failure may be retried. */
export function exactUnobservableAttempt(source: RunState, lost: LostAttempt): boolean {
  const attempts = source.inFlightAgentAttempts ?? []
  const attempt = attempts[0]
  if (source.status !== 'failed' || attempts.length !== 1 || attempt === undefined
    || attempt.stageId !== lost.stageId || attempt.waveId !== lost.waveId
    || attempt.taskId !== lost.taskId || attempt.attempt !== lost.attempt
    || attempt.promptDigest !== lost.promptDigest
    || source.artifacts.some(artifact => artifact.taskId === lost.taskId
      && artifact.stageId === lost.stageId && artifact.waveId === lost.waveId)
    || source.rejectedAttempts.some(rejection => rejection.taskId === lost.taskId
      && rejection.stageId === lost.stageId && rejection.waveId === lost.waveId)) return false
  return source.journal.some(event => {
    if (event.type !== 'task.failed' || event.payload === null
      || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false
    const payload = event.payload as Record<string, unknown>
    return payload.taskId === lost.taskId && payload.category === 'session-recovery-unavailable'
      && payload.retryable === false
  })
}
