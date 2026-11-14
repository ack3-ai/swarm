import type { AgentSandbox } from './agent-sandbox.js'
import type { RuntimeRelease } from './contracts.js'

export interface AuditWorkflowPayload {
  mode: 'start'
  experimentId: string
  runId: string
  releaseDigest?: string
  runtimeRelease?: RuntimeRelease
}

export interface RuntimeIsolationWorkflowPayload {
  fixtureId: string
  runtimeRelease: RuntimeRelease
  holdSeconds: number
  parentCheckpointDigest?: string
  /** Zero-model proof that keep-alive survives a period longer than the inactivity timeout without observer traffic. */
  idleSurvival?: true
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

export function engineRole(env: Pick<Env, 'ENGINE_ROLE'>): 'front-door' | 'runtime' {
  if (env.ENGINE_ROLE !== 'front-door' && env.ENGINE_ROLE !== 'runtime') {
    throw new TypeError('ENGINE_ROLE must be front-door or runtime')
  }
  return env.ENGINE_ROLE
}
