import { prepareSealedWaveRetry } from './sealed-wave-retry.js'
import { prepareQuarantinedOutputRepair, type QuarantinedOutputRepairSelection } from './quarantined-output-repair.js'
import { discoveryDeadline as discoveryDeadlineMs } from './discovery-clock.js'
import type {
  AgentRequest,
  AgentResult,
  ArtifactRecord,
  ExperimentDefinition,
  FailedWaveRecoveryEvidence,
  RejectedAttempt,
  RunState,
  RuntimeRelease,
  SealedCheckpoint,
  TaskDefinition,
  StageDefinition,
  WaveDefinition,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { exhaustedFailedWaveTask, rejectionConsumesRepairAttempt, skippedResumeSlotFailureRecorded, terminalReceiptMismatchTask } from './machine.js'
import { exactUnobservableAttempt } from './unobservable-native-recovery.js'
import { composePrompt, selectVisibleArtifacts } from './prompts.js'
import { validateAgentResult } from './protocol-validation.js'
import { namespaceResearchResult, taskPromptDeadline } from './runner.js'
import { agentResultFromExecutionReceipt } from './late-upstream-handoff.js'
import { providerIdentity } from './provider-identity.js'
import { sameRuntimeRelease } from './runtime-release.js'
import { readSubmission } from './submission.js'
import type { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import type { R2AgentExecutionLogStore } from './agent-execution-log.js'
import type { R2ArtifactStore } from './cloudflare-storage.js'
import {
  preparePromotedExecution,
  type PromotedExecutionSelection,
} from './promoted-execution.js'

function recoveryTask(task: TaskDefinition, peerPredecessors: Readonly<Record<string, string>>): TaskDefinition {
  const buildsOn = peerPredecessors[task.id]
  return buildsOn === undefined || task.research === undefined
    ? task : { ...task, research: { ...task.research, buildsOn } }
}

export async function recoveryPromptMatches(
  input: Omit<Parameters<typeof composePrompt>[0], 'diagnostics'>,
  record: ArtifactRecord,
  source: RunState,
): Promise<boolean> {
  if (source.failedWaveRecovery?.importedTaskIds.includes(record.taskId) === true) return true
  const diagnostics = [
    [] as readonly string[],
    ...(source.failedWaveRecovery?.quarantinedRepair?.taskId === record.taskId
      ? [source.failedWaveRecovery.quarantinedRepair.diagnostics] : []),
    ...source.rejectedAttempts.filter(rejection => (
      rejection.stageId === record.stageId && rejection.waveId === record.waveId && rejection.taskId === record.taskId
        && (rejection.outputDigest !== null || rejection.includeDiagnosticsInRepair === true)
    )).map(rejection => rejection.diagnostics),
  ]
  for (const repairDiagnostics of diagnostics) {
    if ((await composePrompt({ ...input, diagnostics: repairDiagnostics })).promptDigest === record.promptDigest) return true
  }
  const correctionAdmissions = source.journal.filter(event => {
    if (event.type !== 'agent.attempt-admitted' || event.payload === null
      || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false
    const payload = event.payload as Record<string, unknown>
    return payload.stageId === record.stageId && payload.waveId === record.waveId
      && payload.taskId === record.taskId && payload.promptDigest === record.promptDigest
      && Number.isSafeInteger(payload.formatRepairOrdinal)
      && typeof payload.formatRepairSourceDigest === 'string'
  })
  if (correctionAdmissions.length === 0 || !source.journal.some(event => {
    if (event.type !== 'agent.attempt-finished' || event.payload === null
      || typeof event.payload !== 'object' || Array.isArray(event.payload)) return false
    const payload = event.payload as Record<string, unknown>
    return payload.stageId === record.stageId && payload.waveId === record.waveId
      && payload.taskId === record.taskId && payload.promptDigest === record.promptDigest
  })) return false
  for (const event of correctionAdmissions) {
    const admitted = event.payload as Record<string, unknown>
    const sourceRejection = source.rejectedAttempts.find(rejection => (
      rejection.stageId === record.stageId && rejection.waveId === record.waveId
      && rejection.taskId === record.taskId
      && rejection.outputDigest === admitted.formatRepairSourceDigest
      && rejection.attempt < (admitted.attempt as number)
      && (rejection.repairScopeRunId ?? source.runId) === source.runId
    ))
    if (sourceRejection !== undefined && (await composePrompt({
      ...input, diagnostics: sourceRejection.diagnostics, formatRepairOnly: true,
    })).promptDigest === record.promptDigest) return true
  }
  return false
}

export async function historicalAcceptedExecutionMatches(input: {
  definition: ExperimentDefinition
  source: RunState
  stage: StageDefinition
  wave: WaveDefinition
  task: TaskDefinition
  record: ArtifactRecord
  visibleArtifacts: readonly ArtifactRecord[]
  inputDigest?: string
  requests: Pick<R2AgentExecutionLogStore, 'listRequests'>
  receipts: Pick<R2AgentExecutionReceiptStore, 'get'>
}): Promise<boolean> {
  const priorAttempts = input.source.rejectedAttempts.filter(rejection => (
    rejection.stageId === input.stage.id && rejection.waveId === input.wave.id
      && rejection.taskId === input.task.id
      && (rejection.repairScopeRunId ?? input.source.runId) === input.source.runId
  ))
  const acceptedAttempt = Math.max(0, ...priorAttempts.filter(rejectionConsumesRepairAttempt)
    .map(rejection => rejection.attempt)) + 1
  const candidates = (await input.requests.listRequests(input.source.runId, input.task.id)).filter(request => (
    request.runId === input.source.runId && request.stageId === input.stage.id
      && request.waveId === input.wave.id && request.taskId === input.task.id
      && request.promptDigest === input.record.promptDigest
      && request.attempt === acceptedAttempt
      && request.model === input.record.model && request.provider === input.record.provider
      && request.provider === providerIdentity(input.task)
  ))
  const admissions = input.source.journal.filter(event => {
    if (event.type !== 'agent.attempt-admitted' || event.payload === null
      || typeof event.payload !== 'object') return false
    const payload = event.payload as Record<string, unknown>
    return payload.stageId === input.stage.id && payload.waveId === input.wave.id
      && payload.taskId === input.task.id && payload.attempt === acceptedAttempt
      && payload.promptDigest === input.record.promptDigest
  })
  if (admissions.length !== 1) return false
  const finishes = input.source.journal.filter(event => {
    if (event.type !== 'agent.attempt-finished' || event.payload === null
      || typeof event.payload !== 'object') return false
    const payload = event.payload as Record<string, unknown>
    return payload.stageId === input.stage.id && payload.waveId === input.wave.id
      && payload.taskId === input.task.id && payload.promptDigest === input.record.promptDigest
  })
  let matches = 0
  for (const logged of candidates) {
    if (await sha256(logged.prompt) !== logged.promptDigest
      || Date.parse(logged.startedAt) < Date.parse(admissions[0]!.at)
      || !finishes.some(event => Date.parse(logged.startedAt) <= Date.parse(event.at))) continue
    const receipt = await input.receipts.get(input.source.runId, logged.requestDigest)
    if (receipt === null || receipt.requestDigest !== logged.requestDigest) continue
    const request: AgentRequest = {
      experimentId: input.definition.id, runId: input.source.runId,
      stage: input.stage, wave: input.wave, task: input.task,
      prompt: logged.prompt, promptDigest: logged.promptDigest,
      visibleArtifacts: input.visibleArtifacts,
      ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
      releaseDigest: input.source.releaseDigest, attempt: logged.attempt,
      diagnostics: [], repairFiles: {}, freshContext: false,
      continuationMode: 'new', sessionId: null,
    }
    let result: AgentResult
    try { result = await agentResultFromExecutionReceipt(request, receipt, logged.requestDigest, true) }
    catch { continue }
    const usage = {
      modelCalls: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd,
      ...(result.subscriptionWaits === undefined ? {} : { subscriptionWaits: result.subscriptionWaits }),
      ...(result.rawInputTokens === undefined ? {} : { rawInputTokens: result.rawInputTokens }),
      ...(result.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.cachedInputTokens }),
      ...(result.cacheAccountingComplete === undefined ? {} : { cacheAccountingComplete: result.cacheAccountingComplete }),
      ...(result.costAccountingComplete === undefined ? {} : { costAccountingComplete: result.costAccountingComplete }),
    }
    if (result.status === 'accepted' && result.actorId === input.record.actorId
      && await sha256(canonicalJson(result.files)) === input.record.contentDigest
      && canonicalJson(usage) === canonicalJson(input.record.usage)) matches += 1
  }
  if (matches > 1) throw new Error(`historical accepted execution is ambiguous: ${input.task.id}`)
  return matches === 1
}

async function prepareIndependentDiscoveryRecovery(input: {
  definition: ExperimentDefinition
  checkpoint: SealedCheckpoint
  source: RunState
  sourceStateGeneration: number
  sourceStateDigest: string
  targetRuntimeRelease: RuntimeRelease
  artifacts: AcceptedArtifactReader
  unobservableNative?: FailedWaveRecoveryEvidence['unobservableNative']
  promoteExecution?: PromotedExecutionSelection
  executionReceipts?: Pick<R2AgentExecutionReceiptStore, 'get'>
  executionRequests?: Pick<R2AgentExecutionLogStore, 'getRequest'> & Partial<Pick<R2AgentExecutionLogStore, 'listRequests'>>
  quarantined?: Pick<R2ArtifactStore, 'readRejected'>
}): Promise<PreparedFailedWaveRecovery> {
  const { definition, checkpoint, source } = input
  const scheduler = source.discoveryScheduler!
  const stage = definition.stages.find(candidate => candidate.id === scheduler.stageId)
  if (stage?.kind !== 'discovery' || scheduler.admissions.length === 0) {
    throw new Error('failed-wave recovery source has no active discovery cohort')
  }
  const checkpointTasks = new Set(checkpoint.body.acceptedArtifacts.map(artifact => artifact.taskId))
  const importedArtifacts = source.artifacts.filter(artifact => !checkpointTasks.has(artifact.taskId))
  if (importedArtifacts.length === 0) throw new Error('failed-wave recovery has no accepted peer to import')
  const activeTasks = scheduler.admissions.flatMap(admission => admission.taskIds.map(taskId => ({ admission, taskId })))
  const acceptedTaskIds = new Set(source.artifacts.map(artifact => artifact.taskId))
  const missing = activeTasks.filter(({ taskId }) => !acceptedTaskIds.has(taskId))
  const lost = input.unobservableNative
  if (lost !== undefined && (!exactUnobservableAttempt(source, lost)
    || !missing.some(({ taskId }) => taskId === lost.taskId)
    || missing.length !== 1 || input.promoteExecution !== undefined)) {
    throw new Error('unobservable native recovery is not the sole missing admitted task')
  }
  let promotedExecution: FailedWaveRecoveryEvidence['promotedExecution']
  if (input.promoteExecution !== undefined) {
    if (input.executionReceipts === undefined || input.executionRequests === undefined
      || !missing.some(({ taskId }) => taskId === input.promoteExecution?.taskId)) {
      throw new Error('promoted execution does not match a missing recovery task')
    }
    promotedExecution = await preparePromotedExecution({
      definition,
      source,
      selection: input.promoteExecution,
      receipts: input.executionReceipts,
      requests: input.executionRequests,
      ...(input.quarantined === undefined ? {} : { quarantined: input.quarantined }),
    })
  }
  if (missing.length === 0 || missing.some(({ admission, taskId }) => {
    const task = stage.waves[admission.waveIndex]?.tasks.find(candidate => candidate.id === taskId)
    const rejections = source.rejectedAttempts.filter(rejection => rejection.taskId === taskId
      && rejection.stageId === stage.id && rejection.waveId === admission.waveId
      && (rejection.repairScopeRunId ?? source.runId) === source.runId)
    return task === undefined || (lost?.taskId !== taskId && !exhaustedFailedWaveTask(
      task, rejections,
      promotedExecution?.taskId === taskId ? promotedExecution.sourceAttempt : undefined,
      skippedResumeSlotFailureRecorded(source, taskId),
    ) && !(input.promoteExecution === undefined && lost === undefined
      && terminalReceiptMismatchTask(source, task, rejections)))
  })) {
    throw new Error('failed-wave recovery requires exhausted attempts or an exact terminal receipt mismatch')
  }
  for (const record of importedArtifacts) {
    if (record.status !== 'accepted') continue
    const waveIndex = stage.waves.findIndex(candidate => candidate.id === record.waveId)
    const wave = stage.waves[waveIndex]
    const baseTask = wave?.tasks.find(candidate => candidate.id === record.taskId)
    const admission = scheduler.admissions.find(candidate => candidate.taskIds.includes(record.taskId))
    const receipt = source.waveReceipts.find(candidate => candidate.artifactRefs?.some(reference => (
      reference.id === record.id && reference.contentDigest === record.contentDigest
    )) === true)
    const snapshotRefs = admission?.inputArtifacts ?? receipt?.inputArtifacts
    const predecessors = admission?.peerPredecessors ?? receipt?.peerPredecessors
    if (wave === undefined || baseTask === undefined || snapshotRefs === undefined || predecessors === undefined) {
      throw new Error(`failed-wave recovery artifact lacks frozen discovery provenance: ${record.taskId}`)
    }
    const task = recoveryTask(baseTask, predecessors)
    const visibleArtifacts = snapshotRefs.map(reference => source.artifacts.find(artifact => (
      artifact.id === reference.id && artifact.contentDigest === reference.contentDigest
    )))
    if (visibleArtifacts.some(artifact => artifact === undefined)) {
      throw new Error(`failed-wave recovery artifact snapshot is incomplete: ${record.taskId}`)
    }
    const files = await input.artifacts.read(record)
    const storedResult = resultFromArtifact(record, files)
    const validationResult = { ...storedResult, protocol: (await readSubmission(
      task, files, visibleArtifacts as readonly ArtifactRecord[],
    )).protocol }
    const issues = await validateAgentResult(task, validationResult, visibleArtifacts as readonly ArtifactRecord[])
    if (issues.length > 0) throw new Error(`failed-wave recovery artifact failed protocol validation: ${record.taskId}`)
    if (canonicalJson(namespaceResearchResult(task, validationResult).protocol) !== canonicalJson(record.protocol)) {
      throw new Error(`failed-wave recovery artifact has invalid namespaced protocol: ${record.taskId}`)
    }
    if (input.promoteExecution?.quarantineOutputDigest !== undefined) {
      if (input.executionRequests?.listRequests === undefined || input.executionReceipts === undefined
        || !await historicalAcceptedExecutionMatches({
          definition, source, stage, wave, task, record,
          visibleArtifacts: visibleArtifacts as readonly ArtifactRecord[],
          ...(admission?.inputDigest === undefined ? {} : { inputDigest: admission.inputDigest }),
          requests: input.executionRequests as Pick<R2AgentExecutionLogStore, 'listRequests'>,
          receipts: input.executionReceipts,
        })) throw new Error(`failed-wave recovery historical artifact custody is invalid: ${record.taskId}`)
    } else {
      const deadline = taskPromptDeadline(definition, source, stage, wave)
      if (!await recoveryPromptMatches({
        definition, runId: source.runId, stage, wave, task,
        visibleArtifacts: visibleArtifacts as readonly ArtifactRecord[],
        releaseDigest: source.releaseDigest, deadline,
      }, record, source)) throw new Error(`failed-wave recovery artifact prompt binding is invalid: ${record.taskId}`)
    }
  }
  const checkpointRejections = new Set(checkpoint.body.rejectedAttempts.map(value => canonicalJson(value)))
  const inheritedRejectedAttempts = source.rejectedAttempts.filter(rejection => !checkpointRejections.has(canonicalJson(rejection)))
    .map(rejection => ({ ...rejection, repairScopeRunId: rejection.repairScopeRunId ?? source.runId }))
  return {
    importedArtifacts,
    inheritedRejectedAttempts,
    evidence: {
      sourceRunId: source.runId,
      sourceStateGeneration: input.sourceStateGeneration,
      sourceStateDigest: input.sourceStateDigest,
      checkpointDigest: checkpoint.digest,
      importedTaskIds: importedArtifacts.map(artifact => artifact.taskId).toSorted(),
      inheritedRejectedAttemptCount: inheritedRejectedAttempts.length,
      unknownUsageAttemptCount: inheritedRejectedAttempts.filter(usageWasNotObserved).length
        + (lost === undefined ? 0 : 1),
      sourceRuntimeRelease: source.runtimeRelease!,
      targetRuntimeRelease: input.targetRuntimeRelease,
      ...(promotedExecution === undefined ? {} : { promotedExecution }),
      ...(lost === undefined ? {} : { unobservableNative: lost }),
    },
  }
}

interface AcceptedArtifactReader {
  read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>>
}

export interface PreparedFailedWaveRecovery {
  importedArtifacts: readonly ArtifactRecord[]
  inheritedRejectedAttempts: readonly RejectedAttempt[]
  evidence: FailedWaveRecoveryEvidence
}

function resultFromArtifact(record: ArtifactRecord, files: Readonly<Record<string, string>>): AgentResult {
  if (record.usage.modelCalls !== 0 && record.usage.modelCalls !== 1) {
    throw new Error(`failed-wave recovery artifact has invalid model-call usage: ${record.taskId}`)
  }
  return {
    status: record.status,
    actorId: record.actorId,
    model: record.model,
    provider: record.provider,
    files,
    assertions: record.assertions,
    protocol: record.protocol,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    costUsd: record.usage.costUsd,
    modelCalls: record.usage.modelCalls,
    ...(record.usage.subscriptionWaits === undefined ? {} : { subscriptionWaits: record.usage.subscriptionWaits }),
    ...(record.usage.rawInputTokens === undefined ? {} : { rawInputTokens: record.usage.rawInputTokens }),
    ...(record.usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: record.usage.cachedInputTokens }),
    ...(record.usage.cacheAccountingComplete === undefined
      ? {} : { cacheAccountingComplete: record.usage.cacheAccountingComplete }),
    ...(record.usage.costAccountingComplete === undefined
      ? {} : { costAccountingComplete: record.usage.costAccountingComplete }),
    ...(record.unavailableReason === undefined ? {} : { unavailableReason: record.unavailableReason }),
  }
}

function usageWasNotObserved(rejection: RejectedAttempt): boolean {
  return rejection.outputDigest === null
    && rejection.usage.inputTokens === 0
    && rejection.usage.outputTokens === 0
    && rejection.usage.costUsd === 0
}

export async function prepareFailedWaveRecovery(input: {
  definition: ExperimentDefinition
  checkpoint: SealedCheckpoint
  source: RunState
  sourceStateGeneration: number
  sourceStateDigest: string
  targetRuntimeRelease: RuntimeRelease
  artifacts: AcceptedArtifactReader
  unobservableNative?: FailedWaveRecoveryEvidence['unobservableNative']
  promoteExecution?: PromotedExecutionSelection
  retainNative?: { taskId: string, requestDigest: string, snapshotDigest: string, sandboxObjectId: string }
  repairQuarantined?: QuarantinedOutputRepairSelection
  retirementProofDigest?: string | undefined
  executionReceipts?: Pick<R2AgentExecutionReceiptStore, 'get'>
  executionRequests?: Pick<R2AgentExecutionLogStore, 'getRequest'> & Partial<Pick<R2AgentExecutionLogStore, 'listRequests'>>
  quarantined?: Pick<R2ArtifactStore, 'readRejected'>
}): Promise<PreparedFailedWaveRecovery> {
  const { definition, checkpoint, source } = input
  const independentDiscovery = source.discoveryScheduler !== undefined
    && source.discoveryScheduler.admissions.length > 0
  if (source.status !== 'failed' || source.stateGeneration !== input.sourceStateGeneration
    || await sha256(checkpoint.body) !== checkpoint.digest
    || (!source.checkpoints.some(candidate => candidate.digest === checkpoint.digest)
      && source.parentCheckpointDigest !== checkpoint.digest)
    || await sha256(source) !== input.sourceStateDigest || source.runtimeRelease === undefined
    || sameRuntimeRelease(source.runtimeRelease, input.targetRuntimeRelease)
    || source.cursor.stageIndex !== checkpoint.body.cursor.stageIndex
    || source.cursor.waveIndex !== checkpoint.body.cursor.waveIndex
    || (!independentDiscovery && (source.waveAdmission === undefined || source.waveAdmission === null))
    || ((source.inFlightAgentAttempts ?? []).length !== 0
      && (input.unobservableNative === undefined
        || !exactUnobservableAttempt(source, input.unobservableNative)))) {
    throw new Error('failed-wave recovery source is not an exact terminal partial wave')
  }
  if (input.retainNative !== undefined && independentDiscovery) {
    throw new Error('retained native recovery requires a terminal non-discovery wave')
  }
  if (input.unobservableNative !== undefined && !independentDiscovery) {
    throw new Error('unobservable native recovery requires an independent discovery cohort')
  }
  let reviewRepair: FailedWaveRecoveryEvidence['quarantinedRepair']
  if (input.repairQuarantined !== undefined) {
    const isReview = definition.stages[source.cursor.stageIndex]?.kind === 'negative-review'
    if (independentDiscovery || input.promoteExecution !== undefined || input.retainNative !== undefined
      || input.unobservableNative !== undefined || input.executionRequests === undefined
      || input.executionReceipts === undefined || input.quarantined === undefined
      || (!isReview && canonicalJson(source.artifacts) !== canonicalJson(checkpoint.body.acceptedArtifacts))
      || (isReview && source.runtimeRelease.containerImageDigest === input.targetRuntimeRelease.containerImageDigest)) {
      throw new Error('quarantined synthesis repair requires an unchanged sealed accepted frontier')
    }
    const quarantinedRepair = await prepareQuarantinedOutputRepair({
      definition, source, selection: input.repairQuarantined, artifacts: input.artifacts,
      requests: input.executionRequests, receipts: input.executionReceipts, quarantined: input.quarantined,
    })
    if (isReview) reviewRepair = quarantinedRepair
    else {
      const inheritedRejectedAttempts = source.rejectedAttempts.filter(value => (
        value.stageId === quarantinedRepair.stageId && value.waveId === quarantinedRepair.waveId
      )).map(value => ({ ...value, repairScopeRunId: value.repairScopeRunId ?? source.runId }))
      return {
        importedArtifacts: [], inheritedRejectedAttempts,
        evidence: {
          sourceRunId: source.runId, sourceStateGeneration: source.stateGeneration,
          sourceStateDigest: input.sourceStateDigest, checkpointDigest: checkpoint.digest,
          importedTaskIds: [], inheritedRejectedAttemptCount: inheritedRejectedAttempts.length,
          unknownUsageAttemptCount: source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0,
          priorUnknownUsageAttemptCount: source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0,
          sourceRuntimeRelease: source.runtimeRelease,
          targetRuntimeRelease: input.targetRuntimeRelease, quarantinedRepair,
        },
      }
    }
  }
  if (independentDiscovery) return prepareIndependentDiscoveryRecovery(input)
  const stage = definition.stages[source.cursor.stageIndex]
  const wave = stage?.waves[source.cursor.waveIndex]
  if (stage === undefined || wave === undefined
    || source.waveAdmission!.stageId !== stage.id || source.waveAdmission!.waveId !== wave.id) {
    throw new Error('failed-wave recovery source cursor is invalid')
  }
  const importedArtifacts = source.artifacts.filter(artifact => (
    artifact.stageId === stage.id && artifact.waveId === wave.id
  ))
  const sealedWaveRetry = importedArtifacts.length === 0 && reviewRepair === undefined
    && input.promoteExecution === undefined && input.retainNative === undefined && input.unobservableNative === undefined
    && input.repairQuarantined === undefined
    ? await prepareSealedWaveRetry(input) : undefined
  if (importedArtifacts.length === 0 && sealedWaveRetry === undefined) {
    throw new Error('failed-wave recovery has no accepted peer to import')
  }
  const importedTaskIds = new Set(importedArtifacts.map(artifact => artifact.taskId))
  const missingTasks = wave.tasks.filter(task => !importedTaskIds.has(task.id))
  let retainedNative: FailedWaveRecoveryEvidence['retainedNative']
  if (input.retainNative !== undefined) {
    const selection = input.retainNative
    const task = missingTasks.length === 1 ? missingTasks[0] : undefined
    const rejections = source.rejectedAttempts.filter(rejection => rejection.stageId === stage.id
      && rejection.waveId === wave.id && rejection.taskId === selection.taskId
      && (rejection.repairScopeRunId ?? source.runId) === source.runId)
      .toSorted((left, right) => left.attempt - right.attempt)
    const latest = rejections.at(-1)
    const native = latest?.nativeTransport
    if (input.promoteExecution !== undefined || task?.id !== selection.taskId
      || !/^[0-9a-f]{64}$/.test(selection.sandboxObjectId)
      || source.failedWaveRecovery?.retainedNative?.taskId === selection.taskId
      || task.providerClass !== 'additive' || task.backend !== 'dsh-chat-completions'
      || task.workspaceMode === 'continuation' || rejections.length !== 2
      || latest?.attempt !== 2 || latest.outputDigest !== null || latest.quarantineUri !== null
      || native?.code !== 'SERVER' || native.workState !== 'present'
      || native.sourceRunId !== source.runId || native.sessionId !== latest.sessionId
      || native.requestDigest !== selection.requestDigest
      || native.snapshotDigest !== selection.snapshotDigest
      || source.runtimeRelease?.id !== input.targetRuntimeRelease.id
      || source.runtimeRelease.workerService !== input.targetRuntimeRelease.workerService
      || source.runtimeRelease.workflowName !== input.targetRuntimeRelease.workflowName
      || source.runtimeRelease.containerImageDigest !== input.targetRuntimeRelease.containerImageDigest) {
      throw new Error('retained native recovery selection or runtime identity is invalid')
    }
    retainedNative = { stageId: stage.id, waveId: wave.id, taskId: task.id,
      workspaceKey: task.workspaceKey, workspaceAllocationRunId: source.runId,
      sandboxObjectId: selection.sandboxObjectId,
      nativeTransport: native }
  }
  let promotedExecution: FailedWaveRecoveryEvidence['promotedExecution']
  if (input.promoteExecution !== undefined) {
    if (input.executionReceipts === undefined || input.executionRequests === undefined
      || !missingTasks.some(task => task.id === input.promoteExecution?.taskId)) {
      throw new Error('promoted execution does not match a missing recovery task')
    }
    const discoveryDeadline = discoveryDeadlineMs(definition, source)
    if (!Number.isFinite(discoveryDeadline) || Date.now() < discoveryDeadline) {
      throw new Error('legacy promoted execution requires an expired discovery phase')
    }
    promotedExecution = await preparePromotedExecution({
      definition,
      source,
      selection: input.promoteExecution,
      receipts: input.executionReceipts,
      requests: input.executionRequests,
      ...(input.quarantined === undefined ? {} : { quarantined: input.quarantined }),
    })
  }
  if (reviewRepair === undefined && sealedWaveRetry === undefined && (missingTasks.length === 0 || missingTasks.some(task => {
    const rejections = source.rejectedAttempts.filter(rejection => (
      rejection.stageId === stage.id && rejection.waveId === wave.id && rejection.taskId === task.id
        && (rejection.repairScopeRunId ?? source.runId) === source.runId
    ))
    const attemptLimit = task.retryPolicy === 'none' ? 1
      : task.retryPolicy === 'redirect-then-fresh-replacement' ? 3 : 2
    return task.providerClass === 'deterministic' || rejections.length !== attemptLimit
      || rejections.map(rejection => rejection.attempt).toSorted((left, right) => left - right)
        .some((attempt, index) => attempt !== index + 1)
      || ((promotedExecution?.taskId !== task.id || promotedExecution.sourceAttempt !== attemptLimit)
        && rejections.some(rejection => rejection.outputDigest !== null || rejection.quarantineUri !== null
          || rejection.includeDiagnosticsInRepair === true))
  }))) {
    throw new Error('failed-wave recovery is limited to missing tasks with exhausted no-output attempts')
  }
  for (const record of importedArtifacts) {
    const task = wave.tasks.find(candidate => candidate.id === record.taskId)
    if (task === undefined || record.status !== 'accepted') {
      throw new Error(`failed-wave recovery artifact is not an accepted current-wave task: ${record.taskId}`)
    }
    const visibleArtifacts = selectVisibleArtifacts(
      task, source.artifacts, source.waveReceipts, source.cursor.stageIndex, source.cursor.waveIndex, definition,
    )
    const files = await input.artifacts.read(record)
    const storedResult = resultFromArtifact(record, files)
    const validationResult = task.promptKind === 'research'
      ? { ...storedResult, protocol: (await readSubmission(task, files, visibleArtifacts)).protocol }
      : storedResult
    const issues = await validateAgentResult(task, validationResult, visibleArtifacts)
    if (issues.length > 0) throw new Error(`failed-wave recovery artifact failed protocol validation: ${record.taskId}`)
    if (task.promptKind === 'research'
      && canonicalJson(namespaceResearchResult(task, validationResult).protocol) !== canonicalJson(record.protocol)) {
      throw new Error(`failed-wave recovery artifact has invalid namespaced protocol: ${record.taskId}`)
    }
    const deadline = taskPromptDeadline(definition, source, stage, wave)
    if (!await recoveryPromptMatches({
      definition, runId: source.runId, stage, wave, task, visibleArtifacts,
      releaseDigest: source.releaseDigest, deadline,
    }, record, source)) {
      throw new Error(`failed-wave recovery artifact prompt binding is invalid: ${record.taskId}`)
    }
  }
  const inheritedRejectedAttempts = source.rejectedAttempts.filter(rejection => (
    rejection.stageId === stage.id && rejection.waveId === wave.id
  )).map(rejection => ({ ...rejection, repairScopeRunId: rejection.repairScopeRunId ?? source.runId }))
  return {
    importedArtifacts,
    inheritedRejectedAttempts,
    evidence: {
      sourceRunId: source.runId,
      sourceStateGeneration: input.sourceStateGeneration,
      sourceStateDigest: input.sourceStateDigest,
      checkpointDigest: checkpoint.digest,
      importedTaskIds: importedArtifacts.map(artifact => artifact.taskId).toSorted(),
      inheritedRejectedAttemptCount: inheritedRejectedAttempts.length,
      unknownUsageAttemptCount: sealedWaveRetry === undefined
        ? inheritedRejectedAttempts.filter(usageWasNotObserved).length
          + (reviewRepair === undefined ? 0 : source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0)
        : inheritedRejectedAttempts.filter(value => value.repairScopeRunId === source.runId && usageWasNotObserved(value)).length
          + (source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0),
      ...(sealedWaveRetry === undefined ? {} : { sealedWaveRetry,
        priorUnknownUsageAttemptCount: source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0 }),
      ...(reviewRepair === undefined ? {} : { quarantinedRepair: reviewRepair,
        priorUnknownUsageAttemptCount: source.failedWaveRecovery?.unknownUsageAttemptCount ?? 0 }),
      sourceRuntimeRelease: source.runtimeRelease,
      targetRuntimeRelease: input.targetRuntimeRelease,
      ...(promotedExecution === undefined ? {} : { promotedExecution }),
      ...(retainedNative === undefined ? {} : { retainedNative }),
    },
  }
}
