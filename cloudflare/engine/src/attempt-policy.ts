import type { TaskDefinition, RejectedAttempt, InFlightAgentAttempt, ArtifactRecord, JournalEvent } from './contracts.js'
import { canonicalJson } from './canonical.js'
import { retainedTransportForAttempt } from './native-session-custody.js'
import { providerBackoffs, validProviderBackoff } from './provider-backoff.js'

export function retryAttemptLimit(task: Pick<TaskDefinition, 'retryPolicy'>): 1 | 2 | 3 {
  return task.retryPolicy === 'none' ? 1 : task.retryPolicy === 'redirect-then-fresh-replacement' ? 3 : 2
}

/** Corrective model turns are separate from the task's execution/transport allowance. */
export const formatRepairLimit = 10

export function maxAgentAttemptOrdinal(task: Pick<TaskDefinition, 'retryPolicy'>): number {
  return retryAttemptLimit(task) * (formatRepairLimit + 1)
}

/** The attempt as the limits count it: earlier provider backoffs of the occurrence do not count (P2-06). */
export function countedAttempt(attempt: number,
  rejections: readonly (Pick<RejectedAttempt, 'attempt'> & Partial<Pick<RejectedAttempt, 'providerBackoff'>>)[]): number {
  return attempt - providerBackoffs(rejections, attempt).length
}

/** The attempt whose retry mode a launch takes: a relaunch after a backoff is an ordinary retry,
 * so it keeps the resume or fresh-replacement mode that native session custody expects. */
export function retryModeAttempt(attempt: number, counted: number): number {
  return attempt === 1 ? 1 : Math.max(2, counted)
}

export function formatRepairOrdinalForAttempt(
  task: Pick<TaskDefinition, 'retryPolicy'>,
  attempt: number,
  rejections: readonly RejectedAttempt[],
): number | undefined {
  const prior = rejections.filter(rejection => rejection.attempt < attempt)
    .toSorted((left, right) => left.attempt - right.attempt)
  const firstOutput = prior.find(rejection => rejection.outputDigest !== null)
  if (firstOutput === undefined) return undefined
  const outputCount = prior.filter(rejection => rejection.outputDigest !== null).length
  if (outputCount > formatRepairLimit || firstOutput.sessionId === null) {
    throw new Error('output correction allowance or session custody is exhausted')
  }
  const tail = prior.filter(rejection => rejection.attempt > firstOutput.attempt)
  if (tail.some(rejection => rejection.sessionId !== firstOutput.sessionId
    || rejection.formatRepairOrdinal === undefined)) {
    throw new Error('output correction session custody changed')
  }
  const transportSinceOutput = prior.filter(rejection => rejection.attempt > prior.filter(value => value.outputDigest !== null).at(-1)!.attempt
    && rejection.outputDigest === null && rejection.usage.modelCalls > 0 && !validProviderBackoff(rejection.providerBackoff)).length
  if (transportSinceOutput >= retryAttemptLimit(task)) {
    throw new Error('output correction transport allowance is exhausted')
  }
  return outputCount
}

export function formatRepairSourceDigestForAttempt(attempt: number, rejections: readonly RejectedAttempt[]): string | undefined {
  return rejections.filter(rejection => rejection.attempt < attempt && rejection.outputDigest !== null)
    .toSorted((left, right) => left.attempt - right.attempt).at(-1)?.outputDigest ?? undefined
}

export function retryAttemptModes(
  task: Pick<TaskDefinition, 'providerClass' | 'retryPolicy'>,
  attempt: number,
  nativeRecovery = false,
  formatRepairOrdinal?: number,
): readonly { continuationMode: 'new' | 'resume', freshContext: boolean }[] {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > maxAgentAttemptOrdinal(task)) {
    throw new Error('retry attempt is outside policy')
  }
  if (formatRepairOrdinal !== undefined) {
    if (!Number.isSafeInteger(formatRepairOrdinal) || formatRepairOrdinal < 1
      || formatRepairOrdinal > formatRepairLimit) throw new Error('output correction is outside policy')
    return [{ continuationMode: 'resume', freshContext: false }]
  }
  if (attempt > retryAttemptLimit(task)) throw new Error('execution retry attempt is outside policy')
  if (attempt === 1) return [{ continuationMode: 'new', freshContext: false }]
  if (nativeRecovery && task.providerClass === 'additive') return [{ continuationMode: 'resume', freshContext: false }]
  if (attempt === 3 || task.providerClass === 'additive' || task.retryPolicy === 'fresh-repair') {
    return [{ continuationMode: 'new', freshContext: true }]
  }
  if (task.retryPolicy === 'same-session-repair' || task.retryPolicy === 'redirect-then-fresh-replacement') {
    return [
      { continuationMode: 'resume', freshContext: false },
      { continuationMode: 'new', freshContext: true },
    ]
  }
  return [{ continuationMode: 'resume', freshContext: false }]
}

export function retryAttemptMode(
  task: Pick<TaskDefinition, 'providerClass' | 'retryPolicy'>,
  attempt: number,
  hasContinuationSession: boolean,
  nativeRecovery = false,
  formatRepairOrdinal?: number,
): { continuationMode: 'new' | 'resume', freshContext: boolean } {
  const modes = retryAttemptModes(task, attempt, nativeRecovery, formatRepairOrdinal)
  return modes.find(mode => mode.continuationMode !== 'resume' || hasContinuationSession) ?? modes.at(-1)!
}

/** Retry allowance belongs to the selected occurrence, never the importing run. */
export function taskAttemptRejections(rejections: readonly RejectedAttempt[], taskId: string,
  taskExecutionId: string): readonly RejectedAttempt[] {
  if (typeof taskExecutionId !== 'string' || taskExecutionId.length === 0) throw new Error('retry policy requires its selected task occurrence')
  return rejections.filter(value => value.taskId === taskId && value.execution?.taskExecutionId === taskExecutionId)
}

/** The same original-task policy governs live admission, reload and prefix verification.
 * Native request/returned-session ancestry is verified at the provider boundary.
 */
export function assertAgentAttemptPolicy(task: TaskDefinition, admission: Omit<InFlightAgentAttempt, 'admittedAt'>,
  rejections: readonly RejectedAttempt[]): void {
  const scoped = taskAttemptRejections(rejections, admission.taskId, admission.execution?.taskExecutionId ?? '')
  const correction = formatRepairOrdinalForAttempt(task, admission.attempt, scoped)
  const source = scoped.filter(rejection => rejection.attempt < admission.attempt && rejection.outputDigest !== null)
    .toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const counted = countedAttempt(admission.attempt, scoped)
  if (task.id !== admission.taskId || task.providerClass === 'deterministic'
    || !Number.isSafeInteger(admission.attempt) || admission.attempt < 1
    || counted > (admission.formatRepairOrdinal === undefined
      ? retryAttemptLimit(task) : maxAgentAttemptOrdinal(task))
    || !/^[0-9a-f]{64}$/.test(admission.promptDigest)
    || (admission.dispatchDigest !== undefined && !/^[0-9a-f]{64}$/.test(admission.dispatchDigest))
    || correction !== admission.formatRepairOrdinal
    || (correction !== undefined && admission.sessionId !== source?.sessionId)
    || (admission.formatRepairOrdinal === undefined ? admission.formatRepairSourceDigest !== undefined
      : admission.formatRepairSourceDigest !== formatRepairSourceDigestForAttempt(admission.attempt, scoped))
    || admission.execution !== undefined && Object.hasOwn(admission.execution, 'retainedSession')
    || !retryAttemptModes(task, retryModeAttempt(admission.attempt, counted),
      (retainedTransportForAttempt(task, admission.attempt, scoped)?.workState ?? 'none') !== 'none', admission.formatRepairOrdinal).some(mode => mode.freshContext === admission.freshContext
        && mode.continuationMode === admission.continuationMode)
    || (admission.continuationMode === 'resume' && !/^[a-zA-Z0-9._:-]{8,200}$/.test(admission.sessionId ?? ''))) {
    throw new Error(`agent attempt admission is invalid: ${admission.taskId}`)
  }
}

/** Bind an outcome to its configured execution and prompt. */
export function matchesAgentAttemptOutcome(record: Pick<ArtifactRecord, 'stageId' | 'waveId' | 'taskId' | 'promptDigest' | 'execution'>, attempt: InFlightAgentAttempt): boolean {
  return record.stageId === attempt.stageId && record.waveId === attempt.waveId && record.taskId === attempt.taskId
    && record.promptDigest === attempt.promptDigest && attempt.execution !== undefined && record.execution !== undefined
    && canonicalJson(record.execution) === canonicalJson(attempt.execution)
}

/** Re-observation references a preceding immutable receipt; it never adds usage. */
export function recordedAttemptOutcome(event: JournalEvent, journal: readonly JournalEvent[]): ArtifactRecord | RejectedAttempt | undefined {
  if (event.type === 'task.accepted') return (event.payload as { artifact: ArtifactRecord }).artifact
  if (event.type === 'task.attempt-rejected') return event.payload as RejectedAttempt
  if (event.type !== 'task.rejection-observed') return undefined
  const source = journal.find(value => value.digest === (event.payload as { sourceEventDigest: string }).sourceEventDigest)
  return source?.type === 'task.attempt-rejected' && source.sequence < event.sequence ? source.payload as RejectedAttempt : undefined
}

export function matchesRecordedAttemptOutcome(event: JournalEvent, journal: readonly JournalEvent[], attempt: InFlightAgentAttempt): boolean {
  const record = recordedAttemptOutcome(event, journal)
  if (record === undefined || !matchesAgentAttemptOutcome(record, attempt)) return false
  if (event.type !== 'task.rejection-observed') return true
  const source = journal.find(value => value.digest === (event.payload as { sourceEventDigest: string }).sourceEventDigest)!
  const admission = journal.findLast(value => value.sequence < source.sequence && value.type === 'agent.attempt-admitted'
    && (value.payload as InFlightAgentAttempt).taskId === attempt.taskId)?.payload as InFlightAgentAttempt | undefined
  if (admission === undefined || !matchesAgentAttemptOutcome(record, admission)) return false
  // Rejection sessionId records the returned session. Compare the original
  // request admissions instead, including requested session and correction mode.
  const { admittedAt: _sourceTime, ...original } = admission
  const { admittedAt: _currentTime, ...current } = attempt
  return canonicalJson(original) === canonicalJson(current)
}

export function agentAttemptAdmission(journal: readonly JournalEvent[], attempt: InFlightAgentAttempt): JournalEvent | undefined {
  const event = journal.findLast(event => event.type === 'agent.attempt-admitted'
    && (event.payload as InFlightAgentAttempt).taskId === attempt.taskId)
  return event !== undefined && canonicalJson(event.payload) === canonicalJson(attempt) ? event : undefined
}

export function hasRecordedAttemptOutcome(journal: readonly JournalEvent[], attempt: InFlightAgentAttempt): boolean {
  const admission = agentAttemptAdmission(journal, attempt)
  return admission !== undefined && journal.slice(journal.indexOf(admission) + 1)
    .some(event => matchesRecordedAttemptOutcome(event, journal, attempt))
}

/** One closed logical attempt interval, shared by selection and native custody.
 * Receipt/dispatch provenance is separately verified at the native boundary. */
export function finishedAttemptInterval(journal: readonly JournalEvent[], admissionDigest: string) {
  const matches = journal.filter(event => event.digest === admissionDigest), admission = matches[0]
  if (matches.length !== 1 || admission?.type !== 'agent.attempt-admitted') throw new Error('finished admission is missing')
  const attempt = admission.payload as InFlightAgentAttempt
  const finishes = journal.filter(event => event.type === 'agent.attempt-finished'
    && (event.payload as { admissionDigest?: string }).admissionDigest === admissionDigest), finish = finishes[0]
  if (finishes.length !== 1 || finish === undefined || finish.sequence <= admission.sequence
    || canonicalJson(finish.payload) !== canonicalJson({ stageId: attempt.stageId, waveId: attempt.waveId,
      taskId: attempt.taskId, promptDigest: attempt.promptDigest, admissionDigest })) throw new Error('finished attempt differs')
  const interval = journal.filter(event => event.sequence > admission.sequence && event.sequence < finish.sequence)
  if (interval.some(event => event.type === 'agent.attempt-admitted'
    && (event.payload as InFlightAgentAttempt).taskId === attempt.taskId)) throw new Error('finished attempt overlaps another admission')
  const outcomes = interval.filter(event => matchesRecordedAttemptOutcome(event, journal, attempt))
  if (outcomes.length !== 1) throw new Error('finished attempt outcome is missing or ambiguous')
  return { admission, outcome: outcomes[0]!, finish }
}
