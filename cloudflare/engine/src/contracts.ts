export const AUDIT_STAGES = [
  'recon',
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
export type RunPhase = 'preparation' | 'recon' | 'discovery' | 'synthesis' | 'coverage' | 'negative-review' | 'verification' | 'reporting' | 'complete' | 'stopped'
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
    /** Sealed only as `false`: a failed or empty baseline build is recorded and the audit continues. */
    buildRequired?: false
    /** Sealed only when set: agent commands, background jobs included, are stopped after this many minutes. */
    commandTimeoutMinutes?: number
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
  /** Sealed only with keepPocs: the runner keeps this task's new text files from the lane scratch path. */
  scratchCapture?: ScratchCaptureLimits
}

export interface ScratchCaptureLimits {
  maxFileBytes: number
  maxTaskBytes: number
  maxFiles: number
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
  /** Sealed only on Claude pools that set them: accounts used, in order, once credentialSource is used up. */
  fallbackCredentialSources?: readonly string[]
  model: string
  /** Native Codex program selected by the originating pool. */
  cyberAccessProgram?: string
  reasoning: ReasoningEffort
  thinking?: ThinkingMode
  /** Optional only so releases sealed before subagent controls remain replayable. */
  subagents?: SubagentPolicy
  promptKind: 'preflight' | 'recon' | 'research' | 'synthesis' | 'coverage-challenge' | 'coverage-union' | 'negative-review' | 'review-union' | 'verification' | 'reporting' | 'final-seal'
  visibility: ArtifactVisibility
  workspaceMode: 'control' | 'continuation' | 'fresh-pristine'
  workspaceKey: string
  output: OutputContract
  research?: ResearchAssignment
  perspective?: 'effective-state' | 'architecture' | 'resource-lifecycle' | 'open-adversarial'
  observationPrefix?: string
  requiredTable?: string
  optional?: boolean
  /** Sealed only with submitCheck, on every model task: the agent checks its handoff with `ack3-submit`. */
  submitCheck?: true
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
  /** Audit scope text from the manifest's scope file, shown to every model task. */
  scope?: string
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
  /** Sealed only with an audit scope, so releases without one keep their exact catalog. */
  scopeRules?: string
  scopeReminder?: string
  /** Sealed only with keepPocs: PoC test rules for research and verification. */
  pocCapture?: string
  pocReview?: string
  /** Sealed only with submitCheck: tells every model task to run `ack3-submit` before it finishes. */
  submitCheck?: string
  /** What materialHighCriticalDelta means; absent in releases sealed before it existed, which render as before. */
  researchDelta?: string
  /** Sealed only with a recon stage (see recon.ts), so releases without one keep their exact catalog. */
  reconInstructions?: string
  reconSearch?: string
  reconPrivacy?: string
  reconNotes?: string
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
  /** Native Codex program; absent for ordinary model execution. */
  cyberAccessProgram?: string
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
  /** Claude only: more subscription bindings, used in order when the previous account is used up. */
  fallbackCredentialSources?: readonly string[]
  agents: number
  required: boolean
}

export interface ModelConnection {
  baseUrl: string
  apiKeyEnv: string
  /** Optional HTTP header values resolved from API-key environment bindings. */
  headersEnv?: Record<string, string>
  /** Treat a 429 with Retry-After as a resetting usage window: DSH waits for it instead of failing. */
  usageWindowWait?: boolean
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
  subscriptionWaits?: readonly import('../container/subscription-limits.mjs').SubscriptionWait[]
  subscriptionSwitches?: readonly import('../container/subscription-limits.mjs').SubscriptionSwitch[]
  rawInputTokens?: number
  cachedInputTokens?: number
  cacheAccountingComplete?: boolean
  /** True only when all sampled native usage was priced by a configured rate card. */
  costAccountingComplete?: boolean
}

export interface AgentRequest {
  /** Frozen dispatched configuration and read set; absent only on historical requests. */
  execution?: ArtifactExecution
  experimentId: string
  runId: string
  executionAuthority?: import('./execution-authority.js').ExecutionAuthority
  /** Stable across automatic retries, new for an explicit task restart. */
  taskExecutionId?: string
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
  /** From the sealed runtime: the runner stops agent commands older than this. */
  commandTimeoutMs?: number
  freshContext: boolean
  continuationMode: 'new' | 'resume'
  sessionId: string | null
  /** Closed native transport attempt whose retained session may continue. */
  nativeTransport?: NativeTransportEvidence
  /** Sealed DSH web_search connection for this model task. */
  nativeSearchConnection?: NativeSearchConnection
  /** Native Codex search availability for this model task. */
  enableNativeSearch?: boolean
}

/** Private session observation. This proves custody, never permission to launch. */
export interface NativeSessionCustodyReference {
  sourceRunId: string
  requestDigest: string
  sessionId: string
  snapshotDigest: string
  workState: 'none' | 'present' | 'unknown'
}

export interface NativeTransportEvidence extends NativeSessionCustodyReference {
  code: 'TRANSPORT' | 'TIMEOUT' | 'STREAM_CLOSED' | 'SERVER' | 'RATE_LIMIT' | 'EMPTY_RESPONSE'
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
  /** Background web research from the optional recon stage; never observations about the target. */
  recon?: { researchQueries: readonly string[] }
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
  subscriptionWaits?: readonly import('../container/subscription-limits.mjs').SubscriptionWait[]
  /** Present exactly when the task has fallbackCredentialSources; empty when no account was used up. */
  subscriptionSwitches?: readonly import('../container/subscription-limits.mjs').SubscriptionSwitch[]
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
  /** The runner's final `ack3-submit` result; present exactly when the task has submitCheck. */
  submitCheck?: import('./submission-check.js').SubmitCheckReport
  /** Output files in which the runner replaced a credential value; each one asks for a correction. */
  outputCredentials?: readonly import('./agent-execution-receipt.js').OutputCredential[]
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
  /** Exact execution and input membership; absent only on historical records. */
  execution?: ArtifactExecution
}

/** Evidence of execution, not another audit configuration. Releases retain the configuration. */
export interface ArtifactExecution extends ExecutionConfiguration {
  /** Frozen physical lane owner selected at admission; absent on historical allocations. */
  mutationOwner?: import('./workspace-mutation-owner.js').WorkspaceMutationOwner
  /** Native allocation key derived from this task contract, not the current manifest. */
  workspaceKey?: string
  runId: string
  taskExecutionId?: string
  releaseDigest: string
  definitionDigest: string
  taskDigest: string
  attempt: number
  runtimeRelease?: RuntimeRelease
  /** Content-addressed read set in the artifact store, never copied into every checkpoint. */
  inputCount: number
  inputDigest: string
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

export interface RunStateWriteOptions { admission?: boolean; unlessBootstrapped?: boolean }

/** Shared persisted execution identity and progress; current runs always have an owner. */
interface ExecutionState {
  experimentId: string
  runId: string
  executionAuthority: import('./execution-authority.js').ExecutionAuthority
  controls?: import('./run-control-state.js').RunControlState
  forkOrigin?: import('./stage-fork-origin.js').StageForkOrigin
  stateGeneration: number
  rootRunId: string
  rootCreatedAt: string
  modelStartedAt: string | null
  phase: RunPhase
  recoveryEpoch: number
  parentCheckpointDigest: string | null
  releaseDigest: string
  runtimeRelease?: RuntimeRelease
  definitionDigest: string
  cursor: RunCursor
  rejectedAttempts: readonly RejectedAttempt[]
  stageEndReceipts: readonly StageEndReceipt[]
  waveReceipts: readonly WaveReceipt[]
  discoveryScheduler?: DiscoverySchedulerState
  availabilityBoundaries: readonly AvailabilityBoundary[]
  budget: BudgetUsage
}

export interface CheckpointBody extends ExecutionState {
  schemaVersion: 2
  acceptedArtifacts: readonly ArtifactRecord[]
  journalHead: string
  sealedAt: string
}
export interface SealedCheckpoint {
  digest: string
  body: CheckpointBody
}

export interface StageEndReceipt {
  configuration?: ExecutionConfiguration
  stageIndex: number
  from: RunPhase
  to: RunPhase
  reason: 'preflight-passed' | 'stage-complete' | 'two-distinct-complete-saturation-cohorts' | 'phase-deadline' | 'insufficient-time-for-full-wave' | 'measured-budget-inability' | 'safety-ceiling-reached' | 'completion-contract-passed'
  evidence: unknown
  evidenceDigest: string
  endedAt: string
}

/** A reference to the ordinary immutable release, never inline configuration. */
export interface ExecutionConfiguration {
  releaseDigest: string
  definitionDigest: string
}

/** Selected execution of a logical task; configuration remains an immutable release reference. */
export interface TaskOccurrence {
  mutationOwner?: import('./workspace-mutation-owner.js').WorkspaceMutationOwner
  taskId: string
  taskExecutionId: string
  origin: { authority: import('./execution-authority.js').ExecutionAuthority; ordinal: number }
  configuration: ExecutionConfiguration
  taskDigest: string
}

export interface WaveReceipt {
  /** Absent only on uncontrolled legacy executions. */
  taskOccurrences?: readonly TaskOccurrence[]
  configuration?: ExecutionConfiguration
  stageId: string
  waveId: string
  /** Present for an independently sealed discovery cohort. */
  poolId?: string
  /** Exact immutable accepted frontier captured when this wave or cohort was admitted. */
  inputArtifacts?: readonly ArtifactReference[]
  inputDigest?: string
  peerPredecessors?: Readonly<Record<string, string>>
  materialEpoch?: number
  materialHighCriticalDelta?: boolean
  /** Knowledge epoch after this completion, distinct from its admission epoch above. */
  materialEpochAfter?: number
  /** Digest of the prior material completion sharing this epoch, before any new admission. */
  coalescedWith?: string
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

/** Evidence selected before any current task can execute. */
export interface AdmissionEvidence {
  taskOccurrences: readonly TaskOccurrence[]
  /** Immutable frontier for every attempt in this wave. */
  inputArtifacts: readonly ArtifactReference[]
  inputDigest: string
  configuration: ExecutionConfiguration
}

export interface WaveAdmission extends AdmissionEvidence {
  stageId: string
  waveId: string
  cursor: RunCursor
  admittedAt: string
}

export interface DiscoveryCohortAdmission extends AdmissionEvidence {
  stageId: string
  poolId: string
  waveId: string
  waveIndex: number
  taskIds: readonly string[]
  admittedAt: string
  budgetAtAdmission: BudgetUsage
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
  configuration?: ExecutionConfiguration
  provider: string
  effectiveFromWave: number
  reason: 'budget' | 'provider-credit'
  sourceTaskId: string
  /** Exact configured credential route. Absent only on historical states. */
  poolId?: string
  sealedAt: string
}

export interface RejectedAttempt {
  /** Frozen dispatched configuration and read set; absent only on historical requests. */
  execution?: ArtifactExecution
  /** Explicit operator waiver; must retain its matching stage exception receipt. */
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
  /** The provider or its transport failed: this attempt does not count against the limit and
   * the next launch waits until `rejectedAt` + `delayMs` (P2-06). Absent on older records. */
  providerBackoff?: import('./provider-backoff.js').ProviderBackoff
  usage: ProviderUsage
  rejectedAt: string
}

export interface InFlightAgentAttempt {
  /** Exact AgentRequest bytes authorized before native projection; not the native receipt digest. */
  dispatchDigest?: string
  /** Frozen dispatched configuration and read set; absent only on historical requests. */
  execution?: ArtifactExecution
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

export interface RunState extends ExecutionState {
  schemaVersion: 3
  parentRunId: string | null
  status: RunStatus
  artifacts: readonly ArtifactRecord[]
  /** Present only while an admitted wave has not reached its sealed barrier. */
  waveAdmission?: WaveAdmission | null
  /** Paid attempts admitted before dispatch and retained until their terminal evidence is recorded. */
  inFlightAgentAttempts?: readonly InFlightAgentAttempt[]
  checkpoints: readonly SealedCheckpoint[]
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
  disposeWorkspace?(input: { runId: string, workspaceKey: string, freshSuffix?: string, mutationOwner?: import('./workspace-mutation-owner.js').WorkspaceMutationOwner }): Promise<
    import('./workspace-disposal.js').WorkspaceDisposalReceipt | void
  >
}

export interface ArtifactStore {
  putExecutionInputs(inputs: readonly ArtifactReference[]): Promise<string>
  readExecutionInputs(digest: string): Promise<readonly ArtifactReference[]>
  put(record: Omit<ArtifactRecord, 'uri'>, content: string): Promise<ArtifactRecord>
  putRejected(record: {
    id: string
    taskId: string
    contentDigest: string
  }, content: string): Promise<string>
  readRejected(uri: string, contentDigest: string, taskId: string): Promise<Readonly<Record<string, string>>>
}
