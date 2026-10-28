import type {
  AgentProvider,
  AgentRequest,
  ArtifactRecord,
  ArtifactStore,
  DiscoveryCohortAdmission,
  ExperimentDefinition,
  ProviderUsage,
  RunState,
  SealedCheckpoint,
  StageDefinition,
  TaskDefinition,
  WaveDefinition,
  WaveReceipt,
} from './contracts.js'
import { providerIdentity, taskBackend } from './provider-identity.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { namespaceResearchResult } from './research-result-namespace.js'
export { namespaceResearchResult } from './research-result-namespace.js'
import { formatRepairLimit, formatRepairOrdinalForAttempt, rejectionConsumesRepairAttempt, retryAttemptLimit,
  retryAttemptMode, RunMachine } from './machine.js'
import { retainedTransportForAttempt } from './native-session-custody.js'
import { canonicalJson, sha256 } from './canonical.js'
import { mandatorySearchRequirement, validateDismissalResearch } from './native-research.js'
import { composePrompt, selectSealedArtifacts, selectVisibleArtifacts } from './prompts.js'
import { validateAgentResultDetailed } from './protocol-validation.js'
import { remainingRecordedCostUsd, sealedWaveRecordedCostUsd } from './discovery-cost.js'
import {
  AgentAttemptFailure,
  AgentExecutionPending,
  isTransientRunFailure,
  observedAgentAttemptUsage,
  PermanentRunFailure,
  UnobservableAgentExecution,
  RunFailure,
  type RunFailureCategory,
  TransientRunFailure,
} from './run-errors.js'

export interface StageEndDecision {
  reason: 'two-distinct-complete-saturation-cohorts' | 'phase-deadline' | 'insufficient-time-for-full-wave' | 'measured-budget-inability'
  evidence: unknown
}

export interface RunPolicy {
  beforeWave(input: {
    definition: ExperimentDefinition
    state: RunState
    stage: StageDefinition
    wave: WaveDefinition
  }): Promise<StageEndDecision | null>
  afterWave(input: {
    definition: ExperimentDefinition
    state: RunState
    stage: StageDefinition
    wave: WaveDefinition
  }): Promise<StageEndDecision | null>
  assessCompletion(input: { definition: ExperimentDefinition, state: RunState }): readonly string[]
}

function sealedArtifacts(state: RunState): readonly ArtifactRecord[] {
  return selectSealedArtifacts(state.artifacts, state.waveReceipts)
}

export function createAudit0RunPolicy(_now: () => number = Date.now): RunPolicy {
  return {
  async beforeWave() { return null },
  async afterWave() { return null },
  assessCompletion({ definition, state }) {
    const issues: string[] = []
    const accepted = sealedArtifacts(state).filter(artifact => artifact.status === 'accepted')
    const discovery = definition.stages.find(stage => stage.kind === 'discovery')
    const acceptedDiscoveryWaves = new Set(accepted.filter(artifact => artifact.stageId === discovery?.id).map(artifact => artifact.waveId))
    if (!acceptedDiscoveryWaves.has('wave-0')) issues.push('wave 0 is missing')
    const discoveryStop = state.stageEndReceipts.find(receipt => (
      receipt.stageIndex === definition.stages.findIndex(stage => stage.kind === 'discovery')
    ))
    if (discoveryStop === undefined) issues.push('discovery lacks a deterministic stop receipt')
    for (const stage of definition.stages.filter(value => value.kind !== 'discovery')) {
      for (const wave of stage.waves) {
        for (const task of wave.tasks.filter(value => value.optional !== true)) {
          if (!accepted.some(artifact => artifact.taskId === task.id)) issues.push(`required task is missing: ${task.id}`)
        }
      }
    }
    if (definition.stages.some(stage => stage.kind === 'reporting')) {
      const final = accepted.find(artifact => artifact.taskId === 'seal-final')
      if (final === undefined || !final.files.includes('finding.md')) issues.push('deterministically sealed finding.md is missing')
    }
    const crossed = Math.min(state.cursor.stageIndex, definition.stages.length)
    if (state.stageEndReceipts.length !== crossed) issues.push('phase transition receipt chain is incomplete')
    return issues
    },
  }
}

export const audit0RunPolicy: RunPolicy = createAudit0RunPolicy()

interface RejectedAttemptDraft {
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  formatRepairOrdinal?: number
  formatRepairSourceDigest?: string
  promptDigest: string
  outputDigest: string | null
  quarantineUri: string | null
  diagnostics: readonly string[]
  freshContext: boolean
  continuationMode: 'new' | 'resume'
  sessionId: string | null
  nativeTransport?: import('./contracts.js').NativeTransportEvidence
  nativeTerminalCustody?: import('./contracts.js').NativeTerminalCustodyEvidence
  usage: ProviderUsage
}

interface TaskSuccess {
  kind: 'accepted'
  taskIndex: number
  attempt: number
  promptDigest: string
  result: Awaited<ReturnType<AgentProvider['run']>>
  rejections: readonly RejectedAttemptDraft[]
}

interface TaskRetryRequired {
  kind: 'retry-required'
  taskIndex: number
  attempt: number
  promptDigest: string
  rejections: readonly RejectedAttemptDraft[]
}

type TaskProgress = TaskSuccess | TaskRetryRequired

class TaskRunFailure extends RunFailure {
  constructor(
    message: string,
    readonly rejections: readonly RejectedAttemptDraft[],
    classification = new PermanentRunFailure(message, 'agent-repair-exhausted'),
  ) {
    super(message, classification.category, classification.retryable, { cause: classification })
    this.name = 'TaskRunFailure'
  }
}

function additivePlatformInterruption(error: unknown): 'platform-interruption' | null {
  const message = error instanceof Error ? error.message : String(error)
  return /^Sandbox operation (?:sandbox\.[A-Za-z]+|commands\.execute) was interrupted while (?:the platform was updating the sandbox runtime|the runtime connection was closing)$/.test(message)
    ? 'platform-interruption'
    : null
}

export function taskPromptDeadline(
  definition: ExperimentDefinition,
  state: RunState,
  stage: StageDefinition,
  wave: WaveDefinition,
): string {
  const startedAt = new Date(state.modelStartedAt ?? state.rootCreatedAt).getTime()
  const discoveryDeadline = startedAt + definition.limits.phaseMinutes.discovery * 60_000
  const stageIndex = definition.stages.indexOf(stage)
  const waveIndex = stage.waves.indexOf(wave)
  const previousBoundary = waveIndex > 0
    ? state.waveReceipts.find(receipt => (
      receipt.stageId === stage.id && receipt.waveId === stage.waves[waveIndex - 1]?.id
    ))?.completedAt
    : state.stageEndReceipts.find(receipt => receipt.stageIndex === stageIndex - 1)?.endedAt
  const previousBoundaryMs = Date.parse(previousBoundary ?? state.rootCreatedAt)
  const runCreatedAtMs = Date.parse(state.createdAt)
  if (!Number.isFinite(previousBoundaryMs) || !Number.isFinite(runCreatedAtMs)) {
    throw new Error('wave admission clock is invalid')
  }
  const waveAdmittedAt = Math.max(previousBoundaryMs, runCreatedAtMs)
  return stage.kind === 'discovery'
    ? new Date(discoveryDeadline).toISOString()
    : new Date(waveAdmittedAt + definition.limits.maxWallTimeMs).toISOString()
}

async function runTask(input: {
  definition: ExperimentDefinition
  state: RunState
  stage: StageDefinition
  wave: WaveDefinition
  taskIndex: number
  task?: WaveDefinition['tasks'][number]
  visibleArtifacts?: readonly ArtifactRecord[]
  inputDigest?: string
  provider: AgentProvider
  artifactStore: ArtifactStore
  admitProviderCall: (task: WaveDefinition['tasks'][number], request: AgentRequest) => Promise<void>
}): Promise<TaskProgress> {
  const task = input.task ?? input.wave.tasks[input.taskIndex]
  if (task === undefined) throw new Error('task alignment failed')
  const visibleArtifacts = input.visibleArtifacts ?? selectVisibleArtifacts(
    task,
    input.state.artifacts,
    input.state.waveReceipts,
    input.state.cursor.stageIndex,
    input.state.cursor.waveIndex,
    input.definition,
  )
  let diagnostics: readonly string[] = []
  let repairFiles: Readonly<Record<string, string>> = {}
  let lastError: unknown = null
  let continuationSessionId: string | null = null
  const rejections: RejectedAttemptDraft[] = []
  // This remains advisory prompt context. Process lifetime is governed by its
  // terminal state, explicit stop, or a classified permanent failure.
  const promptDeadline = taskPromptDeadline(input.definition, input.state, input.stage, input.wave)
  const attemptLimit = retryAttemptLimit(task)
  const previousRejections = input.state.rejectedAttempts.filter(rejection => (
    rejection.stageId === input.stage.id && rejection.waveId === input.wave.id && rejection.taskId === task.id
      && (rejection.repairScopeRunId ?? input.state.runId) === input.state.runId
  ))
  const retainedNative = input.state.failedWaveRecovery?.retainedNative
  const retainedWorkspace = retainedNative?.stageId === input.stage.id
    && retainedNative.waveId === input.wave.id && retainedNative.taskId === task.id
    && retainedNative.workspaceKey === task.workspaceKey ? retainedNative : undefined
  const consumedAttempts = previousRejections.filter(rejectionConsumesRepairAttempt)
  const lastConsumed = consumedAttempts.toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const interruptedAttempt = previousRejections.filter(rejection => (
    rejection.outputDigest === null && rejection.usage.modelCalls === 0
      && rejection.attempt > (lastConsumed?.attempt ?? 0)
  )).toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const firstAttempt = interruptedAttempt?.attempt ?? ((lastConsumed?.attempt ?? 0) + 1)
  let formatRepairOrdinal: number | undefined
  try { formatRepairOrdinal = formatRepairOrdinalForAttempt(task, firstAttempt, previousRejections) } catch (error) {
    throw new TaskRunFailure(`${task.id}: ${error instanceof Error ? error.message : String(error)}`, [],
      new PermanentRunFailure(`${task.id}: output correction cannot continue`, 'agent-repair-exhausted', { cause: error }))
  }
  if (formatRepairOrdinal === undefined && firstAttempt > attemptLimit) {
    throw new TaskRunFailure(`${task.id}: configured repair attempts are exhausted`, [],
      new PermanentRunFailure(`${task.id}: configured repair attempts are exhausted`, 'agent-repair-exhausted'))
  }
  const latestOutput = previousRejections.filter(rejection => rejection.outputDigest !== null)
    .toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const repairSource = formatRepairOrdinal === undefined ? lastConsumed : latestOutput
  if (repairSource !== undefined) {
    diagnostics = repairSource.outputDigest !== null || repairSource.includeDiagnosticsInRepair === true
      ? repairSource.diagnostics
      : []
    if (repairSource.outputDigest !== null && repairSource.quarantineUri !== null) {
      repairFiles = await input.artifactStore.readRejected(
        repairSource.quarantineUri, repairSource.outputDigest, repairSource.taskId,
      )
    }
  }
  continuationSessionId = interruptedAttempt?.sessionId ?? lastConsumed?.sessionId ?? null
  if (retainedWorkspace !== undefined && previousRejections.length === 0 && firstAttempt === 1) {
    continuationSessionId = retainedWorkspace.nativeTransport.sessionId
  }
  if (formatRepairOrdinal !== undefined && (continuationSessionId === null
    || continuationSessionId !== latestOutput?.sessionId)) {
    throw new TaskRunFailure(`${task.id}: output correction session custody is unavailable`, [],
      new PermanentRunFailure(`${task.id}: output correction session custody is unavailable`, 'agent-repair-exhausted'))
  }
  let lastRequest: AgentRequest | null = null
  for (let attempt = firstAttempt; attempt <= (formatRepairOrdinal === undefined ? attemptLimit : firstAttempt); attempt += 1) {
    const nativeTransport = retainedWorkspace !== undefined && attempt === 1 && previousRejections.length === 0
      ? retainedWorkspace.nativeTransport : retainedTransportForAttempt(task, attempt, previousRejections)
    const { continuationMode, freshContext } = retainedWorkspace !== undefined
      && attempt === 1 && previousRejections.length === 0
      ? { continuationMode: 'resume' as const, freshContext: false }
      : retryAttemptMode(task, attempt, continuationSessionId !== null,
        nativeTransport !== undefined && nativeTransport.workState !== 'none', formatRepairOrdinal)
    if (continuationMode === 'resume' && continuationSessionId === null) {
      continue
    }
    const requestSessionId = continuationMode === 'resume' ? continuationSessionId : null
    const { prompt, promptDigest: composedPromptDigest } = await composePrompt({
      definition: input.definition,
      runId: input.state.runId,
      stage: input.stage,
      wave: input.wave,
      task,
      visibleArtifacts,
      releaseDigest: input.state.releaseDigest,
      deadline: promptDeadline,
      diagnostics,
      ...(formatRepairOrdinal === undefined ? {} : { formatRepairOnly: true }),
    })
    // Reusing an exact historical execution also reuses its original prompt
    // binding, including any repair diagnostics from the source attempt.
    const promoted = input.state.failedWaveRecovery?.promotedExecution
    let promptDigest = promoted?.stageId === input.stage.id && promoted.waveId === input.wave.id
      && promoted.taskId === task.id && promoted.releaseDigest === input.state.releaseDigest
      ? promoted.promptDigest : composedPromptDigest
    const taskProvider = providerIdentity(task)
    const taskPoolId = task.promptKind === 'research' ? configuredResearchTaskPoolId(task) : undefined
    const additiveBoundary = input.state.availabilityBoundaries.find(value => (
      taskPoolId === undefined ? value.provider === taskProvider
        : value.poolId === taskPoolId || (value.poolId === undefined && value.provider === taskProvider)
    ))
    const discoveryWave = input.stage.kind === 'discovery' ? Number(input.wave.id.replace(/^wave-/, '')) : Number.MAX_SAFE_INTEGER
    if (task.providerClass === 'additive' && task.optional === true && additiveBoundary !== undefined
      && discoveryWave >= additiveBoundary.effectiveFromWave) {
      return {
        kind: 'accepted',
        taskIndex: input.taskIndex,
        attempt,
        promptDigest,
        rejections,
        result: {
          status: 'additive-unavailable', actorId: `additive-boundary-${input.state.runId}`,
          model: task.model, provider: taskProvider, files: {}, assertions: [], protocol: {},
          inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0,
          unavailableReason: 'discovery-boundary',
        },
      }
    }
    const nativeSearch = input.definition.nativeSearch
    if (nativeSearch?.enabled === true && task.providerClass === 'additive'
      && taskBackend(task) !== 'codex' && nativeSearch.searchConnection === undefined) {
      throw new TaskRunFailure(`${task.id}: native DSH search connection is unavailable`, [],
        new PermanentRunFailure(`${task.id}: native DSH search connection is unavailable`, 'invalid-configuration'))
    }
    const agentRequest: AgentRequest = {
      experimentId: input.definition.id,
      runId: input.state.runId,
      stage: input.stage,
      wave: input.wave,
      task,
      prompt,
      promptDigest,
      visibleArtifacts,
      ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
      releaseDigest: input.state.releaseDigest,
      attempt,
      ...(formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal }),
      ...(formatRepairOrdinal === undefined ? {} : { formatRepairSourceDigest: latestOutput!.outputDigest! }),
      diagnostics,
      repairFiles,
      freshContext,
      continuationMode,
      sessionId: requestSessionId,
      ...(nativeSearch?.enabled !== true ? {}
        : task.providerClass === 'core' ? { enableNativeSearch: true,
          ...(nativeSearch.searchConnection?.provider === 'exa' ? { nativeSearchConnection: nativeSearch.searchConnection } : {}) }
          : task.providerClass === 'additive' && taskBackend(task) !== 'codex'
            && nativeSearch.searchConnection !== undefined
            ? { nativeSearchConnection: nativeSearch.searchConnection } : {}),
      ...(nativeTransport === undefined ? {} : { nativeTransport }),
      ...(retainedWorkspace === undefined ? {} : {
        workspaceAllocationRunId: retainedWorkspace.workspaceAllocationRunId,
        retainedSandboxObjectId: retainedWorkspace.sandboxObjectId,
      }),
    }
    {
      try {
        await input.admitProviderCall(task, agentRequest)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const classification = error instanceof RunFailure
          ? error
          : new PermanentRunFailure(message, 'budget-exhausted', { cause: error })
        throw new TaskRunFailure(message, rejections, classification)
      }
    }
    try {
      lastRequest = agentRequest
      const rawResult = await input.provider.run(agentRequest)
      const validation = await validateAgentResultDetailed(task, rawResult, visibleArtifacts)
      const searchRequirement = mandatorySearchRequirement(input.definition, task, input.stage.kind)
      if (searchRequirement !== undefined && rawResult.status === 'accepted') {
        const researchIssues = validateDismissalResearch(rawResult, [...previousRejections, ...rejections], searchRequirement)
        validation.issues.push(...researchIssues)
        validation.repairable.push(...researchIssues)
      }
      diagnostics = validation.issues
      const returnedSessionId = rawResult.sessionId ?? rawResult.actorId
      const changedRepairSession = formatRepairOrdinal !== undefined && returnedSessionId !== requestSessionId
      if (changedRepairSession) diagnostics = [...diagnostics, 'output correction returned a different session']
      if (continuationMode === 'resume' && task.providerClass === 'core'
        && (rawResult.sessionId ?? rawResult.actorId) !== requestSessionId) {
        diagnostics = [...diagnostics, 'same-session repair returned a different native session']
      }
      continuationSessionId = returnedSessionId
      if (diagnostics.length === 0) {
        if (task.workspaceMode !== 'continuation'
          && (task.providerClass !== 'deterministic' || task.promptKind === 'preflight')) {
          try {
            await input.provider.disposeWorkspace?.({
              runId: retainedWorkspace?.workspaceAllocationRunId ?? input.state.runId,
              workspaceKey: task.workspaceKey,
            })
          } catch (error) {
            throw new TaskRunFailure(`workspace disposal failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`, rejections)
          }
        }
        return {
          kind: 'accepted', taskIndex: input.taskIndex, attempt, promptDigest,
          result: namespaceResearchResult(task, rawResult), rejections,
        }
      }
      const outputContent = canonicalJson(rawResult.files)
      const outputDigest = await sha256(outputContent)
      const quarantineUri = await input.artifactStore.putRejected({
        id: `${input.stage.id}/${input.wave.id}/${task.id}/attempt-${attempt}/${outputDigest.slice(0, 16)}`,
        taskId: task.id,
        contentDigest: outputDigest,
      }, outputContent)
      rejections.push({
        stageId: input.stage.id,
        waveId: input.wave.id,
        taskId: task.id,
        attempt,
        ...(formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal }),
        ...(formatRepairOrdinal === undefined ? {} : { formatRepairSourceDigest: latestOutput!.outputDigest! }),
        promptDigest,
        outputDigest,
        quarantineUri,
        diagnostics,
        freshContext,
        continuationMode,
        sessionId: continuationSessionId,
        ...(rawResult.nativeSearchEvidence === undefined ? {} : { nativeSearchEvidence: rawResult.nativeSearchEvidence }),
        usage: {
          modelCalls: task.providerClass === 'deterministic' ? 0 : 1,
          inputTokens: rawResult.inputTokens,
          ...(rawResult.rawInputTokens === undefined ? {} : { rawInputTokens: rawResult.rawInputTokens }),
          ...(rawResult.cachedInputTokens === undefined ? {} : { cachedInputTokens: rawResult.cachedInputTokens }),
          ...(rawResult.cacheAccountingComplete === undefined
            ? {}
            : { cacheAccountingComplete: rawResult.cacheAccountingComplete }),
          ...(rawResult.costAccountingComplete === undefined
            ? {} : { costAccountingComplete: rawResult.costAccountingComplete }),
          outputTokens: rawResult.outputTokens,
          costUsd: rawResult.costUsd,
        },
      })
      repairFiles = rawResult.files
      lastError = new Error(diagnostics.join('; '))
      if (validation.integrity.length > 0 || task.providerClass === 'deterministic'
        || rawResult.status !== 'accepted') {
        throw new TaskRunFailure(`${task.id}: output or result integrity failed`, rejections,
          new PermanentRunFailure(`${task.id}: output or result integrity failed`, 'integrity-failed', { cause: lastError }))
      }
      if (changedRepairSession) {
        throw new TaskRunFailure(`${task.id}: output correction session changed`, rejections,
          new PermanentRunFailure(`${task.id}: output correction session changed`, 'integrity-failed'))
      }
      if (formatRepairOrdinal === undefined || formatRepairOrdinal < formatRepairLimit) {
        return { kind: 'retry-required', taskIndex: input.taskIndex, attempt, promptDigest, rejections }
      }
    } catch (error) {
      if (error instanceof TaskRunFailure) throw error
      if (error instanceof AgentExecutionPending) throw error
      // A bounded observation incident does not prove native termination.
      // Keep this admission in flight, with unknown usage and its workspace
      // intact, while the Workflow becomes explicitly failed.
      if (error instanceof UnobservableAgentExecution) {
        throw new TaskRunFailure(`${task.id}: ${error.message}`, rejections, error)
      }
      const unavailableReason = task.providerClass === 'additive' && task.optional === true
        ? additivePlatformInterruption(error)
        : null
      if (unavailableReason !== null) {
        return {
          kind: 'accepted',
          taskIndex: input.taskIndex,
          attempt,
          promptDigest,
          rejections,
          result: {
            status: 'additive-unavailable',
            actorId: `deepseek-${unavailableReason}-${input.state.runId}-${task.id}`,
            model: task.model,
            provider: providerIdentity(task),
            files: {},
            assertions: [],
            protocol: {},
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            modelCalls: 1,
            unavailableReason,
          },
        }
      }
      if (isTransientRunFailure(error)) {
        throw new AgentExecutionPending(`${task.id}:attempt-${attempt}`, 'unavailable', { cause: error })
      }
      lastError = error
      const failureDiagnostics = [error instanceof Error ? error.message : String(error)]
      diagnostics = failureDiagnostics
      const failedUsage = observedAgentAttemptUsage(error)
      rejections.push({
        stageId: input.stage.id,
        waveId: input.wave.id,
        taskId: task.id,
        attempt,
        ...(formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal }),
        ...(formatRepairOrdinal === undefined ? {} : { formatRepairSourceDigest: latestOutput!.outputDigest! }),
        promptDigest,
        outputDigest: null,
        quarantineUri: null,
        diagnostics: failureDiagnostics,
        ...(error instanceof AgentAttemptFailure && error.includeDiagnosticsInRepair
          ? { includeDiagnosticsInRepair: true }
          : {}),
        freshContext,
        continuationMode,
        sessionId: error instanceof AgentAttemptFailure
          ? error.nativeTerminalCustody?.sessionId ?? error.nativeTransport?.sessionId ?? requestSessionId : requestSessionId,
        ...(error instanceof AgentAttemptFailure && error.nativeTransport !== undefined
          ? { nativeTransport: error.nativeTransport } : {}),
        ...(error instanceof AgentAttemptFailure && error.nativeTerminalCustody !== undefined
          ? { nativeTerminalCustody: error.nativeTerminalCustody } : {}),
        usage: failedUsage ?? {
          modelCalls: error instanceof RunFailure || task.providerClass === 'deterministic' ? 0 : 1,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        },
      })
      // Infrastructure retries and permanent preflight/configuration failures
      // are supervisor decisions. They never consume an agent repair attempt,
      // and a Workflow retry cannot grant a new repair allowance.
      if (error instanceof RunFailure) {
        throw new TaskRunFailure(`${task.id}: ${error.message}`, rejections, error)
      }
      if (error instanceof AgentAttemptFailure && error.nativeTerminalCustody !== undefined) {
        throw new TaskRunFailure(`${task.id}: ${error.message}`, rejections,
          new PermanentRunFailure(`${task.id}: provider rejected native request after terminal custody`, 'provider-rejected', { cause: error }))
      }
      const priorCorrectionTransport = formatRepairOrdinal === undefined ? 0 : previousRejections.filter(rejection => (
        rejection.formatRepairOrdinal === formatRepairOrdinal && rejection.outputDigest === null
          && rejection.usage.modelCalls > 0
      )).length
      if (formatRepairOrdinal !== undefined
        ? priorCorrectionTransport + 1 < retryAttemptLimit(task) : attempt < attemptLimit) {
        return { kind: 'retry-required', taskIndex: input.taskIndex, attempt, promptDigest, rejections }
      }
    }
  }
  const retainedNativeWork = task.providerClass === 'additive'
    && rejections.some(rejection => rejection.sessionId !== null
      && (rejection.nativeTransport?.workState !== undefined && rejection.nativeTransport.workState !== 'none'
        || rejection.nativeTerminalCustody?.workState !== undefined && rejection.nativeTerminalCustody.workState !== 'none'))
  if (lastRequest !== null && task.workspaceMode !== 'continuation' && !retainedNativeWork
    && retainedWorkspace === undefined
    && latestOutput === undefined && !rejections.some(rejection => rejection.outputDigest !== null)) {
    await input.provider.disposeWorkspace?.({ runId: input.state.runId, workspaceKey: task.workspaceKey })
  }
  const message = formatRepairOrdinal === formatRepairLimit && rejections.some(rejection => rejection.outputDigest !== null)
    ? `output correction exhausted after ${formatRepairLimit} turns`
    : lastError instanceof Error ? lastError.message : String(lastError)
  throw new TaskRunFailure(`${task.id}: ${message}`, rejections,
    new PermanentRunFailure(`${task.id}: ${message}`, 'agent-repair-exhausted', { cause: lastError }))
}

async function disposeDiscoveryLanes(provider: AgentProvider, state: RunState, stage: StageDefinition) {
  const workspaceKeys = [...new Set(stage.waves.flatMap(wave => wave.tasks)
    .filter(task => task.workspaceMode === 'continuation')
    .map(task => task.workspaceKey))].toSorted()
  if (provider.disposeWorkspace === undefined) return { mode: 'not-applicable' as const, workspaceKeys }
  const receipts = await Promise.all(workspaceKeys.map(async workspaceKey => ({
    workspaceKey,
    receipt: await provider.disposeWorkspace!({
      runId: state.failedWaveRecovery?.retainedNative?.workspaceKey === workspaceKey
        ? state.failedWaveRecovery.retainedNative.workspaceAllocationRunId : state.runId,
      workspaceKey,
    }),
  })))
  const deferred = receipts.filter(value => value.receipt?.status === 'deferred').map(value => value.workspaceKey)
  return deferred.length === 0
    ? { mode: 'provider-verified' as const, workspaceKeys }
    : { mode: 'provider-deferred' as const, workspaceKeys, deferred }
}

export async function disposeTerminalWorkspaces(
  provider: AgentProvider,
  definition: ExperimentDefinition,
  state: RunState,
  options: { forceOwnedWorkspaces?: boolean,
    workspaceAllocationForOwner?: (workspaceKey: string) => Promise<string | null> } = {},
) {
  if (state.status === 'running') throw new Error('terminal workspace disposal requires a terminal run')
  const activeWorkspaceKeys = new Set((state.inFlightAgentAttempts ?? []).flatMap(admission => {
    const task = definition.stages.find(stage => stage.id === admission.stageId)?.waves
      .find(wave => wave.id === admission.waveId)?.tasks.find(candidate => candidate.id === admission.taskId)
    return task === undefined ? [] : [task.workspaceKey]
  }))
  // Preflight owns a Sandbox while its deterministic command runs, but does
  // not reserve a model-call attempt. A direct stop can fence that command
  // before it emits an artifact, so the admitted wave is its durable owner.
  const admitted = state.waveAdmission
  if (admitted !== undefined && admitted !== null) {
    const wave = definition.stages.find(stage => stage.id === admitted.stageId)?.waves
      .find(candidate => candidate.id === admitted.waveId)
    for (const task of wave?.tasks ?? []) {
      if (task.promptKind === 'preflight' && !state.artifacts.some(artifact =>
        artifact.stageId === admitted.stageId && artifact.waveId === admitted.waveId
        && artifact.taskId === task.id && artifact.status === 'accepted')) {
        activeWorkspaceKeys.add(task.workspaceKey)
      }
    }
  }
  const retainedWorkspaceKeys = new Set<string>()
  const evidencedWorkspaceKeys = new Set<string>()
  for (const stage of definition.stages) {
    for (const wave of stage.waves) {
      for (const task of wave.tasks) {
        const hasEvidence = state.artifacts.some(artifact => artifact.stageId === stage.id
          && artifact.waveId === wave.id && artifact.taskId === task.id)
          || state.rejectedAttempts.some(rejection => rejection.stageId === stage.id
            && rejection.waveId === wave.id && rejection.taskId === task.id)
        if (hasEvidence) evidencedWorkspaceKeys.add(task.workspaceKey)
        if (state.status === 'failed' && task.providerClass === 'additive'
          && !state.artifacts.some(artifact => artifact.stageId === stage.id
            && artifact.waveId === wave.id && artifact.taskId === task.id && artifact.status === 'accepted')
          && state.rejectedAttempts.some(rejection => rejection.stageId === stage.id
            && rejection.waveId === wave.id && rejection.taskId === task.id
            && rejection.sessionId !== null
            && (rejection.nativeTransport?.workState !== undefined && rejection.nativeTransport.workState !== 'none'
              || rejection.nativeTerminalCustody?.workState !== undefined && rejection.nativeTerminalCustody.workState !== 'none'))) {
          retainedWorkspaceKeys.add(task.workspaceKey)
        }
      }
    }
  }
  const forceOwned = options.forceOwnedWorkspaces === true
  const candidates = [...new Set([
    ...evidencedWorkspaceKeys,
    ...(forceOwned ? [...activeWorkspaceKeys, ...retainedWorkspaceKeys] : []),
  ])].filter(value => forceOwned || !activeWorkspaceKeys.has(value) && !retainedWorkspaceKeys.has(value)).toSorted()
  const claimed = new Set<string>()
  const allocation = new Map<string, string>()
  await Promise.all(candidates.map(async workspaceKey => {
    const imported = state.failedWaveRecovery?.retainedNative?.workspaceKey === workspaceKey
      ? state.failedWaveRecovery.retainedNative.workspaceAllocationRunId : null
    const owner = options.workspaceAllocationForOwner === undefined
      ? imported === null ? state.runId : null
      : await options.workspaceAllocationForOwner(workspaceKey)
    if (owner === null) claimed.add(workspaceKey)
    else allocation.set(workspaceKey, owner)
  }))
  const workspaceKeys = candidates.filter(value => !claimed.has(value))
  const reportedRetained = forceOwned ? [...claimed] : [...new Set([...retainedWorkspaceKeys, ...claimed])]
  if (provider.disposeWorkspace === undefined) {
    return { mode: 'not-applicable' as const, workspaceKeys,
      activeWorkspaceKeys: [...activeWorkspaceKeys].toSorted(),
      retainedWorkspaceKeys: reportedRetained.toSorted() }
  }
  const settled = await Promise.allSettled(workspaceKeys.map(async workspaceKey => ({
    workspaceKey,
    receipt: await provider.disposeWorkspace!({
      runId: allocation.get(workspaceKey)!,
      workspaceKey,
    }),
  })))
  return {
    mode: 'provider-attempted' as const,
    workspaceKeys,
    activeWorkspaceKeys: [...activeWorkspaceKeys].toSorted(),
    retainedWorkspaceKeys: reportedRetained.toSorted(),
    deferred: settled.flatMap((result, index) => result.status === 'fulfilled'
      && result.value.receipt?.status !== 'deferred' ? [] : [workspaceKeys[index]!]),
  }
}

function discoveryResearchArtifacts(state: RunState): readonly ArtifactRecord[] {
  return sealedArtifacts(state).filter(artifact => (
    artifact.status === 'accepted' && artifact.protocol.research !== undefined
  ))
}

function discoveryReceiptTaskIds(
  stage: StageDefinition,
  receipt: Pick<WaveReceipt, 'waveId'> & { poolId?: string },
): readonly string[] {
  const wave = stage.waves.find(candidate => candidate.id === receipt.waveId)
  if (wave === undefined) return []
  return wave.tasks.filter(task => receipt.poolId === undefined
    || configuredResearchTaskPoolId(task) === receipt.poolId).map(task => task.id)
}

function peerPredecessors(
  stage: StageDefinition,
  wave: WaveDefinition,
  poolId: string,
  frontier: readonly ArtifactRecord[],
): Readonly<Record<string, string>> {
  const poolArtifacts = frontier.filter(artifact => {
    const task = stage.waves.flatMap(candidate => candidate.tasks).find(candidate => candidate.id === artifact.taskId)
    return task !== undefined && configuredResearchTaskPoolId(task) === poolId
  })
  const available = poolArtifacts.flatMap(artifact => {
    const match = artifact.taskId.match(/-wave-(\d+)-research-(\d+)$/)
    return match === null ? [] : [{ wave: Number(match[1]), lane: Number(match[2]) }]
  }).toSorted((left, right) => right.wave - left.wave || left.lane - right.lane)
  return Object.fromEntries(wave.tasks.filter(task => configuredResearchTaskPoolId(task) === poolId).map(task => {
    const assignment = task.research
    if (assignment === undefined || assignment.buildsOn === 'none') return [task.id, 'none']
    const requested = assignment.buildsOn.match(/^wave-(\d+)\/research-(\d+)$/)
    const exact = requested === null ? undefined : available.find(candidate => (
      candidate.wave === Number(requested[1]) && candidate.lane === Number(requested[2])
    ))
    const predecessor = exact ?? available.find(candidate => candidate.lane === assignment.researcher) ?? available[0]
    return [task.id, predecessor === undefined ? 'none' : `wave-${predecessor.wave}/research-${predecessor.lane}`]
  }))
}

function admittedTask(
  task: TaskDefinition,
  admission: DiscoveryCohortAdmission,
): TaskDefinition {
  const buildsOn = admission.peerPredecessors[task.id]
  return buildsOn === undefined || task.research === undefined
    ? task
    : { ...task, research: { ...task.research, buildsOn } }
}

function frozenAdmissionArtifacts(state: RunState, admission: DiscoveryCohortAdmission): readonly ArtifactRecord[] {
  const byId = new Map(state.artifacts.map(artifact => [artifact.id, artifact]))
  const artifacts = admission.inputArtifacts.map(reference => byId.get(reference.id))
  if (artifacts.some((artifact, index) => artifact === undefined
    || artifact.contentDigest !== admission.inputArtifacts[index]?.contentDigest)) {
    throw new PermanentRunFailure(`discovery input snapshot is incomplete: ${admission.poolId}/${admission.waveId}`, 'integrity-failed')
  }
  return artifacts as readonly ArtifactRecord[]
}

interface DiscoveryCohortPoll {
  admission: DiscoveryCohortAdmission
  wave: WaveDefinition
  tasks: readonly TaskDefinition[]
  taskIndexes: readonly number[]
  attempts: readonly PromiseSettledResult<TaskProgress>[]
  savedFailures: readonly RunFailure[]
}

const failureCategories = new Set<RunFailureCategory>([
  'transport', 'invalid-configuration', 'missing-credentials', 'provider-rejected', 'budget-exhausted', 'preflight-failed',
  'agent-repair-exhausted', 'resource-exhausted', 'integrity-failed', 'completion-contract-failed',
  'persisted-run-failed', 'session-recovery-unavailable',
])

function persistedTerminalTaskFailures(state: RunState): ReadonlyMap<string, RunFailure> {
  const failures = new Map<string, RunFailure>()
  for (const event of state.journal) {
    if (event.type !== 'task.failed' || event.payload === null || typeof event.payload !== 'object') continue
    const payload = event.payload as { taskId?: unknown, error?: unknown, category?: unknown, retryable?: unknown }
    if (typeof payload.taskId !== 'string' || typeof payload.error !== 'string' || payload.retryable !== false
      || typeof payload.category !== 'string' || !failureCategories.has(payload.category as RunFailureCategory)
      || payload.category === 'transport') continue
    failures.set(payload.taskId, new PermanentRunFailure(
      payload.error, payload.category as Exclude<RunFailureCategory, 'transport'>,
    ))
  }
  return failures
}

function hasHealthyUnresolvedDiscoveryWork(state: RunState): boolean {
  const terminal = persistedTerminalTaskFailures(state)
  return state.discoveryScheduler?.admissions.some(admission => admission.taskIds.some(taskId => (
    !terminal.has(taskId) && !state.artifacts.some(artifact => artifact.taskId === taskId)
  ))) === true
}

async function processDiscoveryCohortPoll(input: {
  poll: DiscoveryCohortPoll
  machine: RunMachine
  artifactStore: ArtifactStore
  coalesceMaterialDelta?: boolean
}): Promise<{ status: 'completed' | 'pending', materialDelta: boolean }> {
  const { poll, machine, artifactStore } = input
  const failures: unknown[] = [...poll.savedFailures]
  let pending = false
  for (let resultIndex = 0; resultIndex < poll.attempts.length; resultIndex += 1) {
    const attempt = poll.attempts[resultIndex]
    const task = poll.tasks[resultIndex]
    if (attempt === undefined || task === undefined) throw new Error('discovery cohort result alignment failed')
    if (attempt.status === 'rejected') {
      if (attempt.reason instanceof AgentExecutionPending) {
        pending = true
        continue
      }
      if (attempt.reason instanceof TaskRunFailure) {
        for (const rejection of attempt.reason.rejections) {
          try {
            await machine.recordRejectedAttempt(rejection)
            await machine.clearAgentAttempt(rejection.stageId, rejection.waveId, rejection.taskId, rejection.promptDigest)
          } catch (error) { failures.push(error) }
        }
      }
      await machine.recordFailure(task, attempt.reason)
      failures.push(attempt.reason)
      continue
    }
    for (const rejection of attempt.value.rejections) {
      try {
        await machine.recordRejectedAttempt(rejection)
        await machine.clearAgentAttempt(rejection.stageId, rejection.waveId, rejection.taskId, rejection.promptDigest)
      } catch (error) { failures.push(error) }
    }
    if (attempt.value.kind === 'retry-required') {
      pending = true
      continue
    }
    try {
      await machine.recordResult({
        wave: poll.wave,
        task,
        promptDigest: attempt.value.promptDigest,
        result: attempt.value.result,
        artifactStore,
        stageId: poll.admission.stageId,
      })
      await machine.clearAgentAttempt(
        poll.admission.stageId, poll.admission.waveId, task.id, attempt.value.promptDigest,
      )
    } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) {
    const permanent = failures.find(candidate => candidate instanceof RunFailure && !candidate.retryable)
    if (permanent !== undefined && pending) return { status: 'pending', materialDelta: false }
    if (permanent !== undefined) throw permanent
    const failure = failures[0]
    if (pending) throw new AgentExecutionPending('discovery-cohort-terminal-evidence-pending', 'unfinished', { cause: failure })
    throw failure instanceof Error ? failure : new Error(String(failure))
  }
  if (pending) return { status: 'pending', materialDelta: false }
  const materialDelta = await machine.recordDiscoveryCohortReceipt(
    poll.admission.stageId, poll.wave, poll.admission.poolId, input.coalesceMaterialDelta,
  )
  return { status: 'completed', materialDelta }
}

export async function runIndependentDiscoveryTick(input: {
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  onStatePersist?: (state: RunState) => Promise<void>
  stopRequested?: () => Promise<boolean>
}): Promise<SealedCheckpoint | null> {
  const { definition, machine, provider, artifactStore } = input
  await machine.start()
  let state = machine.snapshot()
  const stageIndex = state.cursor.stageIndex
  const stage = definition.stages[stageIndex]
  if (stage?.kind !== 'discovery') throw new Error('independent discovery tick requires the discovery cursor')
  await machine.initializeDiscoveryScheduler(stage.id)
  if (state.discoveryScheduler === undefined) await input.onStatePersist?.(machine.snapshot())

  let mutationQueue = Promise.resolve()
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(operation)
    mutationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }
  const admitProviderCall = async (task: TaskDefinition, request: AgentRequest): Promise<void> => {
    if (task.providerClass === 'deterministic') return
    await mutate(async () => {
      const current = machine.snapshot()
      const inFlight = current.inFlightAgentAttempts ?? []
      const spentReservation = (taskId: string) => current.rejectedAttempts.some(rejection => (
        rejection.taskId === taskId && (rejection.repairScopeRunId ?? current.runId) === current.runId
          && rejectionConsumesRepairAttempt(rejection)
      ))
      const existing = inFlight.some(attempt => attempt.taskId === task.id)
      if (!existing && spentReservation(task.id)) {
        const reservedCalls = current.discoveryScheduler!.admissions.flatMap(admission => admission.taskIds)
          .filter(taskId => !current.artifacts.some(artifact => artifact.taskId === taskId)
            && (inFlight.some(attempt => attempt.taskId === taskId) || !spentReservation(taskId))).length
        if (current.budget.modelCalls + reservedCalls + 1 > definition.limits.maxModelCalls) {
          throw new PermanentRunFailure(`model-call budget admission denied for ${task.id}`, 'budget-exhausted')
        }
      }
      // The durable cohort admission reserves every paid task atomically.
      // Once admitted, every peer drains even if another pool records usage
      // before this task starts. A new repair needs a separate call reservation.
      await machine.admitAgentAttempt({
        stageId: stage.id,
        waveId: request.wave.id,
        taskId: task.id,
        attempt: request.attempt,
        ...(request.formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal: request.formatRepairOrdinal }),
        ...(request.formatRepairSourceDigest === undefined ? {} : { formatRepairSourceDigest: request.formatRepairSourceDigest }),
        promptDigest: request.promptDigest,
        freshContext: request.freshContext,
        continuationMode: request.continuationMode,
        sessionId: request.sessionId,
      })
      try {
        await input.onStatePersist?.(machine.snapshot())
      } catch (error) {
        throw new TransientRunFailure(`agent attempt admission persistence failed for ${task.id}`, { cause: error })
      }
    })
  }
  const executions = new Map<string, Promise<DiscoveryCohortPoll>>()
  const ready = new Map<string, DiscoveryCohortPoll>()
  let admissionsClosed = false
  const launch = (admission: DiscoveryCohortAdmission) => {
    const wave = stage.waves[admission.waveIndex]
    if (wave === undefined) throw new Error(`discovery admission wave is missing: ${admission.waveId}`)
    const visibleArtifacts = frozenAdmissionArtifacts(machine.snapshot(), admission)
    const snapshot = machine.snapshot()
    const terminalFailures = persistedTerminalTaskFailures(snapshot)
    const tasks = admission.taskIds.map(taskId => {
      const task = wave.tasks.find(candidate => candidate.id === taskId)
      if (task === undefined) throw new Error(`discovery admission task is missing: ${taskId}`)
      return admittedTask(task, admission)
    }).filter(task => !snapshot.artifacts.some(artifact => artifact.taskId === task.id)
      && !terminalFailures.has(task.id))
    const taskIndexes = tasks.map(task => wave.tasks.findIndex(candidate => candidate.id === task.id))
    const execution = Promise.allSettled(tasks.map((task, index) => runTask({
      definition,
      state: machine.snapshot(),
      stage,
      wave,
      taskIndex: taskIndexes[index]!,
      task,
      visibleArtifacts,
      inputDigest: admission.inputDigest,
      provider,
      artifactStore,
      admitProviderCall,
    }))).then(attempts => ({
      admission, wave, tasks, taskIndexes, attempts,
      savedFailures: admission.taskIds.flatMap(taskId => {
        const failure = terminalFailures.get(taskId)
        return failure === undefined ? [] : [failure]
      }),
    }))
    executions.set(admission.poolId, execution)
    void execution.then(poll => { ready.set(admission.poolId, poll) })
  }

  const admitRunnablePools = async (): Promise<void> => {
    if (admissionsClosed || persistedTerminalTaskFailures(machine.snapshot()).size > 0
      || await input.stopRequested?.() === true) {
      admissionsClosed = true
      return
    }
    state = machine.snapshot()
    const scheduler = state.discoveryScheduler!
    const deadline = Date.parse(state.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
    if (Date.now() >= deadline) return
    for (const progress of scheduler.pools) {
      const current = machine.snapshot()
      const currentScheduler = current.discoveryScheduler!
      const currentProgress = currentScheduler.pools.find(candidate => candidate.poolId === progress.poolId)!
      if (currentProgress.parked || currentProgress.nextWaveIndex >= stage.waves.length
        || currentScheduler.admissions.some(admission => admission.poolId === progress.poolId)) continue
      const boundary = current.availabilityBoundaries.find(value => value.poolId === progress.poolId)
      if (boundary !== undefined) continue
      const wave = stage.waves[currentProgress.nextWaveIndex]!
      const poolTasks = wave.tasks.filter(task => configuredResearchTaskPoolId(task) === progress.poolId)
      const activeReservations = currentScheduler.admissions.flatMap(admission => admission.taskIds)
        .filter(taskId => !current.artifacts.some(artifact => artifact.taskId === taskId)).length
      const poolCostEstimate = (() => {
        const receipt = current.waveReceipts.filter(candidate => (
          candidate.stageId === stage.id && candidate.poolId === progress.poolId
        )).at(-1)
        return receipt === undefined ? 0 : sealedWaveRecordedCostUsd(
          receipt, current.artifacts, current.rejectedAttempts, discoveryReceiptTaskIds(stage, receipt),
        )
      })()
      const activeCostReservations = currentScheduler.admissions.reduce((total, admission) => {
        const receipt = current.waveReceipts.filter(candidate => (
          candidate.stageId === stage.id && candidate.poolId === admission.poolId
        )).at(-1)
        return total + (receipt === undefined ? 0
          : sealedWaveRecordedCostUsd(
            receipt, current.artifacts, current.rejectedAttempts, discoveryReceiptTaskIds(stage, receipt),
          ))
      }, 0)
      const paidTasks = poolTasks.filter(task => task.providerClass !== 'deterministic').length
      if (current.budget.modelCalls + activeReservations + paidTasks > definition.limits.maxModelCalls
        || (definition.limits.maxInputTokens !== undefined
          && current.budget.inputTokens >= definition.limits.maxInputTokens)
        || (definition.limits.maxOutputTokens !== undefined
          && current.budget.outputTokens >= definition.limits.maxOutputTokens)
        || current.budget.costUsd >= definition.limits.maxCostUsd
        || (poolCostEstimate > 0
          && remainingRecordedCostUsd(definition.limits.maxCostUsd, current.budget.costUsd)
            < activeCostReservations + poolCostEstimate)) continue
      const hasCommittedDiscovery = current.waveReceipts.some(receipt => (
        receipt.stageId === stage.id && receipt.poolId !== undefined
      ))
      const frontier = currentProgress.nextWaveIndex === 0 && !hasCommittedDiscovery
        ? [] : discoveryResearchArtifacts(current)
      const admission = await mutate(async () => {
        const value = await machine.admitDiscoveryCohort({
          stageId: stage.id,
          poolId: progress.poolId,
          waveIndex: currentProgress.nextWaveIndex,
          inputArtifacts: frontier.map(artifact => ({ id: artifact.id, contentDigest: artifact.contentDigest })),
          peerPredecessors: peerPredecessors(stage, wave, progress.poolId, frontier),
        })
        await input.onStatePersist?.(machine.snapshot())
        return value
      })
      launch(admission)
      state = machine.snapshot()
    }
  }

  for (const admission of machine.snapshot().discoveryScheduler!.admissions) launch(admission)
  await admitRunnablePools()
  let terminalFailure: unknown = null
  while (executions.size > 0) {
    if (ready.size === 0) await Promise.race(executions.values())
    await Promise.resolve()
    const batch = [...ready.entries()].filter(([poolId]) => executions.has(poolId))
      .toSorted(([left], [right]) => left.localeCompare(right))
    let cohortCompleted = false
    let materialAdvanced = false
    for (const [poolId, poll] of batch) {
      ready.delete(poolId)
      executions.delete(poolId)
      let outcome: Awaited<ReturnType<typeof processDiscoveryCohortPoll>>
      try {
        outcome = await mutate(async () => {
          const value = await processDiscoveryCohortPoll({
            poll, machine, artifactStore, coalesceMaterialDelta: materialAdvanced,
          })
          await input.onStatePersist?.(machine.snapshot())
          return value
        })
      } catch (error) {
        terminalFailure ??= error
        await input.onStatePersist?.(machine.snapshot())
        continue
      }
      cohortCompleted ||= outcome.status === 'completed'
      materialAdvanced ||= outcome.materialDelta
    }
    if (cohortCompleted && terminalFailure === null) await admitRunnablePools()
  }

  if (terminalFailure !== null) {
    if (terminalFailure instanceof RunFailure && !terminalFailure.retryable
      && hasHealthyUnresolvedDiscoveryWork(machine.snapshot())) return null
    throw terminalFailure
  }

  state = machine.snapshot()
  const scheduler = state.discoveryScheduler!
  if (scheduler.admissions.length > 0) return null
  if (admissionsClosed || await input.stopRequested?.() === true) return null
  const deadline = Date.parse(state.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
  const runnable = scheduler.pools.filter(progress => (
    !state.availabilityBoundaries.some(boundary => boundary.poolId === progress.poolId)
      && progress.nextWaveIndex < stage.waves.length
  ))
  const allParked = runnable.length > 0 && runnable.every(progress => (
    progress.parked && progress.quietEpoch === scheduler.materialEpoch
  ))
  let reason: StageEndDecision['reason'] | 'safety-ceiling-reached' | null = null
  let evidence: unknown = null
  if (allParked) {
    reason = 'two-distinct-complete-saturation-cohorts'
    evidence = {
      materialEpoch: scheduler.materialEpoch,
      pools: scheduler.pools.map(pool => ({
        poolId: pool.poolId, quietCohorts: pool.quietCohorts, quietEpoch: pool.quietEpoch, parked: pool.parked,
      })),
    }
  } else if (Date.now() >= deadline) {
    reason = 'phase-deadline'
    evidence = { discoveryDeadline: deadline, materialEpoch: scheduler.materialEpoch }
  } else if (scheduler.pools.every(progress => progress.nextWaveIndex >= stage.waves.length
    || state.availabilityBoundaries.some(boundary => boundary.poolId === progress.poolId))) {
    reason = 'safety-ceiling-reached'
    evidence = {
      configuredWaves: stage.waves.length,
      pools: scheduler.pools.map(pool => ({ poolId: pool.poolId, completedWaves: pool.nextWaveIndex })),
      artifacts: discoveryResearchArtifacts(state).map(artifact => artifact.contentDigest).toSorted(),
    }
  } else {
    const candidates = scheduler.pools.filter(progress => !progress.parked
      && progress.nextWaveIndex < stage.waves.length
      && !state.availabilityBoundaries.some(boundary => boundary.poolId === progress.poolId))
    const estimates = candidates.map(progress => {
      const wave = stage.waves[progress.nextWaveIndex]!
      const receipt = state.waveReceipts.filter(candidate => (
        candidate.stageId === stage.id && candidate.poolId === progress.poolId
      )).at(-1)
      return {
        poolId: progress.poolId,
        waveId: wave.id,
        modelCalls: wave.tasks.filter(task => configuredResearchTaskPoolId(task) === progress.poolId
          && task.providerClass !== 'deterministic').length,
        costUsd: receipt === undefined ? 0 : sealedWaveRecordedCostUsd(
          receipt, state.artifacts, state.rejectedAttempts,
          discoveryReceiptTaskIds(stage, receipt),
        ),
      }
    })
    const remainingCalls = definition.limits.maxModelCalls - state.budget.modelCalls
    const remainingCostUsd = remainingRecordedCostUsd(definition.limits.maxCostUsd, state.budget.costUsd)
    const hardLimit = state.budget.modelCalls >= definition.limits.maxModelCalls
      || state.budget.costUsd >= definition.limits.maxCostUsd
    || (definition.limits.maxInputTokens !== undefined && state.budget.inputTokens >= definition.limits.maxInputTokens)
      || (definition.limits.maxOutputTokens !== undefined && state.budget.outputTokens >= definition.limits.maxOutputTokens)
    const noCandidateFits = estimates.length > 0 && estimates.every(estimate => (
      estimate.modelCalls > remainingCalls || (estimate.costUsd > 0 && estimate.costUsd > remainingCostUsd)
    ))
    if (hardLimit || noCandidateFits) {
      reason = 'measured-budget-inability'
      evidence = { budget: state.budget, remainingCalls, remainingCostUsd, estimates }
    }
  }
  if (reason === null) return null
  const disposal = await disposeDiscoveryLanes(provider, state, stage)
  return machine.endStage(reason, { ...(evidence as object), disposal }, stageIndex)
}

export async function runNextWave(input: {
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  onWaveAdmission?: (state: RunState) => Promise<void>
}): Promise<SealedCheckpoint | null> {
  const { definition, machine, provider, artifactStore } = input
  await machine.start()
  let state = machine.snapshot()
  if (state.cursor.stageIndex >= definition.stages.length) return null
  const stageIndex = state.cursor.stageIndex
  const waveIndex = state.cursor.waveIndex
  const stage = definition.stages[stageIndex]
  const wave = stage?.waves[waveIndex]
  if (stage === undefined || wave === undefined) throw new Error(`invalid run cursor ${stageIndex}/${waveIndex}`)

  // A peer may still be in flight after a task's permanent failure was
  // journaled. Drain that peer without dispatching the failed task again.
  const persistedFailures = new Map<string, PermanentRunFailure>()
  if (state.waveAdmission?.stageId === stage.id && state.waveAdmission.waveId === wave.id) {
    const admission = state.journal.findLast(event => event.type === 'wave.admitted'
      && typeof event.payload === 'object' && event.payload !== null
      && (event.payload as Record<string, unknown>).stageId === stage.id
      && (event.payload as Record<string, unknown>).waveId === wave.id)
    if (admission === undefined) throw new PermanentRunFailure('admitted wave journal boundary is missing', 'integrity-failed')
    for (const event of state.journal) {
      if (event.sequence <= admission.sequence || event.type !== 'task.failed'
        || typeof event.payload !== 'object' || event.payload === null) continue
      const payload = event.payload as Record<string, unknown>
      const taskId = payload.taskId
      const category = payload.category
      if (typeof taskId !== 'string' || !wave.tasks.some(task => task.id === taskId)
        || payload.retryable !== false || typeof payload.error !== 'string'
        || typeof category !== 'string' || category === 'transport'
        || state.artifacts.some(artifact => artifact.stageId === stage.id
          && artifact.waveId === wave.id && artifact.taskId === taskId)
        || !failureCategories.has(category as RunFailureCategory)) continue
      persistedFailures.set(taskId, new PermanentRunFailure(payload.error,
        category as Exclude<RunFailureCategory, 'transport'>))
    }
  }

  // A transport retry reconstructs the machine from its latest persisted
  // generation. Tasks with an artifact or permanent failure for this exact
  // wave must not be admitted or executed again.
  const pendingTaskIndexes = wave.tasks.flatMap((task, taskIndex) => (
    state.artifacts.some(artifact => artifact.stageId === stage.id
      && artifact.waveId === wave.id && artifact.taskId === task.id) || persistedFailures.has(task.id)
      ? []
      : [taskIndex]
  ))
  const inFlight = state.inFlightAgentAttempts ?? []
  const inFlightPaidTasks = inFlight.filter(admission => {
    const task = wave.tasks.find(candidate => candidate.id === admission.taskId)
    return task !== undefined && task.providerClass !== 'deterministic'
  }).length
  const paidTasks = pendingTaskIndexes.reduce((total, taskIndex) => {
    const task = wave.tasks[taskIndex]!
    return task.providerClass === 'deterministic'
      || inFlight.some(admission => admission.stageId === stage.id
        && admission.waveId === wave.id && admission.taskId === task.id)
      ? total
      : total + 1
  }, 0)
  const discoveryBudgetApplies = stage.kind === 'discovery'
  const remainingModelCalls = discoveryBudgetApplies
    ? definition.limits.maxModelCalls - state.budget.modelCalls - inFlightPaidTasks
    : Number.POSITIVE_INFINITY
  const canCheckWholeBatchBeforeDispatch = inFlightPaidTasks === 0
  if (discoveryBudgetApplies && canCheckWholeBatchBeforeDispatch && paidTasks > remainingModelCalls) {
    throw new PermanentRunFailure(`model-call budget cannot admit wave ${stage.id}/${wave.id}`, 'budget-exhausted')
  }
  if (discoveryBudgetApplies && canCheckWholeBatchBeforeDispatch && paidTasks > 0) {
    if (definition.limits.maxInputTokens !== undefined
      && state.budget.inputTokens >= definition.limits.maxInputTokens) {
      throw new PermanentRunFailure(`input-token budget cannot admit wave ${stage.id}/${wave.id}`, 'budget-exhausted')
    }
    if (definition.limits.maxOutputTokens !== undefined
      && state.budget.outputTokens >= definition.limits.maxOutputTokens) {
      throw new PermanentRunFailure(`output-token budget cannot admit wave ${stage.id}/${wave.id}`, 'budget-exhausted')
    }
    if (state.budget.costUsd >= definition.limits.maxCostUsd) {
      throw new PermanentRunFailure(`cost budget cannot admit wave ${stage.id}/${wave.id}`, 'budget-exhausted')
    }
  }
  await machine.admitWave(stage.id, wave.id)
  if (state.waveAdmission === undefined || state.waveAdmission === null) {
    await input.onWaveAdmission?.(machine.snapshot())
  }
  state = machine.snapshot()

  let admissionQueue = Promise.resolve()
  const admitProviderCall = async (task: WaveDefinition['tasks'][number], request: AgentRequest): Promise<void> => {
    if (task.providerClass === 'deterministic') return
    const operation = admissionQueue.then(async () => {
      const current = machine.snapshot()
      const existing = (current.inFlightAgentAttempts ?? []).some(admission => (
        admission.stageId === stage.id && admission.waveId === wave.id && admission.taskId === task.id
      ))
      if (!existing && discoveryBudgetApplies) {
        const reservedCalls = (current.inFlightAgentAttempts ?? []).length
        if (current.budget.modelCalls + reservedCalls + 1 > definition.limits.maxModelCalls) {
          throw new PermanentRunFailure(`model-call budget admission denied for ${task.id}`, 'budget-exhausted')
        }
        if (definition.limits.maxInputTokens !== undefined
          && current.budget.inputTokens >= definition.limits.maxInputTokens) {
          throw new PermanentRunFailure(`input-token budget admission denied for ${task.id}`, 'budget-exhausted')
        }
        if (definition.limits.maxOutputTokens !== undefined
          && current.budget.outputTokens >= definition.limits.maxOutputTokens) {
          throw new PermanentRunFailure(`output-token budget admission denied for ${task.id}`, 'budget-exhausted')
        }
        if (current.budget.costUsd >= definition.limits.maxCostUsd) {
          throw new PermanentRunFailure(`cost budget admission denied for ${task.id}`, 'budget-exhausted')
        }
      }
      try {
        await machine.admitAgentAttempt({
          stageId: stage.id,
          waveId: wave.id,
          taskId: task.id,
          attempt: request.attempt,
          ...(request.formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal: request.formatRepairOrdinal }),
          ...(request.formatRepairSourceDigest === undefined ? {} : { formatRepairSourceDigest: request.formatRepairSourceDigest }),
          promptDigest: request.promptDigest,
          freshContext: request.freshContext,
          continuationMode: request.continuationMode,
          sessionId: request.sessionId,
        })
      } catch (error) {
        if (error instanceof RunFailure) throw error
        throw new PermanentRunFailure(
          `agent attempt admission integrity failed for ${task.id}`,
          'integrity-failed',
          { cause: error },
        )
      }
      try {
        await input.onWaveAdmission?.(machine.snapshot())
      } catch (error) {
        throw new TransientRunFailure(`agent attempt admission persistence failed for ${task.id}`, { cause: error })
      }
    })
    admissionQueue = operation.then(() => undefined, () => undefined)
    await operation
  }
  const waveStartedAt = state.waveAdmission?.stageId === stage.id && state.waveAdmission.waveId === wave.id
    ? state.waveAdmission.admittedAt
    : new Date().toISOString()
  const attempts = await Promise.allSettled(pendingTaskIndexes.map(taskIndex => runTask({
    definition, state, stage, wave, taskIndex, provider, artifactStore, admitProviderCall,
  })))

  const failures: unknown[] = [...persistedFailures.values()]
  let pending = false
  for (let resultIndex = 0; resultIndex < attempts.length; resultIndex += 1) {
    const attempt = attempts[resultIndex]
    const taskIndex = pendingTaskIndexes[resultIndex]
    const task = taskIndex === undefined ? undefined : wave.tasks[taskIndex]
    if (attempt === undefined || task === undefined) throw new Error('wave result alignment failed')
    if (attempt.status === 'rejected') {
      if (attempt.reason instanceof AgentExecutionPending) {
        pending = true
        continue
      }
      if (attempt.reason instanceof TaskRunFailure) {
        for (const rejection of attempt.reason.rejections) {
          try {
            await machine.recordRejectedAttempt(rejection)
            await machine.clearAgentAttempt(
              rejection.stageId, rejection.waveId, rejection.taskId, rejection.promptDigest,
            )
          } catch (error) {
            failures.push(error)
          }
        }
      }
      await machine.recordFailure(task, attempt.reason)
      failures.push(attempt.reason)
      continue
    }
    for (const rejection of attempt.value.rejections) {
      try {
        await machine.recordRejectedAttempt(rejection)
        await machine.clearAgentAttempt(
          rejection.stageId, rejection.waveId, rejection.taskId, rejection.promptDigest,
        )
      } catch (error) {
        failures.push(error)
      }
    }
    if (attempt.value.kind === 'retry-required') {
      pending = true
      continue
    }
    try {
      await machine.recordResult({
        wave,
        task,
        promptDigest: attempt.value.promptDigest,
        result: attempt.value.result,
        artifactStore,
        stageId: stage.id,
      })
      await machine.clearAgentAttempt(
        stage.id, wave.id, task.id, attempt.value.promptDigest,
      )
    } catch (error) {
      failures.push(error)
    }
  }

  if (failures.length > 0) {
    const failure = failures.find(candidate => candidate instanceof RunFailure && !candidate.retryable) ?? failures[0]
    if (pending) {
      throw new AgentExecutionPending('wave-terminal-evidence-pending', 'unfinished', { cause: failure })
    }
    throw failure instanceof Error ? failure : new Error(String(failure))
  }

  if (pending) return null

  machine.assertWaveComplete(stage.id, wave)
  await machine.recordWaveReceipt(stage.id, wave, waveStartedAt)
  const nextCursor = waveIndex + 1 < stage.waves.length
    ? { stageIndex, waveIndex: waveIndex + 1 }
    : { stageIndex: stageIndex + 1, waveIndex: 0 }
  if (waveIndex + 1 === stage.waves.length && stage.kind !== 'discovery') {
    if (stage.kind === 'reporting') {
      const issues = audit0RunPolicy.assessCompletion({ definition, state: machine.snapshot() })
      if (issues.length > 0) {
        throw new PermanentRunFailure(`completion contract failed: ${issues.join('; ')}`, 'completion-contract-failed')
      }
    }
    return machine.endStage(stage.kind === 'preflight' ? 'preflight-passed'
      : stage.kind === 'reporting' ? 'completion-contract-passed' : 'stage-complete', {
      finalWave: wave.id,
      artifacts: sealedArtifacts(machine.snapshot()).filter(artifact => artifact.stageId === stage.id)
        .map(artifact => artifact.contentDigest).toSorted(),
    }, stageIndex)
  }
  await machine.advance(nextCursor)
  return machine.seal()
}

export async function advanceExperimentOneWave(input: {
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  policy?: RunPolicy
  onCheckpoint?: (checkpoint: SealedCheckpoint) => Promise<void>
  onWaveAdmission?: (state: RunState) => Promise<void>
  stopRequested?: () => Promise<boolean>
}): Promise<boolean> {
  const before = input.machine.snapshot()
  if (before.cursor.stageIndex >= input.definition.stages.length) return false
  const stage = input.definition.stages[before.cursor.stageIndex]
  const wave = stage?.waves[before.cursor.waveIndex]
  if (stage === undefined || wave === undefined) throw new Error('run cursor has no stage or wave')
  await input.machine.start()
  const promoted = before.failedWaveRecovery?.promotedExecution
  const drainsLegacyPromotedWave = stage.kind === 'discovery'
    && before.discoveryScheduler === undefined
    && promoted?.stageId === stage.id
    && promoted.waveId === wave.id
    && !before.waveReceipts.some(receipt => receipt.stageId === stage.id && receipt.waveId === wave.id)
  if (drainsLegacyPromotedWave) {
    const recovered = await runNextWave(input)
    if (recovered === null) return false
    const current = input.machine.snapshot()
    const discoveryDeadline = Date.parse(current.modelStartedAt!)
      + input.definition.limits.phaseMinutes.discovery * 60_000
    if (Date.now() >= discoveryDeadline) {
      const disposal = await disposeDiscoveryLanes(input.provider, current, stage)
      const timing = current.waveReceipts.find(receipt => (
        receipt.stageId === stage.id && receipt.waveId === wave.id
      ))
      const checkpoint = await input.machine.endStage('phase-deadline', {
        admittedWaveSealed: wave.id,
        discoveryDeadline,
        remainingMs: Math.max(0, discoveryDeadline - Date.now()),
        lastCompleteWaveDurationMs: timing?.durationMs,
        recoveredPromotedExecution: promoted.requestDigest,
        disposal,
      }, before.cursor.stageIndex)
      await input.onCheckpoint?.(checkpoint)
      return true
    }
    await input.onCheckpoint?.(recovered)
    return true
  }
  if (stage.kind === 'discovery') {
    const checkpoint = await runIndependentDiscoveryTick({
      definition: input.definition,
      machine: input.machine,
      provider: input.provider,
      artifactStore: input.artifactStore,
      ...(input.onWaveAdmission === undefined ? {} : { onStatePersist: input.onWaveAdmission }),
      ...(input.stopRequested === undefined ? {} : { stopRequested: input.stopRequested }),
    })
    if (checkpoint !== null) await input.onCheckpoint?.(checkpoint)
    return checkpoint !== null
  }
  const checkpoint = await runNextWave(input)
  if (checkpoint === null) return false
  await input.onCheckpoint?.(checkpoint)
  return true
}
