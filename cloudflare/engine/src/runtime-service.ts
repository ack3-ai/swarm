import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getSandbox } from '@cloudflare/sandbox'
import type { RunCursor, RunState, RuntimeRelease } from './contracts.js'
import type {
  AuditWorkflowPayload, Env, QuarantinedRevalidation, RuntimeFailedWaveRecoveryRequest,
  RuntimeIsolationWorkflowPayload, RuntimeResumeRequest, RuntimeTerminalCompletionRecoveryRequest,
} from './env.js'
import { canonicalJson, sha256 } from './canonical.js'
import { containerReadinessCommand } from './container-readiness.js'
import { localRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { CloudflareRunStore, R2ArtifactStore } from './cloudflare-storage.js'
import { resolveTargetEnvironment } from './target-environment.js'
import { assertReleaseProviderCredentials } from './release-provider-credentials.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import { expiredResumeClockAmendment } from './recovery-clock.js'
import { assertIndependentDiscoveryFrontier, rejectedAttemptIdentity, RunMachine } from './machine.js'
import { prepareFailedWaveRecovery } from './failed-wave-recovery.js'
import { prepareTerminalCompletionRecovery } from './terminal-completion-recovery.js'
import { durableLaneDiagnostic } from './lane-diagnostics.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { R2AgentExecutionLogStore } from './agent-execution-log.js'
import { SandboxAgentProvider } from './sandbox-provider.js'
import { disposeTerminalWorkspaces } from './runner.js'
import { placement } from './placement.js'

const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/
const lanePattern = /^[A-Za-z0-9._-]{1,120}$/

function response(env: Env, value: unknown, status = 200): Response {
  let version = 'unavailable'
  try {
    version = localRuntimeRelease(env).workerVersionId
  } catch {
    // Identity failures are returned by the route which required identity.
  }
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      'x-ack3-runtime-worker-version': version,
    },
  })
}

export function engineRole(env: Pick<Env, 'ENGINE_ROLE'>): 'front-door' | 'runtime' {
  if (env.ENGINE_ROLE !== 'front-door' && env.ENGINE_ROLE !== 'runtime') {
    throw new TypeError('ENGINE_ROLE must be front-door or runtime')
  }
  return env.ENGINE_ROLE
}

export function assertLocalRuntime(env: Env, expected: RuntimeRelease): RuntimeRelease {
  const local = localRuntimeRelease(env)
  if (!sameRuntimeRelease(local, expected)) {
    throw new Error(`runtime release destination mismatch: expected ${expected.id}/${expected.workerVersionId}, got ${local.id}/${local.workerVersionId}`)
  }
  return local
}

interface RuntimeFixtureResult {
  fixtureId: string
  runtimeRelease: RuntimeRelease
  parentCheckpointDigest: string | null
  checkpointDigest: string
  containerBuildFingerprint: string
  startedAt: string
  finishedAt: string
}

interface RuntimeFixtureCheckpointBody {
  schemaVersion: 1
  fixtureId: string
  runtimeRelease: RuntimeRelease
  parentCheckpointDigest: string | null
  containerBuildFingerprint: string
  finishedAt: string
}

const fixtureCheckpointKey = (digest: string) => `checkpoints/sha256/${digest}.runtime-isolation.json`

async function readFixtureCheckpoint(env: Env, digest: string): Promise<RuntimeFixtureCheckpointBody> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('runtime fixture checkpoint digest is invalid')
  const object = await env.ARTIFACTS.get(fixtureCheckpointKey(digest))
  if (object === null) throw new Error(`runtime fixture checkpoint is missing: ${digest}`)
  const content = await object.text()
  const objectDigest = await sha256(content)
  const sealed = JSON.parse(content) as { digest?: string, body?: RuntimeFixtureCheckpointBody }
  if (sealed.digest !== digest || sealed.body === undefined || await sha256(sealed.body) !== digest
    || object.customMetadata?.bodySha256 !== digest
    || object.customMetadata?.objectSha256 !== objectDigest
    || object.checksums.toJSON().sha256 !== objectDigest) {
    throw new Error(`runtime fixture checkpoint integrity failed: ${digest}`)
  }
  if (sealed.body.schemaVersion !== 1 || !runIdPattern.test(sealed.body.fixtureId)
    || !/^[0-9a-f]{64}$/.test(sealed.body.containerBuildFingerprint)) {
    throw new Error(`runtime fixture checkpoint is invalid: ${digest}`)
  }
  return sealed.body
}

async function putFixtureCheckpoint(
  env: Env,
  body: RuntimeFixtureCheckpointBody,
): Promise<string> {
  const digest = await sha256(body)
  const content = canonicalJson({ digest, body })
  const objectSha256 = await sha256(content)
  await env.ARTIFACTS.put(fixtureCheckpointKey(digest), content, {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: { bodySha256: digest, objectSha256, fixture: body.fixtureId },
    sha256: objectSha256,
    onlyIf: { etagDoesNotMatch: '*' },
  })
  await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
    .reserveCheckpointRoute(digest, 'runtime-isolation', body.runtimeRelease)
  await readFixtureCheckpoint(env, digest)
  return digest
}

async function ensureAuditWorkflow(
  binding: Workflow<AuditWorkflowPayload>,
  payload: AuditWorkflowPayload,
  location: { locationHint?: DurableObjectLocationHint },
): Promise<{ id: string, reused: boolean }> {
  try {
    const created = await binding.create({
      id: payload.runId,
      params: payload,
      ...location,
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    })
    return { id: created.id, reused: false }
  } catch (createError) {
    // A duplicate run ID or an ambiguous create is reconciled only against the
    // same durable Workflow identity. Never launch a second ID on uncertainty.
    try {
      const existing = await binding.get(payload.runId)
      await existing.status()
      return { id: existing.id, reused: true }
    } catch {
      throw createError
    }
  }
}

function sameCursor(left: RunCursor, right: RunCursor): boolean {
  return left.stageIndex === right.stageIndex && left.waveIndex === right.waveIndex
}

async function assertStoredRunOwner(runId: string, env: Env): Promise<RuntimeRelease> {
  const local = localRuntimeRelease(env)
  const stored = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).runRuntime(runId)
  if (stored !== null && !sameRuntimeRelease(stored, local)) {
    throw new Error(`run belongs to a different runtime release: ${runId}`)
  }
  return local
}

export class RuntimeIsolationWorkflow extends WorkflowEntrypoint<Env, RuntimeIsolationWorkflowPayload> {
  async run(
    event: Readonly<WorkflowEvent<RuntimeIsolationWorkflowPayload>>,
    step: WorkflowStep,
  ): Promise<RuntimeFixtureResult> {
    const payload = event.payload
    if (!runIdPattern.test(payload.fixtureId) || !Number.isSafeInteger(payload.holdSeconds)
      || payload.holdSeconds < 1 || payload.holdSeconds > 3_600
      || (payload.idleSurvival !== undefined && payload.idleSurvival !== true)
      || (payload.parentCheckpointDigest !== undefined
        && !/^[0-9a-f]{64}$/.test(payload.parentCheckpointDigest))) {
      throw new NonRetryableError('runtime isolation fixture payload is invalid')
    }
    if (await new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
      .retiredUnmaterializedRoute(payload.fixtureId) !== null) {
      throw new NonRetryableError('runtime isolation fixture identity is retired')
    }
    const started = await step.do<{
      fixtureId: string
      runtimeRelease: RuntimeRelease
      parentCheckpointDigest: string | null
      startedAt: string
    }>('bind-runtime-release', {
      retries: { limit: 0, delay: '1 second' }, timeout: '1 minute',
    }, async () => {
      const runtimeRelease = assertLocalRuntime(this.env, payload.runtimeRelease)
      if (payload.parentCheckpointDigest !== undefined) {
        const parent = await readFixtureCheckpoint(this.env, payload.parentCheckpointDigest)
        if (!sameRuntimeRelease(parent.runtimeRelease, runtimeRelease)) {
          throw new NonRetryableError('runtime fixture parent belongs to a different runtime release')
        }
      }
      return {
        fixtureId: payload.fixtureId,
        runtimeRelease,
        parentCheckpointDigest: payload.parentCheckpointDigest ?? null,
        startedAt: new Date().toISOString(),
      }
    })
    let container: { containerBuildFingerprint: string }
    if (payload.idleSurvival === true) {
      const launched = await step.do<{ sandboxId: string, processId: string }>('launch-unobserved-container-process', {
        retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes',
      }, async () => {
        if (payload.holdSeconds < 35) throw new NonRetryableError('idle-survival fixture requires at least 35 seconds')
        const sandboxId = `ri-${(await sha256(payload.fixtureId)).slice(0, 32)}`
        const processId = `idle-${(await sha256(`${payload.fixtureId}:idle`)).slice(0, 32)}`
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
          keepAlive: true, sleepAfter: '10s', enableDefaultSession: false, normalizeId: true, transport: 'rpc',
          labels: { purpose: 'runtime-isolation-idle', fixture: payload.fixtureId },
        })
        await sandbox.mkdir('/workspace/private', { recursive: true })
        await sandbox.startProcess(
          `sh -c 'sleep 20; cat /opt/ack3/BUILD_FINGERPRINT > /workspace/private/idle-survival-fingerprint'`,
          { processId, autoCleanup: false },
        )
        return { sandboxId, processId }
      })
      await step.sleep('leave-container-unobserved', `${payload.holdSeconds} seconds`)
      container = await step.do<{ containerBuildFingerprint: string }>('reobserve-unobserved-container-process', {
        retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes',
      }, async () => {
        const sandbox = getSandbox(this.env.Sandbox, launched.sandboxId, {
          keepAlive: true, sleepAfter: '10s', enableDefaultSession: false, normalizeId: true, transport: 'rpc',
          labels: { purpose: 'runtime-isolation-idle', fixture: payload.fixtureId },
        })
        try {
          const process = await sandbox.getProcess(launched.processId)
          const file = await sandbox.readFile('/workspace/private/idle-survival-fingerprint')
          const containerBuildFingerprint = file.content.trim()
          if (process === null || !/^[0-9a-f]{64}$/.test(containerBuildFingerprint)) {
            throw new NonRetryableError('idle-survival fixture lost its container process or filesystem')
          }
          return { containerBuildFingerprint }
        } finally {
          await sandbox.destroy().catch(() => {})
        }
      })
    } else {
      container = await step.do<{ containerBuildFingerprint: string }>('run-held-container-process', {
        retries: { limit: 0, delay: '1 second' }, timeout: '2 hours',
      }, async () => {
        const sandboxId = `ri-${(await sha256(payload.fixtureId)).slice(0, 32)}`
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
          sleepAfter: '2h', enableDefaultSession: false, normalizeId: true, transport: 'rpc',
          labels: { purpose: 'runtime-isolation', fixture: payload.fixtureId },
        })
        try {
          const result = await sandbox.exec(
            `sleep ${payload.holdSeconds}; printf 'container-build-fingerprint='; cat /opt/ack3/BUILD_FINGERPRINT`,
            { timeout: (payload.holdSeconds + 120) * 1_000 },
          )
          const containerBuildFingerprint = result.stdout
            .match(/container-build-fingerprint=([0-9a-f]{64})/)?.[1]
          if (!result.success || containerBuildFingerprint === undefined) {
            throw new NonRetryableError(`runtime fixture container failed: ${result.exitCode}`)
          }
          return { containerBuildFingerprint }
        } finally {
          await sandbox.destroy().catch(() => {})
        }
      })
    }
    return step.do<RuntimeFixtureResult>('seal-runtime-fixture-checkpoint', {
      retries: { limit: 0, delay: '1 second' }, timeout: '1 minute',
    }, async () => {
      const runtimeRelease = assertLocalRuntime(this.env, payload.runtimeRelease)
      const finishedAt = new Date().toISOString()
      const checkpointDigest = await putFixtureCheckpoint(this.env, {
        schemaVersion: 1,
        fixtureId: payload.fixtureId,
        runtimeRelease,
        parentCheckpointDigest: started.parentCheckpointDigest,
        containerBuildFingerprint: container.containerBuildFingerprint,
        finishedAt,
      })
      return { ...started, ...container, runtimeRelease, checkpointDigest, finishedAt }
    })
  }
}

async function createAuditRun(request: Request, env: Env): Promise<Response> {
  const payload = await request.json<AuditWorkflowPayload>()
  if (payload.mode !== 'start' || !runIdPattern.test(payload.runId)
    || !runIdPattern.test(payload.experimentId) || payload.runtimeRelease === undefined) {
    return response(env, { error: 'runtime-bound audit payload is required' }, 400)
  }
  assertLocalRuntime(env, payload.runtimeRelease)
  if (!/^[0-9a-f]{64}$/.test(payload.releaseDigest ?? '')) {
    return response(env, { error: 'runtime-bound release digest is required' }, 400)
  }
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const reservedRuntime = await store.runRuntime(payload.runId)
  if (reservedRuntime === null || !sameRuntimeRelease(reservedRuntime, payload.runtimeRelease)) {
    return response(env, { error: 'run reservation belongs to a different runtime release' }, 409)
  }
  const release = await store.getRelease(payload.releaseDigest as string)
  if (release.body.definition.id !== payload.experimentId) {
    return response(env, { error: 'release experiment mismatch' }, 409)
  }
  assertReleaseEnvironmentMatchesRuntime(release.body, payload.runtimeRelease)
  resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, env)
  await assertReleaseProviderCredentials(release.body.definition, env)
  const instance = await ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
  return response(env, {
    workflowInstanceId: instance.id,
    runtimeRelease: payload.runtimeRelease,
    reusedWorkflow: instance.reused,
  }, 202)
}

async function createAuditResume(request: Request, env: Env): Promise<Response> {
  const body = await request.json<RuntimeResumeRequest>()
  if (!runIdPattern.test(body.experimentId ?? '') || !runIdPattern.test(body.childRunId ?? '')
    || !/^[0-9a-f]{64}$/.test(body.checkpointDigest ?? '')
    || body.runtimeRelease === undefined) {
    return response(env, { error: 'valid childRunId, checkpointDigest, and runtimeRelease are required' }, 400)
  }
  const runtimeRelease = assertLocalRuntime(env, body.runtimeRelease)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const reservedRuntime = await store.runRuntime(body.childRunId)
  if (reservedRuntime === null || !sameRuntimeRelease(reservedRuntime, runtimeRelease)) {
    return response(env, { error: 'child run reservation belongs to a different runtime release' }, 409)
  }
  const checkpoint = await store.getCheckpoint(body.checkpointDigest)
  const checkpointRuntime = await store.checkpointRuntime(body.checkpointDigest)
  if (checkpointRuntime !== null && !sameRuntimeRelease(checkpointRuntime, runtimeRelease) && body.runtimeTransition === undefined) {
    return response(env, { error: 'checkpoint belongs to a different runtime release' }, 409)
  }
  const release = await store.getRelease(checkpoint.body.releaseDigest)
  if (checkpoint.body.experimentId !== body.experimentId || release.body.definition.id !== body.experimentId) {
    return response(env, { error: 'resume experiment mismatch' }, 409)
  }
  assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
  resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, env)
  await assertReleaseProviderCredentials(release.body.definition, env)
  let transitionSource: RunState | undefined
  if (body.runtimeTransition !== undefined) {
    if (body.revalidate !== undefined) return response(env, { error: 'runtime transition cannot revalidate output' }, 409)
    transitionSource = await store.getState(body.runtimeTransition.sourceRunId)
  }
  let revalidation: QuarantinedRevalidation | undefined
  if (body.revalidate !== undefined) {
    if (!runIdPattern.test(body.revalidate.sourceRunId ?? '')
      || !/^[0-9a-f]{64}$/.test(body.revalidate.outputDigest ?? '')) {
      return response(env, { error: 'revalidation requires a valid sourceRunId and outputDigest' }, 400)
    }
    const source = await store.getState(body.revalidate.sourceRunId)
    if (source.runtimeRelease !== undefined && !sameRuntimeRelease(source.runtimeRelease, runtimeRelease)) {
      return response(env, { error: 'revalidation source belongs to a different runtime release' }, 409)
    }
    const sourceOwnsCheckpoint = source.checkpoints.some(candidate => (
      candidate.digest === body.checkpointDigest && sameCursor(candidate.body.cursor, checkpoint.body.cursor)
    ))
    if (source.status !== 'failed' || source.experimentId !== body.experimentId
      || source.releaseDigest !== checkpoint.body.releaseDigest
      || (source.parentCheckpointDigest !== body.checkpointDigest && !sourceOwnsCheckpoint)
      || !sameCursor(source.cursor, checkpoint.body.cursor)) {
      return response(env, { error: 'revalidation source is not a failed descendant or owner of this checkpoint' }, 409)
    }
    const matchingCandidates = source.rejectedAttempts.filter(attempt => (
      attempt.outputDigest === body.revalidate?.outputDigest && attempt.quarantineUri !== null
    ))
    const candidates = [...new Map(matchingCandidates.map(candidate => (
      [rejectedAttemptIdentity(candidate), candidate]
    ))).values()]
    if (candidates.length !== 1) return response(env, { error: 'revalidation attempt is missing or ambiguous' }, 409)
    const candidate = candidates[0]!
    const stage = release.body.definition.stages[checkpoint.body.cursor.stageIndex]
    const wave = stage?.waves[checkpoint.body.cursor.waveIndex]
    const matchedTask = wave?.tasks.find(task => task.id === candidate.taskId)
    if (stage?.id !== candidate.stageId || wave?.id !== candidate.waveId
      || matchedTask === undefined || matchedTask.retryPolicy !== 'none'
      || candidate.outputDigest === null || candidate.quarantineUri === null
      || candidate.usage.modelCalls !== 1 || candidate.attempt !== 1) {
      return response(env, { error: 'revalidation attempt does not match the checkpoint cursor' }, 409)
    }
    revalidation = {
      sourceRunId: source.runId,
      stageId: candidate.stageId,
      waveId: candidate.waveId,
      taskId: candidate.taskId,
      promptDigest: candidate.promptDigest,
      outputDigest: candidate.outputDigest,
      quarantineUri: candidate.quarantineUri,
      usage: candidate.usage,
    }
  }
  const resumedAt = new Date().toISOString()
  const timeAmendment = body.runtimeTransition === undefined
    ? expiredResumeClockAmendment(release.body.definition, checkpoint, resumedAt) : null
  await RunMachine.resume(
    release.body.definition,
    checkpoint,
    body.childRunId,
    new Set(),
    resumedAt,
    timeAmendment ?? undefined,
    runtimeRelease,
    body.runtimeTransition,
    transitionSource,
  )
  const payload: AuditWorkflowPayload = {
    mode: 'resume',
    experimentId: body.experimentId,
    runId: body.childRunId,
    checkpointDigest: body.checkpointDigest,
    runtimeRelease,
    ...(timeAmendment === null ? {} : { timeAmendment }),
    ...(body.runtimeTransition === undefined ? {} : { runtimeTransition: body.runtimeTransition }),
    ...(revalidation === undefined ? {} : { revalidation }),
  }
  const instance = await ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
  return response(env, {
    workflowInstanceId: instance.id,
    checkpointDigest: body.checkpointDigest,
    runtimeRelease,
    timeAmendment,
    revalidation: revalidation === undefined ? null : {
      sourceRunId: revalidation.sourceRunId,
      taskId: revalidation.taskId,
      outputDigest: revalidation.outputDigest,
    },
    reusedWorkflow: instance.reused,
  }, 202)
}

async function createAuditFailedWaveRecovery(request: Request, env: Env): Promise<Response> {
  const body = await request.json<RuntimeFailedWaveRecoveryRequest>()
  const promotionIsValid = body.promoteExecution === undefined || (
    typeof body.promoteExecution.taskId === 'string' && body.promoteExecution.taskId.trim() !== ''
    && Number.isSafeInteger(body.promoteExecution.sourceAttempt) && body.promoteExecution.sourceAttempt >= 1
    && /^[0-9a-f]{64}$/.test(body.promoteExecution.requestDigest)
    && (body.promoteExecution.quarantineOutputDigest === undefined
      || /^[0-9a-f]{64}$/.test(body.promoteExecution.quarantineOutputDigest))
  )
  const retentionIsValid = body.retainNative === undefined || (
    typeof body.retainNative.taskId === 'string' && body.retainNative.taskId.trim() !== ''
    && /^[0-9a-f]{64}$/.test(body.retainNative.requestDigest)
    && /^[0-9a-f]{64}$/.test(body.retainNative.snapshotDigest)
    && /^[0-9a-f]{64}$/.test(body.retainNative.sandboxObjectId)
    && body.promoteExecution === undefined
  )
  if (!runIdPattern.test(body.experimentId ?? '') || !runIdPattern.test(body.childRunId ?? '')
    || !runIdPattern.test(body.sourceRunId ?? '')
    || !Number.isSafeInteger(body.sourceStateGeneration) || body.sourceStateGeneration < 1
    || !/^[0-9a-f]{64}$/.test(body.sourceStateDigest ?? '')
    || !/^[0-9a-f]{64}$/.test(body.checkpointDigest ?? '')
    || body.runtimeRelease === undefined || !promotionIsValid || !retentionIsValid) {
    return response(env, { error: 'valid failed-wave recovery identity and runtimeRelease are required' }, 400)
  }
  const runtimeRelease = assertLocalRuntime(env, body.runtimeRelease)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  if (await store.retiredUnmaterializedRoute(body.childRunId) !== null) {
    return response(env, { error: 'recovery identity was archived' }, 409)
  }
  const reservedRuntime = await store.runRuntime(body.childRunId)
  if (reservedRuntime === null || !sameRuntimeRelease(reservedRuntime, runtimeRelease)) {
    return response(env, { error: 'recovery child reservation belongs to a different runtime release' }, 409)
  }
  const source = await store.getState(body.sourceRunId)
  const unobservableNative = (source.inFlightAgentAttempts ?? []).length === 0
    ? undefined : await store.fencedUnobservableNativeEvidence(source)
  const checkpoint = await store.getCheckpoint(body.checkpointDigest)
  const release = await store.getRelease(checkpoint.body.releaseDigest)
  if (source.experimentId !== body.experimentId || checkpoint.body.experimentId !== body.experimentId
    || release.body.definition.id !== body.experimentId) {
    return response(env, { error: 'failed-wave recovery experiment mismatch' }, 409)
  }
  assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
  // Compatibility belongs to the destination runtime. The front door must
  // still be able to route old checkpoints to a retained global scheduler.
  assertIndependentDiscoveryFrontier(release.body.definition, source)
  resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, env)
  await assertReleaseProviderCredentials(release.body.definition, env)
  const prepared = await prepareFailedWaveRecovery({
    definition: release.body.definition,
    checkpoint,
    source,
    sourceStateGeneration: body.sourceStateGeneration,
    sourceStateDigest: body.sourceStateDigest,
    targetRuntimeRelease: runtimeRelease,
    artifacts: new R2ArtifactStore(env.ARTIFACTS),
    ...(unobservableNative === undefined ? {} : { unobservableNative }),
    ...(body.promoteExecution === undefined ? {} : {
      promoteExecution: body.promoteExecution,
      executionReceipts: new R2AgentExecutionReceiptStore(env.ARTIFACTS),
      executionRequests: new R2AgentExecutionLogStore(env.ARTIFACTS),
      ...(body.promoteExecution.quarantineOutputDigest === undefined ? {}
        : { quarantined: new R2ArtifactStore(env.ARTIFACTS) }),
    }),
    ...(body.retainNative === undefined ? {} : { retainNative: body.retainNative }),
  })
  if (prepared.evidence.retainedNative !== undefined) {
    const retained = prepared.evidence.retainedNative
    const claim = await store.retainedNativeWorkspaceClaim(body.sourceRunId, retained.workspaceKey)
    if (claim?.childRunId !== body.childRunId
      || claim.sourceStateDigest !== body.sourceStateDigest
      || claim.snapshotDigest !== retained.nativeTransport.snapshotDigest
      || claim.sandboxObjectId !== retained.sandboxObjectId
      || await store.retiredRunWorkflow(body.sourceRunId) === null) {
      return response(env, { error: 'retained native workspace is not exclusively fenced' }, 409)
    }
    const sandboxId = `a0-${(await sha256(`${retained.workspaceAllocationRunId}:${retained.workspaceKey}`)).slice(0, 30)}`
    if (env.Sandbox.idFromName(sandboxId).toString() !== retained.sandboxObjectId) {
      return response(env, { error: 'retained Sandbox namespace or actor identity changed' }, 409)
    }
  }
  await RunMachine.recoverFailedWave(
    release.body.definition, checkpoint, source, body.childRunId,
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence,
  )
  if (prepared.evidence.unobservableNative !== undefined) {
    const freshSource = await store.getState(body.sourceRunId)
    const fresh = await store.fencedUnobservableNativeEvidence(freshSource)
    if (canonicalJson(fresh ?? null) !== canonicalJson(prepared.evidence.unobservableNative)) {
      throw new Error('unobservable recovery fence or receipt changed before Workflow admission')
    }
  }
  const payload: AuditWorkflowPayload = {
    mode: 'recover-failed-wave',
    experimentId: body.experimentId,
    runId: body.childRunId,
    checkpointDigest: body.checkpointDigest,
    runtimeRelease,
    failedWaveRecovery: prepared.evidence,
  }
  const instance = await ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
  return response(env, {
    workflowInstanceId: instance.id,
    checkpointDigest: body.checkpointDigest,
    runtimeRelease,
    failedWaveRecovery: prepared.evidence,
    reusedWorkflow: instance.reused,
  }, 202)
}

async function createAuditTerminalCompletionRecovery(request: Request, env: Env): Promise<Response> {
  const body = await request.json<RuntimeTerminalCompletionRecoveryRequest>()
  if (!runIdPattern.test(body.experimentId ?? '') || !runIdPattern.test(body.childRunId ?? '')
    || !runIdPattern.test(body.sourceRunId ?? '')
    || !Number.isSafeInteger(body.sourceStateGeneration) || body.sourceStateGeneration < 1
    || !/^[0-9a-f]{64}$/.test(body.sourceStateDigest ?? '')
    || !/^[0-9a-f]{64}$/.test(body.checkpointDigest ?? '')
    || body.runtimeRelease === undefined) {
    return response(env, { error: 'valid terminal completion recovery identity and runtimeRelease are required' }, 400)
  }
  const runtimeRelease = assertLocalRuntime(env, body.runtimeRelease)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const reservedRuntime = await store.runRuntime(body.childRunId)
  if (reservedRuntime === null || !sameRuntimeRelease(reservedRuntime, runtimeRelease)) {
    return response(env, { error: 'terminal recovery child reservation belongs to a different runtime release' }, 409)
  }
  const source = await store.getState(body.sourceRunId)
  const checkpoint = await store.getCheckpoint(body.checkpointDigest)
  const release = await store.getRelease(checkpoint.body.releaseDigest)
  if (source.experimentId !== body.experimentId || checkpoint.body.experimentId !== body.experimentId
    || release.body.definition.id !== body.experimentId) {
    return response(env, { error: 'terminal completion recovery experiment mismatch' }, 409)
  }
  assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
  resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, env)
  const evidence = await prepareTerminalCompletionRecovery({
    definition: release.body.definition, checkpoint, source,
    sourceStateGeneration: body.sourceStateGeneration, sourceStateDigest: body.sourceStateDigest,
    targetRuntimeRelease: runtimeRelease,
  })
  await RunMachine.recoverTerminalCompletion(release.body.definition, checkpoint, source, body.childRunId, evidence)
  const payload: AuditWorkflowPayload = {
    mode: 'recover-terminal-completion', experimentId: body.experimentId, runId: body.childRunId,
    checkpointDigest: body.checkpointDigest, runtimeRelease, terminalCompletionRecovery: evidence,
  }
  const instance = await ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
  return response(env, { workflowInstanceId: instance.id, checkpointDigest: body.checkpointDigest,
    runtimeRelease, terminalCompletionRecovery: evidence, reusedWorkflow: instance.reused }, 202)
}

async function auditRunStatus(runId: string, env: Env): Promise<Response> {
  await assertStoredRunOwner(runId, env)
  const workflow = await env.AUDIT_WORKFLOW.get(runId)
  const state = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).getState(runId)
  return response(env, { state, workflow: await workflow.status() })
}

async function auditWorkflowStatus(runId: string, env: Env): Promise<Response> {
  const route = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).runRuntime(runId)
  if (route === null || !sameRuntimeRelease(route, localRuntimeRelease(env))) {
    return response(env, { error: 'Workflow run route is unavailable or belongs to a different runtime' }, 409)
  }
  const workflow = await env.AUDIT_WORKFLOW.get(runId)
  return response(env, { runId, runtimeRelease: localRuntimeRelease(env), workflow: await workflow.status() })
}

async function stopAuditRun(runId: string, env: Env): Promise<Response> {
  await assertStoredRunOwner(runId, env)
  await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).requestStop(runId)
  return response(env, { runId, stop: 'requested-at-next-sealed-wave-boundary' }, 202)
}

async function stopAuditRunNow(runId: string, env: Env): Promise<Response> {
  await assertStoredRunOwner(runId, env)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const started = Date.now()
  await store.requestStop(runId)
  const workflow = await env.AUDIT_WORKFLOW.get(runId)
  const before = await workflow.status()
  if (['queued', 'running', 'paused', 'waiting', 'waitingForPause'].includes(before.status)) {
    await workflow.terminate()
  }
  let after = await workflow.status()
  const fenceDeadline = Date.now() + 20_000
  while (!['terminated', 'complete', 'errored'].includes(after.status) && Date.now() < fenceDeadline) {
    await new Promise(resolve => setTimeout(resolve, 250))
    after = await workflow.status()
  }
  if (!['terminated', 'complete', 'errored'].includes(after.status)) {
    throw new Error(`native Workflow did not settle after stop: ${after.status}`)
  }
  let state = await store.getState(runId)
  for (let attempt = 0; state.status === 'running' && attempt < 3; attempt += 1) {
    const release = await store.getRelease(state.releaseDigest)
    const machine = await RunMachine.fromState(release.body.definition, state)
    await machine.stop('operator-requested-immediate-stop')
    try {
      await store.putState(machine.snapshot())
    } catch (error) {
      // A last admitted result can win the generation race while native
      // termination settles. Re-read it rather than dropping its artifact.
      state = await store.getState(runId)
      if (state.status !== 'running') break
      if (attempt === 2) throw error
      continue
    }
    state = await store.getState(runId)
  }
  if (state.status === 'running') throw new Error('native Workflow fenced but terminal state did not settle')
  const release = await store.getRelease(state.releaseDigest)
  const cleanup = await disposeTerminalWorkspaces(
    new SandboxAgentProvider(env), release.body.definition, state, {
      forceOwnedWorkspaces: true,
      workspaceAllocationForOwner: async workspaceKey => {
        const imported = state.failedWaveRecovery?.retainedNative?.workspaceKey === workspaceKey
          ? state.failedWaveRecovery.retainedNative.workspaceAllocationRunId : null
        const allocationRunId = imported ?? runId
        const claim = await store.retainedNativeWorkspaceClaim(allocationRunId, workspaceKey)
        return claim !== null && claim.childRunId !== runId ? null
          : imported !== null && claim?.childRunId !== runId ? null : allocationRunId
      },
    },
  )
  const deferred = cleanup.mode === 'provider-attempted' ? cleanup.deferred : cleanup.workspaceKeys
  const protectedWorkspaces = cleanup.retainedWorkspaceKeys
  const elapsedMs = Date.now() - started
  return response(env, { runId, stop: state.status, workflowStatus: after.status,
    cleanup: { attempted: cleanup.workspaceKeys.length, deferred, protectedWorkspaces },
    physicalZeroVerified: false, elapsedMs,
    deadlineMet: elapsedMs <= 5_000 },
  deferred.length === 0 && protectedWorkspaces.length === 0 && elapsedMs <= 5_000 ? 200 : 503)
}

async function boundedImmediateStop(runId: string, env: Env, ctx?: ExecutionContext,
  deadlineAt = Date.now() + 5_000): Promise<Response> {
  const operation = stopAuditRunNow(runId, env)
  if (ctx === undefined) return operation
  // Keep the exact stop attempt alive after a five-second HTTP miss. A retry
  // reads the durable stop intent and current terminal state; it never admits
  // or repeats model work.
  ctx.waitUntil(operation.catch(error => {
    console.error(canonicalJson({ schemaVersion: 1, kind: 'immediate-stop-failed', runId,
      error: error instanceof Error ? error.message : String(error) }))
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<Response>(resolve => {
      timer = setTimeout(() => resolve(response(env, { runId, stop: 'deadline-missed',
        deadlineMet: false, physicalZeroVerified: false }, 503)), Math.max(0, deadlineAt - Date.now()))
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function laneResult(runId: string, workspaceKey: string, env: Env): Promise<Response> {
  await assertStoredRunOwner(runId, env)
  const diagnostic = await durableLaneDiagnostic(runId, workspaceKey, env)
  return diagnostic === null
    ? response(env, { error: 'durable lane receipt is unavailable', runId, workspaceKey }, 404)
    : response(env, { runId, workspaceKey, ...diagnostic })
}

async function readiness(env: Env): Promise<Response> {
  const probeId = `readiness-${crypto.randomUUID().replaceAll('-', '')}`
  const sandbox = getSandbox(env.Sandbox, probeId, {
    sleepAfter: '1m', enableDefaultSession: false, normalizeId: true, transport: 'rpc',
    labels: { purpose: 'readiness', probe: probeId },
  })
  let disposed = false
  try {
    const result = await sandbox.exec(containerReadinessCommand, { timeout: 120_000 })
    const containerBuildFingerprint = result.stdout.match(/container-build-fingerprint=([0-9a-f]{64})/)?.[1] ?? null
    await sandbox.destroy()
    disposed = true
    return response(env, {
      probeId,
      success: result.success,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(-4_000),
      stderr: result.stderr.slice(-4_000),
      disposed,
      containerBuildFingerprint,
      runtimeRelease: localRuntimeRelease(env),
    }, result.success && containerBuildFingerprint !== null ? 200 : 503)
  } finally {
    if (!disposed) await sandbox.destroy().catch(() => {})
  }
}

async function createFixture(request: Request, env: Env): Promise<Response> {
  if (env.RUNTIME_ISOLATION_WORKFLOW === undefined) {
    return response(env, { error: 'runtime isolation fixture workflow is unavailable' }, 503)
  }
  const payload = await request.json<RuntimeIsolationWorkflowPayload>()
  if (!runIdPattern.test(payload.fixtureId) || payload.runtimeRelease === undefined
    || !Number.isSafeInteger(payload.holdSeconds) || payload.holdSeconds < 1 || payload.holdSeconds > 3_600
    || (payload.idleSurvival !== undefined && payload.idleSurvival !== true)
    || (payload.parentCheckpointDigest !== undefined
      && !/^[0-9a-f]{64}$/.test(payload.parentCheckpointDigest))) {
    return response(env, { error: 'runtime isolation fixture payload is invalid' }, 400)
  }
  const runtimeRelease = assertLocalRuntime(env, payload.runtimeRelease)
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  if (await store.retiredUnmaterializedRoute(payload.fixtureId) !== null) {
    return response(env, { error: 'runtime fixture identity is retired' }, 410)
  }
  const reservedRuntime = await store.runRuntime(payload.fixtureId)
  if (reservedRuntime === null || !sameRuntimeRelease(reservedRuntime, runtimeRelease)) {
    return response(env, { error: 'runtime fixture reservation belongs to a different runtime release' }, 409)
  }
  if (payload.parentCheckpointDigest !== undefined) {
    const parent = await readFixtureCheckpoint(env, payload.parentCheckpointDigest)
    if (!sameRuntimeRelease(parent.runtimeRelease, runtimeRelease)) {
      return response(env, { error: 'runtime fixture parent belongs to a different runtime release' }, 409)
    }
  }
  try {
    const existing = await env.RUNTIME_ISOLATION_WORKFLOW.get(payload.fixtureId)
    await existing.status()
    return response(env, {
      fixtureId: existing.id, runtimeRelease, reusedWorkflow: true,
    }, 202)
  } catch {
    // Missing fixture instances are created below.
  }
  try {
    const instance = await env.RUNTIME_ISOLATION_WORKFLOW.create({
      id: payload.fixtureId,
      params: payload,
      ...placement(env),
      retention: { successRetention: '1 day', errorRetention: '1 day' },
    })
    return response(env, { fixtureId: instance.id, runtimeRelease, reusedWorkflow: false }, 202)
  } catch (createError) {
    try {
      const existing = await env.RUNTIME_ISOLATION_WORKFLOW.get(payload.fixtureId)
      await existing.status()
      return response(env, { fixtureId: existing.id, runtimeRelease, reusedWorkflow: true }, 202)
    } catch {
      throw createError
    }
  }
}

async function fixtureStatus(fixtureId: string, env: Env): Promise<Response> {
  if (env.RUNTIME_ISOLATION_WORKFLOW === undefined) {
    return response(env, { error: 'runtime isolation fixture workflow is unavailable' }, 503)
  }
  await assertStoredRunOwner(fixtureId, env)
  const instance = await env.RUNTIME_ISOLATION_WORKFLOW.get(fixtureId)
  return response(env, { fixtureId, workflow: await instance.status() })
}

export async function runtimeServiceRoute(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response | null> {
  if (engineRole(env) !== 'runtime') return null
  const url = new URL(request.url)
  try {
    if (request.method === 'GET' && url.pathname === '/internal/runtime/identity') {
      return response(env, localRuntimeRelease(env))
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-runs') {
      return createAuditRun(request, env)
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-resumes') {
      return createAuditResume(request, env)
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-recoveries') {
      return createAuditFailedWaveRecovery(request, env)
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-terminal-recoveries') {
      return createAuditTerminalCompletionRecovery(request, env)
    }
    const runMatch = url.pathname.match(/^\/internal\/runtime\/audit-runs\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
    if (request.method === 'GET' && runMatch !== undefined) return auditRunStatus(runMatch, env)
    const workflowMatch = url.pathname.match(/^\/internal\/runtime\/audit-workflows\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
    if (request.method === 'GET' && workflowMatch !== undefined) return auditWorkflowStatus(workflowMatch, env)
    const stopMatch = url.pathname.match(/^\/internal\/runtime\/audit-runs\/([a-z0-9][a-z0-9._-]{0,99})\/stop$/)?.[1]
    if (request.method === 'POST' && stopMatch !== undefined) return stopAuditRun(stopMatch, env)
    const immediateStopMatch = url.pathname.match(/^\/internal\/runtime\/audit-runs\/([a-z0-9][a-z0-9._-]{0,99})\/stop-now$/)?.[1]
    if (request.method === 'POST' && immediateStopMatch !== undefined) {
      const rawDeadline = Number(request.headers.get('x-ack3-stop-deadline-at'))
      const deadlineAt = Number.isSafeInteger(rawDeadline) && rawDeadline > 0
        ? Math.min(rawDeadline, Date.now() + 5_000) : Date.now() + 5_000
      return await boundedImmediateStop(immediateStopMatch, env, ctx, deadlineAt)
    }
    const laneMatch = url.pathname.match(
      /^\/internal\/runtime\/audit-runs\/([a-z0-9][a-z0-9._-]{0,99})\/lanes\/([A-Za-z0-9._-]{1,120})\/last-result$/,
    )
    if (request.method === 'GET' && laneMatch !== null) {
      if (!lanePattern.test(laneMatch[2]!)) return response(env, { error: 'lane is invalid' }, 400)
      return laneResult(laneMatch[1]!, laneMatch[2]!, env)
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/readiness') return readiness(env)
    if (request.method === 'POST' && url.pathname === '/internal/runtime/fixtures') return createFixture(request, env)
    const fixtureMatch = url.pathname.match(/^\/internal\/runtime\/fixtures\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
    if (request.method === 'GET' && fixtureMatch !== undefined) return fixtureStatus(fixtureMatch, env)
    return response(env, { error: 'not found' }, 404)
  } catch (error) {
    return response(env, { error: error instanceof Error ? error.message : String(error) }, 409)
  }
}
