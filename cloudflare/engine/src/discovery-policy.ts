import { taskAttemptRejections } from './attempt-policy.js'
import { selectedTaskOccurrence, assertNoUnprovenTaskAbandonment, acceptedTaskExecutionId } from './task-occurrences.js'
import { persistedTerminalTaskFailures } from './execution-failures.js'
import type { AvailabilityBoundary, ExperimentDefinition, RunState, StageDefinition, WaveReceipt } from './contracts.js'
import { discoveryDeadline, type DiscoveryWaits } from './discovery-clock.js'
import { discoveryPoolIds } from './manifest-amendment.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { admissionPaused } from './run-control-state.js'
import { remainingRecordedCostUsd, sealedWaveRecordedCostUsd } from './discovery-cost.js'
import { rejectionConsumesRepairAttempt } from './execution-budget.js'

export type DiscoveryPolicyState = Pick<RunState, 'journal' | 'runId' | 'rootCreatedAt' | 'modelStartedAt' | 'stageEndReceipts' | 'artifacts'
  | 'executionAuthority' | 'waveAdmission' | 'rejectedAttempts' | 'waveReceipts' | 'discoveryScheduler' | 'budget' | 'controls' | 'inFlightAgentAttempts'>

export function discoveryReceiptTaskIds(
  state: Pick<RunState, 'artifacts'>, stage: StageDefinition,
  receipt: Pick<WaveReceipt, 'waveId' | 'artifactRefs' | 'taskOccurrences'> & { poolId?: string },
): readonly string[] {
  assertNoUnprovenTaskAbandonment(receipt)
  if (receipt.artifactRefs !== undefined) return [...new Set(receipt.artifactRefs.map(reference => {
    const record = state.artifacts.find(record => record.id === reference.id && record.contentDigest === reference.contentDigest)
    if (record === undefined) throw new Error('historical cohort result membership is missing')
    return record.taskId
  }))]
  const wave = stage.waves.find(candidate => candidate.id === receipt.waveId)
  if (wave === undefined) return []
  return wave.tasks.filter(task => receipt.poolId === undefined
    || configuredResearchTaskPoolId(task) === receipt.poolId).map(task => task.id)
}


export function discoveryCostEstimate(state: DiscoveryPolicyState, stage: StageDefinition, poolId: string): number {
  const receipt = state.waveReceipts.filter(value => value.stageId === stage.id && value.poolId === poolId).at(-1)
  return receipt === undefined ? 0 : sealedWaveRecordedCostUsd(receipt, state.artifacts, state.rejectedAttempts,
    discoveryReceiptTaskIds(state, stage, receipt))
}

/** Reserves the initial cohort before any peer dispatches; repairs reserve nothing (see discoveryRepairAllowed). */
export function discoveryAdmissionAllowed(definition: ExperimentDefinition, state: DiscoveryPolicyState,
  poolId: string, availability: readonly AvailabilityBoundary[], now: number, inheritedWaits: DiscoveryWaits = []): boolean {
  if (persistedTerminalTaskFailures(state).size > 0) return false
  const scheduler = state.discoveryScheduler, stage = definition.stages.find(value => value.id === scheduler?.stageId)
  const progress = scheduler?.pools.find(value => value.poolId === poolId)
  const deadline = discoveryDeadline(definition, state, inheritedWaits)
  if (stage?.kind !== 'discovery' || progress === undefined || !discoveryPoolIds(definition).includes(poolId)
    || !Number.isFinite(now) || !Number.isFinite(deadline) || now >= deadline
    || progress.parked || progress.nextWaveIndex >= stage.waves.length
    || scheduler!.admissions.some(value => value.poolId === poolId) || availability.some(value => value.poolId === poolId)) return false
  const tasks = stage.waves[progress.nextWaveIndex]!.tasks.filter(task => configuredResearchTaskPoolId(task) === poolId)
  if (tasks.length === 0 || admissionPaused(state, stage.id, tasks)) return false
  const reservedCalls = scheduler!.admissions.flatMap(value => value.taskIds)
    .filter(taskId => !state.artifacts.some(artifact => artifact.taskId === taskId)).length
  const estimate = discoveryCostEstimate(state, stage, poolId)
  const reservedCost = scheduler!.admissions.reduce((total, admission) => {
    const unfinished = admission.taskIds.some(id => !state.artifacts.some(record => record.taskId === id
        && acceptedTaskExecutionId(record) === admission.taskOccurrences?.find(value => value.taskId === id)?.taskExecutionId))
    return total + (unfinished ? discoveryCostEstimate(state, stage, admission.poolId) : 0)
  }, 0)
  const paid = tasks.filter(task => task.providerClass !== 'deterministic').length
  return state.budget.modelCalls + reservedCalls + paid <= definition.limits.maxModelCalls
    && (definition.limits.maxInputTokens === undefined || state.budget.inputTokens < definition.limits.maxInputTokens)
    && (definition.limits.maxOutputTokens === undefined || state.budget.outputTokens < definition.limits.maxOutputTokens)
    && state.budget.costUsd < definition.limits.maxCostUsd
    && (estimate <= 0 || remainingRecordedCostUsd(definition.limits.maxCostUsd, state.budget.costUsd) >= reservedCost + estimate)
}

export function discoveryRepairAllowed(definition: ExperimentDefinition, state: DiscoveryPolicyState, taskId: string): boolean {
  for (const admission of state.discoveryScheduler?.admissions ?? []) assertNoUnprovenTaskAbandonment(admission)
  const inFlight = state.inFlightAgentAttempts ?? []
  const spent = (id: string) => taskAttemptRejections(state.rejectedAttempts, id,
    selectedTaskOccurrence(state, id).taskExecutionId).some(rejectionConsumesRepairAttempt)
  if (inFlight.some(value => value.taskId === taskId) || !spent(taskId)) return true
  // maxModelCalls stops new cohorts only (D1): a task of an admitted cohort may still correct its
  // output past it. Its attempt limits bound the correction turns.
  return (state.discoveryScheduler?.admissions ?? []).some(value => value.taskIds.includes(taskId))
}

export interface DiscoveryClosureDecision {
  reason: 'two-distinct-complete-saturation-cohorts' | 'phase-deadline' | 'safety-ceiling-reached' | 'measured-budget-inability'
  evidence: Record<string, unknown>
}

/** Same priority and evidence in live execution and historical verification. */
export function discoveryClosureDecision(definition: ExperimentDefinition, state: DiscoveryPolicyState,
  availability: readonly AvailabilityBoundary[], now: number, inheritedWaits: DiscoveryWaits = []): DiscoveryClosureDecision | null {
  if (persistedTerminalTaskFailures(state).size > 0) return null
  const scheduler = state.discoveryScheduler, stage = definition.stages.find(value => value.id === scheduler?.stageId)
  if (stage?.kind !== 'discovery' || scheduler === undefined || scheduler.admissions.length > 0
    || (state.inFlightAgentAttempts?.length ?? 0) > 0 || !Number.isFinite(now)) return null
  const active = new Set(discoveryPoolIds(definition)), progress = scheduler.pools.filter(value => active.has(value.poolId))
  const available = (poolId: string) => !availability.some(value => value.poolId === poolId)
  if (progress.some(pool => pool.nextWaveIndex < stage.waves.length && (!pool.parked || pool.quietEpoch !== scheduler.materialEpoch)
    && available(pool.poolId) && admissionPaused(state, stage.id, stage.waves[pool.nextWaveIndex]!.tasks
      .filter(task => configuredResearchTaskPoolId(task) === pool.poolId)))) return null
  const runnable = progress.filter(pool => available(pool.poolId) && pool.nextWaveIndex < stage.waves.length)
  if (runnable.length > 0 && runnable.every(pool => pool.parked && pool.quietEpoch === scheduler.materialEpoch)) {
    return { reason: 'two-distinct-complete-saturation-cohorts', evidence: { materialEpoch: scheduler.materialEpoch,
      pools: progress.map(pool => ({ poolId: pool.poolId, quietCohorts: pool.quietCohorts, quietEpoch: pool.quietEpoch, parked: pool.parked })) } }
  }
  const deadline = discoveryDeadline(definition, state, inheritedWaits)
  if (!Number.isFinite(deadline)) return null
  if (now >= deadline) return { reason: 'phase-deadline', evidence: { discoveryDeadline: deadline, materialEpoch: scheduler.materialEpoch } }
  if (progress.every(pool => pool.nextWaveIndex >= stage.waves.length || !available(pool.poolId))) {
    const sealed = new Set(state.waveReceipts.flatMap(receipt => receipt.artifactRefs?.map(ref => ref.id) ?? []))
    const artifacts = state.artifacts.filter(record => sealed.has(record.id) && record.status === 'accepted' && record.protocol.research !== undefined)
    return { reason: 'safety-ceiling-reached', evidence: { configuredWaves: stage.waves.length,
      pools: progress.map(pool => ({ poolId: pool.poolId, completedWaves: pool.nextWaveIndex })),
      artifacts: artifacts.map(artifact => artifact.contentDigest).sort() } }
  }
  const estimates = progress.filter(pool => !pool.parked && pool.nextWaveIndex < stage.waves.length && available(pool.poolId)).map(pool => {
    const wave = stage.waves[pool.nextWaveIndex]!
    return { poolId: pool.poolId, waveId: wave.id,
      modelCalls: wave.tasks.filter(task => configuredResearchTaskPoolId(task) === pool.poolId && task.providerClass !== 'deterministic').length,
      costUsd: discoveryCostEstimate(state, stage, pool.poolId) }
  })
  const remainingCalls = definition.limits.maxModelCalls - state.budget.modelCalls
  const remainingCostUsd = remainingRecordedCostUsd(definition.limits.maxCostUsd, state.budget.costUsd)
  const hardLimit = state.budget.modelCalls >= definition.limits.maxModelCalls || state.budget.costUsd >= definition.limits.maxCostUsd
    || (definition.limits.maxInputTokens !== undefined && state.budget.inputTokens >= definition.limits.maxInputTokens)
    || (definition.limits.maxOutputTokens !== undefined && state.budget.outputTokens >= definition.limits.maxOutputTokens)
  if (hardLimit || (estimates.length > 0 && estimates.every(estimate => estimate.modelCalls > remainingCalls
    || (estimate.costUsd > 0 && estimate.costUsd > remainingCostUsd)))) {
    return { reason: 'measured-budget-inability', evidence: { budget: state.budget, remainingCalls, remainingCostUsd, estimates } }
  }
  return null
}
