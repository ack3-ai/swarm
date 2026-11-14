import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { acceptedTaskExecutionId } from './task-occurrences.js'
import type { ArtifactRecord } from './contracts.js'
import type { RunState, WaveAdmission } from './contracts.js'
import { RunFailure, PermanentRunFailure, type RunFailureCategory } from './run-errors.js'

export const failureCategories = new Set<RunFailureCategory>([
  'transport', 'invalid-configuration', 'missing-credentials', 'provider-rejected', 'budget-exhausted', 'preflight-failed',
  'agent-repair-exhausted', 'resource-exhausted', 'integrity-failed', 'completion-contract-failed',
  'persisted-run-failed', 'session-recovery-unavailable',
])

/** Keep exhausted task work available for an explicit decision, without retrying it. */
export function adjustableTaskFailure(error: unknown): error is RunFailure {
  return error instanceof RunFailure && !error.retryable
    && (error.category === 'provider-rejected' || error.category === 'agent-repair-exhausted')
}

export function blockedTasks(state: Pick<RunState, 'journal' | 'executionAuthority' | 'waveAdmission' | 'discoveryScheduler'>) {
  return [...persistedTerminalTaskFailures(state)].filter(([, failure]) => adjustableTaskFailure(failure))
    .map(([taskId, failure]) => ({ taskId, category: failure.category, message: failure.message }))
}

export function persistedTerminalTaskFailures(state: Pick<RunState, 'journal' | 'executionAuthority' | 'waveAdmission' | 'discoveryScheduler'>, afterSequence = -1): ReadonlyMap<string, RunFailure> {
  assertCurrentExecutionFormat(state)
  if (state.executionAuthority === undefined) throw new PermanentRunFailure(
    'terminal task history requires current execution ownership', 'integrity-failed')
  const failures = new Map<string, RunFailure>()
  const admissions = [...(state.waveAdmission == null ? [] : [state.waveAdmission]), ...(state.discoveryScheduler?.admissions ?? [])]
  const selected = new Map(admissions.flatMap(admission => admission.taskOccurrences ?? [])
    .map(value => [value.taskId, value.taskExecutionId]))
  const known = new Map<string, Set<string>>()
  for (const event of state.journal) {
    if (event.type === 'wave.admitted' || event.type === 'discovery.cohort-admitted') {
      const occurrences = (event.payload as WaveAdmission).taskOccurrences
      for (const occurrence of occurrences ?? []) {
        const identities = known.get(occurrence.taskId) ?? new Set<string>()
        identities.add(occurrence.taskExecutionId); known.set(occurrence.taskId, identities)
      }
    }
    if (event.type === 'task.accepted') {
      const record = (event.payload as { artifact: ArtifactRecord }).artifact
      if (selected.get(record.taskId) === acceptedTaskExecutionId(record)) failures.delete(record.taskId)
    }
    if (event.type !== 'task.failed' || event.payload === null || typeof event.payload !== 'object') continue
    const payload = event.payload as { taskId?: unknown, taskExecutionId?: unknown, error?: unknown, category?: unknown, retryable?: unknown }
    if (typeof payload.taskId !== 'string' || typeof payload.error !== 'string' || payload.retryable !== false
      || typeof payload.category !== 'string' || !failureCategories.has(payload.category as RunFailureCategory)
      || payload.category === 'transport') continue
    if (typeof payload.taskExecutionId !== 'string' || !known.get(payload.taskId)?.has(payload.taskExecutionId)) {
      throw new PermanentRunFailure('terminal task failure lacks its admitted occurrence', 'integrity-failed')
    }
    if (selected.get(payload.taskId) !== payload.taskExecutionId) continue
    if (event.sequence <= afterSequence) continue
    failures.set(payload.taskId, new PermanentRunFailure(
      payload.error, payload.category as Exclude<RunFailureCategory, 'transport'>,
    ))
  }
  return failures
}
