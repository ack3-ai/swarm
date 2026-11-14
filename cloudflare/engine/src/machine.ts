import { frozenAdmissionArtifacts } from './frozen-inputs.js'
import { selectSealedArtifacts, selectVisibleArtifacts } from './prompts.js'
import { assertAcceptedTaskOccurrence } from './task-occurrences.js'
import { stageForkOrigin, bindStageForkSeed, type StageForkSeed } from './stage-fork-origin.js'
import { type ExecutionSourceLoader } from './execution-lineage.js'
import { persistedTerminalTaskFailures } from './execution-failures.js'
import { initialTaskOccurrences, selectedTaskOccurrence, admittedTaskOccurrence, assertTaskOccurrenceExecution, assertNoUnprovenTaskAbandonment } from './task-occurrences.js'
import { assertAgentAttemptPolicy, matchesAgentAttemptOutcome, matchesRecordedAttemptOutcome, hasRecordedAttemptOutcome, agentAttemptAdmission } from './attempt-policy.js'
export { retryAttemptLimit, maxAgentAttemptOrdinal, formatRepairLimit, formatRepairOrdinalForAttempt, retryAttemptModes, retryAttemptMode } from './attempt-policy.js'
import { discoveryAdmissionAllowed, discoveryRepairAllowed, discoveryClosureDecision } from './discovery-policy.js'
export { rejectionConsumesRepairAttempt } from './execution-budget.js'
import { copyState } from './state-copy.js'
import { recordAvailabilityBoundary, applicableAvailabilityBoundaries, isAvailabilityBoundaryAcceptance } from './execution-availability.js'
import { checkpointBody } from './checkpoint-body.js'
import { phaseForStage } from './run-phase.js'
export { phaseForStage } from './run-phase.js'
import { addBudget, zeroBudget, assertBudgetShape } from './execution-budget.js'
import { assertWaveRecordsComplete, assertDiscoveryCohortRecordsComplete } from './wave-records.js'
export { assertWaveRecordsComplete, assertDiscoveryCohortRecordsComplete } from './wave-records.js'
import { verifyRegisteredCheckpoint } from './checkpoint-evidence.js'
import { appendExecutionEvent as appendEvent } from './execution-journal.js'
import { completeDiscoveryProgress, discoveryCoalescingPredecessor, initialDiscoveryProgress } from './discovery-progress.js'
import { ExecutionReleases, type ReleaseLoader } from './execution-releases.js'
import type { ArtifactExecution, ExecutionConfiguration } from './contracts.js'
import { auditCancellationEffect, assertAuditCancellation, type AuditCancellationProof, applyAdmissionControl, settledControlState, type RunControlOutcome } from './run-control-state.js'
import type { RunOperation } from './run-command-journal.js'
import { artifactExecution, artifactReferences, assertDispatchedExecution, assertExecutionContract, executionConfiguration } from './artifact-execution.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import type {
  AgentResult,
  ArtifactRecord,
  ArtifactReference,
  ArtifactStore,
  BudgetUsage,
  DiscoveryCohortAdmission,
  ExperimentDefinition,
  InFlightAgentAttempt,
  RejectedAttempt,
  RunCursor,
  RuntimeRelease,
  RunState,
  SealedCheckpoint,
  TaskDefinition,
  WaveDefinition,
} from './contracts.js'
import { providerIdentity } from './provider-identity.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { assertRuntimeRelease } from './runtime-release.js'
import { normalizeCursor, validateExperiment } from './validation.js'
import { normalizedCostUsd } from './discovery-cost.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { isDiscoveryFrontierArtifact } from './recon.js'
import { RunFailure, PermanentRunFailure, TransientRunFailure } from './run-errors.js'
import { compareText } from './text-order.js'

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


// Track only objects recursively frozen here: an externally shallow-frozen
// object must not allow a mutable child to escape through a state view.
const frozenStateObjects = new WeakSet<object>()
function freezeState(value: unknown): void {
  if (value === null || typeof value !== 'object' || frozenStateObjects.has(value)) return
  frozenStateObjects.add(value)
  for (const child of Object.values(value)) freezeState(child)
  Object.freeze(value)
}

function assertRunId(runId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('run id is invalid')
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





const producedStates = new WeakSet<RunState>()

export class RunMachine {
  static isProducedState(state: RunState): boolean { return producedStates.has(state) }

  static assertProducedState(state: RunState): void {
    if (!RunMachine.isProducedState(state)) throw new Error('state must be produced by the execution machine')
  }

  private configuredDefinition: ExperimentDefinition
  get definition(): ExperimentDefinition { return this.configuredDefinition }
  private current: RunState
  get importedSeed(): StageForkSeed | undefined { return this.releases.importedSeed }
  get importedDiscoveryWaits() { return this.releases.importedDiscoveryWaits ?? [] }
  get importedAvailability() { return this.releases.importedAvailability }

  private constructor(definition: ExperimentDefinition, state: RunState, private releases: ExecutionReleases) {
    this.configuredDefinition = deepClone(definition)
    freezeState(this.configuredDefinition)
    this.current = copyState(state)
  }

  static async create(
    definition: ExperimentDefinition,
    releaseDigest: string,
    runId: string,
    now = new Date().toISOString(),
    runtimeRelease?: RuntimeRelease,
    executionAuthority?: ExecutionAuthority,
  ): Promise<RunMachine> {
    validateExperiment(definition)
    assertRunId(runId)
    if (!/^[0-9a-f]{64}$/.test(releaseDigest)) throw new TypeError('release digest is invalid')
    if (runtimeRelease !== undefined) assertRuntimeRelease(runtimeRelease)
    if (executionAuthority === undefined) throw new Error('current execution requires explicit authority')
    {
      assertExecutionAuthority(executionAuthority)
      if (executionAuthority.auditId !== runId || executionAuthority.executionId !== runId
        || executionAuthority.epoch !== 0 || executionAuthority.runtimeDigest !== await sha256(runtimeRelease ?? null)) {
        throw new Error('root execution authority differs from its audit or runtime')
      }
    }
    const definitionDigest = await sha256(definition)
    let state: RunState = {
      schemaVersion: 3,
      experimentId: definition.id,
      runId,
      executionAuthority: deepClone(executionAuthority),
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
      experimentId: definition.id, runId, executionAuthority: deepClone(executionAuthority),
      releaseDigest,
      definitionDigest,
      ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
    }, now)
    return new RunMachine(definition, state, await ExecutionReleases.create(definition, state))
  }

  static async fromState(definition: ExperimentDefinition, state: RunState, loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader): Promise<RunMachine> {
    validateExperiment(definition)
    if (state.schemaVersion !== 3 || state.executionAuthority === undefined || loadExecution?.assertSelected === undefined) {
      throw new Error('execution requires a selected snapshot from its owning app version')
    }
    const snapshot = copyState(state)
    await loadExecution.assertSelected(snapshot)
    if (snapshot.definitionDigest !== await sha256(definition) || snapshot.experimentId !== definition.id) {
      throw new Error('selected execution definition differs')
    }
    const releases = await ExecutionReleases.create(definition, snapshot, loadRelease, loadExecution)
    return new RunMachine(definition, snapshot, releases)
  }

  /** Prepare an independent controlled root from verified source evidence. This
   * grants neither activation nor dispatch; the command executor owns both. */
  static async fork(prepared: StageForkSeed, runId: string, runtimeRelease: RuntimeRelease,
    loadRelease: ReleaseLoader, loadExecution: ExecutionSourceLoader, now = new Date().toISOString()): Promise<RunMachine> {
    const authority = { auditId: runId, executionId: runId, epoch: 0, runtimeDigest: await sha256(runtimeRelease) }
    prepared = await bindStageForkSeed(prepared, authority, loadRelease)
    const definition = prepared.release.body.definition
    const root = await RunMachine.create(definition, prepared.release.digest, runId, now, runtimeRelease, authority)
    const state = root.snapshot(), origin = stageForkOrigin(prepared)
    const { digest: _digest, ...created } = state.journal[0]!
    const event = { ...created, payload: { ...(created.payload as Record<string, unknown>), forkOrigin: origin } }
    let imported: RunState = { ...state, forkOrigin: origin,
      rootCreatedAt: prepared.source.rootCreatedAt, modelStartedAt: prepared.source.modelStartedAt,
      phase: phaseForStage(definition.stages[prepared.stageIndex]), cursor: { stageIndex: prepared.stageIndex, waveIndex: prepared.waveIndex },
      artifacts: copyState(prepared.artifacts), rejectedAttempts: copyState(prepared.rejectedAttempts), waveReceipts: copyState(prepared.waveReceipts), stageEndReceipts: copyState(prepared.stageEndReceipts),
      availabilityBoundaries: deepClone(prepared.availabilityBoundaries),
      ...(prepared.discoveryScheduler === undefined ? {} : { discoveryScheduler: deepClone(prepared.discoveryScheduler) }),
      budget: deepClone(prepared.source.budget), waveAdmission: deepClone(prepared.waveAdmission ?? null), journal: [{ ...event, digest: await sha256(event) }],
    }
    if (prepared.boundary.sourceFrontier === true) {
      imported = await appendEvent({ ...imported, status: 'running' }, 'run.started', { cursor: imported.cursor }, now)
      if (prepared.waveAdmission !== undefined) imported = await appendEvent(imported, 'wave.admitted', prepared.waveAdmission, now)
      for (const admission of prepared.discoveryScheduler?.admissions ?? []) imported = await appendEvent(imported, 'discovery.cohort-admitted', admission, now)
    }
    return new RunMachine(definition, imported, await ExecutionReleases.create(definition, imported, loadRelease, loadExecution))
  }

  /** Complete published definition for admitted work; never merge it with the active manifest. */
  async executionDefinition(reference = executionConfiguration(this.current)): Promise<ExperimentDefinition> {
    return this.releases.definition(reference)
  }

  /** Read-only lookups share the execution's frozen definition instead of copying it. */
  private async executionDefinitionView(reference: ExecutionConfiguration): Promise<ExperimentDefinition> {
    return this.releases.definitionView(reference)
  }

  /** Internal read-only view. State transitions replace branches; never mutate this view. */
  view(): RunState {
    freezeState(this.current)
    producedStates.add(this.current)
    return this.current
  }

  snapshot(): RunState {
    return copyState(this.current)
  }

  async applyAdmissionControl(operation: RunOperation, now = new Date().toISOString()) {
    const controls = await applyAdmissionControl(this.definition, this.current, operation, now)
    if (this.current.controls?.revision === controls.revision) return controls.lastReceipt
    this.current = await appendEvent({ ...this.current, controls }, 'run.control-settled', controls, now)
    return copyState(controls.lastReceipt)
  }

  /** Internal whole-audit cancellation after native stop and launch settlement. */
  async cancelAudit(operation: RunOperation, proof: AuditCancellationProof, now = new Date().toISOString()) {
    const previous = this.current
    const controls = await settledControlState(previous, operation, previous.controls?.pauses ?? [], { status: 'applied' }, now)
    if (previous.controls?.revision === controls.revision) {
      await assertAuditCancellation(previous)
      const effect = previous.journal.at(-2)?.payload as import('./run-control-state.js').AuditCancellationEffect | undefined
      if (effect?.proofDigest !== proof.proofDigest || effect.inventoryDigest !== proof.inventoryDigest
        || canonicalJson(effect.source) !== canonicalJson(operation.source)) throw new Error('audit cancellation proof differs')
      return copyState(controls.lastReceipt)
    }
    const effect = await auditCancellationEffect(previous, operation, proof)
    let candidate = await appendEvent({ ...previous, controls, inFlightAgentAttempts: [],
      status: 'stopped', phase: 'stopped', terminalReason: operation.command.reason }, 'run.cancelled', effect, now)
    candidate = await appendEvent(candidate, 'run.control-settled', controls, now)
    await assertAuditCancellation(candidate)
    if (this.current !== previous) throw new Error('audit cancellation predecessor changed')
    this.current = candidate
    return copyState(controls.lastReceipt)
  }

  async rejectControl(operation: RunOperation, detail: Extract<RunControlOutcome, { status: 'rejected' }>['detail'],
    now = new Date().toISOString()) {
    const controls = await settledControlState(this.current, operation, this.current.controls?.pauses ?? [], { status: 'rejected', detail }, now)
    if (this.current.controls?.revision === controls.revision) return copyState(controls.lastReceipt)
    this.current = await appendEvent({ ...this.current, controls }, 'run.control-settled', controls, now)
    return copyState(controls.lastReceipt)
  }

  /** Caller serializes transitions. A failed admission write cannot leak into a later drain write.
   * Lost external acknowledgements are reconciled by reloading the authoritative state, not by this rollback. */
  async persistAdmission<T>(transition: () => Promise<T>, persist?: (state: RunState) => Promise<void>): Promise<T> {
    const previous = this.current
    try {
      const result = await transition()
      await persist?.(this.view())
      return result
    } catch (error) {
      this.current = previous
      throw error
    }
  }

  async start(now = new Date().toISOString()): Promise<void> {
    if (this.current.status === 'created') {
      this.current = await appendEvent({ ...this.current, status: 'running' }, 'run.started', {
        cursor: this.current.cursor,
      }, now)
    }
    // Register the imported boundary before admitting new work. Retrying start
    // after its durable event can finish the seal without replaying a model call.
    if (this.current.forkOrigin !== undefined && this.current.status === 'running'
      && this.current.forkOrigin.sourceFrontier !== true
      && this.current.journal.length === 2 && this.current.journal[1]?.type === 'run.started'
      && this.current.checkpoints.length === 0) await this.seal(now)
  }

  async recordFailure(task: TaskDefinition, error: unknown, now = new Date().toISOString(), taskExecutionId?: string): Promise<void> {
    this.assertRunning()
    const classified = error instanceof RunFailure ? error : null
    const state = this.current
    const failed = await appendEvent(state, 'task.failed', {
      taskId: task.id,
      ...(taskExecutionId === undefined ? {} : { taskExecutionId }),
      error: error instanceof Error ? error.message : String(error),
      ...(classified === null ? {} : { category: classified.category, retryable: classified.retryable }),
    }, now)
    persistedTerminalTaskFailures(failed)
    if (this.current !== state) throw new Error('task failure predecessor changed')
    this.current = failed
  }

  async recordRejectedAttempt(rejection: Omit<RejectedAttempt, 'rejectedAt'>, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    if (rejection.execution === undefined) throw new Error('controlled rejection lacks its task occurrence')
    assertTaskOccurrenceExecution(selectedTaskOccurrence(this.current, rejection.taskId), rejection.execution)
    assertExecutionContract(rejection.execution)
    const admittedExecution = this.current.inFlightAgentAttempts?.find(attempt => attempt.taskId === rejection.taskId
      && attempt.attempt === rejection.attempt)?.execution
    if (rejection.execution.runId !== this.current.runId || rejection.execution.attempt !== rejection.attempt
      || (admittedExecution !== undefined && canonicalJson(admittedExecution) !== canonicalJson(rejection.execution))) {
      throw new Error('rejected attempt differs from its dispatched execution contract')
    }
    const normalized = deepClone(rejection)
    const identity = rejectedAttemptIdentity(normalized)
    const previous = this.current.rejectedAttempts.find(attempt => rejectedAttemptIdentity(attempt) === identity)
    if (previous !== undefined) {
      const admitted = this.current.inFlightAgentAttempts?.find(attempt => matchesAgentAttemptOutcome(previous, attempt))
      if (admitted !== undefined
        && !hasRecordedAttemptOutcome(this.current.journal, admitted)) {
        const source = this.current.journal.find(event => event.type === 'task.attempt-rejected'
          && canonicalJson(event.payload) === canonicalJson(previous))
        if (source === undefined) throw new Error('reobserved rejection lacks its original receipt')
        const observed = await appendEvent(this.current, 'task.rejection-observed', { sourceEventDigest: source.digest }, now)
        if (!matchesRecordedAttemptOutcome(observed.journal.at(-1)!, observed.journal, admitted)) {
          throw new Error('reobserved rejection request differs from its original admission')
        }
        this.current = observed
      }
      return
    }
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

  private async assertExecutionInputs(task: TaskDefinition, execution: ArtifactExecution,
    stageId: string, waveId: string): Promise<void> {
    const cohort = this.current.discoveryScheduler?.admissions.find(value => value.stageId === stageId
      && value.waveId === waveId && value.taskIds.includes(task.id))
    const admission = cohort ?? this.current.waveAdmission
    if (admission == null || admission.stageId !== stageId || admission.waveId !== waveId) {
      throw new Error('execution lacks its live wave admission')
    }
    const frontier = await frozenAdmissionArtifacts(this.current.artifacts, admission)
    const definition = await this.executionDefinitionView(executionConfiguration(execution))
    const refs = artifactReferences(cohort !== undefined ? frontier : selectVisibleArtifacts(task, frontier,
      this.current.waveReceipts, this.current.waveAdmission!.cursor.stageIndex,
      this.current.waveAdmission!.cursor.waveIndex, definition))
    if (execution.inputCount !== refs.length || execution.inputDigest !== await sha256(refs)) {
      throw new Error('execution inputs differ from the admitted frontier')
    }
  }

  async admitAgentAttempt(
    admission: Omit<InFlightAgentAttempt, 'admittedAt'>,
    now = new Date().toISOString(),
  ): Promise<string> {
    this.assertRunning()
    if (admission.execution === undefined) {
      throw new Error('controlled attempt lacks its task occurrence')
    }
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
    const configuration = selectedTaskOccurrence(this.current, admission.taskId)?.configuration
      ?? discoveryAdmission?.configuration ?? waveAdmission?.configuration ?? executionConfiguration(this.current)
    const definition = await this.executionDefinitionView(configuration)
    let task = definition.stages.find(stage => stage.id === admission.stageId)?.waves
      .find(wave => wave.id === admission.waveId)?.tasks.find(candidate => candidate.id === admission.taskId)
    const peer = discoveryAdmission?.peerPredecessors[admission.taskId]
    if (task?.research !== undefined && peer !== undefined) task = { ...task, research: { ...task.research, buildsOn: peer } }
    if (task === undefined) throw new Error(`agent attempt task is missing: ${admission.taskId}`)
    assertAgentAttemptPolicy(task, admission, this.current.rejectedAttempts)
    if (admission.execution !== undefined) {
      await this.assertExecutionInputs(task, admission.execution, admission.stageId, admission.waveId)
      assertExecutionContract(admission.execution)
      assertTaskOccurrenceExecution(selectedTaskOccurrence(this.current, admission.taskId), admission.execution)
      if (admission.execution.taskDigest !== await sha256(task)) throw new Error('agent attempt task differs from its configured admission')
      if (admission.execution.runId !== this.current.runId || admission.execution.attempt !== admission.attempt
        || canonicalJson(executionConfiguration(admission.execution)) !== canonicalJson(configuration)) {
        throw new Error('agent attempt execution contract differs from its configured admission')
      }
    }
    const attempts = this.current.inFlightAgentAttempts ?? []
    const existing = attempts.find(value => value.stageId === admission.stageId
      && value.waveId === admission.waveId && value.taskId === admission.taskId)
    if (existing !== undefined) {
      const { admittedAt: _admittedAt, ...identity } = existing
      if (canonicalJson(identity) !== canonicalJson(admission)) {
        throw new Error(`agent attempt admission changed while in flight: ${admission.taskId}`)
      }
      const event = agentAttemptAdmission(this.current.journal, existing)
      if (event === undefined) throw new Error('agent attempt admission has no journal event')
      return event.digest
    }
    if (discoveryAdmission !== undefined && !discoveryRepairAllowed(definition, this.current, task.id)) {
      throw new PermanentRunFailure(`model-call budget admission denied for ${task.id}`, 'budget-exhausted')
    }
    const record = { ...deepClone(admission), admittedAt: now }
    this.current = await appendEvent({
      ...this.current, inFlightAgentAttempts: [...attempts, record],
    }, 'agent.attempt-admitted', record, now)
    return this.current.journal.at(-1)!.digest
  }

  async clearAgentAttempt(
    outcome: Pick<ArtifactRecord, 'stageId' | 'waveId' | 'taskId' | 'promptDigest' | 'execution'> & { admissionDigest?: string },
    now = new Date().toISOString(),
  ): Promise<void> {
    this.assertRunning()
    const state = this.current
    const { stageId, waveId, taskId, promptDigest } = outcome
    const attempts = state.inFlightAgentAttempts ?? []
    const existing = attempts.find(value => value.stageId === stageId && value.waveId === waveId
      && value.taskId === taskId)
    if (existing === undefined) return
    if (existing.promptDigest !== promptDigest || !matchesAgentAttemptOutcome(outcome, existing)
        || outcome.admissionDigest === undefined
        || outcome.admissionDigest !== agentAttemptAdmission(state.journal, existing)?.digest) {
      throw new Error(`agent attempt completion differs from its admission: ${taskId}`)
    }
    if (!hasRecordedAttemptOutcome(state.journal, existing)) {
      throw new Error(`agent attempt has no recorded outcome: ${taskId}`)
    }
    const finished = await appendEvent({
      ...state,
      inFlightAgentAttempts: attempts.filter(value => value !== existing),
    }, 'agent.attempt-finished', { stageId, waveId, taskId, promptDigest,
      admissionDigest: outcome.admissionDigest,
    }, now)
    if (this.current !== state) throw new Error('agent attempt completion predecessor changed')
    this.current = finished
  }

  async recordResult(input: {
    wave: WaveDefinition
    task: TaskDefinition
    promptDigest: string
    result: AgentResult
    artifactStore: ArtifactStore
    stageId: string
    attempt: number
    inputArtifacts: readonly ArtifactReference[]
    execution?: ArtifactExecution
  }, now = new Date().toISOString()): Promise<ArtifactRecord> {
    this.assertRunning()
    const usage = {
      modelCalls: input.result.modelCalls ?? (input.task.providerClass === 'deterministic' ? 0 : 1),
      inputTokens: input.result.inputTokens,
      ...(input.result.subscriptionWaits === undefined ? {} : { subscriptionWaits: input.result.subscriptionWaits }),
      ...(input.result.subscriptionSwitches === undefined ? {} : { subscriptionSwitches: input.result.subscriptionSwitches }),
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
    if (input.execution === undefined) {
      throw new Error('controlled result requires its dispatched execution contract')
    }
    const execution = input.execution ?? await artifactExecution({ state: this.current, task: input.task,
      attempt: input.attempt, inputArtifacts: input.inputArtifacts, store: input.artifactStore })
    assertTaskOccurrenceExecution(selectedTaskOccurrence(this.current, input.task.id), execution)
    await assertDispatchedExecution(execution, { runId: this.current.runId, task: input.task,
      attempt: input.attempt, inputArtifacts: input.inputArtifacts })
    const configuration = selectedTaskOccurrence(this.current, input.task.id)?.configuration
      ?? this.current.discoveryScheduler?.admissions.find(admission => admission.stageId === input.stageId
      && admission.waveId === input.wave.id && admission.taskIds.includes(input.task.id))?.configuration
      ?? (this.current.waveAdmission?.stageId === input.stageId && this.current.waveAdmission.waveId === input.wave.id
        ? this.current.waveAdmission.configuration : undefined)
    if (configuration !== undefined && canonicalJson(executionConfiguration(execution)) !== canonicalJson(configuration)) {
      throw new Error('result execution contract differs from its durable admission')
    }
    const admittedExecution = this.current.inFlightAgentAttempts?.find(attempt => attempt.taskId === input.task.id
      && attempt.attempt === input.attempt)?.execution
    if (admittedExecution !== undefined && canonicalJson(admittedExecution) !== canonicalJson(execution)) {
      throw new Error('result execution contract differs from its durable admission')
    }
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
      execution: deepClone(execution),
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
    if (input.result.provider !== providerIdentity(input.task) || input.result.model !== input.task.model) {
      throw new Error('result provider or model differs from its task')
    }
    await this.assertExecutionInputs(input.task, execution, input.stageId, input.wave.id)
    const attempt = this.current.inFlightAgentAttempts?.find(value => matchesAgentAttemptOutcome(candidate, value))
    if (input.task.providerClass !== 'deterministic' && attempt === undefined
      && !await isAvailabilityBoundaryAcceptance({ ...candidate, uri: '' }, input.task, this.current,
        this.definition, this.releases.importedAvailability)) {
      throw new Error('native acceptance lacks its exact admitted attempt')
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
    const availabilityBoundaries = recordAvailabilityBoundary(this.current.availabilityBoundaries, record, input.task, now)
    this.current = await appendEvent({
      ...this.current,
      artifacts: [...this.current.artifacts, record],
      availabilityBoundaries,
      budget: nextBudget,
    }, 'task.accepted', { artifact: record }, now)
    if (violation !== null) throw new Error(violation)
    return record
  }

  async assertWaveComplete(stageId: string, wave: WaveDefinition): Promise<void> {
    const records = this.current.artifacts.filter((artifact) => artifact.stageId === stageId && artifact.waveId === wave.id)
    const imported = new Set(this.importedSeed?.artifacts.map(record => canonicalJson(record)) ?? [])
    for (const record of records) {
      if (imported.has(canonicalJson(record))) continue
      if (record.execution === undefined) throw new Error('completed task lacks its selected occurrence')
      assertAcceptedTaskOccurrence(selectedTaskOccurrence(this.current, record.taskId), record)
    }
    const tasks = await Promise.all(wave.tasks.map(task => {
      if (records.some(record => record.taskId === task.id && imported.has(canonicalJson(record)))) return task
      const selected = admittedTaskOccurrence(this.current.waveAdmission, task.id)
      return this.releases.task(selected.configuration, { stageId, waveId: wave.id, taskId: task.id }, selected.taskDigest)
    }))
    assertWaveRecordsComplete(records, stageId, wave, tasks)
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
    const state = this.current
    const inputArtifacts = artifactReferences(state.artifacts)
    const configuration = executionConfiguration(state)
    const taskOccurrences = await initialTaskOccurrences(state.executionAuthority!, configuration, wave.tasks, {})
    const admission = { configuration, taskOccurrences, stageId, waveId,
      cursor: deepClone(state.cursor), admittedAt: now, inputArtifacts, inputDigest: await sha256(inputArtifacts) }
    const admitted = await appendEvent({ ...state, waveAdmission: admission }, 'wave.admitted', admission, now)
    if (this.current !== state) throw new Error('wave admission predecessor changed')
    this.current = admitted
  }

  async initializeDiscoveryScheduler(stageId: string, now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    const stage = this.definition.stages[this.current.cursor.stageIndex]
    if (stage?.id !== stageId || stage.kind !== 'discovery') {
      throw new Error('discovery scheduler differs from the current stage')
    }
    if (this.current.discoveryScheduler !== undefined) return
    assertIndependentDiscoveryFrontier(this.definition, this.current)
    const scheduler = initialDiscoveryProgress(this.definition, stageId)
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
    const state = this.current
    const scheduler = state.discoveryScheduler
    const stage = this.definition.stages[state.cursor.stageIndex]
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
    const budgetAtAdmission = deepClone(existing?.budgetAtAdmission ?? state.budget)
    assertBudgetShape(budgetAtAdmission)
    const inputArtifacts = [...input.inputArtifacts]
      .toSorted((left, right) => compareText(left.id, right.id) || compareText(left.contentDigest, right.contentDigest))
    if (new Set(inputArtifacts.map(reference => reference.id)).size !== inputArtifacts.length) {
      throw new Error(`discovery pool ${input.poolId} input contains duplicate artifact identities`)
    }
    const inputDigest = await sha256(inputArtifacts)
    if (existing !== undefined) {
      const expected = { ...existing, admittedAt: now }
      const candidate = {
        configuration: executionConfiguration(state),
        taskOccurrences: existing.taskOccurrences,
        stageId: input.stageId, poolId: input.poolId, waveId: wave.id, waveIndex: input.waveIndex,
        taskIds, admittedAt: now, budgetAtAdmission, inputArtifacts, inputDigest,
        materialEpoch: scheduler.materialEpoch, peerPredecessors: deepClone(input.peerPredecessors),
      }
      if (canonicalJson(expected) !== canonicalJson(candidate)) {
        throw new Error(`discovery pool ${input.poolId} already has another cohort admitted`)
      }
      return deepClone(existing)
    }
    const frontier = artifactReferences(selectSealedArtifacts(state.artifacts, state.waveReceipts)
      .filter(isDiscoveryFrontierArtifact))
    if (canonicalJson(inputArtifacts) !== canonicalJson(frontier)) {
      throw new Error('discovery cohort inputs differ from the complete sealed research frontier')
    }
    const availability = await applicableAvailabilityBoundaries(this.current, executionConfiguration(state),
      this.definition, this.importedAvailability)
    if (!discoveryAdmissionAllowed(this.definition, this.current, input.poolId, availability, Date.parse(now), this.importedDiscoveryWaits)) {
      throw new Error('discovery cohort violates its admission policy')
    }
    const taskOccurrences = await initialTaskOccurrences(state.executionAuthority!, executionConfiguration(state),
        wave.tasks.filter(task => taskIds.includes(task.id)), input.peerPredecessors)
    const admission: DiscoveryCohortAdmission = {
      taskOccurrences,
      configuration: executionConfiguration(state),
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
    const admitted = await appendEvent({
      ...state,
      discoveryScheduler: { ...scheduler, admissions: [...scheduler.admissions, admission] },
    }, 'discovery.cohort-admitted', admission, now)
    if (this.current !== state) throw new Error('discovery admission predecessor changed')
    this.current = admitted
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
    const state = this.current
    assertNoUnprovenTaskAbandonment(admission)
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
    if (canonicalJson(admission.configuration) !== canonicalJson(executionConfiguration(this.current))) {
      throw new Error('discovery admission differs from its immutable manifest')
    }
    const predecessor = materialDelta && coalesceMaterialDelta
      ? discoveryCoalescingPredecessor(this.current.journal, stageId) : undefined
    if (materialDelta && coalesceMaterialDelta && (predecessor === undefined
      || predecessor.materialEpochAfter !== scheduler.materialEpoch)) {
      throw new Error('discovery coalescing lacks its prior material completion')
    }
    const progress = completeDiscoveryProgress(scheduler, admission, {
      materialDelta, unavailable, stopOnSaturation: this.definition.stopOnSaturation !== false,
      coalesced: predecessor !== undefined,
    })
    const artifactRefs = records.map(record => ({ id: record.id, contentDigest: record.contentDigest }))
      .toSorted((left, right) => compareText(left.id, right.id) || compareText(left.contentDigest, right.contentDigest))
    const artifactDigests = records.map(record => record.contentDigest).toSorted()
    const receipt = {
      configuration: deepClone(admission.configuration),
      taskOccurrences: deepClone(admission.taskOccurrences),
      stageId,
      waveId: wave.id,
      poolId,
      inputArtifacts: admission.inputArtifacts,
      inputDigest: admission.inputDigest,
      peerPredecessors: admission.peerPredecessors,
      materialEpoch: admission.materialEpoch,
      materialHighCriticalDelta: materialDelta,
      materialEpochAfter: progress.materialEpoch,
      ...(predecessor === undefined ? {} : { coalescedWith: await sha256(predecessor) }),
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
    if (this.current !== state) throw new TransientRunFailure('discovery receipt predecessor changed')
    this.current = await appendEvent({
      ...this.current,
      waveReceipts: [...this.current.waveReceipts, receipt],
      discoveryScheduler: progress,
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
    await this.assertWaveComplete(stageId, wave)
    const admission = this.current.waveAdmission
    if (admission === undefined || admission === null || admission.stageId !== stageId || admission.waveId !== wave.id) {
      throw new Error(`wave completed without durable admission: ${stageId}/${wave.id}`)
    }
    const receipt = {
      taskOccurrences: deepClone(admission.taskOccurrences),
      configuration: deepClone(admission.configuration),
      inputArtifacts: deepClone(admission.inputArtifacts), inputDigest: admission.inputDigest,
      stageId,
      waveId: wave.id,
      startedAt,
      completedAt,
      durationMs,
      artifactDigests,
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
    if (endedStageIndex !== this.current.cursor.stageIndex || endedStageIndex !== this.current.stageEndReceipts.length
      || (this.current.inFlightAgentAttempts?.length ?? 0) !== 0) throw new Error('stage closure differs from the settled cursor')
    const stage = this.definition.stages[endedStageIndex]!
    if (stage.kind !== 'discovery') {
      const waves = this.current.waveReceipts.filter(value => value.stageId === stage.id)
      const expectedReason = stage.kind === 'preflight' ? 'preflight-passed'
        : stage.kind === 'reporting' ? 'completion-contract-passed' : 'stage-complete'
      const expectedEvidence = { finalWave: stage.waves.at(-1)!.id,
        artifacts: this.current.artifacts.filter(value => value.stageId === stage.id).map(value => value.contentDigest).toSorted() }
      if (canonicalJson(waves.map(value => value.waveId)) !== canonicalJson(stage.waves.map(value => value.id))
        || reason !== expectedReason || canonicalJson(evidence) !== canonicalJson(expectedEvidence)) {
        throw new Error('stage closure lacks its completed waves and evidence')
      }
    }
    if (stage.kind === 'discovery') {
      if (evidence === null || typeof evidence !== 'object') throw new Error('discovery closure evidence is missing')
      const { decidedAt, decisionJournalHead, disposal: _disposal, ...decisionEvidence } = evidence as Record<string, unknown>
      if (typeof decidedAt !== 'string' || !Number.isFinite(Date.parse(decidedAt))
        || Date.parse(decidedAt) > Date.parse(now) || decisionJournalHead !== this.current.journal.at(-1)?.digest) {
        throw new Error('discovery closure differs from its decision frontier')
      }
      const predecessor = this.current
      const availability = await applicableAvailabilityBoundaries(predecessor, executionConfiguration(predecessor),
        this.definition, this.importedAvailability)
      const decision = discoveryClosureDecision(this.definition, predecessor, availability, Date.parse(decidedAt), this.importedDiscoveryWaits)
      if (this.current !== predecessor || decision === null || reason !== decision.reason
        || canonicalJson(decisionEvidence) !== canonicalJson(decision.evidence)) throw new Error('discovery closure violates its admission policy')
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
      configuration: executionConfiguration(this.current),
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
    const stage = this.definition.stages[this.current.cursor.stageIndex], wave = stage?.waves[this.current.cursor.waveIndex]
    const normalized = normalizeCursor(this.definition, cursor)
    const expected = normalizeCursor(this.definition, { ...this.current.cursor, waveIndex: this.current.cursor.waveIndex + 1 })
    if (this.current.waveAdmission != null || (this.current.discoveryScheduler?.admissions.length ?? 0) !== 0
      || (this.current.inFlightAgentAttempts?.length ?? 0) !== 0 || wave === undefined
      || !this.current.waveReceipts.some(value => value.stageId === stage!.id && value.waveId === wave.id && value.poolId === undefined)
      || canonicalJson(normalized) !== canonicalJson(expected)) throw new Error('cursor advancement requires its completed wave')
    this.current = await appendEvent({ ...this.current, cursor: normalized }, 'cursor.advanced', normalized, now)
  }

  async verifyCheckpoint(checkpoint: SealedCheckpoint): Promise<void> {
    if (this.releases === undefined) throw new Error('checkpoint verification requires a controlled audit')
    await verifyRegisteredCheckpoint(checkpoint, this.view())
  }

  async seal(now = new Date().toISOString()): Promise<SealedCheckpoint> {
    this.assertRunning()
    const state = this.current
    if (state.waveAdmission !== undefined && state.waveAdmission !== null) {
      throw new Error('cannot seal a checkpoint while a wave is admitted')
    }
    if ((state.discoveryScheduler?.admissions.length ?? 0) !== 0) {
      throw new Error('cannot seal a portable checkpoint while a discovery cohort is admitted')
    }
    if ((state.inFlightAgentAttempts?.length ?? 0) !== 0) throw new Error('cannot seal a checkpoint with admitted agent attempts')
    const journalHead = state.journal.at(-1)?.digest
    if (journalHead === undefined) throw new Error('cannot seal an empty journal')
    const body = checkpointBody(state, now)
    const checkpoint: SealedCheckpoint = { digest: await sha256(body), body }
    if (this.current !== state) throw new Error('checkpoint predecessor changed during validation')
    const sealed = await appendEvent({
      ...state,
      checkpoints: [...state.checkpoints, checkpoint],
    }, 'checkpoint.sealed', { digest: checkpoint.digest, cursor: checkpoint.body.cursor }, now)
    if (this.current !== state) throw new Error('checkpoint predecessor changed during sealing')
    this.current = sealed
    return copyState(checkpoint)
  }

  async complete(now = new Date().toISOString()): Promise<void> {
    this.assertRunning()
    if (normalizeCursor(this.definition, this.current.cursor).stageIndex !== this.definition.stages.length) {
      throw new Error('cannot complete before every stage boundary')
    }
    this.current = await appendEvent({ ...this.current, status: 'completed', phase: 'complete', terminalReason: 'completed' },
      'run.completed', { artifacts: this.current.artifacts.length }, now)
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
