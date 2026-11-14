import { publishImmutableObject } from './immutable-object.js'
import { startLocalAuditWorkflow } from './execution-workflow.js'
import { fixtureCheckpointKey, readFixtureCheckpoint, type RuntimeFixtureCheckpointBody } from './runtime-fixture-checkpoint.js'
export { assertLocalRuntime } from './runtime-release.js'
import { reconcileDeliveredRunControl } from './run-control-executor.js'
import { RunCommandRejected } from './run-commands.js'
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getAgentSandbox } from './agent-sandbox-client.js'
import type { RuntimeRelease } from './contracts.js'
import type {
  AuditWorkflowPayload, Env,
  RuntimeIsolationWorkflowPayload,
} from './env.js'
import { canonicalJson, sha256 } from './canonical.js'
import { containerReadinessCommand } from './container-readiness.js'
import { assertLocalRuntime, localRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import { durableLaneDiagnostic } from './lane-diagnostics.js'
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

export { engineRole } from './env.js'
import { engineRole } from './env.js'


interface RuntimeFixtureResult {
  fixtureId: string
  runtimeRelease: RuntimeRelease
  parentCheckpointDigest: string | null
  checkpointDigest: string
  containerBuildFingerprint: string
  startedAt: string
  finishedAt: string
}

async function putFixtureCheckpoint(
  env: Env,
  body: RuntimeFixtureCheckpointBody,
): Promise<string> {
  const digest = await sha256(body)
  const content = canonicalJson({ digest, body })
  const objectSha256 = await sha256(content)
  await publishImmutableObject(env.ARTIFACTS, fixtureCheckpointKey(digest), content, objectSha256,
    { bodySha256: digest, objectSha256, fixture: body.fixtureId })
  await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
    .reserveCheckpointRoute(digest, 'runtime-isolation', body.runtimeRelease)
  await readFixtureCheckpoint(env.ARTIFACTS, digest)
  return digest
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
        const parent = await readFixtureCheckpoint(this.env.ARTIFACTS, payload.parentCheckpointDigest)
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
        const sandbox = getAgentSandbox(this.env.AGENT_SANDBOX, sandboxId, {
          keepAlive: true, inactivityTimeoutMs: 10_000,
          labels: { purpose: 'runtime-isolation-idle', fixture: payload.fixtureId },
        })
        await sandbox.mkdir('/workspace/private', { recursive: true })
        await sandbox.startProcess(
          `sh -c 'sleep 20; cat /opt/ack3/BUILD_FINGERPRINT > /workspace/private/idle-survival-fingerprint'`,
          { processId },
        )
        return { sandboxId, processId }
      })
      await step.sleep('leave-container-unobserved', `${payload.holdSeconds} seconds`)
      container = await step.do<{ containerBuildFingerprint: string }>('reobserve-unobserved-container-process', {
        retries: { limit: 0, delay: '1 second' }, timeout: '2 minutes',
      }, async () => {
        const sandbox = getAgentSandbox(this.env.AGENT_SANDBOX, launched.sandboxId, {
          keepAlive: true, inactivityTimeoutMs: 10_000,
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
        const sandbox = getAgentSandbox(this.env.AGENT_SANDBOX, sandboxId, {
          inactivityTimeoutMs: 2 * 60 * 60_000, labels: { purpose: 'runtime-isolation', fixture: payload.fixtureId },
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
  const instance = await startLocalAuditWorkflow(env, payload)
  return response(env, {
    workflowInstanceId: instance.id,
    runtimeRelease: payload.runtimeRelease,
    reusedWorkflow: instance.reused,
  }, 202)
}

async function auditRunStatus(runId: string, env: Env): Promise<Response> {
  await assertStoredRunOwner(runId, env)
  const workflow = await env.AUDIT_WORKFLOW.get(runId)
  // The Workflow saves the first state shortly after start; until then there is none.
  const state = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).getStateIfPresent(runId)
  return response(env, { state, workflow: await workflow.status() })
}

async function auditWorkflowStatus(runId: string, env: Env): Promise<Response> {
  const route = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX).runRuntime(runId)
  if (route === null || !sameRuntimeRelease(route, localRuntimeRelease(env))) {
    return response(env, { error: 'Workflow run route is unavailable or belongs to a different runtime' }, 409)
  }
  const workflow = await env.AUDIT_WORKFLOW.get(runId)
  if (workflow.id !== runId) throw new Error('observed Workflow identity differs')
  return response(env, { runId, runtimeRelease: localRuntimeRelease(env), workflow: await workflow.status() })
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
  const sandbox = getAgentSandbox(env.AGENT_SANDBOX, probeId, {
    inactivityTimeoutMs: 60_000, labels: { purpose: 'readiness', probe: probeId },
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
    const parent = await readFixtureCheckpoint(env.ARTIFACTS, payload.parentCheckpointDigest)
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

export async function runtimeServiceRoute(request: Request, env: Env): Promise<Response | null> {
  if (engineRole(env) !== 'runtime') return null
  const url = new URL(request.url)
  try {
    if (request.method === 'GET' && url.pathname === '/internal/runtime/identity') {
      return response(env, localRuntimeRelease(env))
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/saved-work') {
      const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
      return response(env, { digest: await store.exportStageFork(await request.json(), localRuntimeRelease(env)) })
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-controls/reconcile') {
      return response(env, await reconcileDeliveredRunControl(await request.json(), env))
    }
    if (request.method === 'POST' && url.pathname === '/internal/runtime/audit-runs') {
      return createAuditRun(request, env)
    }
    const runMatch = url.pathname.match(/^\/internal\/runtime\/audit-runs\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
    if (request.method === 'GET' && runMatch !== undefined) return auditRunStatus(runMatch, env)
    const workflowMatch = url.pathname.match(/^\/internal\/runtime\/audit-workflows\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
    if (request.method === 'GET' && workflowMatch !== undefined) return auditWorkflowStatus(workflowMatch, env)
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
    return response(env, { error: error instanceof Error ? error.message : String(error),
      ...(error instanceof RunCommandRejected ? { code: error.code } : {}) }, 409)
  }
}
