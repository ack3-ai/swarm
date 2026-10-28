export const AUDIT_STAGES = [
  'discovery',
  'synthesis',
  'coverage',
  'negative-review',
  'verification',
  'reporting',
] as const

export type AuditStageKind = (typeof AUDIT_STAGES)[number]
export type StagePrompts = Partial<Record<AuditStageKind, string>>
export const STAGE_KINDS = ['preflight', ...AUDIT_STAGES] as const

export type StageKind = (typeof STAGE_KINDS)[number]
export type ProviderClass = 'deterministic' | 'core' | 'additive'
export type ModelBackend = 'codex' | 'claude' | 'dsh-chat-completions'
export type ProviderIdentity = string
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'
export type ThinkingMode = 'enabled' | 'disabled'
export type SubagentPolicy = { mode: 'disabled' } | { mode: 'native'; maxConcurrent: number }
export type SubagentStage = AuditStageKind
export type RunPhase = 'preparation' | 'discovery' | 'synthesis' | 'coverage' | 'negative-review' | 'verification' | 'reporting' | 'complete' | 'stopped'
export type RetryPolicy = 'none' | 'same-session-repair' | 'fresh-repair' | 'redirect-then-fresh-replacement'

export type ArtifactVisibility = 'none' | 'previous-wave' | 'accepted-frontier' | 'all-accepted'

export interface TargetSnapshot {
  repository: string
  commit: string
  tree: string
  sourcePackageVersion: 2
  production: false
  resettable: true
  runtime: {
    environmentBindings: Readonly<Record<string, string>>
    preflightCommands: readonly string[]
    /** Optional for releases sealed before per-workspace preparation existed. */
    workspacePreparation?: {
      schemaVersion: 1
      workingDirectory: string
      commands: readonly string[]
      integrityFiles: readonly { path: string; sha256: string }[]
    }
  }
}

export interface OutputContract {
  schema: string
  requiredFiles: readonly string[]
  requiredSections?: readonly string[]
}

export interface ResearchAssignment {
  wave: number
  researcher: number
  /** Lane label from the research plan; shown in the dashboard, never in prompts. */
  role: string
  /** Accepted research this lane receives as peer evidence, or none. */
  buildsOn: string
  laneScratchPath: string
}

export interface TaskDefinition {
  id: string
  logicalRole: string
  objective: string
  providerClass: ProviderClass
  /** Optional only so releases sealed before provider routing was explicit remain replayable. */
  backend?: ModelBackend
  /** Explicit provider identity for generic DSH connections; absent in historical packages. */
  provider?: string
  /** Native DSH Chat Completions connection; absent in historical packages. */
  connection?: ModelConnection
  /** Exact originating pool for newly compiled releases; absent in historical packages. */
  modelPool?: string
  /** Secrets Store binding selected for a native subscription account. */
  credentialSource?: string
  model: string
  reasoning: ReasoningEffort
  thinking?: ThinkingMode
  /** Optional only so releases sealed before subagent controls remain replayable. */
  subagents?: SubagentPolicy
  promptKind: 'preflight' | 'research' | 'synthesis' | 'coverage-challenge' | 'coverage-union' | 'negative-review' | 'review-union' | 'verification' | 'reporting' | 'final-seal'
  visibility: ArtifactVisibility
  workspaceMode: 'control' | 'continuation' | 'fresh-pristine'
  workspaceKey: string
  output: OutputContract
  research?: ResearchAssignment
  perspective?: 'effective-state' | 'architecture' | 'resource-lifecycle' | 'open-adversarial'
  observationPrefix?: string
  requiredTable?: string
  optional?: boolean
  retryPolicy: RetryPolicy
}

export interface ReplicationContract {
  id: 'open-adversarial-coverage' | 'negative-review'
  taskIds: readonly string[]
  minSuccessfulAgents: number
  minDistinctProviders: number
  minDistinctModels: number
  mergePolicy: 'union-preserve-dissent'
  allowAttestedAdditiveUnavailability: true
}

export interface WaveDefinition {
  id: string
  tasks: readonly TaskDefinition[]
  minSuccessfulTasks: number
  minDistinctActors: number
  replication?: ReplicationContract
}

export interface StageDefinition {
  id: string
  kind: StageKind
  objective: string
  waves: readonly WaveDefinition[]
}

export interface ExperimentLimits {
  maxWallTimeMs: number
  /** Discovery-only admission guard. */
  maxModelCalls: number
  /** Optional discovery-only accounting guard. */
  maxInputTokens?: number
  /** Optional discovery-only accounting guard. */
  maxOutputTokens?: number
  /** Discovery-only admission guard. */
  maxCostUsd: number
  /** Discovery admission window; later stages run until their tasks finish. */
  phaseMinutes: {
    discovery: number
  }
}

export interface PromptPolicy {
  /** Legacy sealed-release metadata; v2 operator manifests use authenticated control-plane access. */
  authorization?: string
  outcome: string
  doneWhen: readonly string[]
  notDoneWhen: readonly string[]
  evidenceRules: readonly string[]
  completionRules: readonly string[]
}

/** Every instruction text agents receive, sealed per release. Placeholders use {{NAME}}. */
export interface PromptCatalog {
  researcherProtocol: string
  securityResearcherRole: string
  verifierRole: string
  coverageInstructions: string
  negativeReviewInstructions: string
  synthesisInstructions: string
  verificationInstructions: string
  reportingInstructions: string
  preflightInstructions: string
  assignmentPreamble: string
  researchLeadChecks: string
  negativeReviewView: string
  synthesisLeadChecks: string
  verificationAssignments: string
  handoffIntro: string
  handoffClosing: string
  searchQueries: string
  coverageReferences: string
  verificationEvidenceMethod: string
  reportingEvidenceMethod: string
  reportSections: string
  researchLeadCheckRules: string
  nextExperiment: string
  leadReconciliation: string
  searchQuestion: string
  searchTriggerLeads: string
  searchTriggerNarrowing: string
  searchTriggerDismissal: string
  searchOptional: string
  searchObjective: string
  searchPrivacy: string
  repairDiagnostics: string
  correctionSearchMissing: string
  correctionCitations: string
  correctionSearchUpdate: string
  correctionFormat: string
  correctionDiagnostics: string
}

export interface AgentRoleDefinition {
  id: 'lead' | 'security-researcher' | 'verifier'
  description: string
  seats: number
  toolset: 'coordination' | 'security-testing' | 'independent-verification'
}

export interface ModelPool {
  id: string
  backend: ModelBackend
  /** Explicit provider identity for generic DSH connections; absent in historical packages. */
  provider?: string
  /** Native DSH Chat Completions connection; absent in historical packages. */
  connection?: ModelConnection
  model: string
  /** Optional only so immutable releases sealed before per-pool controls remain replayable. */
  reasoningEffort?: ReasoningEffort
  /** Optional only so immutable releases sealed before per-pool controls remain replayable. */
  thinking?: ThinkingMode
  /** Optional only so releases sealed before subagent controls remain replayable. */
  subagents?: {
    default: SubagentPolicy
    stages?: Partial<Record<SubagentStage, SubagentPolicy>>
  }
  /** Native subscription secret binding; historical Codex labels use the default account. */
  credentialSource?: string
  agents: number
  required: boolean
}

export interface ModelConnection {
  baseUrl: string
  apiKeyEnv: string
  contextWindow?: number
  maxTokens?: number
  /** Optional operator-supplied estimate for this sealed connection and pool model. */
  costRates?: {
    uncachedInputUsdPerMillion: number
    cachedInputUsdPerMillion: number
    outputUsdPerMillion: number
  }
}

/** Native search service connection, never a secret value. Legacy connections remain readable. */
export type NativeSearchConnection = {
  provider: 'exa'
  apiKeyEnv: string
} | {
  provider?: undefined
  baseUrl: string
  apiKeyEnv: string
  model: string
}

/** Optional native web-search access for ordinary model tasks. */
export interface NativeSearchPolicy {
  enabled: boolean
  searchConnection?: NativeSearchConnection
}

export interface ExperimentDefinition {
  schemaVersion: 2
  id: string
  target: TargetSnapshot
  limits: ExperimentLimits
  policy: PromptPolicy
  prompts: PromptCatalog
  stagePrompts: StagePrompts
  /** Absent on historical sealed releases. New audit manifests resolve this explicitly. */
  forceSearch?: {
    enabled: boolean
    promptSet: string
    searchConnection?: NativeSearchConnection
  }
  /** Omitted only on releases sealed before stage-scoped search. */
  forceSearchStages?: readonly StageKind[]
  nativeSearch?: NativeSearchPolicy
  roles: readonly AgentRoleDefinition[]
  pools: readonly ModelPool[]
  discoverySafetyCeiling: number
  stopOnSaturation?: boolean
  stages: readonly StageDefinition[]
}

export interface ReleasePackageBody {
  schemaVersion: 2
  definition: ExperimentDefinition
  /** Present only for manifests that bind an approved container image. */
  environment?: { image: string }
}

export interface ReleasePackage {
  digest: string
  body: ReleasePackageBody
}

/** Immutable execution destination selected once when an audit release is activated. */
export interface RuntimeRelease {
  schemaVersion: 1
  id: string
  frameworkCommit: string
  workerService: string
  workerVersionId: string
  workflowName: string
  containerImageDigest: string
}

export interface BudgetUsage {
  modelCalls: number
  /** Uncached provider input tokens; budgets use this unit. */
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export interface ProviderUsage extends BudgetUsage {
  rawInputTokens?: number
  cachedInputTokens?: number
  cacheAccountingComplete?: boolean
  /** True only when all sampled native usage was priced by a configured rate card. */
  costAccountingComplete?: boolean
}

export interface AgentRequest {
  experimentId: string
  runId: string
  stage: StageDefinition
  wave: WaveDefinition
  task: TaskDefinition
  prompt: string
  promptDigest: string
  visibleArtifacts: readonly ArtifactRecord[]
  /** Exact frozen frontier identity for independently admitted discovery cohorts. */
  inputDigest?: string
  releaseDigest: string
  attempt: number
  /** One-based corrective output turn; absent for the original execution. */
  formatRepairOrdinal?: number
  /** Digest of the exact quarantined output being corrected. */
  formatRepairSourceDigest?: string
  diagnostics: readonly string[]
  repairFiles: Readonly<Record<string, string>>
  /** Optional handoff file collected from the same native task without making it final output. */
  optionalOutputFiles?: readonly string[]
  freshContext: boolean
  continuationMode: 'new' | 'resume'
  sessionId: string | null
  /** Closed native transport attempt whose retained session may continue. */
  nativeTransport?: NativeTransportEvidence
  /** Sealed DSH web_search connection for this model task. */
  nativeSearchConnection?: NativeSearchConnection
  /** Native Codex search availability for this model task. */
  enableNativeSearch?: boolean
  /** Existing Sandbox allocation retained by an exact failed-wave recovery. */
  workspaceAllocationRunId?: string
  retainedSandboxObjectId?: string
}

export interface NativeTransportEvidence {
  code: 'TRANSPORT' | 'TIMEOUT' | 'STREAM_CLOSED' | 'SERVER' | 'RATE_LIMIT' | 'EMPTY_RESPONSE'
  sourceRunId: string
  requestDigest: string
  sessionId: string
  snapshotDigest: string
  workState: 'none' | 'present' | 'unknown'
}

/** Closed credential rejection archived for custody, never an automatic retry grant. */
export interface NativeTerminalCustodyEvidence {
  code: 'AUTH'
  sourceRunId: string
  requestDigest: string
  sessionId: string
  snapshotDigest: string
  archiveStatus: 'available' | 'unavailable'
  workState: 'none' | 'present' | 'unknown'
}

export interface ObservationRecord {
  id: string
  statement: string
  conditions: readonly string[]
  consequence: string
  evidence: readonly string[]
}

export interface ResearchLeadCheck {
  researchQueries?: readonly string[]
  observationId: string
  claimConditions: readonly string[]
  examinedConditions: readonly string[]
  remainingUntestedConditions: readonly string[]
  evidenceMethod: 'fresh-execution' | 'prior-execution-reviewed' | 'source-inspection' | 'not-attempted'
  conclusion: 'refuted' | 'unresolved'
  evidence: string
}

export interface DispositionRecord {
  researchQueries?: readonly string[]
  id: string
  disposition: 'candidate' | 'refuted' | 'unresolved'
  reference: string
  rationale: string
}

export interface ChallengeObservation extends DispositionRecord {
  perspective: NonNullable<TaskDefinition['perspective']>
  referenceEvidence: string | null
}

export interface CoverageUnionEntry {
  observation: ChallengeObservation
  sourceTaskId: string
  actorId: string
  model: string
  provider: string
}

export interface ReviewDecision {
  researchQueries?: readonly string[]
  observationId: string
  action: 'uphold' | 'narrow' | 'overturn' | 'unresolved'
  finalDisposition: DispositionRecord['disposition']
  finalReference: string
  rationale: string
}

export interface VerificationOutcome {
  /** Absent only on archived reference-level outcomes. */
  observationIds?: readonly string[]
  researchQueries?: readonly string[]
  reference: string
  behavior: 'reproduced' | 'not-reproduced' | 'unresolved'
  exploitability: 'supported' | 'refuted' | 'unresolved'
  // Older sealed artifacts predate explicit method custody.
  evidenceMethod?: 'fresh-execution' | 'prior-execution-reviewed' | 'source-inspection' | 'not-attempted'
  evidence: string
}

export interface ReviewUnionEntry {
  observationId: string
  decisions: readonly (ReviewDecision & {
    reviewerTaskId: string
    actorId: string
    model: string
    provider: string
  })[]
  retainedReferences: readonly string[]
  dissent: boolean
}

export interface ReportSectionLink {
  observationId: string
  reference: string
  /** Exact Markdown heading line in finding-draft.md. */
  section: string
}

export interface FinalObservationCustody {
  schemaVersion: 1
  sourceReportArtifactDigest: string
  negativeReviewUnionArtifactDigest: string | null
  retainedReferences: readonly string[]
  decisionDissentObservationIds: readonly string[]
  observations: readonly {
    observationId: string
    observationDigest: string
    primaryDispositionDigest: string
    reportSections?: readonly ReportSectionLink[]
    retainedReferences: readonly string[]
    decisionDissent: boolean
  }[]
}

export interface ProtocolMetadata {
  research?: {
    role: ResearchAssignment['role']
    buildsOn: string
    nextExperiment?: string
    materialHighCriticalDelta: boolean
    observations: readonly ObservationRecord[]
    leadChecks?: readonly ResearchLeadCheck[]
  }
  synthesisDispositions?: readonly DispositionRecord[]
  challengeObservations?: readonly ChallengeObservation[]
  coverageUnion?: readonly CoverageUnionEntry[]
  reviewInputDigest?: string
  reviewDecisions?: readonly ReviewDecision[]
  reviewUnion?: readonly ReviewUnionEntry[]
  verificationOutcomes?: readonly VerificationOutcome[]
  decisionDissentObservationIds?: readonly string[]
  dispositionReferences?: readonly string[]
  retainedReferences?: readonly string[]
  reportSections?: readonly ReportSectionLink[]
  finalCustody?: FinalObservationCustody
}

export interface AgentResult {
  status: 'accepted' | 'additive-unavailable'
  actorId: string
  model: string
  provider: string
  files: Readonly<Record<string, string>>
  assertions: readonly string[]
  protocol: ProtocolMetadata
  inputTokens: number
  rawInputTokens?: number
  cachedInputTokens?: number
  cacheAccountingComplete?: boolean
  costAccountingComplete?: boolean
  outputTokens: number
  costUsd: number
  modelCalls?: 0 | 1
  unavailableReason?: 'budget' | 'provider-credit' | 'platform-interruption' | 'discovery-boundary'
  sessionId?: string
  /** Trusted native-runner tool events, bound to the exact execution receipt. */
  nativeSearchEvidence?: import('./agent-execution-receipt.js').NativeSearchEvidence
}

export interface ArtifactRecord {
  id: string
  stageId: string
  waveId: string
  taskId: string
  status: AgentResult['status']
  actorId: string
  model: string
  provider: string
  promptDigest: string
  contentDigest: string
  uri: string
  files: readonly string[]
  assertions: readonly string[]
  protocol: ProtocolMetadata
  usage: ProviderUsage
  unavailableReason?: AgentResult['unavailableReason']
}

export interface RunCursor {
  stageIndex: number
  waveIndex: number
}

export type RunStatus = 'created' | 'running' | 'stopped' | 'failed' | 'completed'

export interface JournalEvent {
  sequence: number
  type: string
  at: string
  payload: unknown
  previousDigest: string | null
  digest: string
}

export interface CheckpointBody {
  schemaVersion: 2
  experimentId: string
  runId: string
  stateGeneration: number
  rootRunId: string
  rootCreatedAt: string
  modelStartedAt: string | null
  phase: RunPhase
  recoveryEpoch: number
  parentCheckpointDigest: string | null
  /** Present only after an exact failed partial-wave recovery. */
  failedWaveRecovery?: FailedWaveRecoveryEvidence
  /** Immutable proofs for paid executions promoted by this run or an ancestor. */
  promotedExecutionProofs?: readonly PromotedExecutionEvidence[]
  /** Present only after replaying an all-deterministic terminal wave under a corrected runtime. */
  terminalCompletionRecovery?: TerminalCompletionRecoveryEvidence
  /** Exact stopped-checkpoint handoff; inherited recovery evidence remains intact. */
  runtimeTransition?: RuntimeTransitionEvidence
  releaseDigest: string
  /** Absent only on checkpoints sealed before runtime release isolation. */
  runtimeRelease?: RuntimeRelease
  definitionDigest: string
  cursor: RunCursor
  acceptedArtifacts: readonly ArtifactRecord[]
  rejectedAttempts: readonly RejectedAttempt[]
  stageEndReceipts: readonly StageEndReceipt[]
  waveReceipts: readonly WaveReceipt[]
  /** Durable per-pool discovery progress for independently advancing cohorts. */
  discoveryScheduler?: DiscoverySchedulerState
  availabilityBoundaries: readonly AvailabilityBoundary[]
  budget: BudgetUsage
  journalHead: string
  sealedAt: string
}

export interface SealedCheckpoint {
  digest: string
  body: CheckpointBody
}

export interface StageEndReceipt {
  stageIndex: number
  from: RunPhase
  to: RunPhase
  reason: 'preflight-passed' | 'stage-complete' | 'two-distinct-complete-saturation-cohorts' | 'phase-deadline' | 'insufficient-time-for-full-wave' | 'measured-budget-inability' | 'safety-ceiling-reached' | 'completion-contract-passed'
  evidence: unknown
  evidenceDigest: string
  endedAt: string
}

export interface WaveReceipt {
  stageId: string
  waveId: string
  /** Present for an independently sealed discovery cohort. */
  poolId?: string
  /** Exact immutable accepted frontier supplied when this cohort was admitted. */
  inputArtifacts?: readonly ArtifactReference[]
  inputDigest?: string
  peerPredecessors?: Readonly<Record<string, string>>
  materialEpoch?: number
  materialHighCriticalDelta?: boolean
  /** Recorded usage at dispatch, independent of this pool's local wave number. */
  budgetAtAdmission?: BudgetUsage
  startedAt: string
  completedAt: string
  durationMs: number
  artifactDigests: readonly string[]
  /** Exact output membership for independently sealed discovery cohorts. */
  artifactRefs?: readonly ArtifactReference[]
}

export interface ArtifactReference {
  id: string
  contentDigest: string
}

export interface WaveAdmission {
  stageId: string
  waveId: string
  cursor: RunCursor
  admittedAt: string
}

export interface DiscoveryCohortAdmission {
  stageId: string
  poolId: string
  waveId: string
  waveIndex: number
  taskIds: readonly string[]
  admittedAt: string
  budgetAtAdmission: BudgetUsage
  inputArtifacts: readonly ArtifactReference[]
  inputDigest: string
  materialEpoch: number
  peerPredecessors: Readonly<Record<string, string>>
}

export interface DiscoveryPoolProgress {
  poolId: string
  nextWaveIndex: number
  quietCohorts: number
  quietEpoch: number
  parked: boolean
}

export interface DiscoverySchedulerState {
  stageId: string
  materialEpoch: number
  pools: readonly DiscoveryPoolProgress[]
  admissions: readonly DiscoveryCohortAdmission[]
}

export interface AvailabilityBoundary {
  provider: string
  effectiveFromWave: number
  reason: 'budget' | 'provider-credit'
  sourceTaskId: string
  /** Exact configured credential route. Absent only on historical states. */
  poolId?: string
  sealedAt: string
}

export interface RejectedAttempt {
  /** Successful native research retained for correction in the same session. */
  nativeSearchEvidence?: import('./agent-execution-receipt.js').NativeSearchEvidence
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  /** One-based corrective output turn; absent for the original execution. */
  formatRepairOrdinal?: number
  formatRepairSourceDigest?: string
  promptDigest: string
  outputDigest: string | null
  quarantineUri: string | null
  diagnostics: readonly string[]
  includeDiagnosticsInRepair?: boolean
  freshContext: boolean
  continuationMode: 'new' | 'resume'
  sessionId: string | null
  nativeTransport?: NativeTransportEvidence
  nativeTerminalCustody?: NativeTerminalCustodyEvidence
  usage: ProviderUsage
  rejectedAt: string
  /**
   * Run whose repair allowance produced this rejection. Absent on historical
   * states; recovery children retain source usage under the source scope.
   */
  repairScopeRunId?: string
}

export interface FailedWaveRecoveryEvidence {
  sourceRunId: string
  sourceStateGeneration: number
  sourceStateDigest: string
  checkpointDigest: string
  importedTaskIds: readonly string[]
  inheritedRejectedAttemptCount: number
  unknownUsageAttemptCount: number
  sourceRuntimeRelease: RuntimeRelease
  targetRuntimeRelease: RuntimeRelease
  /** Exact durable execution reused without another provider call. */
  promotedExecution?: PromotedExecutionEvidence
  /** One failed native task continued in its original physical workspace. */
  retainedNative?: RetainedNativeRecoveryEvidence
  /** One terminally lost native execution, fenced before a fresh task attempt. */
  unobservableNative?: UnobservableNativeRecoveryEvidence
}

export interface UnobservableNativeRecoveryEvidence {
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  promptDigest: string
  requestDigest: string
  fenceProofDigest: string
}

export interface RetainedNativeRecoveryEvidence {
  stageId: string
  waveId: string
  taskId: string
  workspaceKey: string
  workspaceAllocationRunId: string
  /** Original Cloudflare Sandbox Durable Object, verified before child admission. */
  sandboxObjectId: string
  nativeTransport: NativeTransportEvidence
}

export interface PromotedExecutionEvidence {
  sourceRunId: string
  stageId: string
  waveId: string
  taskId: string
  sourceAttempt: number
  requestDigest: string
  promptDigest: string
  outputDigest: string
  /** Equal to outputDigest only for an explicitly quarantined, revalidated source response. */
  quarantineOutputDigest?: string
  inputDigest?: string
  releaseDigest: string
  usage: ProviderUsage
}

export interface TerminalCompletionRecoveryEvidence {
  sourceRunId: string
  sourceStateGeneration: number
  sourceStateDigest: string
  checkpointDigest: string
  sourceRuntimeRelease: RuntimeRelease
  targetRuntimeRelease: RuntimeRelease
}

export interface RuntimeTransitionEvidence extends TerminalCompletionRecoveryEvidence {
  inheritedRecoveryDigest: string
}

export interface InFlightAgentAttempt {
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  formatRepairOrdinal?: number
  formatRepairSourceDigest?: string
  promptDigest: string
  freshContext: boolean
  continuationMode: 'new' | 'resume'
  sessionId: string | null
  admittedAt: string
}

export interface RunState {
  schemaVersion: 2
  experimentId: string
  runId: string
  stateGeneration: number
  rootRunId: string
  rootCreatedAt: string
  modelStartedAt: string | null
  phase: RunPhase
  recoveryEpoch: number
  parentRunId: string | null
  parentCheckpointDigest: string | null
  /** Present only on a child reconstructed from an exact failed partial wave. */
  failedWaveRecovery?: FailedWaveRecoveryEvidence
  /** Immutable proofs for paid executions promoted by this run or an ancestor. */
  promotedExecutionProofs?: readonly PromotedExecutionEvidence[]
  /** Present only on a child replaying an all-deterministic terminal wave under a corrected runtime. */
  terminalCompletionRecovery?: TerminalCompletionRecoveryEvidence
  runtimeTransition?: RuntimeTransitionEvidence
  releaseDigest: string
  /** Absent only on runs created before runtime release isolation. */
  runtimeRelease?: RuntimeRelease
  definitionDigest: string
  status: RunStatus
  cursor: RunCursor
  artifacts: readonly ArtifactRecord[]
  rejectedAttempts: readonly RejectedAttempt[]
  stageEndReceipts: readonly StageEndReceipt[]
  waveReceipts: readonly WaveReceipt[]
  /** Present while the discovery stage uses independently advancing pools. */
  discoveryScheduler?: DiscoverySchedulerState
  /** Present only while an admitted wave has not reached its sealed barrier. */
  waveAdmission?: WaveAdmission | null
  /** Paid attempts admitted before dispatch and retained until their terminal evidence is recorded. */
  inFlightAgentAttempts?: readonly InFlightAgentAttempt[]
  availabilityBoundaries: readonly AvailabilityBoundary[]
  checkpoints: readonly SealedCheckpoint[]
  budget: BudgetUsage
  journal: readonly JournalEvent[]
  createdAt: string
  updatedAt: string
  terminalReason: string | null
}

export interface RunOutcome {
  state: RunState
  checkpoints: readonly SealedCheckpoint[]
}

export interface AgentProvider {
  run(request: AgentRequest): Promise<AgentResult>
  disposeWorkspace?(input: { runId: string, workspaceKey: string, freshSuffix?: string }): Promise<
    import('./workspace-disposal.js').WorkspaceDisposalReceipt | void
  >
}

export interface ArtifactStore {
  put(record: Omit<ArtifactRecord, 'uri'>, content: string): Promise<ArtifactRecord>
  putRejected(record: {
    id: string
    taskId: string
    contentDigest: string
  }, content: string): Promise<string>
  readRejected(uri: string, contentDigest: string, taskId: string): Promise<Readonly<Record<string, string>>>
}
