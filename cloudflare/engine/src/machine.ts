import { validNativeSearchEvidence } from './agent-execution-receipt.js'
import type {
  AgentResult,
  ArtifactRecord,
  ArtifactStore,
  BudgetUsage,
  CheckpointBody,
  DiscoveryCohortAdmission,
  DiscoverySchedulerState,
  ExperimentDefinition,
  FailedWaveRecoveryEvidence,
  InFlightAgentAttempt,
  JournalEvent,
  PromotedExecutionEvidence,
  RejectedAttempt,
  RunCursor,
  RunPhase,
  RuntimeRelease,
  RuntimeTransitionEvidence,
  RunState,
  SealedCheckpoint,
  TaskDefinition,
  TerminalCompletionRecoveryEvidence,
  WaveDefinition,
} from './contracts.js'
import { providerIdentity } from './provider-identity.js'
import { retainedTransportForAttempt, validNativeTerminalCustody, validNativeTransport } from './native-session-custody.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { exactUnobservableAttempt } from './unobservable-native-recovery.js'
import { createFinalObservationCustody, createNegativeReviewInput } from './protocol-transforms.js'
import type { ModelClockAmendment } from './recovery-clock.js'
import { assertInheritedRuntimeTransition, assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { prepareCheckpointRuntimeTransition } from './checkpoint-runtime-transition.js'
import { normalizeCursor, validateExperiment } from './validation.js'
import { normalizedCostUsd, remainingRecordedCostUsd, sealedWaveRecordedCostUsd } from './discovery-cost.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { RunFailure } from './run-errors.js'

const zeroBudget = (): BudgetUsage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })

export function assertIndependentDiscoveryFrontier(definition: ExperimentDefinition, state: RunState): void {
  const stage = definition.stages[state.cursor.stageIndex]
  if (stage?.kind === 'discovery' && state.discoveryScheduler === undefined
    && (state.cursor.waveIndex !== 0 || state.waveReceipts.some(receipt => receipt.stageId === stage.id))) {
    throw new Error('global discovery checkpoint requires recovery on a compatible global-scheduler runtime')
  }
}

export function rejectedAttemptIdentity(value: RejectedAttempt | Omit<RejectedAttempt, 'rejectedAt'>): string {
  const { rejectedAt: _rejectedAt, ...receipt } = value as RejectedAttempt
  return canonicalJson(receipt)
}

export function retryAttemptLimit(task: Pick<TaskDefinition, 'retryPolicy'>): 1 | 2 | 3 {
  return task.retryPolicy === 'none' ? 1 : task.retryPolicy === 'redirect-then-fresh-replacement' ? 3 : 2
}

/** Corrective model turns are separate from the task's execution/transport allowance. */
export const formatRepairLimit = 10

export function maxAgentAttemptOrdinal(task: Pick<TaskDefinition, 'retryPolicy'>): number {
  return retryAttemptLimit(task) * (formatRepairLimit + 1)
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
    && rejection.outputDigest === null && rejection.usage.modelCalls > 0).length
  if (transportSinceOutput >= retryAttemptLimit(task)) {
    throw new Error('output correction transport allowance is exhausted')
  }
  return outputCount
}

function formatRepairSourceDigestForAttempt(attempt: number, rejections: readonly RejectedAttempt[]): string | undefined {
  return rejections.filter(rejection => rejection.attempt < attempt && rejection.outputDigest !== null)
    .toSorted((left, right) => left.attempt - right.attempt).at(-1)?.outputDigest ?? undefined
}

export function rejectionConsumesRepairAttempt(
  rejection: Pick<RejectedAttempt, 'outputDigest' | 'usage'>,
): boolean {
  return rejection.outputDigest !== null || rejection.usage.modelCalls > 0
}

export function exhaustedFailedWaveTask(
  task: Pick<TaskDefinition, 'providerClass' | 'retryPolicy'>,
  rejections: readonly RejectedAttempt[],
  promotedSourceAttempt: number | undefined,
  skippedResumeSlotRecorded: boolean,
): boolean {
  if (task.providerClass === 'deterministic') return false
  const attemptLimit = retryAttemptLimit(task)
  const ordered = rejections.toSorted((left, right) => left.attempt - right.attempt)
  if (ordered.length === attemptLimit && ordered.every((rejection, index) => rejection.attempt === index + 1)) {
    return promotedSourceAttempt === attemptLimit || ordered.every(rejection => (
      rejection.outputDigest === null && rejection.quarantineUri === null
        && rejection.includeDiagnosticsInRepair !== true
    ))
  }
  // Historical runtimes silently skipped resume-only slot 2 after losing the
  // process and session. Recover this exact exhausted [1, 3] history once;
  // the quarantined third response remains rejected and its usage is retained.
  const lost = ordered[0]
  const exhausted = ordered[1]
  return skippedResumeSlotRecorded && task.providerClass === 'core'
    && task.retryPolicy === 'redirect-then-fresh-replacement'
    && ordered.length === 2 && lost?.attempt === 1 && exhausted?.attempt === 3
    && lost.outputDigest === null && lost.quarantineUri === null && lost.sessionId === null
    && lost.usage.modelCalls === 1 && lost.continuationMode === 'new' && lost.freshContext === false
    && exhausted.outputDigest !== null && exhausted.quarantineUri !== null
    && exhausted.usage.modelCalls === 1 && exhausted.continuationMode === 'new'
    && exhausted.freshContext === true
}

export function skippedResumeSlotFailureRecorded(source: RunState, taskId: string): boolean {
  return source.failedWaveRecovery === undefined && source.journal.some(event => (
    event.type === 'task.failed'
      && typeof event.payload === 'object' && event.payload !== null
      && (event.payload as Record<string, unknown>).taskId === taskId
      && (event.payload as Record<string, unknown>).category === 'agent-repair-exhausted'
      && (event.payload as Record<string, unknown>).retryable === false
  ))
}

function rejectedAttemptModelCallsAreValid(task: Pick<TaskDefinition, 'providerClass'>, rejection: RejectedAttempt): boolean {
  if (task.providerClass === 'deterministic') return rejection.usage.modelCalls === 0
  return rejection.outputDigest === null
    ? [0, 1].includes(rejection.usage.modelCalls)
    : rejection.usage.modelCalls === 1
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

function retryModesWithCustody(
  task: TaskDefinition, attempt: number, rejections: readonly RejectedAttempt[], runId: string,
  formatRepairOrdinal?: number,
  retainedNative?: FailedWaveRecoveryEvidence['retainedNative'],
): ReturnType<typeof retryAttemptModes> {
  const scoped = rejections.filter(r => (r.repairScopeRunId ?? runId) === runId)
  if (retainedNative?.taskId === task.id && attempt === 1
    && formatRepairOrdinal === undefined) {
    return [{ continuationMode: 'resume', freshContext: false }]
  }
  const evidence = retainedTransportForAttempt(task, attempt, scoped)
  return retryAttemptModes(task, attempt, evidence !== undefined && evidence.workState !== 'none', formatRepairOrdinal)
}

export function phaseForStage(stage: ExperimentDefinition['stages'][number] | undefined): RunPhase {
  if (stage === undefined) return 'complete'
  if (stage.kind === 'preflight') return 'preparation'
  if (stage.kind === 'synthesis') return 'synthesis'
  if (stage.kind === 'coverage') return 'coverage'
  return stage.kind
}

function addBudget(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costUsd: normalizedCostUsd(left.costUsd + right.costUsd),
  }
}

async function appendEvent(state: RunState, type: string, payload: unknown, at: string): Promise<RunState> {
  const previous = state.journal.at(-1)?.digest ?? null
  const eventWithoutDigest = {
    sequence: state.journal.length,
    type,
    at,
    payload,
    previousDigest: previous,
  }
  const event: JournalEvent = { ...eventWithoutDigest, digest: await sha256(eventWithoutDigest) }
  return { ...state, stateGeneration: state.stateGeneration + 1, journal: [...state.journal, event], updatedAt: at }
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('run id is invalid')
}

function assertPromotedExecutionEvidence(promoted: PromotedExecutionEvidence, sourceRunId?: string): void {
  const usage = promoted.usage
  if ((sourceRunId !== undefined && promoted.sourceRunId !== sourceRunId)
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(promoted.sourceRunId)
    || [promoted.stageId, promoted.waveId, promoted.taskId].some(item => (
      typeof item !== 'string' || item.trim() === ''
    ))
    || !Number.isSafeInteger(promoted.sourceAttempt) || promoted.sourceAttempt < 1
    || [promoted.requestDigest, promoted.promptDigest, promoted.outputDigest,
      promoted.releaseDigest].some(digest => !/^[a-f0-9]{64}$/.test(digest))
    || (promoted.quarantineOutputDigest !== undefined
      && promoted.quarantineOutputDigest !== promoted.outputDigest)
    || (promoted.inputDigest !== undefined && !/^[a-f0-9]{64}$/.test(promoted.inputDigest))
    || usage.modelCalls !== 1
    || !Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0
    || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0
    || !Number.isFinite(usage.costUsd) || usage.costUsd < 0
    || (usage.rawInputTokens !== undefined
      && (!Number.isSafeInteger(usage.rawInputTokens) || usage.rawInputTokens < 0))
    || (usage.cachedInputTokens !== undefined
      && (!Number.isSafeInteger(usage.cachedInputTokens) || usage.cachedInputTokens < 0))
    || (usage.cacheAccountingComplete !== undefined && typeof usage.cacheAccountingComplete !== 'boolean')
    || (usage.costAccountingComplete !== undefined && typeof usage.costAccountingComplete !== 'boolean')) {
    throw new Error('promoted execution evidence is invalid')
  }
}

function assertPromotedExecutionProofs(proofs: readonly PromotedExecutionEvidence[] | undefined): void {
  if (proofs === undefined) return
  const identities = new Set<string>()
  for (const proof of proofs) {
    assertPromotedExecutionEvidence(proof)
    const identity = `${proof.sourceRunId}\0${proof.stageId}\0${proof.waveId}\0${proof.taskId}\0${proof.requestDigest}`
    if (identities.has(identity)) throw new Error('promoted execution proof is duplicated')
    identities.add(identity)
  }
}

function extendPromotedExecutionProofs(
  inherited: readonly PromotedExecutionEvidence[] | undefined,
  promoted: PromotedExecutionEvidence | undefined,
): readonly PromotedExecutionEvidence[] {
  const proofs = (inherited ?? []).map(proof => deepClone(proof))
  if (promoted !== undefined && !proofs.some(proof => canonicalJson(proof) === canonicalJson(promoted))) {
    proofs.push(deepClone(promoted))
  }
  assertPromotedExecutionProofs(proofs)
  return proofs
}

function assertFailedWaveRecoveryEvidence(value: FailedWaveRecoveryEvidence): void {
  assertRunId(value.sourceRunId)
  if (!Number.isSafeInteger(value.sourceStateGeneration) || value.sourceStateGeneration < 1
    || !/^[0-9a-f]{64}$/.test(value.sourceStateDigest)
    || !/^[0-9a-f]{64}$/.test(value.checkpointDigest)
    || !Array.isArray(value.importedTaskIds)
    || value.importedTaskIds.length === 0
    || value.importedTaskIds.some(taskId => typeof taskId !== 'string' || taskId.trim() === '')
    || new Set(value.importedTaskIds).size !== value.importedTaskIds.length
    || !Number.isSafeInteger(value.inheritedRejectedAttemptCount) || value.inheritedRejectedAttemptCount < 0
    || !Number.isSafeInteger(value.unknownUsageAttemptCount) || value.unknownUsageAttemptCount < 0
    || value.unknownUsageAttemptCount > value.inheritedRejectedAttemptCount
      + (value.unobservableNative === undefined ? 0 : 1)) {
    throw new Error('failed-wave recovery evidence is invalid')
  }
  assertRuntimeRelease(value.sourceRuntimeRelease, 'failed-wave source runtime release')
  assertRuntimeRelease(value.targetRuntimeRelease, 'failed-wave target runtime release')
  const promoted = value.promotedExecution
  if (promoted !== undefined) assertPromotedExecutionEvidence(promoted, value.sourceRunId)
  const retained = value.retainedNative
  const lost = value.unobservableNative
  if (lost !== undefined && (promoted !== undefined || retained !== undefined
    || ![lost.stageId, lost.waveId, lost.taskId].every(part => typeof part === 'string' && part.trim() !== '')
    || !Number.isSafeInteger(lost.attempt) || lost.attempt < 1
    || !/^[0-9a-f]{64}$/.test(lost.promptDigest)
    || !/^[0-9a-f]{64}$/.test(lost.requestDigest)
    || !/^[0-9a-f]{64}$/.test(lost.fenceProofDigest))) {
    throw new Error('unobservable native recovery evidence is invalid')
  }
  if (retained !== undefined && (promoted !== undefined
    || ![retained.stageId, retained.waveId, retained.taskId, retained.workspaceKey]
      .every(part => typeof part === 'string' && part.trim() !== '')
    || retained.workspaceAllocationRunId !== value.sourceRunId
    || !/^[0-9a-f]{64}$/.test(retained.sandboxObjectId)
    || !validNativeTransport(retained.nativeTransport)
    || retained.nativeTransport.sourceRunId !== value.sourceRunId
    || retained.nativeTransport.workState !== 'present'
    || value.sourceRuntimeRelease.id !== value.targetRuntimeRelease.id
    || value.sourceRuntimeRelease.workerService !== value.targetRuntimeRelease.workerService
    || value.sourceRuntimeRelease.workflowName !== value.targetRuntimeRelease.workflowName
    || value.sourceRuntimeRelease.containerImageDigest !== value.targetRuntimeRelease.containerImageDigest)) {
    throw new Error('retained native recovery evidence is invalid')
  }
}

function assertTerminalCompletionRecoveryEvidence(value: TerminalCompletionRecoveryEvidence): void {
  assertRunId(value.sourceRunId)
  if (!Number.isSafeInteger(value.sourceStateGeneration) || value.sourceStateGeneration < 1
    || !/^[0-9a-f]{64}$/.test(value.sourceStateDigest)
    || !/^[0-9a-f]{64}$/.test(value.checkpointDigest)) {
    throw new Error('terminal completion recovery evidence is invalid')
  }
  assertRuntimeRelease(value.sourceRuntimeRelease, 'terminal completion source runtime release')
  assertRuntimeRelease(value.targetRuntimeRelease, 'terminal completion target runtime release')
  if (sameRuntimeRelease(value.sourceRuntimeRelease, value.targetRuntimeRelease)) {
    throw new Error('terminal completion recovery requires a new runtime release')
  }
}

function budgetAfter(current: BudgetUsage, result: AgentResult, modelCall: boolean): BudgetUsage {
  return addBudget(current, {
    modelCalls: result.modelCalls ?? (modelCall ? 1 : 0),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  })
}

function budgetViolation(definition: ExperimentDefinition, budget: BudgetUsage): string | null {
  const limit = definition.limits
  if (budget.modelCalls > limit.maxModelCalls) return 'model-call budget exhausted'
  if (limit.maxInputTokens !== undefined && budget.inputTokens > limit.maxInputTokens) return 'input-token budget exhausted'
  if (limit.maxOutputTokens !== undefined && budget.outputTokens > limit.maxOutputTokens) return 'output-token budget exhausted'
  if (budget.costUsd > limit.maxCostUsd) return 'cost budget exhausted'
  return null
}

function assertWithinBudget(definition: ExperimentDefinition, budget: BudgetUsage): void {
  const violation = budgetViolation(definition, budget)
  if (violation !== null) throw new Error(violation)
}

function assertDiscoveryAdmissionBudget(definition: ExperimentDefinition, budget: BudgetUsage): void {
  assertBudgetShape(budget)
  assertWithinBudget(definition, budget)
  const limits = definition.limits
  if (budget.modelCalls >= limits.maxModelCalls || budget.costUsd >= limits.maxCostUsd
    || (limits.maxInputTokens !== undefined && budget.inputTokens >= limits.maxInputTokens)
    || (limits.maxOutputTokens !== undefined && budget.outputTokens >= limits.maxOutputTokens)) {
    throw new Error('discovery cohort was admitted after a measured budget limit')
  }
}

function assertRecoverableDiscoveryBudget(
  definition: ExperimentDefinition,
  body: Pick<CheckpointBody, 'acceptedArtifacts' | 'rejectedAttempts' | 'waveReceipts' | 'discoveryScheduler'>,
  budget: BudgetUsage,
): void {
  if (body.discoveryScheduler !== undefined) {
    // Pool-local wave numbers are not chronological. A previously admitted
    // slow cohort may finish after faster pools and overrun a measured limit.
    for (const receipt of body.waveReceipts.filter(value => value.stageId === body.discoveryScheduler!.stageId)) {
      if (receipt.budgetAtAdmission === undefined) throw new Error('discovery receipt lacks its admission budget')
      assertDiscoveryAdmissionBudget(definition, receipt.budgetAtAdmission)
      for (const key of ['modelCalls', 'inputTokens', 'outputTokens', 'costUsd'] as const) {
        if (receipt.budgetAtAdmission[key] > budget[key]) throw new Error('discovery admission budget exceeds recorded usage')
      }
    }
    if (budget.modelCalls > definition.limits.maxModelCalls) throw new Error('model-call budget exhausted')
    return
  }
  const violation = budgetViolation(definition, budget)
  if (violation === null) return
  // Model calls are known before dispatch and can never overrun admission.
  if (budget.modelCalls > definition.limits.maxModelCalls) throw new Error('model-call budget exhausted')
  const stage = definition.stages.find(candidate => candidate.kind === 'discovery')
  if (stage === undefined) throw new Error(violation)
  const completedWaveIndexes = body.waveReceipts.filter(receipt => receipt.stageId === stage.id)
    .map(receipt => stage.waves.findIndex(wave => wave.id === receipt.waveId))
  const finalWaveIndex = Math.max(-1, ...completedWaveIndexes)
  const finalWave = stage.waves[finalWaveIndex]
  if (finalWave === undefined) throw new Error(violation)
  // Admission is legal only while the recorded budget is still within every
  // measured limit. Actual usage from that final admitted barrier may cross a
  // token or cost limit, but no later discovery wave may appear.
  const budgetBeforeFinalWave = [
    ...body.acceptedArtifacts.filter(artifact => (
      artifact.stageId === stage.id && artifact.waveId !== finalWave.id
    )).map(artifact => artifact.usage),
    ...body.rejectedAttempts.filter(attempt => (
      attempt.stageId === stage.id && attempt.waveId !== finalWave.id
    )).map(attempt => attempt.usage),
  ].reduce(addBudget, zeroBudget())
  assertWithinBudget(definition, budgetBeforeFinalWave)
}

function assertBudgetShape(budget: BudgetUsage): void {
  if (!Number.isSafeInteger(budget.modelCalls) || budget.modelCalls < 0
    || !Number.isSafeInteger(budget.inputTokens) || budget.inputTokens < 0
    || !Number.isSafeInteger(budget.outputTokens) || budget.outputTokens < 0
    || !Number.isFinite(budget.costUsd) || budget.costUsd < 0) {
    throw new Error('checkpoint budget is invalid')
  }
}

function expectedProvider(task: TaskDefinition): string {
  return providerIdentity(task)
}

export function assertWaveRecordsComplete(records: readonly ArtifactRecord[], stageId: string, wave: WaveDefinition): void {
  const expectedTaskIds = new Set(wave.tasks.map(task => task.id))
  const recordTaskIds = new Set<string>()
  for (const record of records) {
    if (!expectedTaskIds.has(record.taskId)) throw new Error(`wave ${stageId}/${wave.id} contains an unexpected result for ${record.taskId}`)
    if (recordTaskIds.has(record.taskId)) throw new Error(`wave ${stageId}/${wave.id} repeats a terminal result for ${record.taskId}`)
    recordTaskIds.add(record.taskId)
  }
  for (const task of wave.tasks) {
    const record = records.find(value => value.taskId === task.id)
    if (record === undefined) throw new Error(`wave ${stageId}/${wave.id} lacks a terminal result for ${task.id}`)
    if (record.model !== task.model) throw new Error(`task ${task.id} checkpoint model differs from its contract`)
    if (task.optional !== true && record.status !== 'accepted') {
      throw new Error(`required task ${task.id} is unavailable`)
    }
    if (record.status === 'additive-unavailable' && (task.optional !== true || record.unavailableReason === undefined)) {
      throw new Error(`task ${task.id} has invalid additive unavailability`)
    }
  }
  const accepted = records.filter(record => record.status === 'accepted')
  if (accepted.length < wave.minSuccessfulTasks) throw new Error(`wave ${stageId}/${wave.id} lacks successful tasks`)
  if (new Set(accepted.map((record) => record.actorId)).size < wave.minDistinctActors) {
    throw new Error(`wave ${stageId}/${wave.id} lacks independent actors`)
  }
  if (wave.replication !== undefined) {
    const replicated = accepted.filter(record => wave.replication?.taskIds.includes(record.taskId))
    const waived = wave.replication.taskIds.some(taskId => records.some(record => (
      record.taskId === taskId && record.status === 'additive-unavailable'
    )))
    if (!waived && (replicated.length < wave.replication.minSuccessfulAgents
      || new Set(replicated.map(record => record.provider)).size < wave.replication.minDistinctProviders
      || new Set(replicated.map(record => record.model)).size < wave.replication.minDistinctModels)) {
      throw new Error(`wave ${stageId}/${wave.id} lacks required replicated providers and models`)
    }
  }
}

export function assertDiscoveryCohortRecordsComplete(
  records: readonly ArtifactRecord[],
  stageId: string,
  wave: WaveDefinition,
  poolId: string,
): void {
  const tasks = wave.tasks.filter(task => configuredResearchTaskPoolId(task) === poolId)
  if (tasks.length === 0) throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} has no tasks`)
  const expectedTaskIds = new Set(tasks.map(task => task.id))
  if (records.length !== tasks.length || records.some(record => !expectedTaskIds.has(record.taskId))) {
    throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} has an invalid terminal set`)
  }
  for (const task of tasks) {
    const record = records.find(candidate => candidate.taskId === task.id)
    if (record === undefined || record.model !== task.model) {
      throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} lacks ${task.id}`)
    }
    if (task.optional !== true && record.status !== 'accepted') {
      throw new Error(`required discovery task ${task.id} is unavailable`)
    }
    if (record.status === 'additive-unavailable' && (task.optional !== true || record.unavailableReason === undefined)) {
      throw new Error(`discovery task ${task.id} has invalid additive unavailability`)
    }
  }
  const required = tasks.filter(task => task.optional !== true)
  const acceptedRequired = records.filter(record => (
    record.status === 'accepted' && required.some(task => task.id === record.taskId)
  ))
  if (acceptedRequired.length !== required.length
    || new Set(acceptedRequired.map(record => record.actorId)).size !== required.length) {
    throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} lacks independent required actors`)
  }
}

async function assertCheckpointFrontier(definition: ExperimentDefinition, checkpoint: SealedCheckpoint): Promise<void> {
  const body = checkpoint.body
  if (body.runtimeRelease !== undefined) assertRuntimeRelease(body.runtimeRelease, 'checkpoint runtime release')
  await assertInheritedRuntimeTransition(body)
  assertPromotedExecutionProofs(body.promotedExecutionProofs)
  if (body.failedWaveRecovery !== undefined) {
    assertFailedWaveRecoveryEvidence(body.failedWaveRecovery)
    if (body.runtimeRelease === undefined
      || (body.runtimeTransition === undefined && !sameRuntimeRelease(body.runtimeRelease, body.failedWaveRecovery.targetRuntimeRelease))
      || (body.failedWaveRecovery.promotedExecution !== undefined
        && !(body.promotedExecutionProofs ?? []).some(proof => (
          canonicalJson(proof) === canonicalJson(body.failedWaveRecovery!.promotedExecution)
        )))) {
      throw new Error('checkpoint failed-wave recovery lineage is invalid')
    }
  }
  if (body.terminalCompletionRecovery !== undefined) {
    assertTerminalCompletionRecoveryEvidence(body.terminalCompletionRecovery)
    if (body.runtimeRelease === undefined
      || (body.runtimeTransition === undefined && !sameRuntimeRelease(body.runtimeRelease, body.terminalCompletionRecovery.targetRuntimeRelease))) {
      throw new Error('checkpoint terminal completion recovery lineage is invalid')
    }
  }
  if (body.schemaVersion !== 2 || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.runId)
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(body.rootRunId)
    || !Number.isSafeInteger(body.recoveryEpoch) || body.recoveryEpoch < 0
    || !/^[0-9a-f]{64}$/.test(body.releaseDigest) || !/^[0-9a-f]{64}$/.test(body.definitionDigest)
    || !/^[0-9a-f]{64}$/.test(body.journalHead)
    || !Number.isSafeInteger(body.stateGeneration) || body.stateGeneration < 1
    || !Number.isFinite(Date.parse(body.rootCreatedAt)) || !Number.isFinite(Date.parse(body.sealedAt))) {
    throw new Error('checkpoint identity is invalid')
  }
  if (body.recoveryEpoch === 0 && (body.runId !== body.rootRunId || body.parentCheckpointDigest !== null)) {
    throw new Error('root checkpoint lineage is invalid')
  }
  if (body.recoveryEpoch > 0 && !/^[0-9a-f]{64}$/.test(body.parentCheckpointDigest ?? '')) {
    throw new Error('child checkpoint lineage is invalid')
  }
  assertBudgetShape(body.budget)
  const cursor = normalizeCursor(definition, body.cursor)
  const taskLocations = new Map<string, { stageIndex: number, waveIndex: number, stageId: string, wave: WaveDefinition, task: TaskDefinition }>()
  for (const [stageIndex, stage] of definition.stages.entries()) {
    for (const [waveIndex, wave] of stage.waves.entries()) {
      for (const task of wave.tasks) taskLocations.set(task.id, { stageIndex, waveIndex, stageId: stage.id, wave, task })
    }
  }
  const discoveryProgressAllows = (location: { stageIndex: number, waveIndex: number, task: TaskDefinition }): boolean => {
    if (body.discoveryScheduler === undefined
      || definition.stages[location.stageIndex]?.id !== body.discoveryScheduler.stageId) return false
    const poolId = configuredResearchTaskPoolId(location.task)
    return (body.discoveryScheduler.pools.find(pool => pool.poolId === poolId)?.nextWaveIndex ?? 0) > location.waveIndex
  }
  const isBoundPromotedArtifact = async (artifact: ArtifactRecord): Promise<boolean> => {
    const promoted = body.promotedExecutionProofs?.find(proof => (
      artifact.assertions.includes(`promoted-execution:${proof.sourceRunId}:${proof.requestDigest}`)
    ))
    if (promoted === undefined
      || promoted.releaseDigest !== body.releaseDigest
      || (artifact.status !== 'accepted' && artifact.status !== 'additive-unavailable')
      || artifact.stageId !== promoted.stageId
      || artifact.waveId !== promoted.waveId
      || artifact.taskId !== promoted.taskId
      || artifact.promptDigest !== promoted.promptDigest
      || artifact.contentDigest !== promoted.outputDigest
      || artifact.usage.modelCalls !== 0
      || artifact.usage.inputTokens !== 0
      || artifact.usage.outputTokens !== 0
      || artifact.usage.costUsd !== 0
      || (artifact.usage.rawInputTokens ?? 0) !== 0
      || (artifact.usage.cachedInputTokens ?? 0) !== 0
      || artifact.usage.cacheAccountingComplete === false
      || artifact.usage.costAccountingComplete === false
      || !artifact.assertions.includes(`promoted-execution:${promoted.sourceRunId}:${promoted.requestDigest}`)) {
      return false
    }
    if (artifact.status === 'additive-unavailable'
      && (artifact.unavailableReason !== 'platform-interruption' || artifact.files.length !== 0
        || Object.keys(artifact.protocol).length !== 0 || artifact.contentDigest !== await sha256('{}'))) return false
    const sourceRejections = body.rejectedAttempts.filter(rejection => (
      rejection.stageId === promoted.stageId
        && rejection.waveId === promoted.waveId
        && rejection.taskId === promoted.taskId
        && rejection.attempt === promoted.sourceAttempt
        && rejection.promptDigest === promoted.promptDigest
        && (rejection.repairScopeRunId ?? body.runId) === promoted.sourceRunId
    ))
    return sourceRejections.length === 1
      && (promoted.quarantineOutputDigest === undefined
        ? sourceRejections[0]!.outputDigest === null && sourceRejections[0]!.quarantineUri === null
        : sourceRejections[0]!.outputDigest === promoted.quarantineOutputDigest
          && sourceRejections[0]!.quarantineUri !== null)
      && canonicalJson(sourceRejections[0]!.usage) === canonicalJson(promoted.usage)
  }
  for (const rejection of body.rejectedAttempts) {
    assertBudgetShape(rejection.usage)
    if (!validNativeSearchEvidence(rejection.nativeSearchEvidence)) throw new Error('invalid rejected native search evidence')
    const location = taskLocations.get(rejection.taskId)
    let attemptModes: ReturnType<typeof retryAttemptModes> = []
    if (location !== undefined) {
      try { attemptModes = retryModesWithCustody(location.task, rejection.attempt, body.rejectedAttempts,
        rejection.repairScopeRunId ?? body.runId, rejection.formatRepairOrdinal,
        (rejection.repairScopeRunId ?? body.runId) === body.runId
          ? body.failedWaveRecovery?.retainedNative : undefined) } catch { /* rejected below */ }
    }
    if (location === undefined || rejection.stageId !== location.stageId || rejection.waveId !== location.wave.id
      || !Number.isSafeInteger(rejection.attempt) || rejection.attempt < 1
      || rejection.attempt > (rejection.formatRepairOrdinal === undefined
        ? retryAttemptLimit(location.task) : maxAgentAttemptOrdinal(location.task))
      || (rejection.formatRepairOrdinal !== undefined && (() => {
        try {
          return formatRepairOrdinalForAttempt(location.task, rejection.attempt, body.rejectedAttempts.filter(prior => (
            prior.taskId === rejection.taskId
              && (prior.repairScopeRunId ?? body.runId) === (rejection.repairScopeRunId ?? body.runId)
          ))) !== rejection.formatRepairOrdinal
        } catch { return true }
      })())
      || (rejection.formatRepairOrdinal === undefined
        ? rejection.formatRepairSourceDigest !== undefined
        : rejection.formatRepairSourceDigest !== formatRepairSourceDigestForAttempt(rejection.attempt,
          body.rejectedAttempts.filter(prior => prior.taskId === rejection.taskId
            && (prior.repairScopeRunId ?? body.runId) === (rejection.repairScopeRunId ?? body.runId))))
      || !/^[0-9a-f]{64}$/.test(rejection.promptDigest)
      || (rejection.outputDigest === null) !== (rejection.quarantineUri === null)
      || (rejection.outputDigest !== null && (!/^[0-9a-f]{64}$/.test(rejection.outputDigest)
        || rejection.quarantineUri?.trim() === ''))
      || !attemptModes.some(mode => (
        rejection.freshContext === mode.freshContext && rejection.continuationMode === mode.continuationMode
      ))
      || (rejection.continuationMode === 'resume' && !/^[a-zA-Z0-9._:-]{8,200}$/.test(rejection.sessionId ?? ''))
      || (rejection.nativeTransport !== undefined && (!validNativeTransport(rejection.nativeTransport)
        || location.task.backend !== 'dsh-chat-completions' || location.task.providerClass !== 'additive'
        || rejection.outputDigest !== null || rejection.nativeTransport.sessionId !== rejection.sessionId
        || rejection.nativeTransport.sourceRunId !== (rejection.repairScopeRunId ?? body.runId)))
      || (rejection.nativeTerminalCustody !== undefined && (!validNativeTerminalCustody(rejection.nativeTerminalCustody)
        || rejection.nativeTransport !== undefined
        || location.task.backend !== 'dsh-chat-completions' || location.task.providerClass !== 'additive'
        || rejection.outputDigest !== null || rejection.nativeTerminalCustody.sessionId !== rejection.sessionId
        || rejection.nativeTerminalCustody.sourceRunId !== (rejection.repairScopeRunId ?? body.runId)))
      || rejection.diagnostics.length === 0
      || (rejection.includeDiagnosticsInRepair !== undefined
        && typeof rejection.includeDiagnosticsInRepair !== 'boolean')
      || !Number.isFinite(Date.parse(rejection.rejectedAt))
      || (rejection.repairScopeRunId !== undefined && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(rejection.repairScopeRunId))
      || !rejectedAttemptModelCallsAreValid(location.task, rejection)
      || location.stageIndex > cursor.stageIndex
      || (location.stageIndex === cursor.stageIndex && location.waveIndex >= cursor.waveIndex
        && !discoveryProgressAllows(location))) {
      throw new Error(`checkpoint rejected-attempt evidence is invalid: ${rejection.taskId}`)
    }
  }

  const taskIds = new Set<string>()
  for (const artifact of body.acceptedArtifacts) {
    const location = taskLocations.get(artifact.taskId)
    if (location === undefined || artifact.stageId !== location.stageId || artifact.waveId !== location.wave.id) {
      throw new Error(`checkpoint artifact is outside the release topology: ${artifact.taskId}`)
    }
    if (taskIds.has(artifact.taskId)) throw new Error(`checkpoint repeats task artifact: ${artifact.taskId}`)
    taskIds.add(artifact.taskId)
    assertBudgetShape(artifact.usage)
    const promotedArtifact = await isBoundPromotedArtifact(artifact)
    if (!/^[0-9a-f]{64}$/.test(artifact.promptDigest) || !/^[0-9a-f]{64}$/.test(artifact.contentDigest)
      || artifact.actorId.trim() === '' || artifact.provider !== expectedProvider(location.task)
      || artifact.model !== location.task.model
      || artifact.usage.modelCalls !== (location.task.providerClass === 'deterministic'
        || artifact.unavailableReason === 'discovery-boundary' || promotedArtifact ? 0 : 1)
      || (location.task.providerClass === 'deterministic'
        && canonicalJson(artifact.usage) !== canonicalJson(zeroBudget()))) {
      throw new Error(`checkpoint artifact identity is invalid: ${artifact.taskId}`)
    }
    if (location.stageIndex > cursor.stageIndex
      || (location.stageIndex === cursor.stageIndex && location.waveIndex >= cursor.waveIndex
        && !discoveryProgressAllows(location))) {
      throw new Error(`checkpoint contains work beyond its cursor: ${artifact.taskId}`)
    }
  }

  const acceptedReviews = body.acceptedArtifacts.filter(artifact => {
    const location = taskLocations.get(artifact.taskId)
    return artifact.status === 'accepted' && location?.task.promptKind === 'negative-review'
  })
  if (acceptedReviews.length > 0) {
    const reviewLocation = taskLocations.get(acceptedReviews[0]!.taskId)!
    const frozenFrontier = body.acceptedArtifacts.filter(artifact => {
      const location = taskLocations.get(artifact.taskId)
      return location !== undefined && (location.stageIndex < reviewLocation.stageIndex
        || (location.stageIndex === reviewLocation.stageIndex && location.waveIndex < reviewLocation.waveIndex))
    })
    const packet = await createNegativeReviewInput(frozenFrontier)
    for (const review of acceptedReviews) {
      if (review.protocol.reviewInputDigest !== packet.inputSha256) {
        throw new Error(`checkpoint review does not bind the reconstructed frozen input: ${review.taskId}`)
      }
    }
  }

  const verification = body.acceptedArtifacts.find(artifact => artifact.taskId === 'verifier' && artifact.status === 'accepted')
  if (verification !== undefined) {
    const required = [...new Set(body.acceptedArtifacts.flatMap(artifact => [
      ...(artifact.protocol.dispositionReferences ?? []),
      ...(artifact.protocol.retainedReferences ?? []),
      ...(artifact.protocol.decisionDissentObservationIds ?? []),
    ]))]
    const retained = new Set(verification.protocol.retainedReferences ?? [])
    if (required.some(identifier => !retained.has(identifier))) {
      throw new Error('checkpoint verification drops a retained reference or dissent identifier')
    }
  }
  const final = body.acceptedArtifacts.find(artifact => artifact.taskId === 'seal-final' && artifact.status === 'accepted')
  if (final !== undefined) {
    const expectedCustody = await createFinalObservationCustody(body.acceptedArtifacts)
    if (canonicalJson(final.protocol.finalCustody) !== canonicalJson(expectedCustody)) {
      throw new Error('checkpoint final observation custody differs from its immutable review frontier')
    }
  }

  for (const [stageIndex, stage] of definition.stages.entries()) {
    if (stageIndex > cursor.stageIndex) break
    if (stage.kind === 'discovery' && body.discoveryScheduler?.stageId === stage.id) {
      for (const receipt of body.waveReceipts.filter(candidate => candidate.stageId === stage.id)) {
        if (receipt.poolId === undefined) throw new Error('independent discovery receipt lacks its pool')
        const wave = stage.waves.find(candidate => candidate.id === receipt.waveId)
        if (wave === undefined) throw new Error('independent discovery receipt is outside the release topology')
        const taskIds = new Set(wave.tasks.filter(task => configuredResearchTaskPoolId(task) === receipt.poolId)
          .map(task => task.id))
        assertDiscoveryCohortRecordsComplete(body.acceptedArtifacts.filter(artifact => (
          artifact.stageId === stage.id && artifact.waveId === wave.id && taskIds.has(artifact.taskId)
        )), stage.id, wave, receipt.poolId)
      }
      continue
    }
    const completedWaveCount = stageIndex < cursor.stageIndex
      ? stage.kind === 'discovery'
        ? Math.max(0, ...body.acceptedArtifacts.filter(value => value.stageId === stage.id)
          .map(value => stage.waves.findIndex(wave => wave.id === value.waveId) + 1))
        : stage.waves.length
      : cursor.waveIndex
    for (let waveIndex = 0; waveIndex < completedWaveCount; waveIndex += 1) {
      const wave = stage.waves[waveIndex]
      if (wave === undefined) throw new Error('checkpoint cursor exceeds the release topology')
      assertWaveRecordsComplete(body.acceptedArtifacts.filter(value => (
        value.stageId === stage.id && value.waveId === wave.id
      )), stage.id, wave)
    }
  }

  const reconstructedBudget = [...body.acceptedArtifacts.map(artifact => artifact.usage),
    ...body.rejectedAttempts.map(attempt => attempt.usage)]
    .reduce(addBudget, zeroBudget())
  if (canonicalJson(reconstructedBudget) !== canonicalJson(body.budget)) {
    throw new Error('checkpoint budget does not match its accepted and rejected attempt evidence')
  }
  const discoveryBudget = [
    ...body.acceptedArtifacts.filter(artifact => (
      definition.stages[taskLocations.get(artifact.taskId)?.stageIndex ?? -1]?.kind === 'discovery'
    )).map(artifact => artifact.usage),
    ...body.rejectedAttempts.filter(attempt => (
      definition.stages[taskLocations.get(attempt.taskId)?.stageIndex ?? -1]?.kind === 'discovery'
    )).map(attempt => attempt.usage),
  ].reduce(addBudget, zeroBudget())
  assertRecoverableDiscoveryBudget(definition, body, discoveryBudget)

  const expectedReceiptCount = Math.min(cursor.stageIndex, definition.stages.length)
  if (body.stageEndReceipts.length !== expectedReceiptCount) throw new Error('checkpoint has an invalid phase-transition receipt set')
  for (let index = 0; index < expectedReceiptCount; index += 1) {
    const transition = body.stageEndReceipts[index]
    if (transition === undefined || transition.stageIndex !== index
      || transition.from !== phaseForStage(definition.stages[index])
      || transition.to !== phaseForStage(definition.stages[index + 1])
      || transition.evidenceDigest !== await sha256(transition.evidence)
      || !Number.isFinite(Date.parse(transition.endedAt))) {
      throw new Error('checkpoint phase-transition receipt is invalid')
    }
  }
  const expectedPhase = phaseForStage(definition.stages[cursor.stageIndex])
  if (body.phase !== expectedPhase) throw new Error('checkpoint phase differs from its cursor')
  if (cursor.stageIndex === 0 ? body.modelStartedAt !== null : !Number.isFinite(Date.parse(body.modelStartedAt ?? ''))) {
    throw new Error('checkpoint model clock is not bound to successful preflight')
  }
  if (body.discoveryScheduler !== undefined) {
    const scheduler = body.discoveryScheduler
    const stage = definition.stages.find(candidate => candidate.id === scheduler.stageId)
    const expectedPools = stage?.kind === 'discovery' ? [...new Set(stage.waves.flatMap(wave => wave.tasks
      .filter(task => task.promptKind === 'research').map(configuredResearchTaskPoolId)))].toSorted() : []
    if (stage?.kind !== 'discovery' || scheduler.admissions.length !== 0
      || !Number.isSafeInteger(scheduler.materialEpoch) || scheduler.materialEpoch < 0
      || canonicalJson(scheduler.pools.map(pool => pool.poolId).toSorted()) !== canonicalJson(expectedPools)) {
      throw new Error('checkpoint discovery scheduler is invalid')
    }
    for (const pool of scheduler.pools) {
      const receipts = body.waveReceipts.filter(receipt => receipt.stageId === stage.id && receipt.poolId === pool.poolId)
      const indexes = receipts.map(receipt => stage.waves.findIndex(wave => wave.id === receipt.waveId)).toSorted((a, b) => a - b)
      let expectedQuiet = 0
      for (const candidate of [...receipts].toSorted((left, right) => (
        stage.waves.findIndex(wave => wave.id === right.waveId) - stage.waves.findIndex(wave => wave.id === left.waveId)
      ))) {
        const waveIndex = stage.waves.findIndex(wave => wave.id === candidate.waveId)
        const exactIds = new Set(candidate.artifactRefs?.map(reference => reference.id) ?? [])
        const records = body.acceptedArtifacts.filter(artifact => exactIds.size > 0
          ? exactIds.has(artifact.id)
          : candidate.artifactDigests.includes(artifact.contentDigest))
        if (waveIndex < 1 || candidate.materialEpoch !== scheduler.materialEpoch
          || candidate.materialHighCriticalDelta !== false || records.some(record => record.status !== 'accepted')) break
        expectedQuiet += 1
      }
      if (!Number.isSafeInteger(pool.nextWaveIndex) || pool.nextWaveIndex < 0
        || canonicalJson(indexes) !== canonicalJson(Array.from({ length: pool.nextWaveIndex }, (_, index) => index))
        || !Number.isSafeInteger(pool.quietCohorts) || pool.quietCohorts < 0
        || pool.quietCohorts !== expectedQuiet
        || !Number.isSafeInteger(pool.quietEpoch) || pool.quietEpoch < 0 || pool.quietEpoch > scheduler.materialEpoch
        || pool.parked !== (definition.stopOnSaturation !== false && pool.quietCohorts >= 2)) {
        throw new Error(`checkpoint discovery pool progress is invalid: ${pool.poolId}`)
      }
    }
  }

  const receiptKeys = new Set<string>()
  const receiptedArtifacts = new Set<string>()
  for (const waveReceipt of body.waveReceipts) {
    const key = `${waveReceipt.stageId}\0${waveReceipt.waveId}\0${waveReceipt.poolId ?? ''}`
    const expectedRecords = body.acceptedArtifacts.filter(artifact => (
      artifact.stageId === waveReceipt.stageId && artifact.waveId === waveReceipt.waveId
        && (waveReceipt.poolId === undefined
          || configuredResearchTaskPoolId(taskLocations.get(artifact.taskId)!.task) === waveReceipt.poolId)
    ))
    const expectedDigests = expectedRecords.map(artifact => artifact.contentDigest).toSorted()
    const expectedRefs = expectedRecords.map(artifact => ({ id: artifact.id, contentDigest: artifact.contentDigest }))
      .toSorted((left, right) => left.id.localeCompare(right.id) || left.contentDigest.localeCompare(right.contentDigest))
    const expectedMaterialDelta = expectedRecords.some(artifact => (
      artifact.status === 'accepted' && artifact.protocol.research?.materialHighCriticalDelta === true
    ))
    const knownInputRefs = new Set(body.acceptedArtifacts.filter(artifact => (
      body.waveReceipts.some(candidate => Date.parse(candidate.completedAt) <= Date.parse(waveReceipt.startedAt)
        && (candidate.artifactRefs?.some(reference => reference.id === artifact.id
          && reference.contentDigest === artifact.contentDigest)
          ?? candidate.artifactDigests.includes(artifact.contentDigest)))
    )).map(artifact => canonicalJson({ id: artifact.id, contentDigest: artifact.contentDigest })))
    if (receiptKeys.has(key) || expectedDigests.length === 0
      || !Number.isFinite(Date.parse(waveReceipt.startedAt)) || !Number.isFinite(Date.parse(waveReceipt.completedAt))
      || !Number.isFinite(waveReceipt.durationMs) || waveReceipt.durationMs < 0
      || JSON.stringify(waveReceipt.artifactDigests) !== JSON.stringify(expectedDigests)
      || (waveReceipt.poolId !== undefined && (
        !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(waveReceipt.poolId)
        || waveReceipt.inputDigest !== await sha256(waveReceipt.inputArtifacts ?? [])
        || canonicalJson(waveReceipt.inputArtifacts ?? []) !== canonicalJson([...(waveReceipt.inputArtifacts ?? [])]
          .toSorted((left, right) => left.id.localeCompare(right.id) || left.contentDigest.localeCompare(right.contentDigest)))
        || new Set((waveReceipt.inputArtifacts ?? []).map(reference => reference.id)).size
          !== (waveReceipt.inputArtifacts ?? []).length
        || canonicalJson(waveReceipt.artifactRefs ?? []) !== canonicalJson(expectedRefs)
        || canonicalJson(Object.keys(waveReceipt.peerPredecessors ?? {}).toSorted())
          !== canonicalJson(expectedRecords.map(record => record.taskId).toSorted())
        || Object.values(waveReceipt.peerPredecessors ?? {}).some(value => (
          value !== 'none' && !/^wave-\d+\/research-[1-9]\d*$/.test(value)
        ))
        || !Number.isSafeInteger(waveReceipt.materialEpoch) || Number(waveReceipt.materialEpoch) < 0
        || waveReceipt.materialHighCriticalDelta !== expectedMaterialDelta
        || (waveReceipt.inputArtifacts ?? []).some(reference => !knownInputRefs.has(canonicalJson(reference)))
      ))) {
      throw new Error('checkpoint wave timing receipt is invalid')
    }
    receiptKeys.add(key)
    for (const record of expectedRecords) receiptedArtifacts.add(waveReceipt.artifactRefs === undefined
      ? `${waveReceipt.stageId}\0${waveReceipt.waveId}\0${record.contentDigest}`
      : `id\0${record.id}`)
  }
  if (body.acceptedArtifacts.some(artifact => !receiptedArtifacts.has(`id\0${artifact.id}`)
    && !receiptedArtifacts.has(`${artifact.stageId}\0${artifact.waveId}\0${artifact.contentDigest}`))) {
    throw new Error('checkpoint lacks a wave timing receipt')
  }

  for (const boundary of body.availabilityBoundaries) {
    const source = body.acceptedArtifacts.find(artifact => artifact.taskId === boundary.sourceTaskId)
    const sourceLocation = source === undefined ? undefined : taskLocations.get(source.taskId)
    const wave = source === undefined ? -1 : Number(source.waveId.replace(/^wave-/, ''))
    if (sourceLocation === undefined || boundary.provider !== providerIdentity(sourceLocation.task)
      || (boundary.poolId !== undefined && boundary.poolId !== configuredResearchTaskPoolId(sourceLocation.task))
      || !['budget', 'provider-credit'].includes(boundary.reason)
      || source?.status !== 'additive-unavailable' || source.unavailableReason !== boundary.reason
      || boundary.effectiveFromWave !== wave + 1 || !Number.isFinite(Date.parse(boundary.sealedAt))) {
      throw new Error('checkpoint additive availability boundary is invalid')
    }
    for (const artifact of body.acceptedArtifacts) {
      const location = taskLocations.get(artifact.taskId)
      if (location?.task.providerClass !== 'additive' || artifact.taskId === boundary.sourceTaskId) continue
      if (boundary.poolId !== undefined && configuredResearchTaskPoolId(location.task) !== boundary.poolId) continue
      const artifactWave = location.stageId === 'discovery' ? Number(location.wave.id.replace(/^wave-/, '')) : Number.MAX_SAFE_INTEGER
      if (artifactWave >= boundary.effectiveFromWave
        && (artifact.status !== 'additive-unavailable' || artifact.unavailableReason !== 'discovery-boundary'
          || artifact.usage.modelCalls !== 0)) {
        throw new Error('checkpoint replays DeepSeek after its sealed availability boundary')
      }
    }
  }

  const discoveryIndex = definition.stages.findIndex(stage => stage.kind === 'discovery')
  const discoveryStage = definition.stages[discoveryIndex]
  const receipt = body.stageEndReceipts.find(value => value.stageIndex === discoveryIndex)
  if (discoveryStage === undefined) throw new Error('checkpoint release lacks discovery')
  if (cursor.stageIndex > discoveryIndex && receipt === undefined) throw new Error('checkpoint crossed discovery without a deterministic stop receipt')
  if (receipt?.reason === 'two-distinct-complete-saturation-cohorts') {
    if (body.discoveryScheduler !== undefined) {
      const evidence = receipt.evidence as { materialEpoch?: unknown, pools?: unknown }
      const expectedPools = body.discoveryScheduler.pools.map(pool => ({
        poolId: pool.poolId, quietCohorts: pool.quietCohorts, quietEpoch: pool.quietEpoch, parked: pool.parked,
      }))
      const runnable = body.discoveryScheduler.pools.filter(pool => (
        pool.nextWaveIndex < discoveryStage.waves.length
          && !body.availabilityBoundaries.some(boundary => boundary.poolId === pool.poolId)
      ))
      if (evidence.materialEpoch !== body.discoveryScheduler.materialEpoch
        || canonicalJson(evidence.pools) !== canonicalJson(expectedPools)
        || runnable.length === 0 || runnable.some(pool => (
          !pool.parked || pool.quietEpoch !== body.discoveryScheduler!.materialEpoch || pool.quietCohorts < 2
        ))) {
        throw new Error('independent discovery saturation receipt is invalid')
      }
    } else {
    const cohorts = (receipt.evidence as { cohorts?: unknown }).cohorts
    if (!Array.isArray(cohorts) || cohorts.length !== 2) throw new Error('saturation receipt lacks two cohorts')
    const waves = new Set<string>()
    for (const cohort of cohorts) {
      if (cohort === null || typeof cohort !== 'object') throw new Error('saturation receipt cohort is invalid')
      const value = cohort as { wave?: unknown, artifacts?: unknown }
      if (typeof value.wave !== 'string' || waves.has(value.wave) || !Array.isArray(value.artifacts)) {
        throw new Error('saturation receipt cohorts are not distinct')
      }
      waves.add(value.wave)
      const waveIndex = discoveryStage.waves.findIndex(wave => wave.id === value.wave)
      const records = body.acceptedArtifacts.filter(artifact => artifact.stageId === discoveryStage.id
        && artifact.waveId === value.wave)
      const expected = records.map(artifact => artifact.contentDigest).toSorted()
      if (JSON.stringify(value.artifacts) !== JSON.stringify(expected) || expected.length === 0) {
        throw new Error('saturation receipt does not bind its cohort artifacts')
      }
      const researchTasks = discoveryStage.waves[waveIndex]?.tasks.filter(task => task.promptKind === 'research') ?? []
      const completeZeroDelta = researchTasks.length > 0 && researchTasks.every(task => {
        const artifact = records.find(value => value.taskId === task.id)
        if (artifact === undefined) return false
        return artifact.status === 'additive-unavailable'
          ? task.optional === true
          : artifact.protocol.research?.materialHighCriticalDelta === false
      })
      if (waveIndex < 1 || !completeZeroDelta) {
        throw new Error('saturation receipt cohort is not a complete zero-delta cohort')
      }
    }
    }
  } else if (receipt?.reason === 'phase-deadline' || receipt?.reason === 'insufficient-time-for-full-wave') {
    if (body.discoveryScheduler !== undefined) {
      const evidence = receipt.evidence as { discoveryDeadline?: unknown, materialEpoch?: unknown }
      const expectedDeadline = Date.parse(body.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
      if (receipt.reason !== 'phase-deadline' || evidence.discoveryDeadline !== expectedDeadline
        || evidence.materialEpoch !== body.discoveryScheduler.materialEpoch
        || Date.parse(receipt.endedAt) < expectedDeadline) {
        throw new Error('independent discovery deadline receipt is invalid')
      }
    } else {
    const evidence = receipt.evidence as {
      admittedWaveSealed?: unknown, discoveryDeadline?: unknown, remainingMs?: unknown, lastCompleteWaveDurationMs?: unknown
    }
    const latestWaveIndex = Math.max(-1, ...body.acceptedArtifacts.filter(artifact => artifact.stageId === discoveryStage.id)
      .map(artifact => discoveryStage.waves.findIndex(wave => wave.id === artifact.waveId)))
    const timing = body.waveReceipts.find(value => value.stageId === discoveryStage.id && value.waveId === evidence.admittedWaveSealed)
    if (typeof evidence.admittedWaveSealed !== 'string' || !Number.isFinite(evidence.discoveryDeadline)
      || (receipt.reason === 'phase-deadline' && Date.parse(receipt.endedAt) < Number(evidence.discoveryDeadline))
      || evidence.lastCompleteWaveDurationMs !== timing?.durationMs
      || !Number.isFinite(evidence.remainingMs)
      || (receipt.reason === 'insufficient-time-for-full-wave'
        && !(Number(evidence.remainingMs) >= 0 && Number(evidence.remainingMs) < Number(evidence.lastCompleteWaveDurationMs)))
      || evidence.admittedWaveSealed !== discoveryStage.waves[latestWaveIndex]?.id) {
      throw new Error('time admission receipt is not host-bound to a sealed wave')
    }
    }
  } else if (receipt?.reason === 'measured-budget-inability') {
    if (body.discoveryScheduler !== undefined) {
      const evidence = receipt.evidence as {
        budget?: unknown, remainingCalls?: unknown, remainingCostUsd?: unknown, estimates?: unknown
      }
      const budgetAtDiscoveryBoundary = [
        ...body.acceptedArtifacts.filter(artifact => (
          (taskLocations.get(artifact.taskId)?.stageIndex ?? Number.MAX_SAFE_INTEGER) <= discoveryIndex
        )).map(artifact => artifact.usage),
        ...body.rejectedAttempts.filter(attempt => (
          (taskLocations.get(attempt.taskId)?.stageIndex ?? Number.MAX_SAFE_INTEGER) <= discoveryIndex
        )).map(attempt => attempt.usage),
      ].reduce(addBudget, zeroBudget())
      const candidates = body.discoveryScheduler.pools.filter(progress => !progress.parked
        && progress.nextWaveIndex < discoveryStage.waves.length
        && !body.availabilityBoundaries.some(boundary => boundary.poolId === progress.poolId))
      const estimates = candidates.map(progress => {
        const wave = discoveryStage.waves[progress.nextWaveIndex]!
        const prior = body.waveReceipts.filter(candidate => (
          candidate.stageId === discoveryStage.id && candidate.poolId === progress.poolId
        )).at(-1)
        return {
          poolId: progress.poolId,
          waveId: wave.id,
          modelCalls: wave.tasks.filter(task => configuredResearchTaskPoolId(task) === progress.poolId
            && task.providerClass !== 'deterministic').length,
          costUsd: prior === undefined ? 0 : sealedWaveRecordedCostUsd(
            prior, body.acceptedArtifacts, body.rejectedAttempts,
            discoveryStage.waves.find(candidate => candidate.id === prior.waveId)?.tasks
              .filter(task => configuredResearchTaskPoolId(task) === progress.poolId).map(task => task.id) ?? [],
          ),
        }
      })
      const remainingCalls = definition.limits.maxModelCalls - budgetAtDiscoveryBoundary.modelCalls
      const remainingCostUsd = remainingRecordedCostUsd(definition.limits.maxCostUsd, budgetAtDiscoveryBoundary.costUsd)
      const exhausted = budgetAtDiscoveryBoundary.modelCalls >= definition.limits.maxModelCalls
        || budgetAtDiscoveryBoundary.costUsd >= definition.limits.maxCostUsd
        || (definition.limits.maxInputTokens !== undefined
          && budgetAtDiscoveryBoundary.inputTokens >= definition.limits.maxInputTokens)
        || (definition.limits.maxOutputTokens !== undefined
          && budgetAtDiscoveryBoundary.outputTokens >= definition.limits.maxOutputTokens)
      const noCandidateFits = estimates.length > 0 && estimates.every(estimate => (
        estimate.modelCalls > remainingCalls || (estimate.costUsd > 0 && estimate.costUsd > remainingCostUsd)
      ))
      if ((!exhausted && !noCandidateFits) || canonicalJson(evidence.budget) !== canonicalJson(budgetAtDiscoveryBoundary)
        || evidence.remainingCalls !== remainingCalls || evidence.remainingCostUsd !== remainingCostUsd
        || canonicalJson(evidence.estimates) !== canonicalJson(estimates)) {
        throw new Error('independent discovery budget receipt is invalid')
      }
    } else {
    const evidence = receipt.evidence as {
      nextWaveModelCallEstimate?: unknown
      downstreamReserve?: unknown
      remainingCalls?: unknown
      exhaustedLimits?: unknown
      costEstimateBasisWave?: unknown
      lastCompleteWaveCostUsd?: unknown
      remainingCostUsd?: unknown
    }
    const completedWaveCount = Math.max(0, ...body.acceptedArtifacts.filter(artifact => artifact.stageId === discoveryStage.id)
      .map(artifact => discoveryStage.waves.findIndex(wave => wave.id === artifact.waveId) + 1))
    const estimateWave = discoveryStage.waves[completedWaveCount] ?? discoveryStage.waves[completedWaveCount - 1]
    const expectedEstimate = estimateWave?.tasks.reduce((total, task) => (
      total + (task.providerClass === 'deterministic' ? 0 : retryAttemptLimit(task))
    ), 0)
    const legacyDownstreamReserve = definition.stages.slice(discoveryIndex + 1).flatMap(stage => stage.waves)
      .reduce((total, wave) => total + wave.tasks.reduce((calls, task) => (
        calls + (task.providerClass === 'deterministic' ? 0 : retryAttemptLimit(task))
      ), 0), 0)
    const budgetAtDiscoveryBoundary = [
      ...body.acceptedArtifacts.filter(artifact => (taskLocations.get(artifact.taskId)?.stageIndex ?? Number.MAX_SAFE_INTEGER) <= discoveryIndex)
        .map(artifact => artifact.usage),
      ...body.rejectedAttempts.filter(attempt => (taskLocations.get(attempt.taskId)?.stageIndex ?? Number.MAX_SAFE_INTEGER) <= discoveryIndex)
        .map(attempt => attempt.usage),
    ].reduce(addBudget, zeroBudget())
    const reconstructedRemaining = definition.limits.maxModelCalls - budgetAtDiscoveryBoundary.modelCalls
    const expectedExhaustedLimits = [
      ...(definition.limits.maxInputTokens !== undefined
        && budgetAtDiscoveryBoundary.inputTokens >= definition.limits.maxInputTokens ? ['inputTokens'] : []),
      ...(definition.limits.maxOutputTokens !== undefined
        && budgetAtDiscoveryBoundary.outputTokens >= definition.limits.maxOutputTokens ? ['outputTokens'] : []),
      ...(budgetAtDiscoveryBoundary.costUsd >= definition.limits.maxCostUsd ? ['costUsd'] : []),
    ]
    const callInability = reconstructedRemaining < Number(expectedEstimate) + Number(evidence.downstreamReserve)
    const costEvidencePresent = [
      evidence.costEstimateBasisWave,
      evidence.lastCompleteWaveCostUsd,
      evidence.remainingCostUsd,
    ].some(value => value !== undefined)
    const lastDiscoveryReceipt = body.waveReceipts.filter(value => value.stageId === discoveryStage.id).at(-1)
    const expectedLastCompleteWaveCostUsd = lastDiscoveryReceipt === undefined
      ? 0
      : sealedWaveRecordedCostUsd(lastDiscoveryReceipt, body.acceptedArtifacts, body.rejectedAttempts)
    const expectedRemainingCostUsd = remainingRecordedCostUsd(
      definition.limits.maxCostUsd,
      budgetAtDiscoveryBoundary.costUsd,
    )
    const estimatedCostInability = costEvidencePresent
      && expectedLastCompleteWaveCostUsd > 0
      && expectedRemainingCostUsd < expectedLastCompleteWaveCostUsd
    const hasRecordedExhaustedLimits = evidence.exhaustedLimits !== undefined
    const recordedExhaustedLimits = hasRecordedExhaustedLimits ? evidence.exhaustedLimits : []
    if (![evidence.nextWaveModelCallEstimate, evidence.downstreamReserve, evidence.remainingCalls]
      .every(value => Number.isSafeInteger(value) && Number(value) >= 0)
      || evidence.nextWaveModelCallEstimate !== expectedEstimate
      || ![0, legacyDownstreamReserve].includes(Number(evidence.downstreamReserve))
      || evidence.remainingCalls !== reconstructedRemaining
      || (costEvidencePresent && (
        evidence.costEstimateBasisWave !== lastDiscoveryReceipt?.waveId
        || evidence.lastCompleteWaveCostUsd !== expectedLastCompleteWaveCostUsd
        || evidence.remainingCostUsd !== expectedRemainingCostUsd
      ))
      || !Array.isArray(recordedExhaustedLimits)
      || (hasRecordedExhaustedLimits
        && JSON.stringify(recordedExhaustedLimits) !== JSON.stringify(expectedExhaustedLimits))
      || (!callInability && !estimatedCostInability
        && (!hasRecordedExhaustedLimits || expectedExhaustedLimits.length === 0))) {
      throw new Error(`budget receipt does not prove next-wave inability: ${canonicalJson({
        evidence, expectedEstimate, legacyDownstreamReserve, reconstructedRemaining, expectedExhaustedLimits,
        expectedLastCompleteWaveCostUsd, expectedRemainingCostUsd,
      })}`)
    }
    }
  } else if (receipt?.reason === 'safety-ceiling-reached') {
    if (body.discoveryScheduler !== undefined) {
      const evidence = receipt.evidence as { configuredWaves?: unknown, pools?: unknown, artifacts?: unknown }
      const expectedPools = body.discoveryScheduler.pools.map(pool => ({
        poolId: pool.poolId, completedWaves: pool.nextWaveIndex,
      }))
      const expectedArtifacts = body.acceptedArtifacts.filter(artifact => (
        artifact.stageId === discoveryStage.id && artifact.status === 'accepted'
          && artifact.protocol.research !== undefined
      )).map(artifact => artifact.contentDigest).toSorted()
      const allTerminal = body.discoveryScheduler.pools.every(pool => (
        pool.nextWaveIndex >= discoveryStage.waves.length
          || body.availabilityBoundaries.some(boundary => boundary.poolId === pool.poolId)
      ))
      if (!allTerminal || evidence.configuredWaves !== discoveryStage.waves.length
        || evidence.configuredWaves !== definition.discoverySafetyCeiling
        || canonicalJson(evidence.pools) !== canonicalJson(expectedPools)
        || canonicalJson(evidence.artifacts) !== canonicalJson(expectedArtifacts)) {
        throw new Error('independent discovery safety ceiling receipt is invalid')
      }
    } else {
    const evidence = receipt.evidence as { configuredWaves?: unknown, finalWave?: unknown, artifacts?: unknown }
    const expectedArtifacts = body.acceptedArtifacts.filter(artifact => artifact.stageId === discoveryStage.id)
      .map(artifact => artifact.contentDigest).toSorted()
    if (evidence.configuredWaves !== discoveryStage.waves.length
      || evidence.configuredWaves !== definition.discoverySafetyCeiling
      || evidence.finalWave !== discoveryStage.waves.at(-1)?.id
      || JSON.stringify(evidence.artifacts) !== JSON.stringify(expectedArtifacts)) {
      throw new Error('safety ceiling receipt does not bind the complete configured discovery frontier')
    }
    }
  } else if (receipt !== undefined && !['stage-complete', 'preflight-passed'].includes(receipt.reason)) {
    throw new Error('checkpoint stage-end receipt is invalid')
  }
}

export class RunMachine {
  readonly definition: ExperimentDefinition
  private current: RunState

  private constructor(definition: ExperimentDefinition, state: RunState) {
    this.definition = deepClone(definition)
    this.current = deepClone(state)
  }

  static async create(
    definition: ExperimentDefinition,
    releaseDigest: string,
    runId: string,
    now = new Date().toISOString(),
    runtimeRelease?: RuntimeRelease,
  ): Promise<RunMachine> {
    validateExperiment(definition)
    assertRunId(runId)
    if (!/^[0-9a-f]{64}$/.test(releaseDigest)) throw new TypeError('release digest is invalid')
    if (runtimeRelease !== undefined) assertRuntimeRelease(runtimeRelease)
    const definitionDigest = await sha256(definition)
    let state: RunState = {
      schemaVersion: 2,
      experimentId: definition.id,
      runId,
      stateGeneration: 0,
      rootRunId: runId,
      rootCreatedAt: now,
      modelStartedAt: null,
      phase: 'preparation',
      recoveryEpoch: 0,
      parentRunId: null,
      parentCheckpointDigest: null,
      releaseDigest,
      ...(runtimeRelease === undefined ? {} : { runtimeRelease: deepClone(runtimeRelease) }),
      definitionDigest,
      status: 'created',
      cursor: { stageIndex: 0, waveIndex: 0 },
      artifacts: [],
      rejectedAttempts: [],
      stageEndReceipts: [],
      waveReceipts: [],
      waveAdmission: null,
      inFlightAgentAttempts: [],
      availabilityBoundaries: [],
      checkpoints: [],
      budget: zeroBudget(),
      journal: [],
      createdAt: now,
      updatedAt: now,
      terminalReason: null,
    }
    state = await appendEvent(state, 'run.created', {
      releaseDigest,
      definitionDigest,
      ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
    }, now)
    return new RunMachine(definition, state)
  }

  static async fromState(definition: ExperimentDefinition, state: RunState): Promise<RunMachine> {
    validateExperiment(definition)
    if (!Number.isSafeInteger(state.stateGeneration) || state.stateGeneration < 1) throw new Error('run state generation is invalid')
    if (state.definitionDigest !== await sha256(definition)) throw new Error('run definition mismatch')
    if (state.runtimeRelease !== undefined) assertRuntimeRelease(state.runtimeRelease, 'run runtime release')
    await assertInheritedRuntimeTransition(state)
    assertPromotedExecutionProofs(state.promotedExecutionProofs)
    if (state.failedWaveRecovery !== undefined) {
      assertFailedWaveRecoveryEvidence(state.failedWaveRecovery)
      if (state.runtimeRelease === undefined
        || (state.runtimeTransition === undefined && !sameRuntimeRelease(state.runtimeRelease, state.failedWaveRecovery.targetRuntimeRelease))
        || (state.failedWaveRecovery.promotedExecution !== undefined
          && !(state.promotedExecutionProofs ?? []).some(proof => (
            canonicalJson(proof) === canonicalJson(state.failedWaveRecovery!.promotedExecution)
          )))) {
        throw new Error('run failed-wave recovery lineage is invalid')
      }
    }
    if (state.terminalCompletionRecovery !== undefined) {
      assertTerminalCompletionRecoveryEvidence(state.terminalCompletionRecovery)
      if (state.runtimeRelease === undefined
        || (state.runtimeTransition === undefined && !sameRuntimeRelease(state.runtimeRelease, state.terminalCompletionRecovery.targetRuntimeRelease))) {
        throw new Error('run terminal completion recovery lineage is invalid')
      }
    }
    if (state.experimentId !== definition.id) throw new Error('run experiment mismatch')
    const expectedPhase = state.status === 'stopped' ? 'stopped'
      : state.status === 'completed' ? 'complete' : phaseForStage(definition.stages[state.cursor.stageIndex])
    if (state.phase !== expectedPhase) throw new Error('run phase differs from its cursor and status')
    if (state.cursor.stageIndex === 0 ? state.modelStartedAt !== null : !Number.isFinite(Date.parse(state.modelStartedAt ?? ''))) {
      throw new Error('run model clock is not bound to successful preflight')
    }
    if (state.waveAdmission !== undefined && state.waveAdmission !== null) {
      const admittedStage = definition.stages[state.cursor.stageIndex]
      const admittedWave = admittedStage?.waves[state.cursor.waveIndex]
      if (state.waveAdmission.stageId !== admittedStage?.id || state.waveAdmission.waveId !== admittedWave?.id
        || state.waveAdmission.cursor.stageIndex !== state.cursor.stageIndex
        || state.waveAdmission.cursor.waveIndex !== state.cursor.waveIndex
        || !Number.isFinite(Date.parse(state.waveAdmission.admittedAt))) {
        throw new Error('run wave admission differs from its cursor')
      }
    }
    if (state.discoveryScheduler !== undefined) {
      const scheduler = state.discoveryScheduler
      const stageIndex = definition.stages.findIndex(stage => stage.id === scheduler.stageId)
      const stage = definition.stages[stageIndex]
      if (stage?.kind !== 'discovery' || !Number.isSafeInteger(scheduler.materialEpoch)
        || scheduler.materialEpoch < 0 || (state.cursor.stageIndex !== stageIndex && scheduler.admissions.length > 0)) {
        throw new Error('run discovery scheduler identity is invalid')
      }
      const expectedPools = [...new Set(stage.waves.flatMap(wave => wave.tasks
        .filter(task => task.promptKind === 'research').map(configuredResearchTaskPoolId)))].toSorted()
      if (canonicalJson(scheduler.pools.map(pool => pool.poolId).toSorted()) !== canonicalJson(expectedPools)
        || new Set(scheduler.pools.map(pool => pool.poolId)).size !== scheduler.pools.length) {
        throw new Error('run discovery scheduler pool set is invalid')
      }
      const sealedRefs = new Set(state.artifacts.filter(artifact => state.waveReceipts.some(receipt => (
        receipt.artifactRefs?.some(reference => reference.id === artifact.id
          && reference.contentDigest === artifact.contentDigest)
        ?? receipt.artifactDigests.includes(artifact.contentDigest)
      ))).map(artifact => canonicalJson({ id: artifact.id, contentDigest: artifact.contentDigest })))
      for (const pool of scheduler.pools) {
        if (!Number.isSafeInteger(pool.nextWaveIndex) || pool.nextWaveIndex < 0 || pool.nextWaveIndex > stage.waves.length
          || !Number.isSafeInteger(pool.quietCohorts) || pool.quietCohorts < 0
          || !Number.isSafeInteger(pool.quietEpoch) || pool.quietEpoch < 0 || pool.quietEpoch > scheduler.materialEpoch
          || pool.parked !== (definition.stopOnSaturation !== false && pool.quietCohorts >= 2)) {
          throw new Error(`run discovery pool progress is invalid: ${pool.poolId}`)
        }
      }
      const admittedPools = new Set<string>()
      for (const admission of scheduler.admissions) {
        assertDiscoveryAdmissionBudget(definition, admission.budgetAtAdmission)
        const progress = scheduler.pools.find(pool => pool.poolId === admission.poolId)
        const wave = stage.waves[admission.waveIndex]
        const expectedTaskIds = wave?.tasks.filter(task => configuredResearchTaskPoolId(task) === admission.poolId)
          .map(task => task.id).toSorted()
        if (progress?.nextWaveIndex !== admission.waveIndex || wave?.id !== admission.waveId
          || admission.stageId !== stage.id || admittedPools.has(admission.poolId)
          || !Number.isFinite(Date.parse(admission.admittedAt))
          || admission.materialEpoch > scheduler.materialEpoch
          || canonicalJson(admission.taskIds) !== canonicalJson(expectedTaskIds)
          || canonicalJson(admission.inputArtifacts) !== canonicalJson([...admission.inputArtifacts]
            .toSorted((left, right) => left.id.localeCompare(right.id) || left.contentDigest.localeCompare(right.contentDigest)))
          || new Set(admission.inputArtifacts.map(reference => reference.id)).size !== admission.inputArtifacts.length
          || admission.inputArtifacts.some(reference => !sealedRefs.has(canonicalJson(reference)))
          || admission.inputDigest !== await sha256(admission.inputArtifacts)) {
          throw new Error(`run discovery cohort admission is invalid: ${admission.poolId}`)
        }
        admittedPools.add(admission.poolId)
      }
    }
    const inFlight = state.inFlightAgentAttempts ?? []
    const inFlightKeys = new Set<string>()
    for (const attempt of inFlight) {
      const task = definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
        .find(candidate => candidate.id === attempt.taskId)
      const discoveryAdmission = state.discoveryScheduler?.admissions.find(candidate => (
        candidate.stageId === attempt.stageId && candidate.waveId === attempt.waveId
          && candidate.taskIds.includes(attempt.taskId)
      ))
      const admitted = state.waveAdmission !== null && state.waveAdmission !== undefined
        && attempt.stageId === state.waveAdmission.stageId && attempt.waveId === state.waveAdmission.waveId
      const key = `${attempt.stageId}/${attempt.waveId}/${attempt.taskId}`
      if ((!admitted && discoveryAdmission === undefined)
        || task === undefined || task.providerClass === 'deterministic'
        || !Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1
        || attempt.attempt > (attempt.formatRepairOrdinal === undefined
          ? retryAttemptLimit(task) : maxAgentAttemptOrdinal(task))
        || !/^[0-9a-f]{64}$/.test(attempt.promptDigest)
        || (attempt.formatRepairOrdinal !== undefined && (() => {
          try { return formatRepairOrdinalForAttempt(task, attempt.attempt, state.rejectedAttempts.filter(rejection => (
            rejection.taskId === attempt.taskId && (rejection.repairScopeRunId ?? state.runId) === state.runId
          ))) !== attempt.formatRepairOrdinal } catch { return true }
        })())
        || (attempt.formatRepairOrdinal === undefined
          ? attempt.formatRepairSourceDigest !== undefined
          : attempt.formatRepairSourceDigest !== formatRepairSourceDigestForAttempt(attempt.attempt,
            state.rejectedAttempts.filter(rejection => rejection.taskId === attempt.taskId
              && (rejection.repairScopeRunId ?? state.runId) === state.runId)))
        || !retryModesWithCustody(task, attempt.attempt, state.rejectedAttempts, state.runId,
          attempt.formatRepairOrdinal, state.failedWaveRecovery?.retainedNative).some(mode => (
          mode.freshContext === attempt.freshContext && mode.continuationMode === attempt.continuationMode
        ))
        || (attempt.continuationMode === 'resume' && !/^[a-zA-Z0-9._:-]{8,200}$/.test(attempt.sessionId ?? ''))
        || !Number.isFinite(Date.parse(attempt.admittedAt)) || inFlightKeys.has(key)) {
        throw new Error(`run in-flight agent attempt is invalid: ${attempt.taskId}`)
      }
      inFlightKeys.add(key)
    }
    let previousDigest: string | null = null
    for (let index = 0; index < state.journal.length; index += 1) {
      const event = state.journal[index]
      if (event === undefined || event.sequence !== index || event.previousDigest !== previousDigest) {
        throw new Error('run journal chain is invalid')
      }
      const { digest, ...unsigned } = event
      if (await sha256(unsigned) !== digest) throw new Error('run journal digest mismatch')
      previousDigest = digest
    }
    return new RunMachine(definition, state)
  }

  static async resume(
    definition: ExperimentDefinition,
    checkpoint: SealedCheckpoint,
    childRunId: string,
    knownRunIds: ReadonlySet<string> = new Set(),
    now = new Date().toISOString(),
    timeAmendment?: ModelClockAmendment,
    runtimeRelease?: RuntimeRelease,
    runtimeTransition?: RuntimeTransitionEvidence,
    transitionSource?: RunState,
  ): Promise<RunMachine> {
    validateExperiment(definition)
    assertRunId(childRunId)
    if (knownRunIds.has(childRunId)) throw new Error(`run already exists: ${childRunId}`)
    if (childRunId === checkpoint.body.runId) throw new Error('resume requires a fresh child run id')
    if (await sha256(checkpoint.body) !== checkpoint.digest) throw new Error('checkpoint digest mismatch')
    await assertCheckpointFrontier(definition, checkpoint)
    if (runtimeRelease !== undefined) assertRuntimeRelease(runtimeRelease)
    if (checkpoint.body.runtimeRelease !== undefined && runtimeRelease !== undefined
      && !sameRuntimeRelease(checkpoint.body.runtimeRelease, runtimeRelease) && runtimeTransition === undefined) {
      throw new Error('resume runtime release mismatch')
    }
    if (runtimeTransition !== undefined) {
      if (timeAmendment !== undefined) throw new Error('runtime transition cannot amend the original clock')
      if (runtimeRelease === undefined || transitionSource === undefined) throw new Error('runtime transition source and target are required')
      await RunMachine.fromState(definition, transitionSource)
      const prepared = await prepareCheckpointRuntimeTransition({ definition, checkpoint, source: transitionSource,
        sourceStateGeneration: runtimeTransition.sourceStateGeneration, sourceStateDigest: runtimeTransition.sourceStateDigest,
        targetRuntimeRelease: runtimeRelease })
      if (canonicalJson(prepared) !== canonicalJson(runtimeTransition)) throw new Error('runtime transition evidence mismatch')
    }
    const resumedRuntimeRelease = runtimeTransition === undefined ? checkpoint.body.runtimeRelease ?? runtimeRelease : runtimeRelease
    const resumedTransition = runtimeTransition ?? checkpoint.body.runtimeTransition
    if (checkpoint.body.definitionDigest !== await sha256(definition)) throw new Error('checkpoint definition mismatch')
    if (checkpoint.body.experimentId !== definition.id) throw new Error('checkpoint experiment mismatch')
    const cursor = normalizeCursor(definition, checkpoint.body.cursor)
    if (timeAmendment !== undefined) {
      const previousMs = Date.parse(timeAmendment.previousModelStartedAt)
      const amendedMs = Date.parse(timeAmendment.amendedModelStartedAt)
      const amendmentMs = Date.parse(timeAmendment.amendedAt)
      const nowMs = Date.parse(now)
      if (!['operator-resume-after-expired-phase', 'operator-resume-before-unadmittable-wave'].includes(timeAmendment.reason)
        || timeAmendment.previousModelStartedAt !== checkpoint.body.modelStartedAt
        || timeAmendment.phase !== definition.stages[cursor.stageIndex]?.kind
        || ![previousMs, amendedMs, amendmentMs, nowMs].every(Number.isFinite)
        || amendedMs <= previousMs || amendedMs > nowMs || amendmentMs > nowMs) {
        throw new Error('resume time amendment is invalid')
      }
    }
    let state: RunState = {
      schemaVersion: 2,
      experimentId: definition.id,
      runId: childRunId,
      stateGeneration: checkpoint.body.stateGeneration,
      rootRunId: checkpoint.body.rootRunId,
      rootCreatedAt: checkpoint.body.rootCreatedAt,
      modelStartedAt: timeAmendment?.amendedModelStartedAt ?? checkpoint.body.modelStartedAt,
      phase: checkpoint.body.phase,
      recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
      parentRunId: checkpoint.body.runId,
      parentCheckpointDigest: checkpoint.digest,
      ...(checkpoint.body.failedWaveRecovery === undefined
        ? {} : { failedWaveRecovery: deepClone(checkpoint.body.failedWaveRecovery) }),
      ...(checkpoint.body.promotedExecutionProofs === undefined
        ? {} : { promotedExecutionProofs: deepClone(checkpoint.body.promotedExecutionProofs) }),
      ...(checkpoint.body.terminalCompletionRecovery === undefined
        ? {} : { terminalCompletionRecovery: deepClone(checkpoint.body.terminalCompletionRecovery) }),
      releaseDigest: checkpoint.body.releaseDigest,
      ...(resumedRuntimeRelease === undefined ? {} : { runtimeRelease: deepClone(resumedRuntimeRelease) }),
      ...(resumedTransition === undefined ? {} : { runtimeTransition: deepClone(resumedTransition) }),
      definitionDigest: checkpoint.body.definitionDigest,
      status: 'created',
      cursor,
      artifacts: deepClone(checkpoint.body.acceptedArtifacts),
      rejectedAttempts: deepClone(checkpoint.body.rejectedAttempts),
      stageEndReceipts: deepClone(checkpoint.body.stageEndReceipts),
      waveReceipts: deepClone(checkpoint.body.waveReceipts),
      ...(checkpoint.body.discoveryScheduler === undefined
        ? {} : { discoveryScheduler: deepClone(checkpoint.body.discoveryScheduler) }),
      waveAdmission: null,
      inFlightAgentAttempts: [],
      availabilityBoundaries: deepClone(checkpoint.body.availabilityBoundaries),
      checkpoints: [],
      budget: deepClone(checkpoint.body.budget),
      journal: [],
      createdAt: now,
      updatedAt: now,
      terminalReason: null,
    }
    if (timeAmendment !== undefined) state = await appendEvent(state, 'run.time-amended', timeAmendment, now)
    state = await appendEvent(state, 'run.resumed', {
      parentRunId: checkpoint.body.runId,
      parentCheckpointDigest: checkpoint.digest,
      recoveryEpoch: state.recoveryEpoch,
      cursor,
      ...(resumedRuntimeRelease === undefined ? {} : { runtimeRelease: resumedRuntimeRelease }),
      ...(resumedTransition === undefined ? {} : { runtimeTransition: resumedTransition }),
    }, now)
    return new RunMachine(definition, state)
  }

  static async recoverFailedWave(
    definition: ExperimentDefinition,
    checkpoint: SealedCheckpoint,
    source: RunState,
    childRunId: string,
    importedArtifacts: readonly ArtifactRecord[],
    inheritedRejectedAttempts: readonly RejectedAttempt[],
    evidence: FailedWaveRecoveryEvidence,
    now = new Date().toISOString(),
  ): Promise<RunMachine> {
    validateExperiment(definition)
    assertRunId(childRunId)
    assertFailedWaveRecoveryEvidence(evidence)
    const independentDiscovery = source.discoveryScheduler !== undefined
      && source.discoveryScheduler.admissions.length > 0
    if (source.status !== 'failed' || source.runId !== evidence.sourceRunId
      || source.stateGeneration !== evidence.sourceStateGeneration
      || await sha256(source) !== evidence.sourceStateDigest
      || source.definitionDigest !== await sha256(definition)
      || source.releaseDigest !== checkpoint.body.releaseDigest
      || source.runtimeRelease === undefined
      || !sameRuntimeRelease(source.runtimeRelease, evidence.sourceRuntimeRelease)
      || sameRuntimeRelease(evidence.sourceRuntimeRelease, evidence.targetRuntimeRelease)
      || checkpoint.digest !== evidence.checkpointDigest
      || await sha256(checkpoint.body) !== checkpoint.digest
      || (!source.checkpoints.some(candidate => candidate.digest === checkpoint.digest)
        && source.parentCheckpointDigest !== checkpoint.digest)
      || source.cursor.stageIndex !== checkpoint.body.cursor.stageIndex
      || source.cursor.waveIndex !== checkpoint.body.cursor.waveIndex
      || (!independentDiscovery && (source.waveAdmission === undefined || source.waveAdmission === null))
      || (!independentDiscovery && (source.waveAdmission!.cursor.stageIndex !== source.cursor.stageIndex
        || source.waveAdmission!.cursor.waveIndex !== source.cursor.waveIndex))
      || ((source.inFlightAgentAttempts ?? []).length !== 0
        && (evidence.unobservableNative === undefined
          || !exactUnobservableAttempt(source, evidence.unobservableNative)))) {
      throw new Error('failed-wave recovery source identity is invalid')
    }
    await assertCheckpointFrontier(definition, checkpoint)
    if (independentDiscovery) {
      const scheduler = source.discoveryScheduler!
      const stage = definition.stages.find(candidate => candidate.id === scheduler.stageId)
      const acceptedTaskIds = new Set(source.artifacts.map(artifact => artifact.taskId))
      const missing = scheduler.admissions.flatMap(admission => admission.taskIds
        .filter(taskId => !acceptedTaskIds.has(taskId))
        .map(taskId => ({ admission, taskId })))
      if (stage?.kind !== 'discovery' || missing.length === 0
        || (evidence.unobservableNative !== undefined
          && (missing.length !== 1 || missing[0]?.taskId !== evidence.unobservableNative.taskId))
        || missing.some(({ admission, taskId }) => {
        const task = stage.waves[admission.waveIndex]?.tasks.find(candidate => candidate.id === taskId)
        const rejections = source.rejectedAttempts.filter(rejection => rejection.stageId === stage.id
          && rejection.waveId === admission.waveId && rejection.taskId === taskId
          && (rejection.repairScopeRunId ?? source.runId) === source.runId)
        return task === undefined || (evidence.unobservableNative?.taskId !== taskId && !exhaustedFailedWaveTask(
          task, rejections,
          evidence.promotedExecution?.taskId === taskId ? evidence.promotedExecution.sourceAttempt : undefined,
          skippedResumeSlotFailureRecorded(source, taskId),
        ))
      })) {
        throw new Error('failed discovery recovery has an ineligible missing task')
      }
      const checkpointTasks = new Set(checkpoint.body.acceptedArtifacts.map(artifact => artifact.taskId))
      const sourceImports = source.artifacts.filter(artifact => !checkpointTasks.has(artifact.taskId))
      const checkpointRejections = new Set(checkpoint.body.rejectedAttempts.map(value => canonicalJson(value)))
      const sourceRejections = source.rejectedAttempts.filter(value => !checkpointRejections.has(canonicalJson(value)))
      const scopedRejections = sourceRejections.map(rejection => ({
        ...deepClone(rejection), repairScopeRunId: rejection.repairScopeRunId ?? source.runId,
      }))
      if (canonicalJson(sourceImports) !== canonicalJson(importedArtifacts)
        || canonicalJson(evidence.importedTaskIds) !== canonicalJson(importedArtifacts.map(value => value.taskId).toSorted())
        || canonicalJson(scopedRejections) !== canonicalJson(inheritedRejectedAttempts)
        || inheritedRejectedAttempts.length !== evidence.inheritedRejectedAttemptCount
        || evidence.unknownUsageAttemptCount !== inheritedRejectedAttempts.filter(rejection => (
          rejection.outputDigest === null && rejection.usage.inputTokens === 0
          && rejection.usage.outputTokens === 0 && rejection.usage.costUsd === 0
        )).length + (evidence.unobservableNative === undefined ? 0 : 1)
        || canonicalJson(source.promotedExecutionProofs ?? [])
          !== canonicalJson(checkpoint.body.promotedExecutionProofs ?? [])
        || canonicalJson(source.stageEndReceipts) !== canonicalJson(checkpoint.body.stageEndReceipts)) {
        throw new Error('failed discovery recovery evidence differs from its source')
      }
      const budget = [...source.artifacts.map(artifact => artifact.usage), ...source.rejectedAttempts.map(value => value.usage)]
        .reduce(addBudget, zeroBudget())
      if (canonicalJson(budget) !== canonicalJson(source.budget)) {
        throw new Error('failed discovery source budget differs from its recorded usage')
      }
      const promotedExecutionProofs = extendPromotedExecutionProofs(
        checkpoint.body.promotedExecutionProofs, evidence.promotedExecution,
      )
      let state: RunState = {
        schemaVersion: 2,
        experimentId: definition.id,
        runId: childRunId,
        stateGeneration: source.stateGeneration,
        rootRunId: source.rootRunId,
        rootCreatedAt: source.rootCreatedAt,
        modelStartedAt: source.modelStartedAt,
        phase: source.phase,
        recoveryEpoch: source.recoveryEpoch + 1,
        parentRunId: source.runId,
        parentCheckpointDigest: checkpoint.digest,
        failedWaveRecovery: deepClone(evidence),
        ...(promotedExecutionProofs.length === 0 ? {} : { promotedExecutionProofs }),
        releaseDigest: source.releaseDigest,
        runtimeRelease: deepClone(evidence.targetRuntimeRelease),
        definitionDigest: source.definitionDigest,
        status: 'created',
        cursor: deepClone(source.cursor),
        artifacts: deepClone(source.artifacts),
        rejectedAttempts: [...deepClone(checkpoint.body.rejectedAttempts), ...deepClone(scopedRejections)],
        stageEndReceipts: deepClone(source.stageEndReceipts),
        waveReceipts: deepClone(source.waveReceipts),
        discoveryScheduler: deepClone(source.discoveryScheduler!),
        waveAdmission: null,
        inFlightAgentAttempts: [],
        availabilityBoundaries: deepClone(source.availabilityBoundaries),
        checkpoints: [],
        budget,
        journal: [],
        createdAt: now,
        updatedAt: now,
        terminalReason: null,
      }
      state = await appendEvent(state, 'run.failed-wave-recovered', evidence, now)
      return new RunMachine(definition, state)
    }
    const stage = definition.stages[source.cursor.stageIndex]
    const wave = stage?.waves[source.cursor.waveIndex]
    if (stage === undefined || wave === undefined
      || source.waveAdmission!.stageId !== stage.id || source.waveAdmission!.waveId !== wave.id) {
      throw new Error('failed-wave recovery source cursor is invalid')
    }
    const retained = evidence.retainedNative
    if (retained !== undefined) {
      const task = wave.tasks.find(candidate => candidate.id === retained.taskId)
      const rejections = source.rejectedAttempts.filter(rejection => rejection.stageId === stage.id
        && rejection.waveId === wave.id && rejection.taskId === retained.taskId
        && (rejection.repairScopeRunId ?? source.runId) === source.runId)
        .toSorted((left, right) => left.attempt - right.attempt)
      const latest = rejections.at(-1)
      if (retained.stageId !== stage.id || retained.waveId !== wave.id
        || source.failedWaveRecovery?.retainedNative?.taskId === retained.taskId
        || task?.workspaceKey !== retained.workspaceKey || task.providerClass !== 'additive'
        || task.backend !== 'dsh-chat-completions' || task.workspaceMode === 'continuation'
        || rejections.length !== 2 || latest?.attempt !== 2 || latest.outputDigest !== null
        || latest.quarantineUri !== null || latest.sessionId !== retained.nativeTransport.sessionId
        || canonicalJson(latest.nativeTransport) !== canonicalJson(retained.nativeTransport)) {
        throw new Error('retained native source task differs from recovery evidence')
      }
    }
    const inCurrentWave = (value: { stageId: string, waveId: string }) => (
      value.stageId === stage.id && value.waveId === wave.id
    )
    const predecessorArtifacts = source.artifacts.filter(value => !inCurrentWave(value))
    const predecessorRejections = source.rejectedAttempts.filter(value => !inCurrentWave(value))
    if (canonicalJson(predecessorArtifacts) !== canonicalJson(checkpoint.body.acceptedArtifacts)
      || canonicalJson(predecessorRejections) !== canonicalJson(checkpoint.body.rejectedAttempts)
      || canonicalJson(source.promotedExecutionProofs ?? [])
        !== canonicalJson(checkpoint.body.promotedExecutionProofs ?? [])
      || canonicalJson(source.stageEndReceipts) !== canonicalJson(checkpoint.body.stageEndReceipts)
      || canonicalJson(source.waveReceipts) !== canonicalJson(checkpoint.body.waveReceipts)
      || canonicalJson(source.availabilityBoundaries) !== canonicalJson(checkpoint.body.availabilityBoundaries)) {
      throw new Error('failed-wave recovery predecessor frontier differs from its checkpoint')
    }
    const sourceImports = source.artifacts.filter(inCurrentWave)
    if (canonicalJson(sourceImports) !== canonicalJson(importedArtifacts)
      || canonicalJson(evidence.importedTaskIds) !== canonicalJson(importedArtifacts.map(value => value.taskId).toSorted())) {
      throw new Error('failed-wave recovery imported artifact set is invalid')
    }
    const sourceRejections = source.rejectedAttempts.filter(inCurrentWave)
    const scopedRejections = sourceRejections.map(rejection => ({
      ...deepClone(rejection), repairScopeRunId: rejection.repairScopeRunId ?? source.runId,
    }))
    if (canonicalJson(scopedRejections) !== canonicalJson(inheritedRejectedAttempts)
      || inheritedRejectedAttempts.length !== evidence.inheritedRejectedAttemptCount) {
      throw new Error('failed-wave recovery rejected-attempt set is invalid')
    }
    const artifacts = [...deepClone(checkpoint.body.acceptedArtifacts), ...deepClone(importedArtifacts)]
    const rejectedAttempts = [...deepClone(checkpoint.body.rejectedAttempts), ...deepClone(inheritedRejectedAttempts)]
    const budget = [
      ...artifacts.map(artifact => artifact.usage),
      ...rejectedAttempts.map(rejection => rejection.usage),
    ].reduce(addBudget, zeroBudget())
    if (canonicalJson(budget) !== canonicalJson(source.budget)) {
      throw new Error('failed-wave source budget differs from its recorded usage')
    }
    const promotedExecutionProofs = extendPromotedExecutionProofs(
      checkpoint.body.promotedExecutionProofs, evidence.promotedExecution,
    )
    let state: RunState = {
      schemaVersion: 2,
      experimentId: definition.id,
      runId: childRunId,
      stateGeneration: checkpoint.body.stateGeneration,
      rootRunId: checkpoint.body.rootRunId,
      rootCreatedAt: checkpoint.body.rootCreatedAt,
      modelStartedAt: checkpoint.body.modelStartedAt,
      phase: checkpoint.body.phase,
      recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
      parentRunId: source.runId,
      parentCheckpointDigest: checkpoint.digest,
      failedWaveRecovery: deepClone(evidence),
      ...(promotedExecutionProofs.length === 0 ? {} : { promotedExecutionProofs }),
      releaseDigest: checkpoint.body.releaseDigest,
      runtimeRelease: deepClone(evidence.targetRuntimeRelease),
      definitionDigest: checkpoint.body.definitionDigest,
      status: 'created',
      cursor: deepClone(checkpoint.body.cursor),
      artifacts,
      rejectedAttempts,
      stageEndReceipts: deepClone(checkpoint.body.stageEndReceipts),
      waveReceipts: deepClone(checkpoint.body.waveReceipts),
      ...(checkpoint.body.discoveryScheduler === undefined
        ? {} : { discoveryScheduler: deepClone(checkpoint.body.discoveryScheduler) }),
      waveAdmission: null,
      inFlightAgentAttempts: [],
      availabilityBoundaries: deepClone(checkpoint.body.availabilityBoundaries),
      checkpoints: [],
      budget,
      journal: [],
      createdAt: now,
      updatedAt: now,
      terminalReason: null,
    }
    state = await appendEvent(state, 'run.failed-wave-recovered', evidence, now)
    return new RunMachine(definition, state)
  }

  static async recoverTerminalCompletion(
    definition: ExperimentDefinition,
    checkpoint: SealedCheckpoint,
    source: RunState,
    childRunId: string,
    evidence: TerminalCompletionRecoveryEvidence,
    now = new Date().toISOString(),
  ): Promise<RunMachine> {
    validateExperiment(definition)
    assertRunId(childRunId)
    assertTerminalCompletionRecoveryEvidence(evidence)
    await assertCheckpointFrontier(definition, checkpoint)
    if (source.status !== 'failed' || source.runId !== evidence.sourceRunId
      || source.stateGeneration !== evidence.sourceStateGeneration
      || await sha256(source) !== evidence.sourceStateDigest
      || source.definitionDigest !== await sha256(definition)
      || source.releaseDigest !== checkpoint.body.releaseDigest
      || source.runtimeRelease === undefined
      || !sameRuntimeRelease(source.runtimeRelease, evidence.sourceRuntimeRelease)
      || canonicalJson(source.promotedExecutionProofs ?? [])
        !== canonicalJson(checkpoint.body.promotedExecutionProofs ?? [])
      || checkpoint.digest !== evidence.checkpointDigest
      || await sha256(checkpoint.body) !== checkpoint.digest) {
      throw new Error('terminal completion recovery source identity is invalid')
    }
    let state: RunState = {
      schemaVersion: 2,
      experimentId: definition.id,
      runId: childRunId,
      stateGeneration: checkpoint.body.stateGeneration,
      rootRunId: checkpoint.body.rootRunId,
      rootCreatedAt: checkpoint.body.rootCreatedAt,
      modelStartedAt: checkpoint.body.modelStartedAt,
      phase: checkpoint.body.phase,
      recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
      parentRunId: source.runId,
      parentCheckpointDigest: checkpoint.digest,
      ...(checkpoint.body.promotedExecutionProofs === undefined
        ? {} : { promotedExecutionProofs: deepClone(checkpoint.body.promotedExecutionProofs) }),
      terminalCompletionRecovery: deepClone(evidence),
      releaseDigest: checkpoint.body.releaseDigest,
      runtimeRelease: deepClone(evidence.targetRuntimeRelease),
      definitionDigest: checkpoint.body.definitionDigest,
      status: 'created',
      cursor: deepClone(checkpoint.body.cursor),
      artifacts: deepClone(checkpoint.body.acceptedArtifacts),
      rejectedAttempts: deepClone(checkpoint.body.rejectedAttempts),
      stageEndReceipts: deepClone(checkpoint.body.stageEndReceipts),
      waveReceipts: deepClone(checkpoint.body.waveReceipts),
      ...(checkpoint.body.discoveryScheduler === undefined
        ? {} : { discoveryScheduler: deepClone(checkpoint.body.discoveryScheduler) }),
      waveAdmission: null,
      inFlightAgentAttempts: [],
      availabilityBoundaries: deepClone(checkpoint.body.availabilityBoundaries),
      checkpoints: [],
      budget: deepClone(checkpoint.body.budget),
      journal: [],
      createdAt: now,
      updatedAt: now,
      terminalReason: null,
    }
    state = await appendEvent(state, 'run.terminal-completion-recovered', evidence, now)
    return new RunMachine(definition, state)
  }

  snapshot(): RunState {
    return deepClone(this.current)
  }

  async start(now = new Date().toISOString()): Promise<void> {
    if (this.current.status !== 'created') return
    this.current = await appendEvent({ ...this.current, status: 'running' }, 'run.started', {
      cursor: this.current.cursor,
    }, now)
  }

  async recordFailure(task: TaskDefinition, error: unknown, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const classified = error instanceof RunFailure ? error : null
    this.current = await appendEvent(this.current, 'task.failed', {
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
      ...(classified === null ? {} : { category: classified.category, retryable: classified.retryable }),
    }, now)
  }

  async recordRejectedAttempt(rejection: Omit<RejectedAttempt, 'rejectedAt'>, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const normalized = {
      ...deepClone(rejection), repairScopeRunId: rejection.repairScopeRunId ?? this.current.runId,
    }
    const identity = rejectedAttemptIdentity(normalized)
    if (this.current.rejectedAttempts.some(attempt => rejectedAttemptIdentity(attempt) === identity)) return
    const record: RejectedAttempt = {
      ...normalized,
      rejectedAt: now,
    }
    assertBudgetShape(record.usage)
    const nextBudget = addBudget(this.current.budget, record.usage)
    const admitted = (this.current.inFlightAgentAttempts ?? []).some(attempt => (
      attempt.stageId === rejection.stageId && attempt.waveId === rejection.waveId
        && attempt.taskId === rejection.taskId && attempt.attempt === rejection.attempt
        && attempt.promptDigest === rejection.promptDigest
    ))
    const violation = !admitted && this.definition.stages[this.current.cursor.stageIndex]?.kind === 'discovery'
      ? budgetViolation(this.definition, nextBudget) : null
    this.current = await appendEvent({
      ...this.current,
      rejectedAttempts: [...this.current.rejectedAttempts, record],
      budget: nextBudget,
    }, 'task.attempt-rejected', record, now)
    if (violation !== null) throw new Error(violation)
  }

  async admitAgentAttempt(
    admission: Omit<InFlightAgentAttempt, 'admittedAt'>,
    now = new Date().toISOString(),
  ): Promise<void> {
    this.assertRunning()
    const waveAdmission = this.current.waveAdmission
    const discoveryAdmission = this.current.discoveryScheduler?.admissions.find(candidate => (
      candidate.stageId === admission.stageId && candidate.waveId === admission.waveId
        && candidate.taskIds.includes(admission.taskId)
    ))
    if ((waveAdmission === undefined || waveAdmission === null
      || waveAdmission.stageId !== admission.stageId || waveAdmission.waveId !== admission.waveId)
      && discoveryAdmission === undefined) {
      throw new Error(`agent attempt requires its wave admission: ${admission.stageId}/${admission.waveId}/${admission.taskId}`)
    }
    const task = this.definition.stages.flatMap(stage => stage.waves)
      .flatMap(wave => wave.tasks).find(candidate => candidate.id === admission.taskId)
    if (task === undefined || task.providerClass === 'deterministic'
      || !Number.isSafeInteger(admission.attempt) || admission.attempt < 1
      || admission.attempt > (admission.formatRepairOrdinal === undefined
        ? retryAttemptLimit(task) : maxAgentAttemptOrdinal(task))
      || !/^[0-9a-f]{64}$/.test(admission.promptDigest)
      || (admission.formatRepairOrdinal !== undefined && (() => {
        try { return formatRepairOrdinalForAttempt(task, admission.attempt,
          this.current.rejectedAttempts.filter(rejection => rejection.taskId === admission.taskId
            && (rejection.repairScopeRunId ?? this.current.runId) === this.current.runId))
          !== admission.formatRepairOrdinal } catch { return true }
      })())
      || (admission.formatRepairOrdinal === undefined
        ? admission.formatRepairSourceDigest !== undefined
        : admission.formatRepairSourceDigest !== formatRepairSourceDigestForAttempt(admission.attempt,
          this.current.rejectedAttempts.filter(rejection => rejection.taskId === admission.taskId
            && (rejection.repairScopeRunId ?? this.current.runId) === this.current.runId)))
      || (this.current.failedWaveRecovery?.retainedNative?.taskId === task.id
        && admission.attempt === 1 && this.current.rejectedAttempts.some(rejection => (
          rejection.taskId === task.id && (rejection.repairScopeRunId ?? this.current.runId) === this.current.runId)))
      || !retryModesWithCustody(task, admission.attempt, this.current.rejectedAttempts, this.current.runId,
        admission.formatRepairOrdinal, this.current.failedWaveRecovery?.retainedNative).some(mode => (
        mode.freshContext === admission.freshContext && mode.continuationMode === admission.continuationMode
      ))
      || (admission.continuationMode === 'resume' && !/^[a-zA-Z0-9._:-]{8,200}$/.test(admission.sessionId ?? ''))) {
      throw new Error(`agent attempt admission is invalid: ${admission.taskId}`)
    }
    const attempts = this.current.inFlightAgentAttempts ?? []
    const existing = attempts.find(value => value.stageId === admission.stageId
      && value.waveId === admission.waveId && value.taskId === admission.taskId)
    if (existing !== undefined) {
      const { admittedAt: _admittedAt, ...identity } = existing
      if (canonicalJson(identity) !== canonicalJson(admission)) {
        throw new Error(`agent attempt admission changed while in flight: ${admission.taskId}`)
      }
      return
    }
    const record = { ...deepClone(admission), admittedAt: now }
    this.current = await appendEvent({
      ...this.current, inFlightAgentAttempts: [...attempts, record],
    }, 'agent.attempt-admitted', record, now)
  }

  async clearAgentAttempt(
    stageId: string,
    waveId: string,
    taskId: string,
    promptDigest: string,
    now = new Date().toISOString(),
  ): Promise<void> {
    this.assertRunning()
    const attempts = this.current.inFlightAgentAttempts ?? []
    const existing = attempts.find(value => value.stageId === stageId && value.waveId === waveId
      && value.taskId === taskId)
    if (existing === undefined) return
    if (existing.promptDigest !== promptDigest) {
      throw new Error(`agent attempt completion differs from its admission: ${taskId}`)
    }
    this.current = await appendEvent({
      ...this.current,
      inFlightAgentAttempts: attempts.filter(value => value !== existing),
    }, 'agent.attempt-finished', { stageId, waveId, taskId, promptDigest }, now)
  }

  async recordResult(input: {
    wave: WaveDefinition
    task: TaskDefinition
    promptDigest: string
    result: AgentResult
    artifactStore: ArtifactStore
    stageId: string
  }, now = new Date().toISOString()): Promise<ArtifactRecord> {
    this.assertRunning()
    const usage = {
      modelCalls: input.result.modelCalls ?? (input.task.providerClass === 'deterministic' ? 0 : 1),
      inputTokens: input.result.inputTokens,
      ...(input.result.rawInputTokens === undefined ? {} : { rawInputTokens: input.result.rawInputTokens }),
      ...(input.result.cachedInputTokens === undefined ? {} : { cachedInputTokens: input.result.cachedInputTokens }),
      ...(input.result.cacheAccountingComplete === undefined
        ? {}
        : { cacheAccountingComplete: input.result.cacheAccountingComplete }),
      ...(input.result.costAccountingComplete === undefined
        ? {} : { costAccountingComplete: input.result.costAccountingComplete }),
      outputTokens: input.result.outputTokens,
      costUsd: normalizedCostUsd(input.result.costUsd),
    }
    assertBudgetShape(usage)
    const content = canonicalJson(input.result.files)
    const contentDigest = await sha256(content)
    const id = `${input.stageId}/${input.wave.id}/${input.task.id}/${contentDigest.slice(0, 16)}`
    const candidate: Omit<ArtifactRecord, 'uri'> = {
      id,
      stageId: input.stageId,
      waveId: input.wave.id,
      taskId: input.task.id,
      status: input.result.status,
      actorId: input.result.actorId,
      model: input.result.model,
      provider: input.result.provider,
      promptDigest: input.promptDigest,
      contentDigest,
      files: Object.keys(input.result.files).toSorted(),
      assertions: [...input.result.assertions],
      protocol: deepClone(input.result.protocol),
      usage,
      ...(input.result.unavailableReason === undefined ? {} : { unavailableReason: input.result.unavailableReason }),
    }
    const existing = this.current.artifacts.find(artifact => artifact.taskId === input.task.id)
    if (existing !== undefined) {
      const { uri: _uri, ...existingReceipt } = existing
      if (canonicalJson(existingReceipt) !== canonicalJson(candidate)) {
        throw new Error(`task result already exists with different receipt: ${input.task.id}`)
      }
      return deepClone(existing)
    }
    const nextBudget = budgetAfter(this.current.budget, input.result, input.task.providerClass !== 'deterministic')
    const admitted = (this.current.inFlightAgentAttempts ?? []).some(attempt => (
      attempt.stageId === input.stageId && attempt.waveId === input.wave.id
        && attempt.taskId === input.task.id && attempt.promptDigest === input.promptDigest
    ))
    const violation = !admitted
      && this.definition.stages[this.current.cursor.stageIndex]?.kind === 'discovery'
      ? budgetViolation(this.definition, nextBudget) : null
    const record = await input.artifactStore.put(candidate, content)
    let availabilityBoundaries = this.current.availabilityBoundaries
    if (input.task.providerClass === 'additive' && input.result.status === 'additive-unavailable'
      && (input.result.unavailableReason === 'budget' || input.result.unavailableReason === 'provider-credit')
      && input.stageId === 'discovery'
      && !availabilityBoundaries.some(boundary => (
        boundary.poolId === configuredResearchTaskPoolId(input.task)
          || (boundary.poolId === undefined && boundary.provider === providerIdentity(input.task))
      ))) {
      const waveNumber = Number(input.wave.id.replace(/^wave-/, ''))
      availabilityBoundaries = [...availabilityBoundaries, {
        provider: providerIdentity(input.task),
        poolId: configuredResearchTaskPoolId(input.task),
        effectiveFromWave: waveNumber + 1,
        reason: input.result.unavailableReason,
        sourceTaskId: input.task.id,
        sealedAt: now,
      }]
    }
    this.current = await appendEvent({
      ...this.current,
      artifacts: [...this.current.artifacts, record],
      availabilityBoundaries,
      budget: nextBudget,
    }, 'task.accepted', { artifact: record }, now)
    if (violation !== null) throw new Error(violation)
    return record
  }

  assertWaveComplete(stageId: string, wave: WaveDefinition): void {
    const records = this.current.artifacts.filter((artifact) => artifact.stageId === stageId && artifact.waveId === wave.id)
    assertWaveRecordsComplete(records, stageId, wave)
  }

  async admitWave(stageId: string, waveId: string, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const stage = this.definition.stages[this.current.cursor.stageIndex]
    const wave = stage?.waves[this.current.cursor.waveIndex]
    if (stage?.id !== stageId || wave?.id !== waveId) throw new Error('wave admission differs from the current cursor')
    const existing = this.current.waveAdmission
    if (existing !== undefined && existing !== null) {
      if (existing.stageId !== stageId || existing.waveId !== waveId
        || existing.cursor.stageIndex !== this.current.cursor.stageIndex
        || existing.cursor.waveIndex !== this.current.cursor.waveIndex) {
        throw new Error('another wave is already admitted')
      }
      return
    }
    const admission = { stageId, waveId, cursor: deepClone(this.current.cursor), admittedAt: now }
    this.current = await appendEvent({ ...this.current, waveAdmission: admission }, 'wave.admitted', admission, now)
  }

  async initializeDiscoveryScheduler(stageId: string, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const stage = this.definition.stages[this.current.cursor.stageIndex]
    if (stage?.id !== stageId || stage.kind !== 'discovery') {
      throw new Error('discovery scheduler differs from the current stage')
    }
    if (this.current.discoveryScheduler !== undefined) return
    assertIndependentDiscoveryFrontier(this.definition, this.current)
    const poolIds = [...new Set(stage.waves.flatMap(wave => wave.tasks
      .filter(task => task.promptKind === 'research')
      .map(configuredResearchTaskPoolId)))].toSorted()
    const scheduler: DiscoverySchedulerState = {
      stageId,
      materialEpoch: 0,
      pools: poolIds.map(poolId => ({ poolId, nextWaveIndex: 0, quietCohorts: 0, quietEpoch: 0, parked: false })),
      admissions: [],
    }
    this.current = await appendEvent({ ...this.current, discoveryScheduler: scheduler },
      'discovery.scheduler-initialized', scheduler, now)
  }

  async admitDiscoveryCohort(input: {
    stageId: string
    poolId: string
    waveIndex: number
    inputArtifacts: readonly { id: string, contentDigest: string }[]
    peerPredecessors: Readonly<Record<string, string>>
  }, now = new Date().toISOString()): Promise<DiscoveryCohortAdmission> {
    this.assertRunning()
    const scheduler = this.current.discoveryScheduler
    const stage = this.definition.stages[this.current.cursor.stageIndex]
    const wave = stage?.waves[input.waveIndex]
    const progress = scheduler?.pools.find(pool => pool.poolId === input.poolId)
    if (scheduler === undefined || scheduler.stageId !== input.stageId || stage?.id !== input.stageId
      || stage.kind !== 'discovery' || wave === undefined || progress?.nextWaveIndex !== input.waveIndex) {
      throw new Error('discovery cohort admission differs from durable progress')
    }
    const taskIds = wave.tasks.filter(task => configuredResearchTaskPoolId(task) === input.poolId)
      .map(task => task.id).toSorted()
    if (taskIds.length === 0) throw new Error(`discovery pool ${input.poolId} has no wave ${input.waveIndex}`)
    const existing = scheduler.admissions.find(candidate => candidate.poolId === input.poolId)
    const budgetAtAdmission = deepClone(existing?.budgetAtAdmission ?? this.current.budget)
    assertDiscoveryAdmissionBudget(this.definition, budgetAtAdmission)
    const inputArtifacts = [...input.inputArtifacts]
      .toSorted((left, right) => left.id.localeCompare(right.id) || left.contentDigest.localeCompare(right.contentDigest))
    if (new Set(inputArtifacts.map(reference => reference.id)).size !== inputArtifacts.length) {
      throw new Error(`discovery pool ${input.poolId} input contains duplicate artifact identities`)
    }
    const inputDigest = await sha256(inputArtifacts)
    if (existing !== undefined) {
      const expected = { ...existing, admittedAt: now }
      const candidate = {
        stageId: input.stageId, poolId: input.poolId, waveId: wave.id, waveIndex: input.waveIndex,
        taskIds, admittedAt: now, budgetAtAdmission, inputArtifacts, inputDigest,
        materialEpoch: scheduler.materialEpoch, peerPredecessors: deepClone(input.peerPredecessors),
      }
      if (canonicalJson(expected) !== canonicalJson(candidate)) {
        throw new Error(`discovery pool ${input.poolId} already has another cohort admitted`)
      }
      return deepClone(existing)
    }
    const admission: DiscoveryCohortAdmission = {
      stageId: input.stageId,
      poolId: input.poolId,
      waveId: wave.id,
      waveIndex: input.waveIndex,
      taskIds,
      admittedAt: now,
      budgetAtAdmission,
      inputArtifacts,
      inputDigest,
      materialEpoch: scheduler.materialEpoch,
      peerPredecessors: deepClone(input.peerPredecessors),
    }
    this.current = await appendEvent({
      ...this.current,
      discoveryScheduler: { ...scheduler, admissions: [...scheduler.admissions, admission] },
    }, 'discovery.cohort-admitted', admission, now)
    return deepClone(admission)
  }

  async recordDiscoveryCohortReceipt(
    stageId: string,
    wave: WaveDefinition,
    poolId: string,
    coalesceMaterialDelta = false,
    completedAt = new Date().toISOString(),
  ): Promise<boolean> {
    this.assertRunning()
    const scheduler = this.current.discoveryScheduler
    const admission = scheduler?.admissions.find(candidate => (
      candidate.stageId === stageId && candidate.waveId === wave.id && candidate.poolId === poolId
    ))
    if (scheduler === undefined || admission === undefined) {
      throw new Error(`discovery cohort completed without durable admission: ${stageId}/${wave.id}/${poolId}`)
    }
    const taskIds = new Set(admission.taskIds)
    const records = this.current.artifacts.filter(artifact => (
      artifact.stageId === stageId && artifact.waveId === wave.id && taskIds.has(artifact.taskId)
    ))
    assertDiscoveryCohortRecordsComplete(records, stageId, wave, poolId)
    if ((this.current.inFlightAgentAttempts ?? []).some(value => (
      value.stageId === stageId && value.waveId === wave.id && taskIds.has(value.taskId)
    ))) {
      throw new Error(`discovery cohort completed with an in-flight attempt: ${stageId}/${wave.id}/${poolId}`)
    }
    const materialDelta = records.some(record => (
      record.status === 'accepted' && record.protocol.research?.materialHighCriticalDelta === true
    ))
    const unavailable = records.some(record => record.status === 'additive-unavailable')
    let materialEpoch = scheduler.materialEpoch
    let pools = scheduler.pools.map(pool => ({ ...pool }))
    if (materialDelta && !coalesceMaterialDelta) {
      materialEpoch += 1
      pools = pools.map(pool => ({ ...pool, quietCohorts: 0, quietEpoch: materialEpoch, parked: false }))
    } else if (materialDelta) {
      pools = pools.map(pool => ({ ...pool, quietCohorts: 0, quietEpoch: materialEpoch, parked: false }))
    }
    const pool = pools.find(candidate => candidate.poolId === poolId)
    if (pool === undefined) throw new Error(`discovery pool progress is missing: ${poolId}`)
    pool.nextWaveIndex = admission.waveIndex + 1
    if (!materialDelta && !unavailable && admission.waveIndex > 0 && admission.materialEpoch === materialEpoch) {
      pool.quietEpoch = materialEpoch
      pool.quietCohorts += 1
      pool.parked = this.definition.stopOnSaturation !== false && pool.quietCohorts >= 2
    } else if (!materialDelta && (unavailable || admission.materialEpoch !== materialEpoch)) {
      pool.quietCohorts = 0
      pool.quietEpoch = materialEpoch
      pool.parked = false
    }
    const artifactRefs = records.map(record => ({ id: record.id, contentDigest: record.contentDigest }))
      .toSorted((left, right) => left.id.localeCompare(right.id) || left.contentDigest.localeCompare(right.contentDigest))
    const artifactDigests = records.map(record => record.contentDigest).toSorted()
    const receipt = {
      stageId,
      waveId: wave.id,
      poolId,
      inputArtifacts: admission.inputArtifacts,
      inputDigest: admission.inputDigest,
      peerPredecessors: admission.peerPredecessors,
      materialEpoch: admission.materialEpoch,
      materialHighCriticalDelta: materialDelta,
      startedAt: admission.admittedAt,
      budgetAtAdmission: admission.budgetAtAdmission,
      completedAt,
      durationMs: Math.max(1, Date.parse(completedAt) - Date.parse(admission.admittedAt)),
      artifactDigests,
      artifactRefs,
    }
    const existing = this.current.waveReceipts.find(candidate => (
      candidate.stageId === stageId && candidate.waveId === wave.id && candidate.poolId === poolId
    ))
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(receipt)) {
        throw new Error(`discovery cohort receipt changed: ${stageId}/${wave.id}/${poolId}`)
      }
      return existing.materialHighCriticalDelta === true
    }
    this.current = await appendEvent({
      ...this.current,
      waveReceipts: [...this.current.waveReceipts, receipt],
      discoveryScheduler: {
        ...scheduler,
        materialEpoch,
        pools,
        admissions: scheduler.admissions.filter(candidate => candidate !== admission),
      },
    }, 'discovery.cohort-completed', receipt, completedAt)
    return materialDelta
  }

  async recordWaveReceipt(stageId: string, wave: WaveDefinition, startedAt: string, completedAt = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const durationMs = Math.max(1, Date.parse(completedAt) - Date.parse(startedAt))
    if (!Number.isFinite(durationMs)) throw new TypeError('wave receipt time is invalid')
    const artifactDigests = this.current.artifacts.filter(artifact => artifact.stageId === stageId && artifact.waveId === wave.id)
      .map(artifact => artifact.contentDigest).toSorted()
    const existing = this.current.waveReceipts.find(receipt => receipt.stageId === stageId && receipt.waveId === wave.id)
    if (existing !== undefined) {
      if (canonicalJson(existing.artifactDigests) !== canonicalJson(artifactDigests)) {
        throw new Error(`wave receipt already exists with different artifacts: ${stageId}/${wave.id}`)
      }
      return
    }
    const receipt = {
      stageId,
      waveId: wave.id,
      startedAt,
      completedAt,
      durationMs,
      artifactDigests,
    }
    const admission = this.current.waveAdmission
    if (admission === undefined || admission === null || admission.stageId !== stageId || admission.waveId !== wave.id) {
      throw new Error(`wave completed without durable admission: ${stageId}/${wave.id}`)
    }
    if ((this.current.inFlightAgentAttempts ?? []).some(value => value.stageId === stageId && value.waveId === wave.id)) {
      throw new Error(`wave completed with an in-flight agent attempt: ${stageId}/${wave.id}`)
    }
    this.current = await appendEvent({
      ...this.current, waveReceipts: [...this.current.waveReceipts, receipt], waveAdmission: null,
    },
      'wave.completed', receipt, completedAt)
  }

  async endStage(reason: string, evidence: unknown, endedStageIndex = this.current.cursor.stageIndex, now = new Date().toISOString()): Promise<SealedCheckpoint> {
    this.assertRunning()
    if (this.current.waveAdmission !== undefined && this.current.waveAdmission !== null) {
      throw new Error('cannot end a stage while a wave is admitted')
    }
    if ((this.current.discoveryScheduler?.admissions.length ?? 0) !== 0) {
      throw new Error('cannot end discovery while a cohort is admitted')
    }
    if (!Number.isSafeInteger(endedStageIndex) || endedStageIndex < 0 || endedStageIndex >= this.definition.stages.length) {
      throw new TypeError('ended stage index is invalid')
    }
    const next = normalizeCursor(this.definition, { stageIndex: endedStageIndex + 1, waveIndex: 0 })
    if (this.current.cursor.stageIndex > next.stageIndex) throw new Error('cannot end an earlier stage after later work started')
    const permitted = ['preflight-passed', 'stage-complete', 'two-distinct-complete-saturation-cohorts',
      'phase-deadline', 'insufficient-time-for-full-wave', 'measured-budget-inability', 'safety-ceiling-reached',
      'completion-contract-passed']
    if (!permitted.includes(reason)) {
      throw new TypeError('stage end reason is invalid')
    }
    const from = phaseForStage(this.definition.stages[endedStageIndex])
    const to = phaseForStage(this.definition.stages[endedStageIndex + 1])
    const receipt = {
      stageIndex: endedStageIndex,
      from,
      to,
      reason: reason as import('./contracts.js').StageEndReceipt['reason'],
      evidence: deepClone(evidence),
      evidenceDigest: await sha256(evidence),
      endedAt: now,
    }
    this.current = await appendEvent({
      ...this.current,
      cursor: next,
      phase: to,
      modelStartedAt: endedStageIndex === 0 ? now : this.current.modelStartedAt,
      stageEndReceipts: [...this.current.stageEndReceipts, receipt],
    }, 'stage.ended', receipt, now)
    return this.seal(now)
  }

  async advance(cursor: RunCursor, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const normalized = normalizeCursor(this.definition, cursor)
    this.current = await appendEvent({ ...this.current, cursor: normalized }, 'cursor.advanced', normalized, now)
  }

  async seal(now = new Date().toISOString()): Promise<SealedCheckpoint> {
    this.assertRunning()
    if (this.current.waveAdmission !== undefined && this.current.waveAdmission !== null) {
      throw new Error('cannot seal a checkpoint while a wave is admitted')
    }
    if ((this.current.discoveryScheduler?.admissions.length ?? 0) !== 0) {
      throw new Error('cannot seal a portable checkpoint while a discovery cohort is admitted')
    }
    const journalHead = this.current.journal.at(-1)?.digest
    if (journalHead === undefined) throw new Error('cannot seal an empty journal')
    const body = {
      schemaVersion: 2 as const,
      experimentId: this.current.experimentId,
      runId: this.current.runId,
      stateGeneration: this.current.stateGeneration,
      rootRunId: this.current.rootRunId,
      rootCreatedAt: this.current.rootCreatedAt,
      modelStartedAt: this.current.modelStartedAt,
      phase: this.current.phase,
      recoveryEpoch: this.current.recoveryEpoch,
      parentCheckpointDigest: this.current.parentCheckpointDigest,
      ...(this.current.failedWaveRecovery === undefined
        ? {} : { failedWaveRecovery: deepClone(this.current.failedWaveRecovery) }),
      ...(this.current.promotedExecutionProofs === undefined
        ? {} : { promotedExecutionProofs: deepClone(this.current.promotedExecutionProofs) }),
      ...(this.current.terminalCompletionRecovery === undefined
        ? {} : { terminalCompletionRecovery: deepClone(this.current.terminalCompletionRecovery) }),
      releaseDigest: this.current.releaseDigest,
      ...(this.current.runtimeRelease === undefined ? {} : { runtimeRelease: deepClone(this.current.runtimeRelease) }),
      ...(this.current.runtimeTransition === undefined ? {} : { runtimeTransition: deepClone(this.current.runtimeTransition) }),
      definitionDigest: this.current.definitionDigest,
      cursor: deepClone(this.current.cursor),
      acceptedArtifacts: deepClone(this.current.artifacts),
      rejectedAttempts: deepClone(this.current.rejectedAttempts),
      stageEndReceipts: deepClone(this.current.stageEndReceipts),
      waveReceipts: deepClone(this.current.waveReceipts),
      ...(this.current.discoveryScheduler === undefined
        ? {} : { discoveryScheduler: deepClone(this.current.discoveryScheduler) }),
      availabilityBoundaries: deepClone(this.current.availabilityBoundaries),
      budget: deepClone(this.current.budget),
      journalHead,
      sealedAt: now,
    }
    const checkpoint: SealedCheckpoint = { digest: await sha256(body), body }
    this.current = await appendEvent({
      ...this.current,
      checkpoints: [...this.current.checkpoints, checkpoint],
    }, 'checkpoint.sealed', { digest: checkpoint.digest, cursor: checkpoint.body.cursor }, now)
    return deepClone(checkpoint)
  }

  async complete(now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    if (normalizeCursor(this.definition, this.current.cursor).stageIndex !== this.definition.stages.length) {
      throw new Error('cannot complete before every stage boundary')
    }
    this.current = await appendEvent({ ...this.current, status: 'completed', phase: 'complete', terminalReason: 'completed' },
      'run.completed', { artifacts: this.current.artifacts.length }, now)
  }

  async stop(reason: string, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    if (reason.trim() === '') throw new TypeError('stop reason is required')
    this.current = await appendEvent({ ...this.current, status: 'stopped', phase: 'stopped', terminalReason: reason },
      'run.stopped', { reason, checkpointDigest: this.current.checkpoints.at(-1)?.digest ?? null }, now)
  }

  async fail(reason: string, now = new Date().toISOString()): Promise<void> {
    if (this.current.status === 'completed') throw new Error('completed run is immutable')
    this.current = await appendEvent({ ...this.current, status: 'failed', terminalReason: reason },
      'run.failed', { reason }, now)
  }

  private assertRunning(): void {
    if (this.current.status !== 'running') throw new Error(`run is not active: ${this.current.status}`)
  }
}
