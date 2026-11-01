import type { DiscoveryPoolWaiver } from './discovery-pool-waiver.js'
import type { AgentSandbox } from './agent-sandbox.js'
import type { ModelClockAmendment } from './recovery-clock.js'
import type {
  FailedWaveRecoveryEvidence, ProviderUsage, RuntimeRelease, RuntimeTransitionEvidence, TerminalCompletionRecoveryEvidence,
} from './contracts.js'

export interface QuarantinedRevalidation {
  sourceRunId: string
  stageId: string
  waveId: string
  taskId: string
  promptDigest: string
  outputDigest: string
  quarantineUri: string
  usage: ProviderUsage
}

export interface AuditWorkflowPayload {
  mode: 'start' | 'resume' | 'recover-failed-wave' | 'recover-terminal-completion' | 'recover-discovery-waiver'
  experimentId: string
  runId: string
  releaseDigest?: string
  checkpointDigest?: string
  runtimeRelease?: RuntimeRelease
  timeAmendment?: ModelClockAmendment
  revalidation?: QuarantinedRevalidation
  failedWaveRecovery?: FailedWaveRecoveryEvidence
  terminalCompletionRecovery?: TerminalCompletionRecoveryEvidence
  runtimeTransition?: RuntimeTransitionEvidence
  discoveryPoolWaiver?: DiscoveryPoolWaiver
}

export interface RuntimeIsolationWorkflowPayload {
  fixtureId: string
  runtimeRelease: RuntimeRelease
  holdSeconds: number
  parentCheckpointDigest?: string
  /** Zero-model proof that keep-alive survives a period longer than the inactivity timeout without observer traffic. */
  idleSurvival?: true
}

export interface RuntimeResumeRequest {
  experimentId: string
  childRunId: string
  checkpointDigest: string
  runtimeRelease: RuntimeRelease
  runtimeTransition?: RuntimeTransitionEvidence
  revalidate?: {
    sourceRunId: string
    outputDigest: string
  }
}

export interface RuntimeFailedWaveRecoveryRequest {
  experimentId: string
  childRunId: string
  sourceRunId: string
  sourceStateGeneration: number
  sourceStateDigest: string
  checkpointDigest: string
  runtimeRelease: RuntimeRelease
  promoteExecution?: {
    taskId: string
    sourceAttempt: number
    requestDigest: string
    quarantineOutputDigest?: string
  }
  retainNative?: { taskId: string, requestDigest: string, snapshotDigest: string, sandboxObjectId: string }
  repairQuarantined?: { taskId: string, requestDigest: string, outputDigest: string }
}

export interface RuntimeTerminalCompletionRecoveryRequest extends RuntimeFailedWaveRecoveryRequest {}

export interface RuntimeDiscoveryWaiverRequest extends RuntimeFailedWaveRecoveryRequest {
  poolId: string
  requestDigest: string
}

export interface Env {
  DASHBOARD_ACCESS_ISSUER?: string
  DASHBOARD_ACCESS_AUDIENCE?: string
  DASHBOARD_ACCESS_EMAILS?: string
  /** Optional placement hint for Workflows and the coordinator, such as enam. */
  LOCATION_HINT?: DurableObjectLocationHint
  PACKAGES: R2Bucket
  ARTIFACTS: R2Bucket
  INDEX: D1Database
  COORDINATORS: DurableObjectNamespace
  AGENT_SANDBOX: DurableObjectNamespace<AgentSandbox>
  AUDIT_WORKFLOW: Workflow<AuditWorkflowPayload>
  RUNTIME_ISOLATION_WORKFLOW?: Workflow<RuntimeIsolationWorkflowPayload>
  ENGINE_ROLE?: 'front-door' | 'runtime'
  RUNTIME_CATALOG_JSON?: string
  RUNTIME_SLOT_POOL_ENABLED?: string
  RUNTIME_RELEASE_JSON?: string
  VERSION_METADATA?: WorkerVersionMetadata
  ACK3_CODEX_AUTH_JSON: string | { get(): Promise<string> }
  ACK3_CODEX_WORKSPACE_ID: string
  CONTROL_API_TOKEN: string
  [binding: string]: unknown
}
