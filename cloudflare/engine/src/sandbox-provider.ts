import { deepClone } from './canonical.js'
import { auditScopeHeader, auditScopePath } from './prompts.js'
import { verifiedCancellationWinner, assertCurrentTaskOwner } from './command-custody.js'
import { executionRequestBody } from './native-request.js'
import { reserveNativeLaunch, assertNativeTaskAdmission, assertSupervisorTaskAdmission } from './native-launch-authority.js'
import { assertCurrentWorkspaceRequest, nativeWorkspaceKey, nativeSandboxName, workspaceAllocationName } from './native-workspace.js'
import { artifactReferences, assertDispatchedExecution } from './artifact-execution.js'
import { modelHeaderCredentialNames } from '../container/reasoning-config.mjs'
import { credentialsFromJson } from '../container/credential-json.mjs'
import { getAgentSandbox, type SandboxClient } from './agent-sandbox-client.js'
import { parseLogObservation, sandboxLogReadMaxBytes } from './sandbox-log-observation.js'
import type { AgentProvider, AgentRequest, AgentResult } from './contracts.js'
import type { Env } from './env.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertExecutionAuthority, ExecutionAuthorityStore } from './execution-authority.js'
import { assertControlId, RunCommandConflict } from './run-commands.js'
import {
  createCoverageUnion,
  createFinalObservationCustody,
  createNegativeReviewUnion,
  createNegativeReviewUnionManifest,
  renderCoverageUnion,
  sealFinalFinding,
} from './protocol-transforms.js'
import { CloudflareRunStore, R2ArtifactStore } from './cloudflare-storage.js'
import { writeAccepted } from './accepted-mounts.js'
import { capturedBundlePath } from './poc-handoff.js'
import { submissionTemplate, SUBMISSION_PATH } from './submission.js'
import { SUBMIT_CHECK_CONTEXT_PATH, submitCheckContext } from './submission-check.js'
import { mandatorySearchRequirement } from './native-research.js'
import { agentResultReadFailure } from './agent-diagnostics.js'
import { clearUntrustedTaskOutputs } from './task-output-boundary.js'
import { resolveCredentialBinding } from './release-provider-credentials.js'
import { ensureCoverageChallengeOutput } from './coverage-output.js'
import {
  AgentExecutionReceiptIntegrityError,
  agentExecutionReceiptWrapper,
  classifyAgentExecutionReceipt,
  parseExactAgentExecutionReceipt,
  R2AgentExecutionReceiptStore,
} from './agent-execution-receipt.js'
import { agentProcessId, waitForAgentProcess } from './agent-process.js'
import { agentProcessWaitSliceMs, workflowAttemptTimeoutMs } from './workflow-step-config.js'
import { boundedWorkspaceDisposal, type WorkspaceDisposalReceipt } from './workspace-disposal.js'
import { boundedLaunchPrerequisite, boundedReadOnlyObservation, boundedTerminalLogDrain } from './bounded-observation.js'
import { R2AgentObservationHealthStore, type AgentObservationIdentity } from './agent-observation-health.js'
import { annotateContainerResourceFailure, containerCapacity, lookupObservationResourceLoss, workspaceLimitNotes } from './container-resource-diagnostics.js'
import { providerIdentity, taskBackend } from './provider-identity.js'
import { claudeAccountBindings, subscriptionCredentialSource, codexWorkspaceId } from './subscription-credentials.js'
import { resolveTargetEnvironment } from './target-environment.js'
import { agentResultFromExecutionReceipt } from './late-upstream-handoff.js'
import {
  AgentAttemptFailure,
  AgentExecutionPending,
  PermanentRunFailure,
  UnobservableAgentExecution,
  RunFailure,
  TransientRunFailure,
} from './run-errors.js'
import { R2AgentExecutionLogStore } from './agent-execution-log.js'
import { NativeSessionCustody, nativeTerminalCustodyCode, nativeTransportCode,
  renderNativeSessionIdPatch, renderNativeSessionResumePatch } from './native-session-custody.js'
import { renderDshReasoningPatch } from '../container/reasoning-config.mjs'
import { nativeDshDiagnosticEndpoint, nativeDshHttp2PreloadPath, nativeDshHttp2PreloadSource,
  usesNativeDshHttp2, withNativeDshHttp2NodeOptions } from './native-dsh-http2.js'

const targetWorkspaceEnvironment = {
  SWARM_SOURCE_DIR: '/workspace/source',
  SWARM_VERIFIER_DIR: '/workspace/verifier',
  DEEPSEEK_SWARM_RUN_DIR: '/workspace/results',
  XDG_DATA_HOME: '/workspace/home/.local/share',
} as const

// Launch ownership is a separate safety clock. Observation may yield often,
// but another Workflow attempt must not revoke a slow setup owner early.
// Includes bounded source verification and workspace preparation before a
// credential-bearing model process can be registered.
export const executionLaunchGraceMs = 15 * 60_000
/** Root script that stops every agent-user process left in a sandbox; older images lack it. */
export const agentProcessSweepPath = '/usr/local/bin/ack3-stop-agent-processes'
export const agentLogObservationIntervalMs = 15_000
export const agentLogReadMaxBytes = sandboxLogReadMaxBytes
export const agentLogFinalDrainSlices = 8
// Keep one read-only Sandbox observation below the Workflow step's 30-minute
// deadline. Expiry retains the exact paid attempt and never revokes its owner.
// Give peers a prompt chance to settle when one sandbox observation hangs.
// A later Workflow poll reattaches to the same admitted process and exact receipt.
export const agentSandboxObservationMs = 2 * 60_000
export const agentSandboxLaunchPrerequisiteMs = 60_000
export const agentSandboxTerminalReceiptMs = 60_000
export const terminalLogDrainMs = 10_000
// An inaccessible admitted process may still be doing paid work. Keep its
// custody, but do not let an observation outage masquerade as a live audit
// indefinitely. This bounds only the control plane's wait, not process life.
export const agentObservationIncidentMaxMs = 60 * 60_000
/** A failed preparation command is retried in place after these waits (E10). */
export const workspacePreparationRetryWaitsMs: readonly number[] = [30_000, 60_000]
/** A new try starts only this soon after the first began, so one launch's setup stays bounded. */
export const workspacePreparationRetryWindowMs = 10 * 60_000

function observationIdentityFor(request: AgentRequest): AgentObservationIdentity {
  return { runId: request.runId, stageId: request.stage.id, waveId: request.wave.id,
    ...(request.taskExecutionId === undefined ? {} : { taskExecutionId: request.taskExecutionId }),
    taskId: request.task.id, attempt: request.attempt, promptDigest: request.promptDigest }
}

function observationHealthIntegrityError(error: unknown): boolean {
  return error instanceof Error && /provenance mismatch|health is invalid|request digest changed/.test(error.message)
}

class AgentObservationExpired extends AgentExecutionPending {
  constructor(processId: string, readonly operation: string, readonly startedAt: Date) {
    super(processId, 'unavailable')
  }
}

async function observeSandboxRead<T>(operation: () => Promise<T>, deadline: number,
  processId: string, operationName = 'sandbox-read'): Promise<T> {
  const startedAt = new Date()
  const observation = await boundedReadOnlyObservation(operation, deadline)
  if (observation.expired) throw new AgentObservationExpired(processId, operationName, startedAt)
  return observation.value
}

function lifecycleLog(event: string, fields: Readonly<Record<string, unknown>>): void {
  console.log(canonicalJson({ schemaVersion: 1, kind: 'agent-sandbox-lifecycle', event, ...fields }))
}

function redactKnownCredentials(value: string, env: Env): string {
  const credentials = Object.entries(env)
    .filter(([name, secret]) => (
      typeof secret === 'string' && secret.length >= 8
      && (/^TARGET_/i.test(name) || /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name))
    ))
    // A Codex login binding is JSON: its tokens are listed one by one too, named as the container log names them (T3).
    .flatMap(([name, secret]): [string, unknown][] => [[name, secret], ...(/_AUTH_JSON$/.test(name)
      ? credentialsFromJson(String(secret), name.slice(0, -'_JSON'.length)).map(item => [item.name, item.value] as [string, unknown])
      : [])])
    .sort((left, right) => String(right[1]).length - String(left[1]).length)
  let redacted = value
  for (const [name, secret] of credentials) redacted = redacted.replaceAll(String(secret), `<redacted:${name}>`)
  return redacted
}


/** Copy the quarantined output files back for a repair attempt. */
export async function writeRepairBaseline(sandbox: Pick<SandboxClient, 'exec' | 'mkdir' | 'writeFile'>,
  request: Pick<AgentRequest, 'task' | 'repairFiles'>): Promise<void> {
  for (const [path, content] of Object.entries(request.repairFiles)) {
    // The runner rewrites its scratch test bundle; it stays in repairFiles for the digest binding.
    if (path === capturedBundlePath(request.task)) continue
    if (!request.task.output.requiredFiles.includes(path)) {
      throw new PermanentRunFailure(`repair file is outside output contract: ${path}`, 'invalid-configuration')
    }
    const destination = `/workspace/results/${path}`
    await sandbox.mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
    await sandbox.writeFile(destination, content)
    const writable = await sandbox.exec(`chown 10001:10001 ${destination} && chmod 0600 ${destination}`, { timeout: 10_000 })
    if (!writable.success) {
      throw new PermanentRunFailure(`repair baseline ownership failed: ${writable.stderr.slice(-2_000)}`, 'invalid-configuration')
    }
  }
}

export function agentProcessEnvironment(request: AgentRequest, env: Env,
  targetEnvironment: Readonly<Record<string, string>>): Record<string, string> {
  const resolvedKey = (name: string): string => {
    const value = env[name]
    if (name === 'CLOUDFLARE_OBSERVABILITY_TOKEN' || typeof value !== 'string' || value.trim() === '') {
      throw new PermanentRunFailure(`agent credential ${name} is missing`, 'missing-credentials')
    }
    return value
  }
  const scopedTargetEnvironment = targetEnvironment
  const nativeDshHttp2 = usesNativeDshHttp2(request.task)
  const diagnosticEndpoint = nativeDshHttp2 ? nativeDshDiagnosticEndpoint(request.task) : null
  if (taskBackend(request.task) === 'claude') {
    return { ...targetWorkspaceEnvironment, ...scopedTargetEnvironment,
      CLAUDE_CODE_OAUTH_TOKEN: resolvedKey(request.task.credentialSource!),
      // Fallback accounts keep their own binding names; the runner gives the CLI only the active token.
      ...Object.fromEntries((request.task.fallbackCredentialSources ?? []).map(name => [name, resolvedKey(name)])),
      ...(request.nativeSearchConnection === undefined ? {} : {
        [request.nativeSearchConnection.apiKeyEnv]: resolvedKey(request.nativeSearchConnection.apiKeyEnv),
      }),
    }
  }
  return request.task.providerClass === 'additive'
    ? {
        ...targetWorkspaceEnvironment,
        ...scopedTargetEnvironment,
        [request.task.connection!.apiKeyEnv]: resolvedKey(request.task.connection!.apiKeyEnv),
        ...Object.fromEntries(modelHeaderCredentialNames(request.task.connection).map(name => [name, resolvedKey(name)])),
        ...(request.nativeSearchConnection === undefined ? {} : {
          [request.nativeSearchConnection.apiKeyEnv]: resolvedKey(request.nativeSearchConnection.apiKeyEnv),
        }),
        ...(diagnosticEndpoint === null ? {} : {
          NODE_OPTIONS: withNativeDshHttp2NodeOptions(scopedTargetEnvironment.NODE_OPTIONS),
          ACK3_DSH_DIAGNOSTIC_ORIGIN: diagnosticEndpoint.origin,
          ACK3_DSH_DIAGNOSTIC_PATH: diagnosticEndpoint.path,
        }),
      }
    : { ...targetWorkspaceEnvironment, ...scopedTargetEnvironment,
      ACK3_CODEX_WORKSPACE_ID: request.task.credentialSource === undefined ? env.ACK3_CODEX_WORKSPACE_ID
        : codexWorkspaceId(resolvedKey(subscriptionCredentialSource(request.task)!), '', true),
      ...(request.nativeSearchConnection === undefined ? {} : {
        [request.nativeSearchConnection.apiKeyEnv]: resolvedKey(request.nativeSearchConnection.apiKeyEnv),
      }),
    }
}

export class SandboxAgentProvider implements AgentProvider {
  private readonly artifacts: R2ArtifactStore
  private readonly executionReceipts: R2AgentExecutionReceiptStore
  private readonly observationHealth: R2AgentObservationHealthStore
  private readonly executionLogs: R2AgentExecutionLogStore
  private readonly nativeSessions: NativeSessionCustody
  private readonly runs: CloudflareRunStore
  private readonly sandboxObservationMs = agentSandboxObservationMs
  private readonly sandboxLaunchPrerequisiteMs = agentSandboxLaunchPrerequisiteMs
  private readonly sandboxTerminalReceiptMs = agentSandboxTerminalReceiptMs
  private readonly runtimeEnvironments = new Map<string, Readonly<Record<string, string>>>()
  private readonly credentialValues = new Map<string, string>()
  private readonly preparationSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

  constructor(private readonly env: Env) {
    this.artifacts = new R2ArtifactStore(env.ARTIFACTS)
    this.executionReceipts = new R2AgentExecutionReceiptStore(env.ARTIFACTS)
    this.observationHealth = new R2AgentObservationHealthStore(env.ARTIFACTS)
    this.executionLogs = new R2AgentExecutionLogStore(env.ARTIFACTS)
    this.nativeSessions = new NativeSessionCustody(env.ARTIFACTS)
    this.runs = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    assertCurrentWorkspaceRequest(request)
    request = deepClone(request)
    if (request.executionAuthority === undefined || request.execution === undefined) {
      throw new PermanentRunFailure('native request belongs to its historical app version', 'integrity-failed')
    }
    try {
      await assertDispatchedExecution(request.execution, { runId: request.runId, task: request.task,
        attempt: request.attempt, inputArtifacts: artifactReferences(request.visibleArtifacts) })
      if (request.execution.releaseDigest !== request.releaseDigest
        || request.execution.taskExecutionId !== request.taskExecutionId) throw new Error('execution configuration binding differs')
    } catch (error) {
      throw new PermanentRunFailure('native request differs from its dispatched execution contract', 'integrity-failed', { cause: error })
    }
    assertExecutionAuthority(request.executionAuthority)
    assertControlId(request.taskExecutionId, 'task execution id')
    if (request.executionAuthority.executionId !== request.runId) {
      throw new PermanentRunFailure('execution request differs from its authority', 'integrity-failed')
    }
    if (['coverage-union', 'review-union', 'final-seal'].includes(request.task.promptKind)) {
      await this.assertCurrentAdmission(request)
      assertCurrentTaskOwner(request)
    }
    if (request.task.promptKind === 'coverage-union') return this.coverageUnion(request)
    if (request.task.promptKind === 'review-union') return this.reviewUnion(request)
    if (request.task.promptKind === 'final-seal') return this.finalSeal(request)
    await this.assertProviderCredentials(request)
    if (request.execution !== undefined && Object.hasOwn(request.execution, 'retainedSession')) {
      throw new PermanentRunFailure('execution record belongs to its historical app version', 'integrity-failed')
    }
    const sandboxId = await nativeSandboxName(request)
    // Complete exact successful receipt recovery before touching the sandbox.
    const requestDigest = await sha256(canonicalJson(executionRequestBody(request, this.env.ACK3_CODEX_WORKSPACE_ID)))
    let durableCached: import('./agent-execution-receipt.js').AgentExecutionReceipt | null
    try {
      durableCached = await this.executionReceipts.get(request.runId, requestDigest)
    } catch (error) {
      if (error instanceof AgentExecutionReceiptIntegrityError) {
        throw new PermanentRunFailure(error.message, 'integrity-failed', { cause: error })
      }
      throw new TransientRunFailure('durable execution receipt observation is temporarily unavailable', { cause: error })
    }
    if (durableCached?.exitCode === 0) {
      lifecycleLog('receipt-recovered', {
        runId: request.runId, taskId: request.task.id, attempt: request.attempt,
        requestDigest, sandboxId, source: 'r2', exitCode: 0,
      })
      await this.settleControlledLaunch(request, durableCached, requestDigest)
      return agentResultFromExecutionReceipt(request, durableCached, requestDigest)
    }
    await this.assertCurrentAdmission(request)
    const observationIdentity = observationIdentityFor(request)
    let health: Awaited<ReturnType<R2AgentObservationHealthStore['get']>>
    try {
      health = await this.observationHealth.get(observationIdentity)
    } catch (error) {
      if (observationHealthIntegrityError(error)) {
        throw new PermanentRunFailure('agent observation health integrity failed', 'integrity-failed', { cause: error })
      }
      throw new TransientRunFailure('durable observation health is temporarily unavailable', { cause: error })
    }
    if (health !== null && health.requestDigest !== requestDigest) {
      throw new PermanentRunFailure('observation health request digest changed', 'integrity-failed')
    }
    if (health?.incidentSince !== null && health?.incidentSince !== undefined
      && Date.now() - Date.parse(health.incidentSince) >= agentObservationIncidentMaxMs) {
      // A receipt can arrive while the health record is read. Check it once
      // more before ending this Workflow; never revoke or replace the process.
      let terminal: Awaited<ReturnType<R2AgentExecutionReceiptStore['get']>>
      try { terminal = await this.executionReceipts.get(request.runId, requestDigest) } catch (error) {
        if (error instanceof AgentExecutionReceiptIntegrityError) {
          throw new PermanentRunFailure(error.message, 'integrity-failed', { cause: error })
        }
        throw new TransientRunFailure('terminal receipt observation is temporarily unavailable', { cause: error })
      }
      if (terminal !== null) {
        await this.settleControlledLaunch(request, terminal, requestDigest)
        return agentResultFromExecutionReceipt(request, terminal, requestDigest)
      }
      let actorId = ''
      try { actorId = this.env.AGENT_SANDBOX.idFromName(sandboxId).toString() } catch { /* Missing diagnostic identity stays unknown. */ }
      const resources = await lookupObservationResourceLoss({ env: this.env, actorId,
        firstFailedAt: health.firstFailedAt ?? health.incidentSince, memoryLimitMiB: containerCapacity.memoryMiB })
      lifecycleLog('observation-resource-assessment', {
        runId: request.runId, taskId: request.task.id, attempt: request.attempt, requestDigest, sandboxId,
        workerVersionId: this.env.VERSION_METADATA?.id ?? null, resources,
      })
      throw new UnobservableAgentExecution(
        `agent native work remained unobservable after the recorded observation incident; process and usage custody are unresolved; resources: ${canonicalJson(resources)}`)
    }
    if (health?.nextObservationAfter !== null && health?.nextObservationAfter !== undefined
      && Date.now() < Date.parse(health.nextObservationAfter)) {
      throw new AgentExecutionPending(agentProcessId(requestDigest), 'unavailable')
    }
    // A failed observation before claimStart is not an admitted paid process.
    // It must not prevent the first legitimate launch after control recovers.
    let retainedClaim = false
    if (health !== null && health.consecutiveFailures > 0) {
      try {
        retainedClaim = await this.executionReceipts.getStart(request.runId, requestDigest) !== null
      } catch (error) {
        throw new TransientRunFailure('durable launch claim is temporarily unavailable', { cause: error })
      }
    }
    assertCurrentTaskOwner(request)
    const mutationOwner = deepClone(request.execution?.mutationOwner)
    const sandbox = getAgentSandbox(this.env.AGENT_SANDBOX, sandboxId, {
      ...(mutationOwner === undefined ? {} : { mutationOwner }),
      // Model calls and continuation scratch can outlive Workflow scheduling
      // gaps. Cloudflare stops an idle Sandbox and loses its processes/files;
      // disposal below remains the explicit terminal lifecycle boundary.
      ...(!retainedClaim || health?.incidentSince === null
        ? { keepAlive: true, inactivityTimeoutMs: 30 * 60_000,
          labels: { experiment: request.experimentId, run: request.runId, lane: await nativeWorkspaceKey(request.task) } }
        : {}) })
    if (mutationOwner?.ordinal === 0) {
      try {
        const birth = await boundedLaunchPrerequisite(() => this.registerWorkspaceBirth(sandbox, sandboxId, mutationOwner),
          Date.now() + this.sandboxLaunchPrerequisiteMs)
        if (birth.expired) throw new AgentExecutionPending(agentProcessId(requestDigest), 'unavailable')
      } catch (error) {
        if (error instanceof RunFailure || error instanceof AgentExecutionPending) throw error
        throw new TransientRunFailure('workspace birth publication remains uncertain', { cause: error })
      }
    }
    // Await the critical lifetime setting before an admitted agent can start work.
    const processId = agentProcessId(requestDigest)
    if (!retainedClaim || health?.incidentSince === null) {
      try {
        const startedAt = new Date()
        const lifetime = await boundedLaunchPrerequisite(
          () => sandbox.setKeepAlive(true), Date.now() + this.sandboxLaunchPrerequisiteMs,
        )
        if (lifetime.expired) throw new AgentObservationExpired(processId, 'lifetime-config', startedAt)
      } catch (error) {
        if (error instanceof AgentObservationExpired) {
          await this.deferExpiredObservation(observationIdentity, requestDigest, error.operation, error.startedAt)
        }
        if (error instanceof AgentExecutionPending) throw error
        throw new TransientRunFailure('Cloudflare Sandbox lifetime configuration failed', { cause: error })
      }
    }
    try {
      const result = await this.runInSandbox(sandbox, request, retainedClaim,
        observationIdentity, requestDigest)
      return result
    } catch (error) {
      if (error instanceof AgentObservationExpired) {
        await this.deferExpiredObservation(observationIdentity, requestDigest, error.operation, error.startedAt)
      }
      if (error instanceof AgentExecutionPending) throw error
      const annotated = await annotateContainerResourceFailure(sandbox, request, error, requestDigest)
      if (annotated instanceof RunFailure || annotated instanceof AgentAttemptFailure) throw annotated
      throw new TransientRunFailure('Cloudflare Sandbox transport failed', { cause: annotated })
    }
  }

  private async deferExpiredObservation(identity: AgentObservationIdentity,
    requestDigest: string, operation: string, startedAt: Date): Promise<void> {
    try {
      await this.observationHealth.recordFailure(identity, requestDigest, operation, startedAt, new Date())
    } catch (error) {
      if (observationHealthIntegrityError(error)) {
        throw new PermanentRunFailure('agent observation health failed integrity', 'integrity-failed',
          { cause: error })
      }
      throw new TransientRunFailure('durable observation health could not be saved', { cause: error })
    }
  }

  private async recordObservationSuccess(identity: AgentObservationIdentity,
    requestDigest: string, observedAt: Date): Promise<void> {
    try {
      await this.observationHealth.recordProcessSuccess(identity, requestDigest, observedAt)
    } catch {
      // A confirmed process or exact receipt is authoritative even if its
      // auxiliary observation-health record cannot be refreshed right now.
      lifecycleLog('observation-health-write-failed', {
        runId: identity.runId, taskId: identity.taskId, attempt: identity.attempt, requestDigest,
      })
    }
  }

  private async credential(name: string): Promise<string | null> {
    if (name === 'CLOUDFLARE_OBSERVABILITY_TOKEN') return null
    const cached = this.credentialValues.get(name)
    if (cached !== undefined) return cached
    const value = await resolveCredentialBinding(this.env, name)
    if (value !== null) this.credentialValues.set(name, value)
    return value
  }

  private redactKnownCredentials(value: string): string {
    return redactKnownCredentials(value, { ...this.env, ...Object.fromEntries(this.credentialValues) })
  }

  private async assertProviderCredentials(request: AgentRequest): Promise<void> {
    if (taskBackend(request.task) === 'claude') {
      for (const name of claudeAccountBindings(request.task)) {
        if (!(await this.credential(name))?.startsWith('sk-ant-oat')) {
          throw new PermanentRunFailure(`Claude subscription token ${name} is missing or invalid`, 'missing-credentials')
        }
      }
      if (request.nativeSearchConnection !== undefined
        && (await this.credential(request.nativeSearchConnection.apiKeyEnv)) === null) {
        throw new PermanentRunFailure('native search credential is missing', 'missing-credentials')
      }
      return
    }
    if (request.task.providerClass === 'core') {
      const auth = await this.credential(subscriptionCredentialSource(request.task)!)
      if (auth === null || (request.task.credentialSource === undefined && this.env.ACK3_CODEX_WORKSPACE_ID.trim() === '')) {
        throw new PermanentRunFailure('core provider credentials are missing', 'missing-credentials')
      }
      try { codexWorkspaceId(auth, '', request.task.credentialSource !== undefined) }
      catch { throw new PermanentRunFailure('selected Codex account is invalid', 'missing-credentials') }
      if (request.nativeSearchConnection !== undefined
        && (await this.credential(request.nativeSearchConnection.apiKeyEnv)) === null) {
        throw new PermanentRunFailure(`native search credential is missing for ${request.task.id}`, 'missing-credentials')
      }
      return
    }
    if (request.task.providerClass !== 'additive') return
    const connection = request.task.connection
    if (taskBackend(request.task) !== 'dsh-chat-completions' || connection === undefined
      || !/^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(connection.apiKeyEnv)) {
      throw new PermanentRunFailure(`additive provider connection is invalid for ${request.task.id}`, 'invalid-configuration')
    }
    if ((await this.credential(connection.apiKeyEnv)) === null) {
      throw new PermanentRunFailure(`additive provider credential is missing for ${request.task.id}`, 'missing-credentials')
    }
    for (const name of modelHeaderCredentialNames(connection)) {
      if ((await this.credential(name)) === null) throw new PermanentRunFailure(`model header credential ${name} is missing`, 'missing-credentials')
    }
    if (request.nativeSearchConnection !== undefined) {
      if ((await this.credential(request.nativeSearchConnection.apiKeyEnv)) === null) {
        throw new PermanentRunFailure(`native search credential is missing for ${request.task.id}`, 'missing-credentials')
      }
    }
  }

  private async runtimeEnvironment(releaseDigest: string): Promise<Readonly<Record<string, string>>> {
    const cached = this.runtimeEnvironments.get(releaseDigest)
    if (cached !== undefined) return cached
    const release = await this.runs.getRelease(releaseDigest)
    const values = resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, this.env)
    this.runtimeEnvironments.set(releaseDigest, values)
    return values
  }

  private async runInSandbox(sandbox: SandboxClient, request: AgentRequest, observationIncident = false,
    observationIdentity?: AgentObservationIdentity, observedRequestDigest?: string): Promise<AgentResult> {
    if (request.execution !== undefined && Object.hasOwn(request.execution, 'retainedSession')) {
      throw new PermanentRunFailure('execution record belongs to its historical app version', 'integrity-failed')
    }
    const sandboxId = await nativeSandboxName(request)
    const requestPath = '/workspace/private/agent-request.json'
    const resultPath = '/workspace/private/agent-result.json'
    const requestBody = executionRequestBody(request, this.env.ACK3_CODEX_WORKSPACE_ID)
    const requestDigest = await sha256(canonicalJson(requestBody))
    if (observedRequestDigest !== undefined && requestDigest !== observedRequestDigest) {
      throw new PermanentRunFailure('observation request changed', 'integrity-failed')
    }
    const processId = agentProcessId(requestDigest)
    const observationDeadline = Date.now() + this.sandboxObservationMs
    const observe = <T>(operation: () => Promise<T>, operationName: string) =>
      observeSandboxRead(operation, observationDeadline, processId, operationName)
    const durableCached = await this.executionReceipts.get(request.runId, requestDigest)
    if (durableCached !== null) {
      await this.ensureAgentLogRequest(request, requestDigest)
      lifecycleLog('receipt-recovered', {
        runId: request.runId, taskId: request.task.id, attempt: request.attempt,
        requestDigest, sandboxId, source: 'r2', exitCode: durableCached.exitCode,
      })
      return this.agentResult(sandbox, request, durableCached, requestDigest)
    }
    const sandboxReceipt = await observe(() => sandbox.exists(resultPath), 'receipt-exists')
    if (sandboxReceipt.exists) {
      const file = await observe(() => sandbox.readFile(resultPath), 'receipt-read')
      const sandboxReceiptMatch = classifyAgentExecutionReceipt(file.content, requestDigest)
      if (sandboxReceiptMatch.status === 'invalid') {
        throw new PermanentRunFailure('sandbox execution receipt failed integrity validation', 'integrity-failed')
      }
      if (sandboxReceiptMatch.status === 'exact') {
        // Stored as the normal path stores it (T3).
        const receipt = { ...sandboxReceiptMatch.receipt, stderr: this.redactKnownCredentials(sandboxReceiptMatch.receipt.stderr) }
        await this.executionReceipts.put(request.runId, requestDigest, receipt, request)
        await this.ensureAgentLogRequest(request, requestDigest)
        await this.drainAgentLogs(sandbox, request, requestDigest)
        lifecycleLog('receipt-recovered', {
          runId: request.runId, taskId: request.task.id, attempt: request.attempt,
          requestDigest, sandboxId, source: 'sandbox', exitCode: receipt.exitCode,
        })
        return this.agentResult(sandbox, request, receipt, requestDigest)
      }
    }

    if (request.task.providerClass === 'deterministic') {
      await sandbox.mkdir('/workspace/private', { recursive: true })
      await this.prepareSandbox(sandbox, request)
      await writeAccepted(sandbox, request, this.artifacts)
      await clearUntrustedTaskOutputs(sandbox,
        [...request.task.output.requiredFiles, ...(request.optionalOutputFiles ?? [])], request.repairFiles)
      return this.preflight(sandbox, request)
    }

    const wrapperPath = '/workspace/private/agent-runner-with-receipt.mjs'
    const launchFencePath = `/workspace/private/agent-launch-${requestDigest}`
    const launchReadyPath = `/workspace/private/agent-ready-${requestDigest}`
    lifecycleLog('observe', {
      runId: request.runId, taskId: request.task.id, attempt: request.attempt,
      requestDigest, sandboxId, processId,
    })
    let process = await observe(() => sandbox.getProcess(processId), 'process-lookup')
    if (observationIncident && process === null) {
      // Observation loss is not proof that the paid process or its native work
      // disappeared. Never enter the normal launch/revocation path from an
      // unresolved observation incident without separate terminal custody.
      if (observationIdentity !== undefined) {
        try {
          await this.observationHealth.recordFailure(observationIdentity, requestDigest,
            'process-missing', new Date(observationDeadline - this.sandboxObservationMs))
        } catch (error) {
          throw new AgentExecutionPending(processId, 'unavailable', { cause: error })
        }
      }
      throw new AgentExecutionPending(processId, 'unavailable')
    }
    let admittedAt: string | null = null
    if (process === null) {
      await sandbox.mkdir('/workspace/private', { recursive: true })
      const targetEnvironment = await this.runtimeEnvironment(request.releaseDigest)
      const nativeDshHttp2 = usesNativeDshHttp2(request.task)
      const credentialEnv = { ...this.env }
      for (const name of [request.task.connection?.apiKeyEnv, ...modelHeaderCredentialNames(request.task.connection), request.nativeSearchConnection?.apiKeyEnv,
        request.task.credentialSource === undefined ? undefined : subscriptionCredentialSource(request.task),
        ...(request.task.fallbackCredentialSources ?? [])]) {
        if (name !== undefined) {
          const value = await this.credential(name)
          if (value === null) throw new PermanentRunFailure(`agent credential ${name} is missing`, 'missing-credentials')
          credentialEnv[name] = value
        }
      }
      const processEnvironment = agentProcessEnvironment(request, credentialEnv, targetEnvironment)
      let existingClaim = null
      if (request.nativeTransport !== undefined || request.formatRepairOrdinal !== undefined) {
        // A transient custody read must not strand an immutable launch claim.
        // An existing owner may already be changing the journal: observe its
        // receipt/process using the normal fences instead of inspecting it.
        const readClaim = async () => {
          try { return await this.executionReceipts.getStart(request.runId, requestDigest) } catch (error) {
            throw new TransientRunFailure('native execution claim observation is temporarily unavailable', { cause: error })
          }
        }
        existingClaim = await readClaim()
        if (existingClaim === null) {
          try {
            if (request.nativeTransport !== undefined) await this.nativeSessions.assertRetryCustody(sandbox, request)
            if (request.formatRepairOrdinal !== undefined && request.task.providerClass === 'additive'
              && request.task.backend === 'dsh-chat-completions') {
              await this.nativeSessions.assertFormatRepairCustody(sandbox, request)
            }

          } catch (error) {
            // Another owner can win while our inspection is in flight.
            existingClaim = await readClaim()
            if (existingClaim === null) {
              if (request.formatRepairOrdinal === undefined
                && error instanceof PermanentRunFailure && error.category === 'session-recovery-unavailable'
                && request.task.optional === true) {
                return this.nativeSessionUnavailable(request, { actorId: request.sessionId!, inputTokens: 0, outputTokens: 0, costUsd: 0 }, 0)
              }
              throw error
            }
          }
        }
      }
      // Reservation and fencing share one atomic index. A reserved but not yet
      // observable launch remains outstanding until terminal/physical evidence;
      // a fence cannot silently drop it and activate a second executor.
      try {
        if (existingClaim === null) {
          await reserveNativeLaunch(this.runs, new ExecutionAuthorityStore(this.env.INDEX), request, requestDigest)
        }
      } catch (error) {
        if (error instanceof RunFailure) throw error
        if (error instanceof RunCommandConflict || error instanceof TypeError) {
          throw new PermanentRunFailure(`native launch authority conflict: ${error.message}`, 'integrity-failed', { cause: error })
        }
        throw new TransientRunFailure('native launch authority is temporarily unavailable', { cause: error })
      }
      const launchClaim = existingClaim ?? await this.executionReceipts.claimStart(request.runId, requestDigest)
      admittedAt = launchClaim.claimedAt
      if (!launchClaim.acquired) {
        const recoveredDurable = await this.executionReceipts.get(request.runId, requestDigest)
        if (recoveredDurable !== null) return this.agentResult(sandbox, request, recoveredDurable, requestDigest)
        const recoveredSandbox = await observe(() => sandbox.exists(resultPath), 'receipt-exists')
        if (recoveredSandbox.exists) {
          const file = await observe(() => sandbox.readFile(resultPath), 'receipt-read')
          const match = classifyAgentExecutionReceipt(file.content, requestDigest)
          if (match.status === 'invalid') {
            throw new PermanentRunFailure('sandbox execution receipt failed integrity validation', 'integrity-failed')
          }
          if (match.status === 'exact') {
            // Stored as the normal path stores it (T3).
            const receipt = { ...match.receipt, stderr: this.redactKnownCredentials(match.receipt.stderr) }
            await this.executionReceipts.put(request.runId, requestDigest, receipt, request)
            await this.ensureAgentLogRequest(request, requestDigest)
            await this.drainAgentLogs(sandbox, request, requestDigest)
            return this.agentResult(sandbox, request, receipt, requestDigest)
          }
        }
        process = await observe(() => sandbox.getProcess(processId), 'process-lookup')
        if (process === null) {
          // Setup can fail after claiming launch but before registering a model
          // process. Retry private diagnostic custody before normal lost-owner
          // revocation; never replace a zero-model failure blindly.
          if (await this.persistWorkspacePreparationFailure(sandbox, request, requestDigest)) {
            throw new PermanentRunFailure('workspace preparation failed; private diagnostic receipt retained', 'preflight-failed')
          }
          const claimAgeMs = Date.now() - Date.parse(launchClaim.claimedAt)
          if (claimAgeMs < executionLaunchGraceMs) {
            throw new AgentExecutionPending(processId, 'unavailable')
          }
          const revoked = await sandbox.exec(
            `if mkdir ${launchFencePath} 2>/dev/null; then : > ${launchFencePath}/revoked; exit 0; fi; exit 1`,
            { timeout: 10_000 },
          )
          if (revoked.success) {
            lifecycleLog('revoked-missing-owner', {
              runId: request.runId, taskId: request.task.id, attempt: request.attempt,
              requestDigest, sandboxId, processId, claimAgeMs,
            })
            throw new AgentAttemptFailure(
              'the admitted execution lost its Sandbox process and durable receipt; a replacement attempt is required',
              { includeDiagnosticsInRepair: false },
            )
          }
          const alreadyRevoked = await sandbox.exists(`${launchFencePath}/revoked`)
          if (alreadyRevoked.exists) {
            throw new AgentAttemptFailure(
              'the admitted execution lost its Sandbox process and durable receipt; a replacement attempt is required',
              { includeDiagnosticsInRepair: false },
            )
          }
          process = await observe(() => sandbox.getProcess(processId), 'process-lookup')
          if (process === null) throw new AgentExecutionPending(processId, 'unavailable')
        }
      } else {
        // Only the launch-claim holder reaches this point, after the lane's earlier
        // attempt ended, so no agent runner or workspace preparation is running here.
        // Stop what an earlier attempt left behind before setup touches the workspace (T2).
        await this.stopLeftoverAgentProcesses(sandbox, request, requestDigest, sandboxId)
        // Target-controlled setup runs before the credential-bearing process
        // exists. The durable claim and grace clock protect this bounded work.
        await this.prepareSandbox(sandbox, request, requestDigest)
        // The process holds an atomic local fence and cannot invoke the model
        // until setup publishes its request-bound ready marker.
        const guardedLaunch = `sh -c 'if mkdir ${launchFencePath} 2>/dev/null; then : > ${launchFencePath}/owner; else exit 75; fi; for i in $(seq 1 ${Math.ceil(workflowAttemptTimeoutMs / 1_000)}); do if [ -f ${launchReadyPath} ]; then exec node ${wrapperPath} ${requestPath} ${resultPath}; fi; sleep 1; done; exit 74'`
        process = await sandbox.startProcess(guardedLaunch, {
          processId,
          cwd: '/workspace/source',
          env: processEnvironment,
        })
        lifecycleLog('process-started', {
          runId: request.runId, taskId: request.task.id, attempt: request.attempt,
          requestDigest, sandboxId, processId,
        })
        const revoked = await sandbox.exists(`${launchFencePath}/revoked`)
        if (revoked.exists) throw new AgentExecutionPending(processId, 'unavailable')
        await writeAccepted(sandbox, request, this.artifacts, { pocTests: await this.verifierReceivesPocTests(request) })
        const nativeResume = request.continuationMode === 'resume'
          && (request.nativeTransport !== undefined || request.formatRepairOrdinal !== undefined)
        if (!nativeResume) await clearUntrustedTaskOutputs(sandbox,
          [...request.task.output.requiredFiles, ...(request.optionalOutputFiles ?? [])], request.repairFiles)
        if (request.task.promptKind === 'coverage-challenge') await ensureCoverageChallengeOutput(sandbox)
        if (Object.keys(request.repairFiles).length > 0) {
          await writeRepairBaseline(sandbox, request)
          await sandbox.writeFile('/control/output-contract-diagnostics.json', canonicalJson({
            schemaVersion: 1,
            kind: 'canonical-output-contract-diagnostics',
            taskId: request.task.id,
            attempt: request.attempt - 1,
            diagnostics: request.diagnostics,
          }))
          const readable = await sandbox.exec('chmod 0444 /control/output-contract-diagnostics.json', { timeout: 10_000 })
          if (!readable.success) {
            throw new PermanentRunFailure(`repair diagnostics permission failed: ${readable.stderr.slice(-2_000)}`, 'invalid-configuration')
          }
        } else if (!nativeResume) {
          const template = await submissionTemplate(request.task, request.visibleArtifacts)
          if (template !== null) {
            const path = `/workspace/results/${SUBMISSION_PATH}`
            await sandbox.mkdir('/workspace/results/.swarm', { recursive: true })
            await sandbox.writeFile(path, template)
            const writable = await sandbox.exec(`chown 10001:10001 ${path} && chmod 0600 ${path}`, { timeout: 10_000 })
            if (!writable.success) {
              throw new PermanentRunFailure(`submission template ownership failed: ${writable.stderr.slice(-2_000)}`, 'invalid-configuration')
            }
          }
        }
        await sandbox.writeFile(requestPath, canonicalJson({ ...requestBody, requestDigest }))
        await sandbox.writeFile(wrapperPath, agentExecutionReceiptWrapper)
        if (request.task.providerClass === 'additive') {
          // Native DSH's HOME layer overrides the installed runner's profile.
          // Replace the complete configuration only while a new launch is fenced;
          // receipt recovery and process observation never rewrite an active lane.
          await sandbox.writeFile('/opt/dsh-home/cordis.patch.yml', renderDshReasoningPatch(requestBody)
            + (nativeResume ? request.nativeTransport !== undefined
              ? renderNativeSessionResumePatch(request.nativeTransport)
              : renderNativeSessionIdPatch(request.sessionId!) : ''))
          const readable = await sandbox.exec('chmod 0444 /opt/dsh-home/cordis.patch.yml', { timeout: 10_000 })
          if (!readable.success) {
            throw new PermanentRunFailure('native DSH configuration permission failed', 'invalid-configuration')
          }
          if (nativeDshHttp2) {
            await sandbox.writeFile(nativeDshHttp2PreloadPath, nativeDshHttp2PreloadSource)
            const preloadReadable = await sandbox.exec(
              `chown root:root /control ${nativeDshHttp2PreloadPath} && chmod 0755 /control && chmod 0444 ${nativeDshHttp2PreloadPath}`,
              { timeout: 10_000 },
            )
            if (!preloadReadable.success) {
              throw new PermanentRunFailure('native DSH HTTP/2 preload permission failed', 'invalid-configuration')
            }
          }
        }
        const cleared = await sandbox.exec(`rm -f ${resultPath}`, { timeout: 10_000 })
        if (!cleared.success) {
          throw new PermanentRunFailure(`stale agent result cleanup failed: ${cleared.stderr.slice(-2_000)}`, 'invalid-configuration')
        }
        const revokedAfterSetup = await sandbox.exists(`${launchFencePath}/revoked`)
        if (revokedAfterSetup.exists) throw new AgentExecutionPending(processId, 'unavailable')
        await sandbox.writeFile(launchReadyPath, 'ready')
      }
    }
    // Retry immutable request metadata on every owner observation. The paid
    // process is already registered (and setup has released new launches), so
    // monitor failure cannot prevent or duplicate execution.
    await this.ensureAgentLogRequest(request, requestDigest, admittedAt)
    // A bounded wait keeps each Workflow step durable. An elapsed slice is not
    // an execution failure: the next step reattaches to this exact process ID.
    let pollActive = true
    let statusObserved = false
    let statusExpired = false
    let exitCode: Awaited<ReturnType<typeof waitForAgentProcess>>
    try {
      exitCode = await waitForAgentProcess(process, agentProcessWaitSliceMs, 1_000, {
        intervalMs: agentLogObservationIntervalMs,
        immediate: true,
        onStatusProbe: outcome => {
          if (outcome === 'success') statusObserved = true
          if (outcome === 'expired') statusExpired = true
        },
        observe: async () => {
          await this.captureAgentLogs(sandbox, request, requestDigest, false, () => pollActive)
        },
      })
    } finally {
      pollActive = false
    }
    if (statusExpired && !statusObserved) throw new AgentObservationExpired(processId,
      'process-status', new Date(observationDeadline - this.sandboxObservationMs))
    if (exitCode === 'unavailable') throw new AgentObservationExpired(processId,
      'process-status-unavailable', new Date(observationDeadline - this.sandboxObservationMs))
    lifecycleLog('process-observed', {
      runId: request.runId, taskId: request.task.id, attempt: request.attempt,
      requestDigest, sandboxId, processId, status: exitCode,
    })
    if (exitCode === 'running') {
      if (statusObserved && observationIdentity !== undefined) {
        await this.recordObservationSuccess(observationIdentity, requestDigest,
          new Date(observationDeadline - this.sandboxObservationMs))
      }
      throw new AgentExecutionPending(processId, 'unfinished')
    }
    const raw = await observeSandboxRead(
      () => sandbox.readFile(resultPath),
      Date.now() + this.sandboxTerminalReceiptMs,
      processId,
      'receipt-read',
    ).catch(error => {
      if (error instanceof AgentExecutionPending) throw error
      // Process logs are best-effort diagnostics. A stalled log RPC must not
      // hold a completed exact receipt behind the Workflow observation step.
      const failure = agentResultReadFailure({ success: exitCode === 0, exitCode, stderr: '' }, error)
      if (exitCode === 0) throw new TransientRunFailure(failure.message, { cause: error })
      throw new AgentAttemptFailure(failure.message, { cause: error })
    })
    const parsedResult = parseExactAgentExecutionReceipt(raw.content, requestDigest)
    if (parsedResult === null) {
      throw new PermanentRunFailure('agent result receipt does not match the exact request', 'integrity-failed')
    }
    const result = { ...parsedResult, stderr: this.redactKnownCredentials(parsedResult.stderr) }
    try {
      await this.executionReceipts.put(request.runId, requestDigest, result, request)
    } catch (error) {
      lifecycleLog('receipt-persist-failed', {
        runId: request.runId, taskId: request.task.id, attempt: request.attempt,
        requestDigest, sandboxId, processId, exitCode: result.exitCode,
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw error
    }
    lifecycleLog('receipt-durable', {
      runId: request.runId, taskId: request.task.id, attempt: request.attempt,
      requestDigest, sandboxId, processId, exitCode: result.exitCode,
    })
    // Terminal capture begins only after the exact paid execution receipt is
    // durable. Its fixed slice budget cannot affect payment/retry evidence.
    await this.drainAgentLogs(sandbox, request, requestDigest)
    return this.agentResult(sandbox, request, result, requestDigest, exitCode === 0)
  }

  private async ensureAgentLogRequest(
    request: AgentRequest,
    requestDigest: string,
    admittedAt: string | null = null,
  ): Promise<void> {
    try {
      const startedAt = admittedAt ?? (await this.executionReceipts.getStart(request.runId, requestDigest))?.claimedAt
      if (startedAt === undefined) throw new Error('agent log request lacks its native launch claim')
      let researcherProtocol: string | undefined
      try {
        researcherProtocol = (await this.runs.getRelease(request.releaseDigest)).body.definition.prompts.researcherProtocol
      } catch {}
      const recordedPrompt = this.redactKnownCredentials(request.prompt)
      if (recordedPrompt !== request.prompt) throw new Error('agent prompt contains a known credential')
      const recordedProtocol = researcherProtocol === undefined
        ? undefined
        : this.redactKnownCredentials(researcherProtocol)
      await this.executionLogs.putRequest({
        schemaVersion: 1,
        runId: request.runId,
        stageId: request.stage.id,
        waveId: request.wave.id,
        taskId: request.task.id,
        requestDigest,
        promptDigest: request.promptDigest,
        prompt: request.prompt,
        model: request.task.model,
        provider: providerIdentity(request.task),
        attempt: request.attempt,
        startedAt,
        startedAtBasis: 'execution-admission',
        ...(recordedProtocol === undefined || recordedProtocol !== researcherProtocol
          ? {}
          : { researcherProtocol: recordedProtocol }),
      })
    } catch (error) {
      lifecycleLog('log-request-capture-failed', {
        runId: request.runId,
        taskId: request.task.id,
        requestDigest,
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
  }

  private async captureAgentLogs(
    sandbox: SandboxClient,
    request: AgentRequest,
    requestDigest: string,
    terminal: boolean,
    active: () => boolean = () => true,
  ): Promise<boolean> {
    try {
      const cursor = await this.executionLogs.cursor({
        runId: request.runId,
        taskId: request.task.id,
        requestDigest,
      })
      if (!active() || !cursor.ready) return false
      const observed = await sandbox.observeAgentLog(requestDigest, cursor.index.sourceBytes, agentLogReadMaxBytes)
      if (!active()) return false
      const record = parseLogObservation(observed, cursor.index.sourceBytes, agentLogReadMaxBytes)
      if (record.status === 'missing') {
        if (terminal && active()) await this.executionLogs.finish({
          runId: request.runId, taskId: request.task.id, requestDigest, truncated: true,
        })
        return terminal
      }
      const bytes = Uint8Array.from(atob(record.data), character => character.charCodeAt(0))
      const reachedEnd = record.offset + record.bytes === record.size
      if (!active()) return false
      const index = await this.executionLogs.sync({
        runId: request.runId,
        taskId: request.task.id,
        requestDigest,
        source: new TextDecoder().decode(bytes),
        sourceOffset: cursor.index.sourceBytes,
        complete: terminal && reachedEnd,
      })
      return index.complete
    } catch (error) {
      lifecycleLog('log-stream-capture-failed', {
        runId: request.runId,
        taskId: request.task.id,
        requestDigest,
        terminal,
        error: error instanceof Error ? error.name : 'unknown',
      })
      return false
    }
  }

  private async drainAgentLogs(sandbox: SandboxClient, request: AgentRequest, requestDigest: string): Promise<void> {
    const completed = await boundedTerminalLogDrain(async active => {
      for (let slice = 0; slice < agentLogFinalDrainSlices; slice += 1) {
        if (!active()) return
        if (await this.captureAgentLogs(sandbox, request, requestDigest, true, active)) return
      }
      if (!active()) return
      try {
        await this.executionLogs.finish({
          runId: request.runId,
          taskId: request.task.id,
          requestDigest,
          truncated: true,
        })
      } catch (error) {
        lifecycleLog('log-terminal-capture-failed', {
          runId: request.runId,
          taskId: request.task.id,
          requestDigest,
          error: error instanceof Error ? error.name : 'unknown',
        })
      }
    }, terminalLogDrainMs)
    if (!completed) lifecycleLog('log-terminal-capture-deferred', {
      runId: request.runId, taskId: request.task.id, requestDigest,
    })
  }

  private nativeSessionUnavailable(
    request: AgentRequest,
    usage: { actorId: string, inputTokens: number, outputTokens: number, costUsd: number,
      rawInputTokens?: number, cachedInputTokens?: number, cacheAccountingComplete?: boolean,
      costAccountingComplete?: boolean },
    modelCalls: 0 | 1 = 1,
  ): AgentResult {
    return { actorId: usage.actorId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd,
      ...(usage.rawInputTokens === undefined ? {} : { rawInputTokens: usage.rawInputTokens }),
      ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
      ...(usage.cacheAccountingComplete === undefined ? {} : { cacheAccountingComplete: usage.cacheAccountingComplete }),
      ...(usage.costAccountingComplete === undefined ? {} : { costAccountingComplete: usage.costAccountingComplete }),
      status: 'additive-unavailable', model: request.task.model, provider: providerIdentity(request.task),
      files: {}, assertions: [], protocol: {}, modelCalls, unavailableReason: 'platform-interruption' }
  }

  private async agentResult(
    sandbox: SandboxClient,
    request: AgentRequest,
    result: import('./agent-execution-receipt.js').AgentExecutionReceipt,
    requestDigest: string,
    executionSuccess = result.exitCode === 0,
  ): Promise<AgentResult> {
    await this.settleControlledLaunch(request, result, requestDigest)
    try {
      const accepted = await agentResultFromExecutionReceipt(request, result, requestDigest, executionSuccess,
        fields => lifecycleLog('late-upstream-handoff-candidate', fields))
      if (accepted.status === 'additive-unavailable' && nativeTransportCode(request, result) !== null) {
        await this.nativeSessions.capture(sandbox, request, result)
      }
      return accepted
    } catch (error) {
      if (!(error instanceof AgentAttemptFailure)) throw error
      if (nativeTerminalCustodyCode(request, result) !== null) {
        const nativeTerminalCustody = await this.nativeSessions.captureTerminal(sandbox, request, result)
        if (nativeTerminalCustody === null) throw new PermanentRunFailure('native terminal custody classification changed', 'integrity-failed')
        throw new AgentAttemptFailure(error.message, { cause: error, usage: error.usage!,
          includeDiagnosticsInRepair: false, nativeTerminalCustody })
      }
      if (nativeTransportCode(request, result) === null) throw error
      const nativeTransport = await this.nativeSessions.capture(sandbox, request, result)
      if (nativeTransport === null) {
        lifecycleLog('native-session-custody-unavailable', { runId: request.runId, taskId: request.task.id,
          requestDigest, actorId: result.actorId })
        if (request.task.optional === true) return this.nativeSessionUnavailable(request, result)
        throw new PermanentRunFailure('native transport failed without resumable session custody',
          'session-recovery-unavailable', { cause: error })
      }
      throw new AgentAttemptFailure(error.message, { cause: error, usage: error.usage!,
        includeDiagnosticsInRepair: false, nativeTransport,
        ...(error.providerTransient === undefined ? {} : { providerTransient: error.providerTransient }) })
    }
  }

  private async settleControlledLaunch(request: AgentRequest,
    receipt: import('./agent-execution-receipt.js').AgentExecutionReceipt, requestDigest: string): Promise<void> {
    if (request.executionAuthority === undefined) return
    try {
      await new ExecutionAuthorityStore(this.env.INDEX).settleLaunch(
        request.executionAuthority, requestDigest, await sha256(receipt),
      )
    } catch (error) {
      if (error instanceof RunCommandConflict) {
        try {
          const selected = await new ExecutionAuthorityStore(this.env.INDEX).observeLaunch(
            request.executionAuthority, request.taskExecutionId!, requestDigest)
          if (selected?.receiptDigest !== null && selected?.receiptDigest !== undefined
            && await verifiedCancellationWinner(this.env, request, requestDigest, selected.receiptDigest)) {
            // The genuine receipt is already durable. Await the existing control
            // transition, without accepting this output or retrying paid work.
            throw new AgentExecutionPending(agentProcessId(requestDigest), 'cancelled')
          }
        } catch (observationError) {
          if (observationError instanceof RunFailure || observationError instanceof AgentExecutionPending) throw observationError
          if (observationError instanceof RunCommandConflict || observationError instanceof TypeError) {
            throw new PermanentRunFailure('native cancellation settlement integrity failed', 'integrity-failed', { cause: observationError })
          }
          throw new TransientRunFailure('native cancellation settlement observation is unavailable', { cause: observationError })
        }
      }
      if (error instanceof RunCommandConflict || error instanceof TypeError) {
        throw new PermanentRunFailure('native launch settlement integrity failed', 'integrity-failed', { cause: error })
      }
      // The exact paid receipt is already durable. A lost database response is
      // observation failure, never a failed model attempt or a fresh launch.
      throw new TransientRunFailure('native launch settlement is temporarily unavailable', { cause: error })
    }
  }

  private async assertCurrentAdmission(request: AgentRequest): Promise<void> {
    let state: import('./contracts.js').RunState
    try { state = await this.runs.getState(request.runId) }
    catch (cause) {
      if (cause instanceof RunFailure || cause instanceof AgentExecutionPending) throw cause
      throw new TransientRunFailure('task admission state is temporarily unavailable', { cause })
    }
    try {
      const check = request.task.providerClass === 'deterministic' ? assertSupervisorTaskAdmission : assertNativeTaskAdmission
      await check(state, request, digest => this.runs.getRelease(digest), this.runs.executionSources())
    } catch (cause) {
      if (cause instanceof RunFailure || cause instanceof AgentExecutionPending) throw cause
      if (cause instanceof RunCommandConflict) throw new TransientRunFailure('task selection changed; reload before execution', { cause })
      throw new PermanentRunFailure('task admission evidence is invalid', 'integrity-failed', { cause })
    }
  }

  private async registerWorkspaceBirth(sandbox: SandboxClient, sandboxId: string,
    owner: import('./workspace-mutation-owner.js').WorkspaceMutationOwner): Promise<void> {
    const receipt = await sandbox.initializeMutationOwner(owner)
    if (canonicalJson(receipt.owner) !== canonicalJson(owner)
      || receipt.objectId !== this.env.AGENT_SANDBOX.idFromName(sandboxId).toString()) {
      throw new PermanentRunFailure('workspace birth receipt differs', 'integrity-failed')
    }
  }

  async disposeWorkspace(input: {
    runId: string
    workspaceKey: string
    freshSuffix?: string
    mutationOwner?: import('./workspace-mutation-owner.js').WorkspaceMutationOwner
  }): Promise<WorkspaceDisposalReceipt> {
    input = deepClone(input)
    const sandboxId = await workspaceAllocationName(input)
    const sandbox = getAgentSandbox(this.env.AGENT_SANDBOX, sandboxId, {
      ...(input.mutationOwner === undefined ? {} : { mutationOwner: input.mutationOwner }),
      // Terminal workspace ownership disables keep-alive before destroy. If
      // teardown is delayed, the inactivity timeout remains a bounded fallback.
      keepAlive: false, inactivityTimeoutMs: 30 * 60_000,
      labels: { run: input.runId, lane: input.workspaceKey },
    })
    lifecycleLog('dispose-requested', {
      runId: input.runId, workspaceKey: input.workspaceKey, sandboxId,
    })
    // Include lifetime configuration in the same terminal deadline. A late
    // keep-alive response must not initiate destruction after deferral.
    const receipt = await boundedWorkspaceDisposal(async expired => {
      // An admitted synthetic unavailable result may never have created this
      // actor. Birth registration is metadata-only and refuses stale owners.
      if (input.mutationOwner?.ordinal === 0) await this.registerWorkspaceBirth(sandbox, sandboxId, input.mutationOwner)
      if (expired()) return
      await sandbox.setKeepAlive(false)
      if (!expired()) await sandbox.destroy()
    })
    lifecycleLog('dispose-settled', {
      runId: input.runId, workspaceKey: input.workspaceKey, sandboxId, status: receipt.status,
    })
    return receipt
  }

  private coverageUnion(request: AgentRequest): AgentResult {
    const union = createCoverageUnion(request.visibleArtifacts)
    const references = [...new Set(union.filter(value => value.observation.disposition !== 'refuted')
      .map(value => value.observation.reference))].toSorted()
    return {
      status: 'accepted', actorId: `supervisor-${request.runId}`, model: 'deterministic', provider: 'deterministic-supervisor',
      files: { 'coverage-challenge.md': renderCoverageUnion(union) }, assertions: ['coverage-union-preserves-all-inputs'],
      protocol: { coverageUnion: union, dispositionReferences: references }, inputTokens: 0, outputTokens: 0, costUsd: 0,
    }
  }

  private reviewUnion(request: AgentRequest): AgentResult {
    const union = createNegativeReviewUnion(request.visibleArtifacts)
    const manifest = createNegativeReviewUnionManifest(request.visibleArtifacts, union)
    return {
      status: 'accepted', actorId: `supervisor-${request.runId}`, model: 'deterministic', provider: 'deterministic-supervisor',
      files: { 'negative-disposition-review-union.json': canonicalJson(manifest) },
      assertions: ['negative-review-union-preserves-dissent'],
      protocol: {
        reviewUnion: union,
        dispositionReferences: manifest.unionReferences,
        decisionDissentObservationIds: manifest.decisionDissentObservationIds,
      },
      inputTokens: 0, outputTokens: 0, costUsd: 0,
    }
  }

  private async finalSeal(request: AgentRequest): Promise<AgentResult> {
    const reporter = request.visibleArtifacts.find(artifact => artifact.taskId === 'reporter' && artifact.status === 'accepted')
    if (reporter === undefined) throw new Error('final seal lacks an accepted reporter draft')
    const files = await this.artifacts.read(reporter)
    const draft = files['finding-draft.md']
    if (draft === undefined) throw new Error('reporter artifact lacks finding-draft.md')
    const custody = await createFinalObservationCustody(request.visibleArtifacts)
    return {
      status: 'accepted', actorId: `supervisor-${request.runId}`, model: 'deterministic', provider: 'deterministic-supervisor',
      files: { 'finding.md': sealFinalFinding(draft, custody) }, assertions: ['final-observation-custody-sealed'],
      protocol: { finalCustody: custody, retainedReferences: custody.retainedReferences },
      inputTokens: 0, outputTokens: 0, costUsd: 0,
    }
  }

  private async persistWorkspacePreparationFailure(
    sandbox: SandboxClient, request: AgentRequest, requestDigest: string,
  ): Promise<boolean> {
    const path = `/workspace/private/workspace-preparation-failure-${requestDigest}.json`
    const exists = await sandbox.exists(path)
    if (!exists.success) throw new TransientRunFailure('workspace preparation diagnostic observation is unavailable')
    if (!exists.exists) return false
    const release = await this.runs.getRelease(request.releaseDigest)
    const profile = release.body.definition.target.runtime.workspacePreparation
    if (profile === undefined) {
      throw new PermanentRunFailure('workspace preparation receipt has no sealed profile', 'integrity-failed')
    }
    let content: string
    try { content = (await sandbox.readFile(path)).content } catch (error) {
      throw new TransientRunFailure('workspace preparation diagnostic read is temporarily unavailable', { cause: error })
    }
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(content) as Record<string, unknown> } catch {
      throw new PermanentRunFailure('workspace preparation failure receipt is invalid', 'integrity-failed')
    }
    const commit = release.body.definition.target.commit
    const tree = release.body.definition.target.tree
    const profileDigest = await sha256(canonicalJson(profile))
    if (parsed.schemaVersion !== 1 || parsed.status !== 'failed' || parsed.commit !== commit
      || parsed.tree !== tree || parsed.profileDigest !== profileDigest || parsed.requestDigest !== requestDigest) {
      throw new PermanentRunFailure('workspace preparation failure receipt identity mismatch', 'integrity-failed')
    }
    const privateContent = canonicalJson({
      schemaVersion: 1, kind: 'workspace-preparation-failure',
      runId: request.runId, taskId: request.task.id, requestDigest,
      releaseDigest: request.releaseDigest, sourceCommit: commit, sourceTree: tree, profileDigest,
      receipt: {
        ...parsed,
        results: Array.isArray(parsed.results) ? parsed.results.map(value => {
          if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
          const item = value as Record<string, unknown>
          return { ...item, command: this.redactKnownCredentials(String(item.command ?? '')) }
        }) : parsed.results,
        stdout: this.redactKnownCredentials(String(parsed.stdout ?? '')),
        stderr: this.redactKnownCredentials(String(parsed.stderr ?? '')),
      },
    })
    try {
      await this.executionLogs.putWorkspacePreparationFailure({
        runId: request.runId, taskId: request.task.id, requestDigest, content: privateContent,
      })
    } catch (error) {
      throw new TransientRunFailure('workspace preparation diagnostic custody is temporarily unavailable', { cause: error })
    }
    return true
  }

  /** Keep a failed preparation try's failure file under a per-try name and log it, so the
   * next try starts clean and the last failure is still the one reported. False when there is
   * no failure file to keep: then the failure is not a command failure and is not retried. */
  private async setAsideWorkspacePreparationFailure(sandbox: SandboxClient, request: AgentRequest,
    requestDigest: string, tryNumber: number): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(requestDigest)) return false
    const path = `/workspace/private/workspace-preparation-failure-${requestDigest}.json`
    const exists = await sandbox.exists(path)
    if (!exists.success || !exists.exists) return false
    let code: unknown = null, command: unknown = null
    try {
      const failure = JSON.parse((await sandbox.readFile(path)).content) as { code?: unknown, results?: { index?: unknown }[] }
      code = typeof failure.code === 'string' ? failure.code : null
      command = Array.isArray(failure.results) ? failure.results.at(-1)?.index ?? null : null
    } catch { /* The kept file remains the evidence. */ }
    const kept = `/workspace/private/workspace-preparation-failure-${requestDigest}.try-${tryNumber}.json`
    const moved = await sandbox.exec(`mv -f -- '${path}' '${kept}'`, { timeout: 10_000 })
    if (!moved.success) return false
    lifecycleLog('workspace-preparation-retry', { runId: request.runId, taskId: request.task.id,
      attempt: request.attempt, requestDigest, try: tryNumber, code, command })
    return true
  }

  /** Stop the agent-user processes an earlier attempt left in this sandbox. An image without
   * the script skips this, and a failed sweep is only logged: neither stops the launch. */
  private async stopLeftoverAgentProcesses(sandbox: SandboxClient, request: AgentRequest,
    requestDigest: string, sandboxId: string): Promise<void> {
    const fields = { runId: request.runId, taskId: request.task.id, attempt: request.attempt, requestDigest, sandboxId }
    if (!(await sandbox.exists(agentProcessSweepPath)).exists) {
      lifecycleLog('agent-process-sweep-skipped', fields)
      return
    }
    const swept = await sandbox.exec(agentProcessSweepPath, { timeout: 30_000 })
    let counts: { stopped?: unknown; remaining?: unknown } = {}
    try { counts = JSON.parse(swept.stdout) as typeof counts } catch {}
    if (!swept.success) lifecycleLog('agent-process-sweep-failed', { ...fields, exitCode: swept.exitCode })
    else if (counts.stopped !== 0 || counts.remaining !== 0) {
      lifecycleLog('agent-processes-stopped', { ...fields, stopped: counts.stopped, remaining: counts.remaining })
    }
  }

  /** Only a verifier in a keepPocs release gets the discovery PoC tests. */
  private async verifierReceivesPocTests(request: AgentRequest): Promise<boolean> {
    if (request.task.promptKind !== 'verification') return false
    return (await this.runs.getRelease(request.releaseDigest)).body.definition.prompts.pocReview !== undefined
  }

  private async prepareSandbox(sandbox: SandboxClient, request: AgentRequest, requestDigest?: string): Promise<void> {
    const release = await this.runs.getRelease(request.releaseDigest)
    await sandbox.mkdir('/workspace/private', { recursive: true })
    await sandbox.mkdir('/control', { recursive: true })
    const privateMode = await sandbox.exec('chmod 0700 /workspace/private', { timeout: 10_000 })
    if (!privateMode.success) throw new PermanentRunFailure('private workspace permissions failed', 'invalid-configuration')
    await sandbox.writeFile('/control/researcher-protocol.md',
      `${release.body.definition.prompts.researcherProtocol}\n\nWorkspace facts: /control/workspace-environment.md\n`)
    // A copy agents can reread when a long session no longer holds the start of its prompt.
    if (release.body.definition.policy.scope !== undefined) await sandbox.writeFile(auditScopePath, `${auditScopeHeader(release.body.definition)}\n`)
    // What `ack3-submit` needs to rerun the Worker's checks: the task's output contract and accepted inputs.
    if (request.task.submitCheck === true) {
      await sandbox.writeFile(SUBMIT_CHECK_CONTEXT_PATH, canonicalJson(submitCheckContext(request.task,
        [...request.task.output.requiredFiles, ...(request.optionalOutputFiles ?? [])], request.visibleArtifacts,
        mandatorySearchRequirement(release.body.definition, request.task, request.stage.kind))))
      const readable = await sandbox.exec(`chmod 0444 ${SUBMIT_CHECK_CONTEXT_PATH}`, { timeout: 10_000 })
      if (!readable.success) throw new PermanentRunFailure('submission check context permission failed', 'invalid-configuration')
    }
    const tree = release.body.definition.target.tree
    const commit = release.body.definition.target.commit
    const marker = await sandbox.exists(`/workspace/private/source-tree-${tree}`)
    if (!marker.exists) {
      const source = await this.runs.getSource(tree, commit, release.body.definition.target.sourcePackageVersion)
      await sandbox.writeFile('/workspace/private/source.tar.zst', source.body)
      const prepared = await sandbox.exec('/usr/local/bin/ack3-prepare-source', {
        env: { ACK3_EXPECTED_COMMIT: commit, ACK3_EXPECTED_TREE: tree }, timeout: 120_000,
      })
      if (!prepared.success) {
        throw new PermanentRunFailure(`source tree verification failed: ${prepared.stderr.slice(-2_000)}`, 'integrity-failed')
      }
      await sandbox.writeFile(`/workspace/private/source-tree-${tree}`, tree)
    }
    const profile = release.body.definition.target.runtime.workspacePreparation
    if (profile !== undefined && request.task.providerClass !== 'deterministic') {
      const profileDigest = await sha256(canonicalJson(profile))
      const prepare = () => sandbox.exec('/usr/local/bin/ack3-prepare-workspace', {
        cwd: '/workspace/source', timeout: 9 * 60_000,
        env: {
          ACK3_EXPECTED_COMMIT: commit, ACK3_EXPECTED_TREE: tree,
          ACK3_WORKSPACE_PREPARATION_JSON: canonicalJson(profile),
          ACK3_WORKSPACE_PREPARATION_DIGEST: profileDigest,
          ...(release.body.definition.target.runtime.buildRequired === false ? { ACK3_BUILD_REQUIRED: 'false' } : {}),
          ...(release.body.definition.target.runtime.commandTimeoutMinutes === undefined ? {}
            : { ACK3_COMMAND_TIMEOUT_MINUTES: String(release.body.definition.target.runtime.commandTimeoutMinutes) }),
          ...(requestDigest === undefined ? {} : { ACK3_REQUEST_DIGEST: requestDigest }),
        },
      })
      const firstTryAt = Date.now()
      let prepared = await prepare()
      // A failed command (a registry timeout, a command over its limit) is retried in place.
      // Only a failure that left its failure file is retried; the file is kept under a per-try name.
      for (let retry = 0; !prepared.success && retry < workspacePreparationRetryWaitsMs.length; retry += 1) {
        const wait = workspacePreparationRetryWaitsMs[retry]!
        if (requestDigest === undefined || Date.now() - firstTryAt + wait > workspacePreparationRetryWindowMs
          || !await this.setAsideWorkspacePreparationFailure(sandbox, request, requestDigest, retry + 1)) break
        await this.preparationSleep(wait)
        prepared = await prepare()
      }
      if (!prepared.success) {
        const retained = requestDigest === undefined ? false
          : await this.persistWorkspacePreparationFailure(sandbox, request, requestDigest)
        if (!retained && requestDigest !== undefined && prepared.stderr.includes('command')) {
          throw new TransientRunFailure('workspace preparation failed before diagnostic custody was available')
        }
        throw new PermanentRunFailure(`workspace preparation failed: ${prepared.stderr.slice(-2_000)}`, 'preflight-failed')
      }
    } else {
      await sandbox.writeFile('/control/workspace-environment.md', [
        '# Workspace environment', '',
        ...(release.body.definition.target.runtime.buildRequired === false ? ['The baseline build is optional for this audit and may fail here. Check whether the project builds before relying on tests; if it does not, work from the source.', ''] : []),
        'The verified source is an archive without Git history; `git status` is unavailable.',
        'No per-workspace preparation profile was sealed for this release.',
        'Project dependencies and dynamic test readiness are unverified in this workspace.', '',
        'Optional OS tools: `sudo -n /usr/local/bin/ack3-install-os-packages PACKAGE` installs literal packages from configured repositories in this workspace. Use project-local package managers for project dependencies.',
        'GitHub CLI: `gh` works when the audit provides a read-only `GH_TOKEN`; without one, use `git clone` or `curl` for public GitHub data. Keep GitHub searches generic so they reveal nothing about the target.',
        ...workspaceLimitNotes(release.body.definition.target.runtime.commandTimeoutMinutes), '',
      ].join('\n'))
    }
    if (taskBackend(request.task) === 'claude') {
      const prepared = await sandbox.exec('install -d -m 0700 -o 10001 -g 10001 /workspace/home /workspace/home/.claude /workspace/results /workspace/accepted && chown -R 10001:10001 /workspace/home /workspace/results /workspace/accepted /workspace/source', { timeout: 10_000 })
      if (!prepared.success) throw new PermanentRunFailure('Claude workspace ownership setup failed', 'invalid-configuration')
    }
    if (taskBackend(request.task) === 'codex') {
      // Resolve on every attempt so the existing log redaction cache remains
      // populated, but never stage the bootstrap over an existing native home.
      const auth = await this.credential(subscriptionCredentialSource(request.task)!)
      if (auth === null) throw new PermanentRunFailure('core provider credentials are missing', 'missing-credentials')
      const nativeAuth = await sandbox.exists('/codex-home/auth.json')
      if (nativeAuth.exists) {
        // Codex rotates its refresh token in this file. Reinstalling the sealed
        // bootstrap credential on a resumed session can restore a spent token.
        const parseable = await sandbox.exec('node -e \'try { const fs = require("node:fs"); const auth = JSON.parse(fs.readFileSync("/codex-home/auth.json", "utf8")); if (!auth || typeof auth !== "object" || Array.isArray(auth) || Object.keys(auth).length === 0) process.exit(1) } catch { process.exit(1) }\'', { timeout: 10_000 })
        if (!parseable.success) throw new PermanentRunFailure('native Codex auth is malformed; existing credential preserved', 'invalid-configuration')
        // Keep the non-credential directory/ownership setup normally done by
        // the installer, without staging or replacing the rotated auth file.
        const prepared = await sandbox.exec('install -d -m 0700 -o 10001 -g 10001 /codex-home /workspace/home /workspace/results /workspace/accepted && { chown -R 10001:10001 /workspace/home /workspace/results /workspace/accepted /workspace/source 2>/dev/null || true; }', { timeout: 10_000 })
        if (!prepared.success) throw new PermanentRunFailure('Codex workspace ownership setup failed', 'invalid-configuration')
      } else {
        if (request.continuationMode === 'resume') {
          throw new PermanentRunFailure('native Codex auth is missing for resumed session', 'missing-credentials')
        }
        await sandbox.writeFile('/workspace/private/codex-auth.json', auth)
        const installed = await sandbox.exec('/usr/local/bin/ack3-install-codex-auth', {
          env: { ACK3_CODEX_WORKSPACE_ID: codexWorkspaceId(auth, this.env.ACK3_CODEX_WORKSPACE_ID,
            request.task.credentialSource !== undefined) }, timeout: 10_000,
        })
        if (!installed.success) throw new PermanentRunFailure('Codex auth installation failed', 'invalid-configuration')
      }
    }
    if (request.task.promptKind === 'coverage-challenge') {
      const alias = request.task.providerClass === 'additive'
        ? '/workspace/source'
        : `/workspace/challenge-${request.task.perspective}`
      const linked = await sandbox.exec([
        `mkdir -p /workspace/source/.swarm`,
        alias === '/workspace/source' ? ':' : `ln -sfn /workspace/source ${alias}`,
        `ln -sfn /workspace/results/coverage-challenge.md /workspace/source/.swarm/coverage-challenge.md`,
      ].join(' && '), { timeout: 10_000 })
      if (!linked.success) {
        throw new PermanentRunFailure(`coverage prompt workspace binding failed: ${linked.stderr.slice(-2_000)}`, 'invalid-configuration')
      }
    }
    if (request.task.promptKind === 'negative-review' && request.task.providerClass === 'core') {
      const linked = await sandbox.exec('ln -sfn /workspace/source /workspace/disposition-reviewer', { timeout: 10_000 })
      if (!linked.success) {
        throw new PermanentRunFailure(`review prompt workspace binding failed: ${linked.stderr.slice(-2_000)}`, 'invalid-configuration')
      }
    }
    if (request.task.promptKind === 'verification') {
      const linked = await sandbox.exec('ln -sfn /workspace/source /workspace/verifier', { timeout: 10_000 })
      if (!linked.success) {
        throw new PermanentRunFailure(`verification prompt workspace binding failed: ${linked.stderr.slice(-2_000)}`, 'invalid-configuration')
      }
    }
  }

  private async preflight(sandbox: SandboxClient, request: AgentRequest): Promise<AgentResult> {
    const release = await this.runs.getRelease(request.releaseDigest)
    const targetEnvironment = await this.runtimeEnvironment(request.releaseDigest)
    const result = await sandbox.exec('/usr/local/bin/ack3-preflight', {
      cwd: '/workspace/source', timeout: 3_600_000,
      env: {
        ...targetWorkspaceEnvironment,
        SWARM_VERIFIER_DIR: '/workspace/source',
        ...targetEnvironment,
        ACK3_EXPECTED_COMMIT: release.body.definition.target.commit,
        ACK3_EXPECTED_TREE: release.body.definition.target.tree,
        ACK3_TARGET_REQUIRED_ENVIRONMENT_JSON: JSON.stringify(
          Object.keys(release.body.definition.target.runtime.environmentBindings),
        ),
        ACK3_TARGET_PREFLIGHT_COMMANDS_JSON: JSON.stringify(
          release.body.definition.target.runtime.preflightCommands,
        ),
        ...(release.body.definition.target.runtime.buildRequired === false ? { ACK3_TARGET_BUILD_REQUIRED: 'false' } : {}),
      },
    })
    if (!result.success) {
      throw new PermanentRunFailure(`preflight failed: ${result.stderr.slice(-2_000)}`, 'preflight-failed')
    }
    return {
      status: 'accepted', actorId: `supervisor-${request.runId}`, model: 'deterministic',
      provider: 'deterministic-supervisor', files: { 'preflight.json': result.stdout }, assertions: ['source-and-tools-verified'],
      protocol: {}, inputTokens: 0, outputTokens: 0, costUsd: 0,
    }
  }
}
