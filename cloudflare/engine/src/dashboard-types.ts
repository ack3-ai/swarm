import type { dashboardContext } from './dashboard-context.js'
import type { ProviderUsage, RunPhase, RunStatus, StageKind } from './contracts.js'

export interface DashboardRun {
  id: string
  experimentId: string
  status: RunStatus
  phase: RunPhase
  rootRunId: string
  parentRunId: string | null
  recoveryEpoch: number
  stateGeneration: number
  updatedAt: string
  createdAt: string
  terminalReason: string | null
}

export interface LiveCompletion {
  requestDigest: string
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  model: string
  provider: string
  actorId: string
  promptDigest: string
  outputDigest: string
  recordedAt: string
  usage: ProviderUsage
}

export interface DashboardCompletion extends LiveCompletion {
  originTiming?: { runId: string; startedAt: string | null; endedAt: string }
}

export interface DashboardStage {
  id: string
  kind: StageKind
  label: string
  status: 'complete' | 'current' | 'pending' | 'failed' | 'stopped' | 'incomplete' | 'not-run'
  usage: ProviderUsage
  waveCount: number
  completedWaves: number
  waveUnit?: 'pool waves'
  timing?: DashboardTiming
  throughput?: DashboardThroughput | null
}

export interface DashboardTiming {
  startedAt: string | null
  finishedAt: string | null
  elapsedMs: number | null
  live: boolean
  sourceRunId?: string
  basis: 'run-span' | 'stage-span' | 'wave' | 'single-task-wave' | 'result' | 'last-rejection'
}

/** Recorded usage divided by elapsed wall time, not model generation speed. */
export interface DashboardThroughput {
  elapsedMs: number
  inputTokensPerSecond: number
  outputTokensPerSecond: number
  totalTokensPerSecond: number
  provisional: boolean
  partial: boolean
}

export interface DashboardWaveTask {
  context?: ReturnType<typeof dashboardContext> | undefined
  workspace?: { key: string; policy: string } | undefined
  taskId: string
  agentId: string
  modelPool?: string
  localWave?: number
  promptKind?: string
  providerClass?: string
  researcher?: number
  model: string
  provider: string
  role: string
  status: 'pending' | 'awaiting-result' | 'returned' | 'accepted' | 'rejected' | 'unavailable' | 'interrupted' | 'not-run' | 'unknown'
  lastAttempt: number | null
  lastReceiptAt: string | null
  rejectedAttempts: number
  usage: ProviderUsage
  provisionalUsage: ProviderUsage
  timing?: DashboardTiming
  throughput?: DashboardThroughput | null
}

export interface DashboardWave {
  sourceWaveId?: string
  modelPool?: string
  id: string
  stageId: string
  index: number
  label: string
  status: 'complete' | 'current' | 'pending' | 'not-run' | 'failed' | 'stopped' | 'incomplete'
  usage: ProviderUsage
  startedAt: string | null
  completedAt: string | null
  timing?: DashboardTiming
  throughput?: DashboardThroughput | null
  agentCount: number
  tasks: DashboardWaveTask[]
  observationCount: number
}

export interface DashboardAgent {
  id: string
  model: string
  provider: string
  role: string
  usage: ProviderUsage
  acceptedTasks: number
  rejectedAttempts: number
  observations: number
  linkedReportItems: number
  firstRecordedItems: number
}

export interface DashboardNode {
  id: string
  kind: 'observation' | 'reference' | 'review' | 'verification' | 'report'
  label: string
  detail: string
  stageId: string
  waveId: string
  waveIndex: number
  model: string | null
  agentId: string | null
  artifactId: string | null
  artifactDigest: string | null
}

export interface DashboardEdge {
  from: string
  to: string
  kind: 'disposition' | 'review' | 'report'
}

export interface DashboardFinding {
  id: string
  label: string
  disposition: 'candidate' | 'refuted' | 'unresolved'
  inReport: boolean
  confirmation: 'not-recorded' | 'axes-recorded'
  verification: DashboardVerification[]
  severity: 'not-recorded'
  earliestWave: number | null
  firstContributors: string[]
  contributors: string[]
  observationIds: string[]
  nodeIds: string[]
  dissent: boolean
}

export interface DashboardVerification {
  observationIds?: readonly string[]
  nodeId: string
  behavior: 'reproduced' | 'not-reproduced' | 'unresolved'
  exploitability: 'supported' | 'refuted' | 'unresolved'
  evidenceMethod?: 'fresh-execution' | 'prior-execution-reviewed' | 'source-inspection' | 'not-attempted'
  evidence: string
}

export interface DashboardSnapshot {
  schemaVersion: 1
  generatedAt: string
  run: DashboardRun
  executionStatus?: RunStatus | 'incomplete' | 'unknown' | 'paused'
  timing?: DashboardTiming
  throughput?: DashboardThroughput | null
  recordedUsage: ProviderUsage
  provisionalUsage: ProviderUsage
  stages: DashboardStage[]
  waves: DashboardWave[]
  agents: DashboardAgent[]
  activity: { stageId: string; waveId: string; agentId: string; usage: ProviderUsage }[]
  findings: DashboardFinding[]
  nodes: DashboardNode[]
  edges: DashboardEdge[]
  provisionalCompletions: LiveCompletion[]
  freshness: {
    recordedAt: string
    liveReceipts: number
    legacyReceipts: number
    receiptsTruncated: boolean
    inFlightTokensKnown: false
  }
  limitations: string[]
}

