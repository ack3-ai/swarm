import { normalizedCostUsd } from './discovery-cost.js'
import type { NativeQuotaWait } from './native-quota-wait.js'
import type {
  ArtifactRecord, BudgetUsage, CheckpointBody, ExperimentDefinition, InFlightAgentAttempt,
  RejectedAttempt, RunState, RuntimeRelease, SealedCheckpoint,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { discoveryDeadline } from './discovery-clock.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { assertStoppedRunRetirementProof, type StoppedRunRetirementProof } from './stopped-run-retirement.js'

/** An operator exception, never an accepted research result or saturation evidence. */
export interface DiscoveryPoolWaiver {
  schemaVersion: 1
  sourceRunId: string
  childRunId: string
  sourceStateGeneration: number
  sourceStateDigest: string
  checkpointDigest: string
  sourceRuntimeRelease: RuntimeRelease
  targetRuntimeRelease: RuntimeRelease
  poolId: string
  admission: InFlightAgentAttempt
  requestDigest: string
  /** Hash of the durable native log snapshot, including completeness/truncation flags. */
  logCustodyDigest: string
  quotaWait: NativeQuotaWait
  fenceProofDigest: string
  acceptedArtifactManifestDigest: string
  sourceBudget: BudgetUsage
  usage: 'unknown'
  discoveryDeadline: number
  decidedAt: string
}

export const waiverManifest = (artifacts: readonly ArtifactRecord[]) => artifacts.map(record => ({
  id: record.id, contentDigest: record.contentDigest, files: record.files,
}))

export function waivedAttempt(evidence: DiscoveryPoolWaiver): RejectedAttempt {
  const { admittedAt: _, ...admission } = evidence.admission
  return { ...admission, repairScopeRunId: evidence.sourceRunId,
    outputDigest: null, quarantineUri: null, includeDiagnosticsInRepair: false,
    operatorWaiver: { sourceRunId: evidence.sourceRunId, poolId: evidence.poolId, fenceProofDigest: evidence.fenceProofDigest },
    diagnostics: ['operator waived unfinished discovery attempt after native fence; usage unknown'],
    usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0,
      cacheAccountingComplete: false, costAccountingComplete: false },
    rejectedAt: evidence.decidedAt }
}

/** Validate the narrow migration. A live source or any other unresolved work is ineligible. */
export async function prepareDiscoveryPoolWaiver(input: {
  definition: ExperimentDefinition
  source: RunState
  childRunId: string
  sourceStateGeneration: number
  sourceStateDigest: string
  checkpoint: SealedCheckpoint
  targetRuntimeRelease: RuntimeRelease
  poolId: string
  requestDigest: string
  logCustodyDigest: string
  quotaWait: NativeQuotaWait
  fence: StoppedRunRetirementProof
}): Promise<DiscoveryPoolWaiver> {
  const { definition, source, checkpoint, fence } = input
  assertStoppedRunRetirementProof(fence)
  assertRuntimeRelease(input.targetRuntimeRelease)
  const stage = definition.stages[source.cursor.stageIndex]
  const attempts = source.inFlightAgentAttempts ?? []
  const attempt = attempts[0]
  const scheduler = source.discoveryScheduler
  const cohort = scheduler?.admissions[0]
  const task = stage?.waves.flatMap(wave => wave.tasks).find(task => task.id === attempt?.taskId)
  const deadline = discoveryDeadline(definition, source)
  if (source.status !== 'stopped' || source.terminalReason !== 'operator-requested-immediate-stop'
    || source.stateGeneration !== input.sourceStateGeneration || await sha256(source) !== input.sourceStateDigest
    || source.recoveryEpoch !== 0 || source.parentRunId !== null || source.failedWaveRecovery !== undefined
    || source.terminalCompletionRecovery !== undefined || source.runtimeTransition !== undefined
    || source.runtimeRelease === undefined || sameRuntimeRelease(source.runtimeRelease, input.targetRuntimeRelease)
    || source.runtimeRelease.id === input.targetRuntimeRelease.id
    || source.runtimeRelease.workerService === input.targetRuntimeRelease.workerService
    || source.runtimeRelease.workflowName === input.targetRuntimeRelease.workflowName
    || source.runtimeRelease.containerImageDigest !== input.targetRuntimeRelease.containerImageDigest
    || source.experimentId !== definition.id || source.definitionDigest !== await sha256(definition)
    || checkpoint.digest !== source.checkpoints.at(-1)?.digest || await sha256(checkpoint.body) !== checkpoint.digest
    || checkpoint.body.runId !== source.runId || checkpoint.body.releaseDigest !== source.releaseDigest
    || source.waveAdmission != null || stage?.kind !== 'discovery' || scheduler?.stageId !== stage.id
    || attempts.length !== 1 || attempt === undefined || task === undefined
    || scheduler.pools.some(pool => pool.nextWaveIndex < 1)
    || scheduler.admissions.length !== 1 || cohort?.poolId !== input.poolId
    || cohort.taskIds.length !== 1 || cohort.taskIds[0] !== attempt.taskId
    || cohort.stageId !== attempt.stageId || cohort.waveId !== attempt.waveId
    || task.backend !== 'claude' || input.quotaWait?.provider !== 'claude'
    || (attempt.sessionId !== null && input.quotaWait.sessionId !== attempt.sessionId)
    || !Number.isFinite(Date.parse(input.quotaWait.resetsAt))
    || (input.quotaWait.startedAt !== null && (!Number.isFinite(Date.parse(input.quotaWait.startedAt))
      || Date.parse(input.quotaWait.startedAt) < Date.parse(attempt.admittedAt)
      || Date.parse(input.quotaWait.startedAt) > Date.parse(source.updatedAt)))
    || Date.parse(input.quotaWait.resetsAt) <= Date.parse(source.updatedAt)
    || task.promptKind !== 'research' || configuredResearchTaskPoolId(task) !== input.poolId
    || task.optional === true || task.providerClass === 'deterministic'
    || source.artifacts.some(record => record.taskId === attempt.taskId)
    || source.rejectedAttempts.some(record => record.taskId === attempt.taskId && record.attempt === attempt.attempt)
    || !Number.isFinite(deadline) || Date.parse(source.updatedAt) < deadline
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(input.childRunId) || input.childRunId === source.runId
    || !/^[a-f0-9]{64}$/.test(input.requestDigest) || !/^[a-f0-9]{64}$/.test(input.logCustodyDigest)) {
    throw new Error('pool waiver requires an exact stopped root discovery run with one unfinished required task after its deadline')
  }
  // No downstream role, quorum, prompt or model may be silently reassigned.
  if (definition.stages.slice(source.cursor.stageIndex + 1).flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks).some(candidate => candidate.modelPool === input.poolId
      || (candidate.backend === task.backend && candidate.model === task.model))) {
    throw new Error('retired pool is required downstream; explicit new contract is necessary')
  }
  const accepted = source.artifacts.filter(record => record.status === 'accepted')
  const acceptedArtifactManifestDigest = await sha256(waiverManifest(accepted))
  if (fence.kind !== 'terminal-stopped-custody' || fence.runId !== source.runId
    || fence.experimentId !== source.experimentId || fence.stateGeneration !== source.stateGeneration
    || fence.stateDigest !== input.sourceStateDigest || fence.checkpointDigest !== checkpoint.digest
    || !sameRuntimeRelease(fence.runtimeRelease, source.runtimeRelease)
    || fence.acceptedArtifactManifestDigest !== acceptedArtifactManifestDigest) {
    throw new Error('pool waiver native fence differs from source state or accepted bytes')
  }
  return { schemaVersion: 1, sourceRunId: source.runId, childRunId: input.childRunId,
    sourceStateGeneration: source.stateGeneration, sourceStateDigest: input.sourceStateDigest,
    checkpointDigest: checkpoint.digest, sourceRuntimeRelease: source.runtimeRelease,
    targetRuntimeRelease: input.targetRuntimeRelease, poolId: input.poolId, admission: attempt,
    requestDigest: input.requestDigest, logCustodyDigest: input.logCustodyDigest, quotaWait: input.quotaWait,
    fenceProofDigest: await sha256(fence), acceptedArtifactManifestDigest,
    sourceBudget: source.budget, usage: 'unknown', discoveryDeadline: deadline, decidedAt: source.updatedAt }
}

/** Checkpoint consumers must retain the exception and its incomplete accounting. */
export async function assertDiscoveryWaiverFrontier(
  definition: ExperimentDefinition,
  body: Pick<CheckpointBody, 'stageEndReceipts' | 'acceptedArtifacts' | 'rejectedAttempts' | 'cursor'
    | 'discoveryScheduler' | 'modelStartedAt' | 'rootCreatedAt'>,
): Promise<void> {
  const receipts = body.stageEndReceipts.filter(receipt => receipt.reason === 'operator-discovery-pool-waiver')
  const waived = body.rejectedAttempts.filter(attempt => attempt.operatorWaiver !== undefined)
  if (receipts.length === 0 && waived.length === 0) return
  if (waived.length !== 1) throw new Error('waiver attempt accounting is missing or duplicated')
  if (receipts.length !== 1) throw new Error('repeated discovery pool waiver')
  const receipt = receipts[0]!
  const e = receipt.evidence as DiscoveryPoolWaiver
  const stageIndex = definition.stages.findIndex(stage => stage.kind === 'discovery')
  const stage = definition.stages[stageIndex]!
  const task = stage.waves.flatMap(wave => wave.tasks).find(task => task.id === e?.admission?.taskId)
  if (e?.schemaVersion !== 1 || e.usage !== 'unknown' || task === undefined
    || task.backend !== 'claude' || e.quotaWait?.provider !== 'claude'
    || (e.admission.sessionId !== null && e.quotaWait.sessionId !== e.admission.sessionId)
    || !['partial', 'complete'].includes(e.quotaWait.waitCapture)
    || (e.quotaWait.waitCapture === 'partial' ? e.quotaWait.startedAt !== null
      : !Number.isFinite(Date.parse(e.quotaWait.startedAt ?? '')))
    || !Number.isFinite(Date.parse(e.quotaWait.resetsAt))
    || Date.parse(e.quotaWait.resetsAt) <= Date.parse(e.decidedAt)
    || [e.quotaWait.rejectionDigest, e.quotaWait.resultDigest, e.quotaWait.waitDigest].some(value => !/^[a-f0-9]{64}$/.test(value))
    || configuredResearchTaskPoolId(task) !== e.poolId || e.admission.stageId !== stage.id
    || !stage.waves.some(wave => wave.id === e.admission.waveId && wave.tasks.includes(task))
    || receipt.stageIndex !== stageIndex || body.cursor.stageIndex <= stageIndex
    || receipt.endedAt !== e.decidedAt || receipt.evidenceDigest !== await sha256(e)
    || e.discoveryDeadline !== discoveryDeadline(definition, { ...body, artifacts: body.acceptedArtifacts })
    || !Number.isFinite(Date.parse(e.decidedAt)) || Date.parse(e.decidedAt) < e.discoveryDeadline
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(e.sourceRunId)
    || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(e.childRunId) || e.childRunId === e.sourceRunId
    || !Number.isSafeInteger(e.sourceStateGeneration) || e.sourceStateGeneration < 1
    || [e.sourceStateDigest, e.checkpointDigest, e.requestDigest, e.logCustodyDigest,
      e.fenceProofDigest, e.acceptedArtifactManifestDigest].some(value => !/^[a-f0-9]{64}$/.test(value))
    || body.discoveryScheduler?.admissions.length !== 0
    || body.acceptedArtifacts.some(record => record.taskId === task.id)
    || !body.rejectedAttempts.some(record => canonicalJson(record) === canonicalJson(waivedAttempt(e)))) {
    throw new Error('discovery pool waiver frontier is invalid')
  }
  assertRuntimeRelease(e.sourceRuntimeRelease)
  assertRuntimeRelease(e.targetRuntimeRelease)
  if (sameRuntimeRelease(e.sourceRuntimeRelease, e.targetRuntimeRelease)
    || e.sourceRuntimeRelease.id === e.targetRuntimeRelease.id
    || e.sourceRuntimeRelease.workerService === e.targetRuntimeRelease.workerService
    || e.sourceRuntimeRelease.workflowName === e.targetRuntimeRelease.workflowName
    || e.sourceRuntimeRelease.containerImageDigest !== e.targetRuntimeRelease.containerImageDigest) {
    throw new Error('discovery pool waiver runtime transition is invalid')
  }
  const progress = body.discoveryScheduler.pools.find(pool => pool.poolId === e.poolId)
  if (progress === undefined || progress.nextWaveIndex !== task.research?.wave
    || body.acceptedArtifacts.some(record => stage.waves.slice(progress.nextWaveIndex)
      .flatMap(wave => wave.tasks).some(task => configuredResearchTaskPoolId(task) === e.poolId && task.id === record.taskId))) {
    throw new Error('retired pool acquired later accepted work')
  }
  const priorUsage = [...body.acceptedArtifacts,
    ...body.rejectedAttempts.filter(record => canonicalJson(record) !== canonicalJson(waivedAttempt(e)))]
    .filter(record => definition.stages.slice(0, stageIndex + 1).some(stage => stage.id === record.stageId))
    .reduce((total, record) => ({ modelCalls: total.modelCalls + record.usage.modelCalls,
      inputTokens: total.inputTokens + record.usage.inputTokens,
      outputTokens: total.outputTokens + record.usage.outputTokens,
      costUsd: normalizedCostUsd(total.costUsd + record.usage.costUsd) }), { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
  if (canonicalJson(priorUsage) !== canonicalJson(e.sourceBudget)) throw new Error('waiver changed historical accounting')
  const priorAccepted = body.acceptedArtifacts.filter(record => record.status === 'accepted'
    && definition.stages.slice(0, stageIndex + 1).some(stage => stage.id === record.stageId))
  if (await sha256(waiverManifest(priorAccepted)) !== e.acceptedArtifactManifestDigest) {
    throw new Error('discovery pool waiver accepted frontier changed')
  }
  if (definition.stages.slice(stageIndex + 1).flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
    .some(candidate => candidate.modelPool === e.poolId || (candidate.backend === task.backend && candidate.model === task.model))) {
    throw new Error('retired pool is required downstream')
  }
}
