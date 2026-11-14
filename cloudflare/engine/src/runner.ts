import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { assertNoUnprovenTaskAbandonment } from './task-occurrences.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import type { StageForkSeed } from './stage-fork-origin.js'
import { taskAttemptRejections } from './attempt-policy.js'
import { frozenAdmissionArtifacts } from './frozen-inputs.js'
import { nativeWorkspaceKey } from './native-workspace.js'
import { persistedTerminalTaskFailures, adjustableTaskFailure } from './execution-failures.js'
import { discoveryAdmissionAllowed, discoveryClosureDecision } from './discovery-policy.js'
import { applicableAvailabilityBoundaries, type ImportedAvailabilityContext } from './execution-availability.js'
import { ExecutionReleases, type ReleaseLoader } from './execution-releases.js'
import { cleanupWorkspaceTasks, groupWorkspaceAllocations, selectedMutationOwner, type OwnedWorkspaceResolver } from './execution-workspaces.js'
import { discoveryPoolIds } from './manifest-amendment.js'
import type { ArtifactExecution, ExecutionConfiguration } from './contracts.js'
import { admissionPaused } from './run-control-state.js'
import type { RunStateWriteOptions } from './contracts.js'
import { discoveryDeadline as discoveryDeadlineMs, type DiscoveryWaits } from './discovery-clock.js'
import { isDiscoveryFrontierArtifact, isReconArtifact } from './recon.js'
import type {
  AgentProvider,
  AgentRequest,
  ArtifactRecord,
  ArtifactReference,
  ArtifactStore,
  DiscoveryCohortAdmission,
  ExperimentDefinition,
  ProviderUsage,
  RunState,
  SealedCheckpoint,
  StageDefinition,
  TaskDefinition,
  WaveDefinition,
} from './contracts.js'
import { providerIdentity, taskBackend } from './provider-identity.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { namespaceResearchResult } from './research-result-namespace.js'
export { namespaceResearchResult } from './research-result-namespace.js'
import { RunMachine } from './machine.js'
import { rejectionConsumesRepairAttempt } from './execution-budget.js'
import { formatRepairLimit, formatRepairOrdinalForAttempt, retryAttemptLimit, retryAttemptMode, retryModeAttempt } from './attempt-policy.js'
import { nextProviderBackoff, providerBackoffs, providerBackoffUntil, validProviderBackoff } from './provider-backoff.js'
import { retainedTransportForAttempt } from './native-session-custody.js'
import { canonicalJson, sha256 } from './canonical.js'
import { artifactExecution, artifactReferences, executionConfiguration } from './artifact-execution.js'
import { admittedTaskOccurrence, selectedTaskOccurrence } from './task-occurrences.js'
import { composePrompt, selectSealedArtifacts, selectVisibleArtifacts } from './prompts.js'
import { validateExecutionResult } from './protocol-validation.js'
import {
  AgentAttemptFailure,
  AgentExecutionPending,
  isTransientRunFailure,
  observedAgentAttemptUsage,
  PermanentRunFailure,
  UnobservableAgentExecution,
  RunFailure,
  TransientRunFailure,
} from './run-errors.js'
import { compareText } from './text-order.js'

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

/** No sealed, accepted research in discovery's first wave: the run cannot complete. */
function discoveryWaveZeroMissing(definition: ExperimentDefinition, state: RunState): boolean {
  const discovery = definition.stages.find(stage => stage.kind === 'discovery')
  return !sealedArtifacts(state).some(artifact => artifact.status === 'accepted'
    && artifact.stageId === discovery?.id && artifact.waveId === 'wave-0')
}

export function createAudit0RunPolicy(_now: () => number = Date.now): RunPolicy {
  return {
  async beforeWave() { return null },
  async afterWave() { return null },
  assessCompletion({ definition, state }) {
    const issues: string[] = []
    const accepted = sealedArtifacts(state).filter(artifact => artifact.status === 'accepted')
    if (discoveryWaveZeroMissing(definition, state)) issues.push('wave 0 is missing')
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
  /** Local settlement token; not part of the immutable provider receipt or its deduplication key. */
  admissionDigest?: string
  execution?: ArtifactExecution
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

/** Preserve receipt deduplication across repeated observations, while settlement
 * belongs to the exact admission returned to this caller before dispatch. */
async function settleRejectedAttempt(machine: RunMachine, draft: RejectedAttemptDraft): Promise<void> {
  const { admissionDigest, ...receipt } = draft
  await machine.recordRejectedAttempt(receipt)
  await machine.clearAgentAttempt({ ...receipt, ...(admissionDigest === undefined ? {} : { admissionDigest }) })
}

interface TaskSuccess {
  admissionDigest?: string
  execution: ArtifactExecution
  kind: 'accepted'
  taskIndex: number
  attempt: number
  promptDigest: string
  result: Awaited<ReturnType<AgentProvider['run']>>
  rejections: readonly RejectedAttemptDraft[]
  inputArtifacts: readonly ArtifactReference[]
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
  inheritedWaits: DiscoveryWaits = [],
): string {
  const discoveryDeadline = discoveryDeadlineMs(definition, state, inheritedWaits)
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
  configuration: ExecutionConfiguration
  importedAvailability: ImportedAvailabilityContext | undefined
  importedDiscoveryWaits: DiscoveryWaits
  state: RunState
  stage: StageDefinition
  wave: WaveDefinition
  taskIndex: number
  task?: WaveDefinition['tasks'][number]
  visibleArtifacts?: readonly ArtifactRecord[]
  inputDigest?: string
  provider: AgentProvider
  artifactStore: ArtifactStore
  admitProviderCall: (task: WaveDefinition['tasks'][number], request: AgentRequest) => Promise<string | undefined>
}): Promise<TaskProgress> {
  const task = input.task ?? input.wave.tasks[input.taskIndex]
  if (task === undefined) throw new Error('task alignment failed')
  const admission = input.state.waveAdmission
  const frontier = input.visibleArtifacts !== undefined ? input.visibleArtifacts
    : await frozenAdmissionArtifacts(input.state.artifacts, admission ?? {})
  const visibleArtifacts = input.visibleArtifacts ?? selectVisibleArtifacts(
    task,
    frontier,
    input.state.waveReceipts,
    input.state.cursor.stageIndex,
    input.state.cursor.waveIndex,
    input.definition,
  )
  const inputArtifacts = artifactReferences(visibleArtifacts)
  const occurrence = selectedTaskOccurrence(input.state, task.id)
  if (occurrence === undefined || input.state.executionAuthority === undefined) {
    throw new PermanentRunFailure('task is not selected for execution', 'integrity-failed')
  }
  const admittedConfiguration = occurrence.configuration
  if (canonicalJson(admittedConfiguration) !== canonicalJson(input.configuration)
    || await sha256(input.definition) !== input.configuration.definitionDigest) {
    throw new PermanentRunFailure('admitted task requires its original release definition', 'integrity-failed')
  }
  const taskExecutionId = occurrence.taskExecutionId
  let diagnostics: readonly string[] = []
  let repairFiles: Readonly<Record<string, string>> = {}
  let lastError: unknown = null
  let continuationSessionId: string | null = null
  const rejections: RejectedAttemptDraft[] = []
  // This remains advisory prompt context. Process lifetime is governed by its
  // terminal state, explicit stop, or a classified permanent failure.
  const promptDeadline = taskPromptDeadline(input.definition, input.state, input.stage, input.wave, input.importedDiscoveryWaits)
  const attemptLimit = retryAttemptLimit(task)
  const previousRejections = taskAttemptRejections(input.state.rejectedAttempts, task.id, taskExecutionId)
    .filter(rejection => rejection.stageId === input.stage.id && rejection.waveId === input.wave.id)
  const consumedAttempts = previousRejections.filter(rejectionConsumesRepairAttempt)
  const lastConsumed = consumedAttempts.toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const interruptedAttempt = previousRejections.filter(rejection => (
    rejection.outputDigest === null && rejection.usage.modelCalls === 0
      && rejection.attempt > (lastConsumed?.attempt ?? 0)
  )).toSorted((left, right) => left.attempt - right.attempt).at(-1)
  const firstAttempt = interruptedAttempt?.attempt ?? ((lastConsumed?.attempt ?? 0) + 1)
  // Provider backoffs (P2-06) are not counted against the limit; every one precedes firstAttempt.
  const backoffCount = providerBackoffs(previousRejections, firstAttempt).length
  let formatRepairOrdinal: number | undefined
  try { formatRepairOrdinal = formatRepairOrdinalForAttempt(task, firstAttempt, previousRejections) } catch (error) {
    throw new TaskRunFailure(`${task.id}: ${error instanceof Error ? error.message : String(error)}`, [],
      new PermanentRunFailure(`${task.id}: output correction cannot continue`, 'agent-repair-exhausted', { cause: error }))
  }
  if (formatRepairOrdinal === undefined && firstAttempt - backoffCount > attemptLimit) {
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
  if (formatRepairOrdinal !== undefined && (continuationSessionId === null
    || continuationSessionId !== latestOutput?.sessionId)) {
    throw new TaskRunFailure(`${task.id}: output correction session custody is unavailable`, [],
      new PermanentRunFailure(`${task.id}: output correction session custody is unavailable`, 'agent-repair-exhausted'))
  }
  // After a provider-side failure the next launch waits; polling stays pending until then.
  const backoffUntil = providerBackoffUntil(previousRejections)
  if (backoffUntil !== null && Date.now() < backoffUntil && !(input.state.inFlightAgentAttempts ?? []).some(value => (
    value.stageId === input.stage.id && value.waveId === input.wave.id && value.taskId === task.id))) {
    throw new AgentExecutionPending(`${task.id}:provider-backoff`, 'unavailable')
  }
  let lastRequest: AgentRequest | null = null
  for (let attempt = firstAttempt; attempt <= (formatRepairOrdinal === undefined ? attemptLimit + backoffCount : firstAttempt); attempt += 1) {
    const execution = await artifactExecution({ state: input.state, configuration: input.configuration, task, attempt,
      inputArtifacts, store: input.artifactStore })
    const nativeTransport = retainedTransportForAttempt(task, attempt, previousRejections)
    const { continuationMode, freshContext } = retryAttemptMode(task, retryModeAttempt(attempt, attempt - backoffCount),
      continuationSessionId !== null, nativeTransport !== undefined && nativeTransport.workState !== 'none', formatRepairOrdinal)
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
      releaseDigest: input.configuration.releaseDigest,
      deadline: promptDeadline,
      diagnostics,
      ...(formatRepairOrdinal === undefined ? {} : { formatRepairOnly: true }),
    })
    let promptDigest = composedPromptDigest
    const taskProvider = providerIdentity(task)
    const taskPoolId = task.modelPool ?? (task.promptKind === 'research' ? configuredResearchTaskPoolId(task) : undefined)
    const additiveBoundary = (await applicableAvailabilityBoundaries(input.state, input.configuration, input.definition, input.importedAvailability)).find(value => (
      taskPoolId === undefined ? value.provider === taskProvider
        : value.poolId === taskPoolId || (value.poolId === undefined && value.provider === taskProvider)
    ))
    const discoveryWave = input.stage.kind === 'discovery' ? Number(input.wave.id.replace(/^wave-/, '')) : Number.MAX_SAFE_INTEGER
    if (task.providerClass === 'additive' && task.optional === true && additiveBoundary !== undefined
      && discoveryWave >= additiveBoundary.effectiveFromWave) {
      return {
        kind: 'accepted',
        execution, inputArtifacts,
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
      execution,
      experimentId: input.definition.id,
      runId: input.state.runId,
      executionAuthority: input.state.executionAuthority, taskExecutionId,
      stage: input.stage,
      wave: input.wave,
      task,
      prompt,
      promptDigest,
      visibleArtifacts,
      ...(input.inputDigest === undefined ? {} : { inputDigest: input.inputDigest }),
      releaseDigest: input.configuration.releaseDigest,
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
      ...(input.definition.target.runtime.commandTimeoutMinutes === undefined ? {}
        : { commandTimeoutMs: input.definition.target.runtime.commandTimeoutMinutes * 60_000 }),
    }
    let admissionDigest: string | undefined
    {
      try {
        admissionDigest = await input.admitProviderCall(task, agentRequest)
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
      const validation = await validateExecutionResult(input.definition, agentRequest, rawResult, [...previousRejections, ...rejections])
      diagnostics = validation.issues
      const { changedRepairSession } = validation
      continuationSessionId = validation.returnedSessionId
      if (diagnostics.length === 0) {
        if (task.workspaceMode !== 'continuation'
          && (task.providerClass !== 'deterministic' || task.promptKind === 'preflight')) {
          try {
            await input.provider.disposeWorkspace?.({
              runId: input.state.runId,
              workspaceKey: await nativeWorkspaceKey(task),
              ...(execution.mutationOwner === undefined ? {} : { mutationOwner: execution.mutationOwner }),
            })
          } catch (error) {
            throw new TaskRunFailure(`workspace disposal failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`, rejections)
          }
        }
        return {
          kind: 'accepted', taskIndex: input.taskIndex, attempt, promptDigest,
          execution, inputArtifacts,
          ...(admissionDigest === undefined ? {} : { admissionDigest }),
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
        execution,
        ...(admissionDigest === undefined ? {} : { admissionDigest }),
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
          ...(rawResult.subscriptionWaits === undefined ? {} : { subscriptionWaits: rawResult.subscriptionWaits }),
          ...(rawResult.subscriptionSwitches === undefined ? {} : { subscriptionSwitches: rawResult.subscriptionSwitches }),
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
          execution, inputArtifacts,
          ...(admissionDigest === undefined ? {} : { admissionDigest }),
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
      // Only a required task waits out an outage; an optional lane still drops out as unavailable.
      const providerBackoff = error instanceof AgentAttemptFailure && error.providerTransient !== undefined
        && error.nativeTerminalCustody === undefined && failedUsage !== null && task.optional !== true
        ? nextProviderBackoff(error.providerTransient, [...previousRejections, ...rejections]) : null
      rejections.push({
        execution,
        ...(admissionDigest === undefined ? {} : { admissionDigest }),
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
        ...(providerBackoff === null ? {} : { providerBackoff }),
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
      // Waits for its backoff instead of counting against the limit.
      if (providerBackoff !== null) {
        return { kind: 'retry-required', taskIndex: input.taskIndex, attempt, promptDigest, rejections }
      }
      const priorCorrectionTransport = formatRepairOrdinal === undefined ? 0 : previousRejections.filter(rejection => (
        rejection.formatRepairOrdinal === formatRepairOrdinal && rejection.outputDigest === null
          && rejection.usage.modelCalls > 0 && !validProviderBackoff(rejection.providerBackoff)
      )).length
      if (formatRepairOrdinal !== undefined
        ? priorCorrectionTransport + 1 < retryAttemptLimit(task) : attempt - backoffCount < attemptLimit) {
        return { kind: 'retry-required', taskIndex: input.taskIndex, attempt, promptDigest, rejections }
      }
    }
  }
  const retainedNativeWork = task.providerClass === 'additive'
    && rejections.some(rejection => rejection.sessionId !== null
      && (rejection.nativeTransport?.workState !== undefined && rejection.nativeTransport.workState !== 'none'
        || rejection.nativeTerminalCustody?.workState !== undefined && rejection.nativeTerminalCustody.workState !== 'none'))
  if (lastRequest !== null && task.workspaceMode !== 'continuation' && !retainedNativeWork
    && latestOutput === undefined && !rejections.some(rejection => rejection.outputDigest !== null)) {
    await input.provider.disposeWorkspace?.({ runId: input.state.runId, workspaceKey: await nativeWorkspaceKey(task),
      ...(lastRequest.execution?.mutationOwner === undefined ? {} : { mutationOwner: lastRequest.execution.mutationOwner }) })
  }
  const message = formatRepairOrdinal === formatRepairLimit && rejections.some(rejection => rejection.outputDigest !== null)
    ? `output correction exhausted after ${formatRepairLimit} turns`
    : lastError instanceof Error ? lastError.message : String(lastError)
  throw new TaskRunFailure(`${task.id}: ${message}`, rejections,
    new PermanentRunFailure(`${task.id}: ${message}`, 'agent-repair-exhausted', { cause: lastError }))
}

function disposeAllocations(provider: AgentProvider, runId: string,
  groups: Awaited<ReturnType<typeof groupWorkspaceAllocations>>) {
  return groups.map(async ({ workspaceKey, members }) => {
    const mutationOwner = await selectedMutationOwner(members)
    return provider.disposeWorkspace!({ runId, workspaceKey,
      ...(mutationOwner === undefined ? {} : { mutationOwner }) })
  })
}

async function disposeDiscoveryLanes(provider: AgentProvider, state: RunState, stage: StageDefinition,
  definition: ExperimentDefinition, seed?: StageForkSeed, owned?: OwnedWorkspaceResolver) {
  const recorded = await cleanupWorkspaceTasks(definition, state, seed, owned)
  const groups = await groupWorkspaceAllocations(recorded.filter(value => value.stageId === stage.id
    && value.task.workspaceMode === 'continuation'), state.runId)
  const workspaceKeys = [...new Set(groups.map(value => value.workspaceKey))].toSorted()
  if (provider.disposeWorkspace === undefined) return { mode: 'not-applicable' as const, workspaceKeys }
  const receipts = await Promise.all(disposeAllocations(provider, state.runId, groups))
  const deferred = receipts.flatMap((receipt, index) => receipt?.status === 'deferred' ? [groups[index]!.workspaceKey] : [])
  return deferred.length === 0
    ? { mode: 'provider-verified' as const, workspaceKeys }
    : { mode: 'provider-deferred' as const, workspaceKeys, deferred }
}

export async function disposeTerminalWorkspaces(
  provider: AgentProvider,
  definition: ExperimentDefinition,
  state: RunState,
  options: { loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader, loadOwnedWorkspaces?: OwnedWorkspaceResolver } = {},
) {
  assertCurrentExecutionFormat(state)
  if (options.loadExecution?.assertSelected !== undefined) await options.loadExecution.assertSelected(state)
  else RunMachine.assertProducedState(state)
  if (state.status !== 'completed') throw new Error('unfinished execution cleanup requires the cancel control')
  const releases = state.forkOrigin === undefined ? undefined
    : await ExecutionReleases.create(definition, state, options.loadRelease, options.loadExecution)
  const recorded = await cleanupWorkspaceTasks(definition, state,
    releases?.importedSeed, options.loadOwnedWorkspaces)
  if (recorded.some(record => record.active || record.admitted)) throw new Error('completed cleanup contains unfinished native work')
  const workspaceKeys = [...new Set(recorded.filter(record => record.evidenced).map(record => record.workspaceKey))].toSorted()
  if (provider.disposeWorkspace === undefined) {
    return { mode: 'not-applicable' as const, workspaceKeys,
      activeWorkspaceKeys: [] as string[], retainedWorkspaceKeys: [] as string[] }
  }
  const groups = await groupWorkspaceAllocations(recorded.filter(record => workspaceKeys.includes(record.workspaceKey)), state.runId)
  const settled = await Promise.allSettled(disposeAllocations(provider, state.runId, groups))
  return {
    mode: 'provider-attempted' as const,
    workspaceKeys,
    activeWorkspaceKeys: [] as string[], retainedWorkspaceKeys: [] as string[],
    deferred: settled.flatMap((result, index) => result.status === 'fulfilled'
      && result.value?.status !== 'deferred' ? [] : [groups[index]!.workspaceKey]),
  }
}

function discoveryResearchArtifacts(state: RunState): readonly ArtifactRecord[] {
  return sealedArtifacts(state).filter(isDiscoveryFrontierArtifact)
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

interface DiscoveryCohortPoll {
  admission: DiscoveryCohortAdmission
  wave: WaveDefinition
  tasks: readonly TaskDefinition[]
  taskIndexes: readonly number[]
  attempts: readonly PromiseSettledResult<TaskProgress>[]
  savedFailures: readonly RunFailure[]
}

function hasHealthyUnresolvedDiscoveryWork(state: RunState): boolean {
  const terminal = persistedTerminalTaskFailures(state)
  return state.discoveryScheduler?.admissions.some(admission => admission.taskIds.some(taskId => (
    !terminal.has(taskId) && !state.artifacts.some(artifact => artifact.taskId === taskId)
  ))) === true
}

/** The scheduler reserves the lane; every provider call then publishes the
 * same attempt identity before it can execute, regardless of stage. */
async function admitProviderRequest(machine: RunMachine, request: AgentRequest,
  persist?: (state: RunState) => Promise<void>): Promise<string> {
  let digest: string
  try {
    digest = await machine.admitAgentAttempt({
      dispatchDigest: await sha256(request), stageId: request.stage.id, waveId: request.wave.id,
      taskId: request.task.id, attempt: request.attempt,
      ...(request.execution === undefined ? {} : { execution: request.execution }),
      ...(request.formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal: request.formatRepairOrdinal }),
      ...(request.formatRepairSourceDigest === undefined ? {} : { formatRepairSourceDigest: request.formatRepairSourceDigest }),
      promptDigest: request.promptDigest, freshContext: request.freshContext,
      continuationMode: request.continuationMode, sessionId: request.sessionId,
    })
  } catch (error) {
    if (error instanceof RunFailure) throw error
    throw new PermanentRunFailure(`agent attempt admission integrity failed for ${request.task.id}`,
      'integrity-failed', { cause: error })
  }
  try { await persist?.(machine.view()) }
  catch (error) {
    throw new TransientRunFailure(`agent attempt admission persistence failed for ${request.task.id}`, { cause: error })
  }
  return digest
}

/** Every admitted lane settles the same evidence before its scheduling policy
 * decides whether to drain peers, seal a wave, or surface a failure. */
async function settleTaskResults(input: {
  machine: RunMachine
  artifactStore: ArtifactStore
  stageId: string
  wave: WaveDefinition
  tasks: readonly TaskDefinition[]
  attempts: readonly PromiseSettledResult<TaskProgress>[]
  savedFailures: readonly RunFailure[]
  taskExecutionId: (task: TaskDefinition) => string | undefined
}): Promise<{ failures: unknown[]; pending: boolean }> {
  const { machine, artifactStore } = input
  const failures: unknown[] = [...input.savedFailures]
  let pending = false
  for (let resultIndex = 0; resultIndex < input.attempts.length; resultIndex += 1) {
    const attempt = input.attempts[resultIndex]
    const task = input.tasks[resultIndex]
    if (attempt === undefined || task === undefined) throw new Error('task result alignment failed')
    if (attempt.status === 'rejected') {
      if (attempt.reason instanceof AgentExecutionPending) {
        pending = true
        continue
      }
      if (attempt.reason instanceof TaskRunFailure) {
        for (const rejection of attempt.reason.rejections) {
          try {
            await settleRejectedAttempt(machine, rejection)
          } catch (error) { failures.push(error) }
        }
      }
      await machine.recordFailure(task, attempt.reason, undefined,
        input.taskExecutionId(task))
      failures.push(attempt.reason)
      continue
    }
    for (const rejection of attempt.value.rejections) {
      try {
        await settleRejectedAttempt(machine, rejection)
      } catch (error) { failures.push(error) }
    }
    if (attempt.value.kind === 'retry-required') {
      pending = true
      continue
    }
    try {
      await machine.recordResult({
        wave: input.wave,
        task,
        promptDigest: attempt.value.promptDigest,
        result: attempt.value.result,
        artifactStore,
        stageId: input.stageId,
        attempt: attempt.value.attempt,
        inputArtifacts: attempt.value.inputArtifacts,
        execution: attempt.value.execution,
      })
      await machine.clearAgentAttempt({ stageId: input.stageId, waveId: input.wave.id,
        taskId: task.id, promptDigest: attempt.value.promptDigest, execution: attempt.value.execution,
        ...(attempt.value.admissionDigest === undefined ? {} : { admissionDigest: attempt.value.admissionDigest }) })
    } catch (error) { failures.push(error) }
  }
  return { failures, pending }
}

async function processDiscoveryCohortPoll(input: {
  poll: DiscoveryCohortPoll
  machine: RunMachine
  artifactStore: ArtifactStore
  coalesceMaterialDelta?: boolean
}): Promise<{ status: 'completed' | 'pending', materialDelta: boolean }> {
  const { poll, machine, artifactStore } = input
  const { failures, pending } = await settleTaskResults({ machine, artifactStore,
    stageId: poll.admission.stageId, wave: poll.wave, tasks: poll.tasks, attempts: poll.attempts,
    savedFailures: poll.savedFailures,
    taskExecutionId: task => poll.admission.taskOccurrences?.find(value => value.taskId === task.id)?.taskExecutionId })
  if (failures.length > 0) {
    const permanent = failures.find(candidate => candidate instanceof RunFailure && !candidate.retryable && !adjustableTaskFailure(candidate))
      ?? failures.find(candidate => candidate instanceof RunFailure && !candidate.retryable)
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
  loadOwnedWorkspaces?: OwnedWorkspaceResolver
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  onStatePersist?: (state: RunState, options?: RunStateWriteOptions) => Promise<void>
  reconcileControls?: () => Promise<boolean | void>
}): Promise<SealedCheckpoint | null> {
  const { definition, machine, provider, artifactStore } = input
  await machine.start()
  const controlConfiguration = executionConfiguration(machine.view())
  if (await input.reconcileControls?.() === false || machine.view().status !== 'running'
    || canonicalJson(executionConfiguration(machine.view())) !== canonicalJson(controlConfiguration)) return null
  let state = machine.view()
  const stageIndex = state.cursor.stageIndex
  const stage = definition.stages[stageIndex]
  if (stage?.kind !== 'discovery') throw new Error('independent discovery tick requires the discovery cursor')
  const tickConfiguration = executionConfiguration(state)
  const activePools = new Set(discoveryPoolIds(definition))
  await machine.initializeDiscoveryScheduler(stage.id)
  if (state.discoveryScheduler === undefined) await input.onStatePersist?.(machine.view())

  let controlsBlocked = false
  let mutationQueue = Promise.resolve()
  const mutate = async <T>(operation: () => Promise<T>): Promise<T> => {
    const queued = mutationQueue.then(operation)
    mutationQueue = queued.then(() => undefined, () => undefined)
    return queued
  }
  const admitProviderCall = async (task: TaskDefinition, request: AgentRequest): Promise<string | undefined> => {
    if (task.providerClass === 'deterministic') return
    return mutate(async () => {
      if (controlsBlocked || machine.view().status !== 'running') throw new AgentExecutionPending(task.id, 'cancelled')
      // The durable cohort admission reserves every paid task atomically.
      // Once admitted, every peer drains even if another pool records usage
      // before this task starts. A new repair needs a separate call reservation.
      return admitProviderRequest(machine, request, input.onStatePersist)
    })
  }
  const executions = new Map<string, Promise<DiscoveryCohortPoll>>()
  const ready = new Map<string, DiscoveryCohortPoll>()
  let admissionsClosed = false
  const launch = async (admission: DiscoveryCohortAdmission) => {
    const admittedDefinition = await machine.executionDefinition(admission.configuration)
    const admittedStage = admittedDefinition.stages.find(candidate => candidate.id === admission.stageId)
    if (admittedStage?.kind !== 'discovery') throw new Error('admitted discovery stage is missing')
    const wave = admittedStage.waves[admission.waveIndex]
    if (wave === undefined) throw new Error(`discovery admission wave is missing: ${admission.waveId}`)
    const visibleArtifacts = await frozenAdmissionArtifacts(machine.view().artifacts, admission)
    const snapshot = machine.view()
    const terminalFailures = persistedTerminalTaskFailures(snapshot)
    assertNoUnprovenTaskAbandonment(admission)
    const tasks = admission.taskIds.map(taskId => {
      const task = wave.tasks.find(candidate => candidate.id === taskId)
      if (task === undefined) throw new Error(`discovery admission task is missing: ${taskId}`)
      return admittedTask(task, admission)
    }).filter(task => !snapshot.artifacts.some(artifact => artifact.taskId === task.id)
      && !terminalFailures.has(task.id))
    const taskIndexes = tasks.map(task => wave.tasks.findIndex(candidate => candidate.id === task.id))
    const execution = Promise.allSettled(tasks.map((task, index) => runTask({
      definition: admittedDefinition,
      configuration: admission.configuration ?? executionConfiguration(machine.view()),
      importedAvailability: machine.importedAvailability, importedDiscoveryWaits: machine.importedDiscoveryWaits,
      state: machine.view(),
      stage: admittedStage,
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
    if (admissionsClosed) {
      admissionsClosed = true
      return
    }
    state = machine.view()
    const scheduler = state.discoveryScheduler!
    for (const progress of scheduler.pools.filter(pool => activePools.has(pool.poolId))) {
      const admission = await mutate(async () => {
        if (await input.reconcileControls?.() === false || machine.view().status !== 'running') {
          controlsBlocked = true; admissionsClosed = true
          return undefined
        }
        const current = machine.view()
        if (canonicalJson(executionConfiguration(current)) !== canonicalJson(tickConfiguration)) {
          admissionsClosed = true
          return undefined
        }
        const availability = await applicableAvailabilityBoundaries(current, executionConfiguration(current),
          machine.definition, machine.importedAvailability)
        const admittedAt = new Date(Date.now()).toISOString()
        if (!discoveryAdmissionAllowed(definition, current, progress.poolId, availability, Date.parse(admittedAt), machine.importedDiscoveryWaits)) return undefined
        const currentProgress = current.discoveryScheduler!.pools.find(candidate => candidate.poolId === progress.poolId)!
        const wave = stage.waves[currentProgress.nextWaveIndex]!
        const hasCommittedDiscovery = current.waveReceipts.some(receipt => receipt.stageId === stage.id && receipt.poolId !== undefined)
        const frontier = currentProgress.nextWaveIndex === 0 && !hasCommittedDiscovery
          ? discoveryResearchArtifacts(current).filter(isReconArtifact) : discoveryResearchArtifacts(current)
        return machine.persistAdmission(() => machine.admitDiscoveryCohort({
          stageId: stage.id, poolId: progress.poolId, waveIndex: currentProgress.nextWaveIndex,
          inputArtifacts: frontier.map(artifact => ({ id: artifact.id, contentDigest: artifact.contentDigest })),
          peerPredecessors: peerPredecessors(stage, wave, progress.poolId, frontier),
        }, admittedAt), state => input.onStatePersist?.(state, { admission: true }) ?? Promise.resolve())
      })
      if (admissionsClosed) return
      if (admission === undefined) continue
      await launch(admission)
      state = machine.view()
    }
  }

  for (const admission of machine.view().discoveryScheduler!.admissions) await launch(admission)
  await admitRunnablePools()
  let terminalFailure: unknown = null
  while (executions.size > 0) {
    if (ready.size === 0) await Promise.race(executions.values())
    await Promise.resolve()
    const batch = [...ready.entries()].filter(([poolId]) => executions.has(poolId))
      .toSorted(([left], [right]) => compareText(left, right))
    let cohortCompleted = false
    let materialAdvanced = false
    for (const [poolId, poll] of batch) {
      ready.delete(poolId)
      executions.delete(poolId)
      let outcome: Awaited<ReturnType<typeof processDiscoveryCohortPoll>>
      try {
        outcome = await mutate(async () => {
          // Native receipts remain durable; do not accept a late result after
          // the control transition abandoned its admission.
          if (controlsBlocked || machine.view().status !== 'running') return { status: 'pending' as const, materialDelta: false }
          const value = await processDiscoveryCohortPoll({
            poll, machine, artifactStore, coalesceMaterialDelta: materialAdvanced,
          })
          await input.onStatePersist?.(machine.view())
          return value
        })
      } catch (error) {
        // Cohorts settle in any order: a permanent failure that settles later must not hide
        // behind an adjustable one (the same priority processDiscoveryCohortPoll uses in a cohort).
        if (terminalFailure === null || (adjustableTaskFailure(terminalFailure)
          && error instanceof RunFailure && !error.retryable && !adjustableTaskFailure(error))) terminalFailure = error
        await input.onStatePersist?.(machine.view())
        continue
      }
      cohortCompleted ||= outcome.status === 'completed'
      materialAdvanced ||= outcome.materialDelta
    }
    if (cohortCompleted && terminalFailure === null) await admitRunnablePools()
  }

  if (terminalFailure !== null) {
    if (terminalFailure instanceof RunFailure && !terminalFailure.retryable
      && hasHealthyUnresolvedDiscoveryWork(machine.view())) return null
    throw terminalFailure
  }

  if (controlsBlocked) return null
  if (await mutate(async () => input.reconcileControls?.()) === false || machine.view().status !== 'running') return null
  state = machine.view()
  if (canonicalJson(executionConfiguration(state)) !== canonicalJson(tickConfiguration)) return null
  const scheduler = state.discoveryScheduler!
  if (scheduler.admissions.length > 0) return null
  if (admissionsClosed) return null
  const availability = await applicableAvailabilityBoundaries(state, executionConfiguration(state),
    machine.definition, machine.importedAvailability)
  const decidedAt = new Date(Date.now()).toISOString()
  const decision = discoveryClosureDecision(definition, state, availability, Date.parse(decidedAt), machine.importedDiscoveryWaits)
  if (decision === null) return null
  // The same check as the completion contract, made before any later stage spends on empty input.
  if (discoveryWaveZeroMissing(definition, state)) {
    throw new PermanentRunFailure(`completion contract failed: wave 0 is missing; discovery ended by ${decision.reason} `
      + 'before any research was accepted', 'completion-contract-failed')
  }
  const decisionJournalHead = state.journal.at(-1)!.digest
  const disposal = await disposeDiscoveryLanes(provider, state, stage, definition, machine.importedSeed, input.loadOwnedWorkspaces)
  // Disposal can await native cleanup. Never close a newer manifest/control frontier
  // using a decision computed before those changes.
  if (machine.view() !== state) return null
  return machine.endStage(decision.reason, { ...decision.evidence, decidedAt, decisionJournalHead, disposal }, stageIndex)

}

export async function runNextWave(input: {
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  onWaveAdmission?: (state: RunState, options?: RunStateWriteOptions) => Promise<void>
  reconcileControls?: () => Promise<boolean | void>
}): Promise<SealedCheckpoint | null> {
  const { definition, machine, provider, artifactStore } = input
  await machine.start()
  const controlConfiguration = executionConfiguration(machine.view())
  if (await input.reconcileControls?.() === false || machine.view().status !== 'running'
    || canonicalJson(executionConfiguration(machine.view())) !== canonicalJson(controlConfiguration)) return null
  let state = machine.view()
  if (state.cursor.stageIndex >= definition.stages.length) return null
  const stageIndex = state.cursor.stageIndex
  const waveIndex = state.cursor.waveIndex
  const admittedDefinition = await machine.executionDefinition(state.waveAdmission?.configuration)
  const stage = admittedDefinition.stages[stageIndex]
  const wave = stage?.waves[waveIndex]
  if (stage === undefined || wave === undefined) throw new Error(`invalid run cursor ${stageIndex}/${waveIndex}`)

  const currentConfiguration = executionConfiguration(state)
  const imported = new Set(machine.importedSeed?.artifacts.map(value => value.taskId) ?? [])
  const selection = await Promise.all(wave.tasks.map(async (task, taskIndex) => {
    const occurrence = state.waveAdmission == null || imported.has(task.id) ? undefined : admittedTaskOccurrence(state.waveAdmission, task.id)
    const configuration = occurrence?.configuration ?? state.waveAdmission?.configuration ?? currentConfiguration
    if (canonicalJson(configuration) !== canonicalJson(currentConfiguration)
      || (occurrence !== undefined && await sha256(task) !== occurrence.taskDigest)) {
      throw new PermanentRunFailure('selected task differs from its immutable manifest', 'integrity-failed')
    }
    return { definition: admittedDefinition, configuration, stage, wave, taskIndex, task }
  }))
  const tasks = selection.map(value => value.task)

  // A peer may still be in flight after a task's permanent failure was
  // journaled. Drain that peer without dispatching the failed task again.
  const persistedFailures = new Map<string, RunFailure>()
  if (state.waveAdmission?.stageId === stage.id && state.waveAdmission.waveId === wave.id) {
    const admission = state.journal.findLast(event => event.type === 'wave.admitted'
      && typeof event.payload === 'object' && event.payload !== null
      && (event.payload as Record<string, unknown>).stageId === stage.id
      && (event.payload as Record<string, unknown>).waveId === wave.id)
    if (admission === undefined) throw new PermanentRunFailure('admitted wave journal boundary is missing', 'integrity-failed')
    const failures = persistedTerminalTaskFailures(state, admission.sequence)
    for (const [taskId, failure] of failures) {
      if (tasks.some(task => task.id === taskId) && !state.artifacts.some(artifact =>
        artifact.stageId === stage.id && artifact.waveId === wave.id && artifact.taskId === taskId)) {
        persistedFailures.set(taskId, failure)
      }
    }
  }

  // A transport retry reconstructs the machine from its latest persisted
  // generation. Tasks with an artifact or permanent failure for this exact
  // wave must not be admitted or executed again.
  const pendingTaskIndexes = tasks.flatMap((task, taskIndex) => {
    assertNoUnprovenTaskAbandonment(state.waveAdmission)
    if (state.artifacts.some(artifact => artifact.stageId === stage.id
      && artifact.waveId === wave.id && artifact.taskId === task.id) || persistedFailures.has(task.id)) return []
    return [taskIndex]
  })
  const inFlight = state.inFlightAgentAttempts ?? []
  const inFlightPaidTasks = inFlight.filter(admission => {
    const task = tasks.find(candidate => candidate.id === admission.taskId)
    return task !== undefined && task.providerClass !== 'deterministic'
  }).length
  const paidTasks = pendingTaskIndexes.reduce((total, taskIndex) => {
    const task = tasks[taskIndex]!
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
  if (state.waveAdmission === undefined || state.waveAdmission === null) {
    if (await input.reconcileControls?.() === false || machine.view().status !== 'running') return null
    if (canonicalJson(executionConfiguration(machine.view())) !== canonicalJson(executionConfiguration(state))) return null
    if (admissionPaused(machine.view(), stage.id, tasks)) return null
    await machine.persistAdmission(() => machine.admitWave(stage.id, wave.id),
      state => input.onWaveAdmission?.(state, { admission: true }) ?? Promise.resolve())
  }
  state = machine.view()

  let admissionQueue = Promise.resolve()
  const admitProviderCall = async (task: WaveDefinition['tasks'][number], request: AgentRequest): Promise<string | undefined> => {
    if (task.providerClass === 'deterministic') return
    const operation = admissionQueue.then(async () => {
      const current = machine.view()
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
      return admitProviderRequest(machine, request, input.onWaveAdmission)
    })
    admissionQueue = operation.then(() => undefined, () => undefined)
    return operation
  }
  const waveStartedAt = state.waveAdmission?.stageId === stage.id && state.waveAdmission.waveId === wave.id
    ? state.waveAdmission.admittedAt
    : new Date().toISOString()
  const attempts = await Promise.allSettled(pendingTaskIndexes.map(taskIndex => runTask({
    ...selection[taskIndex]!, importedAvailability: machine.importedAvailability, importedDiscoveryWaits: machine.importedDiscoveryWaits,
    state, provider, artifactStore, admitProviderCall,
  })))

  const { failures, pending } = await settleTaskResults({ machine, artifactStore, stageId: stage.id, wave,
    tasks: pendingTaskIndexes.map(index => tasks[index]!), attempts, savedFailures: [...persistedFailures.values()],
    taskExecutionId: task => selectedTaskOccurrence(state, task.id)?.taskExecutionId })

  if (failures.length > 0) {
    const failure = failures.find(candidate => candidate instanceof RunFailure && !candidate.retryable) ?? failures[0]
    if (pending) {
      throw new AgentExecutionPending('wave-terminal-evidence-pending', 'unfinished', { cause: failure })
    }
    throw failure instanceof Error ? failure : new Error(String(failure))
  }

  if (pending) return null

  await machine.recordWaveReceipt(stage.id, wave, waveStartedAt)
  const nextCursor = waveIndex + 1 < stage.waves.length
    ? { stageIndex, waveIndex: waveIndex + 1 }
    : { stageIndex: stageIndex + 1, waveIndex: 0 }
  if (waveIndex + 1 === stage.waves.length && stage.kind !== 'discovery') {
    if (stage.kind === 'reporting') {
      const issues = audit0RunPolicy.assessCompletion({ definition, state: machine.view() })
      if (issues.length > 0) {
        throw new PermanentRunFailure(`completion contract failed: ${issues.join('; ')}`, 'completion-contract-failed')
      }
    }
    return machine.endStage(stage.kind === 'preflight' ? 'preflight-passed'
      : stage.kind === 'reporting' ? 'completion-contract-passed' : 'stage-complete', {
      finalWave: wave.id,
      artifacts: sealedArtifacts(machine.view()).filter(artifact => artifact.stageId === stage.id)
        .map(artifact => artifact.contentDigest).toSorted(),
    }, stageIndex)
  }
  await machine.advance(nextCursor)
  return machine.seal()
}

export async function advanceExperimentOneWave(input: {
  loadOwnedWorkspaces?: OwnedWorkspaceResolver
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  policy?: RunPolicy
  onCheckpoint?: (checkpoint: SealedCheckpoint) => Promise<void>
  onWaveAdmission?: (state: RunState, options?: RunStateWriteOptions) => Promise<void>
  reconcileControls?: () => Promise<boolean | void>
}): Promise<boolean> {
  const before = input.machine.view()
  if (!['created', 'running'].includes(before.status)) return false
  if (before.cursor.stageIndex >= input.definition.stages.length) return false
  const stage = input.definition.stages[before.cursor.stageIndex]
  const wave = stage?.waves[before.cursor.waveIndex]
  if (stage === undefined || wave === undefined) throw new Error('run cursor has no stage or wave')
  await input.machine.start()
  if (stage.kind === 'discovery') {
    const checkpoint = await runIndependentDiscoveryTick({
      definition: input.definition,
      machine: input.machine,
      provider: input.provider,
      artifactStore: input.artifactStore,
      ...(input.loadOwnedWorkspaces === undefined ? {} : { loadOwnedWorkspaces: input.loadOwnedWorkspaces }),
      ...(input.onWaveAdmission === undefined ? {} : { onStatePersist: input.onWaveAdmission }),
      ...(input.reconcileControls === undefined ? {} : { reconcileControls: input.reconcileControls }),
    })
    if (checkpoint !== null) await input.onCheckpoint?.(checkpoint)
    return checkpoint !== null
  }
  const checkpoint = await runNextWave(input)
  if (checkpoint === null) return false
  await input.onCheckpoint?.(checkpoint)
  return true
}
