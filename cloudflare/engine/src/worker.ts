import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getSandbox } from '@cloudflare/sandbox'
import { resolveTargetEnvironment } from './target-environment.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import type { AuditWorkflowPayload, Env, QuarantinedRevalidation } from './env.js'
import type {
  FailedWaveRecoveryEvidence, ReleasePackageBody, RetainedNativeRecoveryEvidence,
  RunCursor, RunState, RuntimeRelease, SealedCheckpoint,
  TerminalCompletionRecoveryEvidence, RuntimeTransitionEvidence,
} from './contracts.js'
import { CloudflareRunStore, R2ArtifactStore } from './cloudflare-storage.js'
import { canonicalJson, sha256 } from './canonical.js'
import { containerReadinessCommand } from './container-readiness.js'
import { expiredResumeClockAmendment } from './recovery-clock.js'
import { rejectedAttemptIdentity, RunMachine } from './machine.js'
import { SandboxAgentProvider } from './sandbox-provider.js'
import { QuarantinedRevalidationProvider } from './revalidation-provider.js'
import { advanceExperimentOneWave, audit0RunPolicy, disposeTerminalWorkspaces } from './runner.js'
import dashboardHtml from './dashboard.html'
import { monitoringRoute } from './dashboard-api.js'
import { dashboardAccessAllowed, monitoringRequestFromDashboard } from './dashboard-access.js'
import { storeSourceArchive } from './source-provenance.js'
import { isPermanentRunFailure, PermanentRunFailure, TransientRunFailure } from './run-errors.js'
import {
  canStopAtSealedWaveBoundary,
  failureForWorkflowProgress,
  type WaveProgress,
  workflowFailureDisposition,
  workflowProgress,
} from './workflow-outcome.js'
import { waveStepConfig, workflowBootstrapProgress } from './workflow-step-config.js'
import {
  pinnedRuntime, resolveRuntimeSelector, RuntimeRouter, sameRuntimeRelease, type RuntimeSelector,
} from './runtime-release.js'
import { assertLocalRuntime, engineRole, runtimeServiceRoute } from './runtime-service.js'
import { placement } from './placement.js'
import { prepareFailedWaveRecovery } from './failed-wave-recovery.js'
import { prepareTerminalCompletionRecovery } from './terminal-completion-recovery.js'
import { prepareCheckpointRuntimeTransition } from './checkpoint-runtime-transition.js'
import { durableLaneDiagnostic } from './lane-diagnostics.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { R2AgentExecutionLogStore } from './agent-execution-log.js'
import { PromotedExecutionProvider } from './promoted-execution.js'
import { retireTerminalFixture } from './terminal-fixture-retirement.js'
import { retireStoppedRun } from './stopped-run-retirement.js'
import { retireFailedRun } from './failed-run-retirement.js'
import { assertUnmaterializedRecoveryRetirementProof } from './unmaterialized-recovery-retirement.js'
import { validateNewSearchAdmission } from './validation.js'

export { Sandbox } from '@cloudflare/sandbox'
export { RuntimeIsolationWorkflow } from './runtime-service.js'

const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/
const digestPattern = /^[0-9a-f]{64}$/

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

async function authorized(request: Request, secret: string): Promise<boolean> {
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  if (supplied === '' || secret === '') return false
  const values = await Promise.all([supplied, secret].map(value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
  const left = new Uint8Array(values[0]!)
  const right = new Uint8Array(values[1]!)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

function experimentFrom(pathname: string): string | null {
  const value = pathname.match(/^\/v1\/experiments\/([a-z0-9][a-z0-9._-]{0,99})\/(?:release|activate|runs|resumes|recoveries|terminal-recoveries|retire-unmaterialized-recovery|retire-failed-native)$/)?.[1]
  return value ?? null
}

interface ReleasePointer {
  experimentId: string
  digest: string
  generation: number
  activatedAt: string
  /** New activations save selection intent; each new run resolves it once at reservation. */
  runtimeSelector?: RuntimeSelector
  /** Absent only on pointers activated before runtime release isolation. */
  runtimeRelease?: RuntimeRelease
}

type RunReservationProvenance =
  | Readonly<{ mode: 'start', releaseDigest: string, runtimeRelease?: RuntimeRelease }>
  | Readonly<{
    mode: 'resume'
    checkpointDigest: string
    runtimeRelease?: RuntimeRelease
    runtimeTransition?: RuntimeTransitionEvidence
    revalidate?: { sourceRunId?: string, outputDigest?: string }
  }>
  | Readonly<{
    mode: 'recover-failed-wave'
    checkpointDigest: string
    runtimeRelease: RuntimeRelease
    failedWaveRecovery: FailedWaveRecoveryEvidence
  }>
  | Readonly<{
    mode: 'recover-terminal-completion'
    checkpointDigest: string
    runtimeRelease: RuntimeRelease
    terminalCompletionRecovery: TerminalCompletionRecoveryEvidence
  }>

interface RunReservation {
  experimentId: string
  requestDigest: string
  provenance: RunReservationProvenance
  reservedAt: string
  dispatchedAt?: string
  workflowInstanceId?: string
  retirementProofDigest?: string
  dispatchInProgress?: true
  dispatchRefusedStatus?: number
}

async function runtimeResponseBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`runtime release returned an invalid response: ${response.status}`)
  }
  if (!response.ok) throw new Error(`runtime release request failed: ${String((value as Record<string, unknown>).error ?? response.status)}`)
  return value as Record<string, unknown>
}

async function dispatchAuditWorkflow(env: Env, payload: AuditWorkflowPayload): Promise<string> {
  if (engineRole(env) !== 'front-door') {
    const instance = await env.AUDIT_WORKFLOW.create({
      id: payload.runId,
      params: payload,
      ...placement(env),
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    })
    return instance.id
  }
  if (payload.runtimeRelease === undefined) throw new Error('runtime-bound audit payload is required')
  const response = await new RuntimeRouter(env).fetch(payload.runtimeRelease, '/internal/runtime/audit-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await runtimeResponseBody(response)
  if (typeof body.workflowInstanceId !== 'string' || body.workflowInstanceId !== payload.runId) {
    throw new Error('runtime release returned an invalid Workflow identity')
  }
  return body.workflowInstanceId
}

export class ExperimentCoordinator extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const experimentId = request.headers.get('x-ack3-experiment') ?? ''
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(experimentId)) return json({ error: 'invalid experiment id' }, 400)
    try {
      if (request.method === 'GET' && url.pathname === '/release') return await this.release(experimentId)
      if (request.method === 'POST' && url.pathname === '/activate') return await this.activate(request, experimentId)
      if (request.method === 'POST' && url.pathname === '/runs') return await this.start(request, experimentId)
      if (request.method === 'POST' && url.pathname === '/resumes') return await this.resume(request, experimentId)
      if (request.method === 'POST' && url.pathname === '/recoveries') return await this.recoverFailedWave(request, experimentId)
      if (request.method === 'POST' && url.pathname === '/retire-unmaterialized-recovery') {
        return await this.retireUnmaterializedRecovery(request, experimentId)
      }
      if (request.method === 'POST' && url.pathname === '/retire-failed-native') {
        return await this.retireFailedNative(request, experimentId)
      }
      if (request.method === 'POST' && url.pathname === '/terminal-recoveries') return await this.recoverTerminalCompletion(request, experimentId)
      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  }

  private async release(experimentId: string): Promise<Response> {
    const pointer = await this.ctx.storage.get<ReleasePointer>('release-pointer')
    if (pointer === undefined) return json({ experimentId, digest: null, generation: 0, activatedAt: null })
    return json(pointer)
  }

  private async activate(request: Request, experimentId: string): Promise<Response> {
    const started = performance.now()
    const body = await request.json<{ digest?: string, expectedGeneration?: number, runtimeId?: string }>()
    if (!digestPattern.test(body.digest ?? '') || !Number.isSafeInteger(body.expectedGeneration) || (body.expectedGeneration ?? -1) < 0) {
      return json({ error: 'digest and non-negative expectedGeneration are required' }, 400)
    }
    const digest = body.digest as string
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    if (!await store.releaseExists(digest)) return json({ error: 'release package is missing' }, 404)
    const frontDoor = engineRole(this.env) === 'front-door'
    if (!frontDoor) {
      const release = await store.getRelease(digest)
      resolveTargetEnvironment(release.body.definition.target.runtime.environmentBindings, this.env)
    }
    const runtimeSelector: RuntimeSelector | undefined = frontDoor
      ? body.runtimeId === undefined || body.runtimeId === 'latest'
        ? { mode: 'latest' }
        : { mode: 'release', id: body.runtimeId }
      : undefined
    if (runtimeSelector?.mode === 'release'
      && new RuntimeRouter(this.env).catalog.releases[runtimeSelector.id] === undefined) {
      return json({ error: `runtime release is unavailable: ${runtimeSelector.id}` }, 409)
    }
    const pointer = await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<ReleasePointer>('release-pointer')
      const generation = current?.generation ?? 0
      if (generation !== body.expectedGeneration) throw new Error(`release generation changed: ${generation}`)
      const next: ReleasePointer = {
        experimentId,
        digest,
        generation: generation + 1,
        activatedAt: new Date().toISOString(),
        ...(runtimeSelector === undefined ? {} : { runtimeSelector }),
      }
      await transaction.put('release-pointer', next)
      return next
    })
    const activationMs = performance.now() - started
    const latencyTargetMs = 1_000
    return json({ ...pointer, activationMs, latencyTargetMs, latencyTargetMet: activationMs < latencyTargetMs }, 200,
      { 'server-timing': `activation;dur=${activationMs.toFixed(1)}` })
  }

  private async start(request: Request, experimentId: string): Promise<Response> {
    const started = performance.now()
    const body = await request.json<{
      runId?: string
      expectedReleaseDigest?: string
      expectedGeneration?: number
      expectedRuntimeRelease?: RuntimeRelease
    }>()
    if (!runIdPattern.test(body.runId ?? '')) return json({ error: 'valid runId is required' }, 400)
    const guarded = body.expectedReleaseDigest !== undefined
      || body.expectedGeneration !== undefined || body.expectedRuntimeRelease !== undefined
    if (guarded && (!digestPattern.test(body.expectedReleaseDigest ?? '')
      || !Number.isSafeInteger(body.expectedGeneration) || (body.expectedGeneration ?? -1) < 1
      || body.expectedRuntimeRelease === undefined)) {
      return json({ error: 'complete exact release, generation and runtime guard is required' }, 400)
    }
    const runId = body.runId as string
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const frontDoor = engineRole(this.env) === 'front-door'
    const requestIdentity = { mode: 'start', experimentId, runId,
      ...(guarded ? { expectedReleaseDigest: body.expectedReleaseDigest,
        expectedGeneration: body.expectedGeneration,
        expectedRuntimeRelease: body.expectedRuntimeRelease } : {}),
    }
    let reservation = await this.reservationFor(runId, requestIdentity)
    let selectedRelease: ReleasePackageBody | undefined
    if (reservation === undefined) {
      const pointer = await this.ctx.storage.get<ReleasePointer>('release-pointer')
      if (pointer === undefined || pointer.experimentId !== experimentId) return json({ error: 'no active release' }, 409)
      if (guarded && (pointer.digest !== body.expectedReleaseDigest
        || pointer.generation !== body.expectedGeneration)) {
        return json({ error: 'active release changed before guarded start' }, 409)
      }
      if (frontDoor && pointer.runtimeSelector === undefined) {
        return json({ error: 'new runs require an explicit runtime selector' }, 409)
      }
      if (!frontDoor) {
        const release = await store.getRelease(pointer.digest)
        if (release.body.definition.id !== experimentId) return json({ error: 'active release experiment mismatch' }, 409)
      }
      const runtimeRelease = frontDoor
        ? await resolveRuntimeSelector(pointer.runtimeSelector!, new RuntimeRouter(this.env))
        : pointer.runtimeRelease
      if (guarded && (runtimeRelease === undefined
        || !sameRuntimeRelease(runtimeRelease, body.expectedRuntimeRelease!))) {
        return json({ error: 'runtime release changed before guarded start' }, 409)
      }
      const release = await store.getRelease(pointer.digest)
      selectedRelease = release.body
      validateNewSearchAdmission(release.body.definition)
      assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
      reservation = await this.reserveRunId(runId, requestIdentity, {
        mode: 'start', releaseDigest: pointer.digest,
        ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
      }, guarded ? { experimentId, digest: pointer.digest, generation: pointer.generation } : undefined)
    }
    if (reservation.provenance.mode !== 'start') throw new Error(`run already exists: ${runId}`)
    const { releaseDigest, runtimeRelease } = reservation.provenance
    assertReleaseEnvironmentMatchesRuntime(selectedRelease ?? (await store.getRelease(releaseDigest)).body, runtimeRelease)
    if (runtimeRelease !== undefined) await store.reserveRunRoute(runId, experimentId, runtimeRelease)
    if (reservation.workflowInstanceId !== undefined) {
      const dispatchMs = performance.now() - started
      return json({
        runId, workflowInstanceId: reservation.workflowInstanceId, releaseDigest, runtimeRelease,
        dispatchMs, reusedReservation: true,
      }, 202, { 'server-timing': `dispatch;dur=${dispatchMs.toFixed(1)}` })
    }
    try {
      const workflowInstanceId = await dispatchAuditWorkflow(this.env, {
        mode: 'start', experimentId, runId, releaseDigest,
        ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
      })
      await this.markRunDispatched(runId, workflowInstanceId)
      const dispatchMs = performance.now() - started
      return json({ runId, workflowInstanceId, releaseDigest, runtimeRelease, dispatchMs }, 202,
        { 'server-timing': `dispatch;dur=${dispatchMs.toFixed(1)}` })
    } catch (error) {
      throw new Error(`workflow dispatch failed; retry the identical request: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async resume(request: Request, experimentId: string): Promise<Response> {
    const started = performance.now()
    const body = await request.json<{
      childRunId?: string
      checkpointDigest?: string
      revalidate?: { sourceRunId?: string, outputDigest?: string }
      runtimeId?: string
      transition?: { sourceRunId: string, sourceStateGeneration: number, sourceStateDigest: string }
    }>()
    if (!runIdPattern.test(body.childRunId ?? '') || !digestPattern.test(body.checkpointDigest ?? '')) {
      return json({ error: 'valid childRunId and checkpointDigest are required' }, 400)
    }
    const runId = body.childRunId as string
    const checkpointDigest = body.checkpointDigest as string
    if ((body.runtimeId !== undefined) !== (body.transition !== undefined)
      || (body.transition !== undefined && (body.revalidate !== undefined
        || !runIdPattern.test(body.transition.sourceRunId ?? '')
        || !Number.isSafeInteger(body.transition.sourceStateGeneration) || body.transition.sourceStateGeneration < 1
        || !digestPattern.test(body.transition.sourceStateDigest ?? '')))) {
      return json({ error: 'runtime transition requires explicit runtimeId and exact stopped source evidence' }, 400)
    }
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    if (engineRole(this.env) === 'front-door') {
      if (body.revalidate !== undefined && (!runIdPattern.test(body.revalidate.sourceRunId ?? '')
        || !digestPattern.test(body.revalidate.outputDigest ?? ''))) {
        return json({ error: 'revalidation requires a valid sourceRunId and outputDigest' }, 400)
      }
      const router = new RuntimeRouter(this.env)
      const requestIdentity = {
        mode: 'resume', experimentId, runId, checkpointDigest,
        ...(body.revalidate === undefined ? {} : { revalidate: body.revalidate }),
        ...(body.transition === undefined ? {} : { runtimeId: body.runtimeId, transition: body.transition }),
      }
      let reservation = await this.reservationFor(runId, requestIdentity)
      if (reservation === undefined) {
        let runtimeRelease = pinnedRuntime(await store.checkpointRuntime(checkpointDigest))
        let runtimeTransition: RuntimeTransitionEvidence | undefined
        if (body.transition !== undefined) {
          runtimeRelease = await resolveRuntimeSelector(body.runtimeId === 'latest'
            ? { mode: 'latest' } : { mode: 'release', id: body.runtimeId! }, router)
          const checkpoint = await store.getCheckpoint(checkpointDigest)
          const release = await store.getRelease(checkpoint.body.releaseDigest)
          const source = await store.getState(body.transition.sourceRunId)
          if (checkpoint.body.experimentId !== experimentId) throw new Error('resume experiment mismatch')
          runtimeTransition = await prepareCheckpointRuntimeTransition({ definition: release.body.definition,
            checkpoint, source, ...body.transition, targetRuntimeRelease: runtimeRelease })
          await RunMachine.resume(release.body.definition, checkpoint, runId, new Set(),
            new Date().toISOString(), undefined, runtimeRelease, runtimeTransition, source)
        }
        const selectedCheckpoint = await store.getCheckpoint(checkpointDigest)
        assertReleaseEnvironmentMatchesRuntime(
          (await store.getRelease(selectedCheckpoint.body.releaseDigest)).body, runtimeRelease)
        reservation = await this.reserveRunId(runId, requestIdentity, {
          mode: 'resume', checkpointDigest, runtimeRelease,
          ...(runtimeTransition === undefined ? {} : { runtimeTransition }),
          ...(body.revalidate === undefined ? {} : { revalidate: body.revalidate }),
        })
      }
      if (reservation.provenance.mode !== 'resume') throw new Error(`run already exists: ${runId}`)
      const runtimeRelease = reservation.provenance.runtimeRelease
      if (runtimeRelease === undefined) throw new Error('front-door resume reservation is missing its runtime release')
      const selectedCheckpoint = await store.getCheckpoint(checkpointDigest)
      assertReleaseEnvironmentMatchesRuntime(
        (await store.getRelease(selectedCheckpoint.body.releaseDigest)).body, runtimeRelease)
      await store.reserveRunRoute(runId, experimentId, runtimeRelease)
      if (reservation.workflowInstanceId !== undefined) {
        const resumeDispatchMs = performance.now() - started
        return json({
          runId,
          workflowInstanceId: reservation.workflowInstanceId,
          checkpointDigest,
          runtimeRelease,
          resumeDispatchMs,
          reusedReservation: true,
        }, 202, { 'server-timing': `resume-dispatch;dur=${resumeDispatchMs.toFixed(1)}` })
      }
      const routed = await router.fetch(runtimeRelease, '/internal/runtime/audit-resumes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          experimentId,
          childRunId: runId,
          checkpointDigest,
          runtimeRelease,
          ...(body.revalidate === undefined ? {} : { revalidate: body.revalidate }),
          ...(reservation.provenance.runtimeTransition === undefined ? {} : { runtimeTransition: reservation.provenance.runtimeTransition }),
        }),
      })
      const result = await runtimeResponseBody(routed)
      if (result.workflowInstanceId !== runId) throw new Error('runtime release returned an invalid Workflow identity')
      await this.markRunDispatched(runId, runId)
      const resumeDispatchMs = performance.now() - started
      return json({ runId, ...result, resumeDispatchMs }, 202,
        { 'server-timing': `resume-dispatch;dur=${resumeDispatchMs.toFixed(1)}` })
    }
    if (body.transition !== undefined) return json({ error: 'runtime transition requires the front door' }, 409)
    const checkpoint = await store.getCheckpoint(checkpointDigest)
    const release = await store.getRelease(checkpoint.body.releaseDigest)
    if (checkpoint.body.experimentId !== experimentId || release.body.definition.id !== experimentId) {
      return json({ error: 'resume experiment mismatch' }, 409)
    }
    let revalidation: QuarantinedRevalidation | undefined
    if (body.revalidate !== undefined) {
      if (!runIdPattern.test(body.revalidate.sourceRunId ?? '')
        || !digestPattern.test(body.revalidate.outputDigest ?? '')) {
        return json({ error: 'revalidation requires a valid sourceRunId and outputDigest' }, 400)
      }
      const source = await store.getState(body.revalidate.sourceRunId as string)
      const sourceOwnsCheckpoint = source.checkpoints.some(candidate => (
        candidate.digest === checkpointDigest && sameCursor(candidate.body.cursor, checkpoint.body.cursor)
      ))
      if (source.status !== 'failed' || source.experimentId !== experimentId
        || source.releaseDigest !== checkpoint.body.releaseDigest
        || (source.parentCheckpointDigest !== checkpointDigest && !sourceOwnsCheckpoint)
        || !sameCursor(source.cursor, checkpoint.body.cursor)) {
        return json({ error: 'revalidation source is not a failed descendant or owner of this checkpoint' }, 409)
      }
      const matchingCandidates = source.rejectedAttempts.filter(attempt => (
        attempt.outputDigest === body.revalidate?.outputDigest && attempt.quarantineUri !== null
      ))
      const candidates = [...new Map(matchingCandidates.map(candidate => (
        [rejectedAttemptIdentity(candidate), candidate]
      ))).values()]
      if (candidates.length !== 1) return json({ error: 'revalidation attempt is missing or ambiguous' }, 409)
      const candidate = candidates[0]!
      const stage = release.body.definition.stages[checkpoint.body.cursor.stageIndex]
      const wave = stage?.waves[checkpoint.body.cursor.waveIndex]
      const matchedTask = wave?.tasks.find(task => task.id === candidate.taskId)
      if (stage?.id !== candidate.stageId || wave?.id !== candidate.waveId
        || matchedTask === undefined || matchedTask.retryPolicy !== 'none'
        || candidate.outputDigest === null || candidate.quarantineUri === null
        || candidate.usage.modelCalls !== 1
        || candidate.attempt !== 1) {
        return json({ error: 'revalidation attempt does not match the checkpoint cursor' }, 409)
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
    const timeAmendment = expiredResumeClockAmendment(release.body.definition, checkpoint, resumedAt)
    const runtimeRelease = checkpoint.body.runtimeRelease
    assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
    await RunMachine.resume(
      release.body.definition, checkpoint, runId, new Set(), resumedAt, timeAmendment ?? undefined, runtimeRelease,
    )
    const legacyRequestIdentity = {
      mode: 'resume', experimentId, runId, checkpointDigest,
      ...(body.revalidate === undefined ? {} : { revalidate: body.revalidate }),
    }
    await this.reserveRunId(runId, legacyRequestIdentity, {
      mode: 'resume', checkpointDigest,
      ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
      ...(body.revalidate === undefined ? {} : { revalidate: body.revalidate }),
    })
    try {
      const workflowInstanceId = await dispatchAuditWorkflow(this.env, {
        mode: 'resume', experimentId, runId, checkpointDigest,
        ...(timeAmendment === null ? {} : { timeAmendment }),
        ...(revalidation === undefined ? {} : { revalidation }),
        ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
      })
      await this.markRunDispatched(runId, workflowInstanceId)
      const resumeDispatchMs = performance.now() - started
      return json({
        runId, workflowInstanceId, checkpointDigest, timeAmendment, runtimeRelease, resumeDispatchMs,
        revalidation: revalidation === undefined ? null : {
          sourceRunId: revalidation.sourceRunId,
          taskId: revalidation.taskId,
          outputDigest: revalidation.outputDigest,
        },
      }, 202,
        { 'server-timing': `resume-dispatch;dur=${resumeDispatchMs.toFixed(1)}` })
    } catch (error) {
      throw new Error(`resume dispatch failed; reserved child ID must not be reused: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async recoverFailedWave(request: Request, experimentId: string): Promise<Response> {
    if (engineRole(this.env) !== 'front-door') return json({ error: 'failed-wave recovery requires the front door' }, 409)
    const started = performance.now()
    const body = await request.json<{
      childRunId?: string
      sourceRunId?: string
      sourceStateGeneration?: number
      sourceStateDigest?: string
      checkpointDigest?: string
      runtimeId?: string
      promoteExecution?: {
        taskId?: string
        sourceAttempt?: number
        requestDigest?: string
        quarantineOutputDigest?: string
      }
      retainNative?: { taskId?: string, requestDigest?: string, snapshotDigest?: string, sandboxObjectId?: string }
    }>()
    const promoteExecution = body.promoteExecution
    const promotionIsValid = promoteExecution === undefined || (
      typeof promoteExecution.taskId === 'string' && promoteExecution.taskId.trim() !== ''
      && Number.isSafeInteger(promoteExecution.sourceAttempt) && (promoteExecution.sourceAttempt ?? 0) >= 1
      && digestPattern.test(promoteExecution.requestDigest ?? '')
      && (promoteExecution.quarantineOutputDigest === undefined
        || digestPattern.test(promoteExecution.quarantineOutputDigest))
    )
    const retainNative = body.retainNative
    const retentionIsValid = retainNative === undefined || (
      typeof retainNative.taskId === 'string' && retainNative.taskId.trim() !== ''
      && digestPattern.test(retainNative.requestDigest ?? '')
      && digestPattern.test(retainNative.snapshotDigest ?? '')
      && digestPattern.test(retainNative.sandboxObjectId ?? '')
      && promoteExecution === undefined
    )
    if (!runIdPattern.test(body.childRunId ?? '') || !runIdPattern.test(body.sourceRunId ?? '')
      || !Number.isSafeInteger(body.sourceStateGeneration) || (body.sourceStateGeneration ?? 0) < 1
      || !digestPattern.test(body.sourceStateDigest ?? '') || !digestPattern.test(body.checkpointDigest ?? '')
      || !runIdPattern.test(body.runtimeId ?? '') || !promotionIsValid || !retentionIsValid) {
      return json({
        error: 'valid childRunId, sourceRunId, sourceStateGeneration, sourceStateDigest, checkpointDigest, and explicit runtimeId are required',
      }, 400)
    }
    const runId = body.childRunId as string
    const sourceRunId = body.sourceRunId as string
    const sourceStateGeneration = body.sourceStateGeneration as number
    const sourceStateDigest = body.sourceStateDigest as string
    const checkpointDigest = body.checkpointDigest as string
    const runtimeId = body.runtimeId as string
    const requestIdentity = {
      mode: 'recover-failed-wave', experimentId, runId, sourceRunId, sourceStateGeneration,
      sourceStateDigest, checkpointDigest, runtimeId,
      ...(promoteExecution === undefined ? {} : { promoteExecution }),
      ...(retainNative === undefined ? {} : { retainNative }),
    }
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const retired = await store.retiredUnmaterializedRoute(runId)
    if (retired !== null) throw new Error(`recovery identity was archived: ${runId}`)
    let reservation = await this.reservationFor(runId, requestIdentity)
    if (reservation === undefined) {
      const router = new RuntimeRouter(this.env)
      const runtimeRelease = await resolveRuntimeSelector({ mode: 'release', id: runtimeId }, router)
      const source = await store.getState(sourceRunId)
      const checkpoint = await store.getCheckpoint(checkpointDigest)
      const release = await store.getRelease(checkpoint.body.releaseDigest)
      if (source.experimentId !== experimentId || checkpoint.body.experimentId !== experimentId
        || release.body.definition.id !== experimentId) {
        return json({ error: 'failed-wave recovery experiment mismatch' }, 409)
      }
      assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
      const unobservableNative = (source.inFlightAgentAttempts ?? []).length === 0
        ? undefined : await store.fencedUnobservableNativeEvidence(source)
      const prepared = await prepareFailedWaveRecovery({
        definition: release.body.definition,
        checkpoint,
        source,
        sourceStateGeneration,
        sourceStateDigest,
        targetRuntimeRelease: runtimeRelease,
        artifacts: new R2ArtifactStore(this.env.ARTIFACTS),
        ...(unobservableNative === undefined ? {} : { unobservableNative }),
        ...(promoteExecution === undefined ? {} : {
          promoteExecution: {
            taskId: promoteExecution.taskId!,
            sourceAttempt: promoteExecution.sourceAttempt!,
            requestDigest: promoteExecution.requestDigest!,
            ...(promoteExecution.quarantineOutputDigest === undefined ? {}
              : { quarantineOutputDigest: promoteExecution.quarantineOutputDigest }),
          },
          executionReceipts: new R2AgentExecutionReceiptStore(this.env.ARTIFACTS),
          executionRequests: new R2AgentExecutionLogStore(this.env.ARTIFACTS),
          ...(promoteExecution.quarantineOutputDigest === undefined ? {}
            : { quarantined: new R2ArtifactStore(this.env.ARTIFACTS) }),
        }),
        ...(retainNative === undefined ? {} : { retainNative: {
          taskId: retainNative.taskId!, requestDigest: retainNative.requestDigest!,
          snapshotDigest: retainNative.snapshotDigest!, sandboxObjectId: retainNative.sandboxObjectId!,
        } }),
      })
      if (prepared.evidence.retainedNative !== undefined) {
        const retained = prepared.evidence.retainedNative
        const claim = await store.retainedNativeWorkspaceClaim(sourceRunId, retained.workspaceKey)
        if (claim?.childRunId !== runId || claim.sourceStateDigest !== sourceStateDigest
          || claim.snapshotDigest !== retained.nativeTransport.snapshotDigest
          || claim.sandboxObjectId !== retained.sandboxObjectId
          || await store.retiredRunWorkflow(sourceRunId) === null) {
          throw new Error('retained native workspace was not exclusively fenced for this child')
        }
      }
      await RunMachine.recoverFailedWave(
        release.body.definition, checkpoint, source, runId,
        prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence,
      )
      if (prepared.evidence.unobservableNative !== undefined) {
        const freshSource = await store.getState(sourceRunId)
        const fresh = await store.fencedUnobservableNativeEvidence(freshSource)
        if (canonicalJson(fresh ?? null) !== canonicalJson(prepared.evidence.unobservableNative)) {
          throw new Error('unobservable recovery fence or receipt changed before reservation')
        }
      }
      reservation = await this.reserveRunId(runId, requestIdentity, {
        mode: 'recover-failed-wave', checkpointDigest, runtimeRelease, failedWaveRecovery: prepared.evidence,
      })
    }
    if (reservation.provenance.mode !== 'recover-failed-wave') throw new Error(`run already exists: ${runId}`)
    const { runtimeRelease, failedWaveRecovery } = reservation.provenance
    const selectedCheckpoint = await store.getCheckpoint(checkpointDigest)
    assertReleaseEnvironmentMatchesRuntime(
      (await store.getRelease(selectedCheckpoint.body.releaseDigest)).body, runtimeRelease)
    if (failedWaveRecovery.unobservableNative !== undefined) {
      const freshSource = await store.getState(sourceRunId)
      const fresh = await store.fencedUnobservableNativeEvidence(freshSource)
      if (canonicalJson(fresh ?? null) !== canonicalJson(failedWaveRecovery.unobservableNative)) {
        throw new Error('unobservable recovery fence or receipt changed before route reservation')
      }
    }
    await store.reserveRunRoute(runId, experimentId, runtimeRelease)
    if (reservation.workflowInstanceId !== undefined) {
      const recoveryDispatchMs = performance.now() - started
      return json({
        runId, workflowInstanceId: reservation.workflowInstanceId, checkpointDigest,
        runtimeRelease, failedWaveRecovery, recoveryDispatchMs, reusedReservation: true,
      }, 202, { 'server-timing': `recovery-dispatch;dur=${recoveryDispatchMs.toFixed(1)}` })
    }
    if (reservation.dispatchInProgress === true) {
      const observed = await new RuntimeRouter(this.env).fetch(runtimeRelease,
        `/internal/runtime/audit-workflows/${runId}`)
      const native = await runtimeResponseBody(observed)
      if (native.runId !== runId || native.runtimeRelease === null
        || typeof native.runtimeRelease !== 'object'
        || !sameRuntimeRelease(native.runtimeRelease as RuntimeRelease, runtimeRelease)
        || native.workflow === null || typeof native.workflow !== 'object'
        || typeof (native.workflow as { status?: unknown }).status !== 'string') {
        throw new Error('pending recovery Workflow identity is unavailable or different')
      }
      const existingState = await store.getStateIfPresent(runId)
      if (existingState !== null && (existingState.runId !== runId
        || existingState.runtimeRelease === undefined
        || !sameRuntimeRelease(existingState.runtimeRelease, runtimeRelease)
        || existingState.failedWaveRecovery === undefined
        || canonicalJson(existingState.failedWaveRecovery) !== canonicalJson(failedWaveRecovery))) {
        throw new Error('pending recovery state differs from its reservation')
      }
      await this.markRunDispatched(runId, runId)
      return json({ runId, workflowInstanceId: runId, checkpointDigest,
        runtimeRelease, failedWaveRecovery, reusedReservation: true,
        reconciledExistingWorkflow: true }, 202)
    }
    await this.claimRecoveryDispatch(runId, reservation.requestDigest)
    const routed = await new RuntimeRouter(this.env).fetch(runtimeRelease, '/internal/runtime/audit-recoveries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        experimentId,
        childRunId: runId,
        sourceRunId,
        sourceStateGeneration,
        sourceStateDigest,
        checkpointDigest,
        runtimeRelease,
        ...(promoteExecution === undefined ? {} : { promoteExecution }),
        ...(retainNative === undefined ? {} : { retainNative }),
      }),
    })
    if (!routed.ok && [400, 409].includes(routed.status)
      && routed.headers.get('x-ack3-runtime-worker-version') === runtimeRelease.workerVersionId) {
      await this.markRecoveryDispatchRefused(runId, routed.status)
    }
    const result = await runtimeResponseBody(routed)
    if (result.workflowInstanceId !== runId) throw new Error('runtime release returned an invalid recovery Workflow identity')
    if (canonicalJson(result.failedWaveRecovery) !== canonicalJson(failedWaveRecovery)) {
      throw new Error('runtime release returned different failed-wave recovery evidence')
    }
    await this.markRunDispatched(runId, runId)
    const recoveryDispatchMs = performance.now() - started
    return json({ runId, ...result, recoveryDispatchMs }, 202,
      { 'server-timing': `recovery-dispatch;dur=${recoveryDispatchMs.toFixed(1)}` })
  }

  private async retireUnmaterializedRecovery(request: Request, experimentId: string): Promise<Response> {
    if (engineRole(this.env) !== 'front-door') {
      return json({ error: 'recovery retirement requires the front door' }, 409)
    }
    const proof: unknown = await request.json()
    assertUnmaterializedRecoveryRetirementProof(proof)
    if (proof.experimentId !== experimentId) throw new Error('recovery retirement experiment differs')
    const key = `run-reservation:${proof.runId}`
    const reservation = await this.ctx.storage.get<RunReservation>(key)
    if (reservation?.provenance.mode !== 'recover-failed-wave'
      || reservation.workflowInstanceId !== undefined
      || reservation.dispatchedAt !== undefined
      || reservation.dispatchInProgress === true
      || reservation.requestDigest !== proof.reservationRequestDigest
      || !sameRuntimeRelease(reservation.provenance.runtimeRelease, proof.runtimeRelease)
      || reservation.provenance.checkpointDigest !== proof.checkpointDigest
      || reservation.provenance.failedWaveRecovery.sourceRunId !== proof.sourceRunId
      || reservation.provenance.failedWaveRecovery.sourceStateDigest !== proof.sourceStateDigest) {
      throw new Error('recovery reservation changed or was dispatched')
    }
    const proofDigest = await sha256(canonicalJson(proof))
    if (reservation.retirementProofDigest !== undefined
      && reservation.retirementProofDigest !== proofDigest) {
      throw new Error('recovery reservation was retired with different proof')
    }
    if (reservation.retirementProofDigest === undefined
      && (Date.now() - Date.parse(proof.observedAt) > 120_000
        || Date.parse(proof.observedAt) > Date.now() + 10_000)) {
      throw new Error('recovery retirement observation is stale')
    }
    await this.ctx.storage.transaction(async transaction => {
      const current = await transaction.get<RunReservation>(key)
      if (current === undefined || current.requestDigest !== reservation.requestDigest
        || current.workflowInstanceId !== undefined || current.dispatchedAt !== undefined
        || current.dispatchInProgress === true
        || (current.retirementProofDigest !== undefined
          && current.retirementProofDigest !== proofDigest)) {
        throw new Error('recovery reservation changed before retirement')
      }
      await transaction.put(key, { ...current, retirementProofDigest: proofDigest })
    })
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const archivedDigest = await store.archiveUnmaterializedRecoveryAndReleaseLease(proof)
    if (archivedDigest !== proofDigest) throw new Error('recovery retirement proof changed')
    return json({ runId: proof.runId, retired: true, proofDigest })
  }

  private async retireFailedNative(request: Request, experimentId: string): Promise<Response> {
    if (engineRole(this.env) !== 'front-door') {
      return json({ error: 'failed native retirement requires the front door' }, 409)
    }
    const body = await request.json<{
      childRunId?: string, sourceRunId?: string, sourceStateGeneration?: number,
      sourceStateDigest?: string, checkpointDigest?: string,
      retainNative?: { taskId?: string, requestDigest?: string, snapshotDigest?: string, sandboxObjectId?: string }
    }>()
    const selection = body.retainNative
    if (!runIdPattern.test(body.childRunId ?? '') || !runIdPattern.test(body.sourceRunId ?? '')
      || !Number.isSafeInteger(body.sourceStateGeneration) || (body.sourceStateGeneration ?? 0) < 1
      || !digestPattern.test(body.sourceStateDigest ?? '') || !digestPattern.test(body.checkpointDigest ?? '')
      || typeof selection?.taskId !== 'string' || selection.taskId.trim() === ''
      || !digestPattern.test(selection.requestDigest ?? '')
      || !digestPattern.test(selection.snapshotDigest ?? '')
      || !digestPattern.test(selection.sandboxObjectId ?? '')) {
      return json({ error: 'exact failed native source, child, checkpoint and retained session are required' }, 400)
    }
    const sourceRunId = body.sourceRunId!, childRunId = body.childRunId!
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    if (await this.ctx.storage.get<RunReservation>(`run-reservation:${childRunId}`) !== undefined
      || await store.getStateIfPresent(childRunId) !== null
      || await store.runRuntime(childRunId) !== null) {
      throw new Error('retained native child identity is already reserved')
    }
    const source = await store.getState(sourceRunId)
    const checkpoint = await store.getCheckpoint(body.checkpointDigest!)
    if (source.experimentId !== experimentId || checkpoint.body.experimentId !== experimentId
      || source.status !== 'failed' || source.runtimeRelease === undefined
      || source.stateGeneration !== body.sourceStateGeneration
      || await sha256(source) !== body.sourceStateDigest) {
      throw new Error('failed native source or checkpoint differs')
    }
    const stage = (await store.getRelease(source.releaseDigest)).body.definition.stages[source.cursor.stageIndex]
    const wave = stage?.waves[source.cursor.waveIndex]
    const task = wave?.tasks.find(candidate => candidate.id === selection.taskId)
    const rejection = source.rejectedAttempts.filter(value => value.stageId === stage?.id
      && value.waveId === wave?.id && value.taskId === task?.id
      && (value.repairScopeRunId ?? source.runId) === source.runId)
      .toSorted((left, right) => left.attempt - right.attempt).at(-1)
    const native = rejection?.nativeTransport
    if (stage === undefined || wave === undefined || task === undefined
      || task.providerClass !== 'additive' || task.backend !== 'dsh-chat-completions'
      || rejection?.attempt !== 2 || rejection.outputDigest !== null || rejection.quarantineUri !== null
      || native?.code !== 'SERVER' || native.workState !== 'present'
      || native.sourceRunId !== sourceRunId || native.requestDigest !== selection.requestDigest
      || native.snapshotDigest !== selection.snapshotDigest
      || source.failedWaveRecovery?.retainedNative?.taskId === task.id) {
      throw new Error('failed native source has no selected retained task')
    }
    const retainedNative: RetainedNativeRecoveryEvidence = {
      stageId: stage.id, waveId: wave.id, taskId: task.id, workspaceKey: task.workspaceKey,
      workspaceAllocationRunId: sourceRunId, sandboxObjectId: selection.sandboxObjectId!,
      nativeTransport: native,
    }
    const observed = await runtimeResponseBody(await new RuntimeRouter(this.env).fetch(
      source.runtimeRelease, `/internal/runtime/audit-workflows/${sourceRunId}`))
    if (observed.runId !== sourceRunId
      || canonicalJson(observed.runtimeRelease) !== canonicalJson(source.runtimeRelease)
      || (observed.workflow as { status?: unknown } | null)?.status !== 'errored') {
      throw new Error('native Workflow is not terminally errored for this source')
    }
    const proofDigest = await store.archiveFailedNativeRunAndReleaseLease({
      experimentId, sourceRunId, childRunId,
      sourceStateGeneration: body.sourceStateGeneration!, sourceStateDigest: body.sourceStateDigest!,
      checkpointDigest: body.checkpointDigest!, retainedNative, workflow: observed.workflow,
    })
    return json({ sourceRunId, childRunId, retired: true, proofDigest })
  }

  private async recoverTerminalCompletion(request: Request, experimentId: string): Promise<Response> {
    if (engineRole(this.env) !== 'front-door') return json({ error: 'terminal completion recovery requires the front door' }, 409)
    const body = await request.json<{
      childRunId?: string
      sourceRunId?: string
      sourceStateGeneration?: number
      sourceStateDigest?: string
      checkpointDigest?: string
      runtimeId?: string
    }>()
    if (!runIdPattern.test(body.childRunId ?? '') || !runIdPattern.test(body.sourceRunId ?? '')
      || !Number.isSafeInteger(body.sourceStateGeneration) || (body.sourceStateGeneration ?? 0) < 1
      || !digestPattern.test(body.sourceStateDigest ?? '') || !digestPattern.test(body.checkpointDigest ?? '')
      || !runIdPattern.test(body.runtimeId ?? '')) {
      return json({ error: 'valid terminal completion recovery identity and explicit runtimeId are required' }, 400)
    }
    const runId = body.childRunId as string
    const sourceRunId = body.sourceRunId as string
    const sourceStateGeneration = body.sourceStateGeneration as number
    const sourceStateDigest = body.sourceStateDigest as string
    const checkpointDigest = body.checkpointDigest as string
    const runtimeId = body.runtimeId as string
    const requestIdentity = {
      mode: 'recover-terminal-completion', experimentId, runId, sourceRunId, sourceStateGeneration,
      sourceStateDigest, checkpointDigest, runtimeId,
    }
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    let reservation = await this.reservationFor(runId, requestIdentity)
    if (reservation === undefined) {
      const runtimeRelease = await resolveRuntimeSelector(
        { mode: 'release', id: runtimeId }, new RuntimeRouter(this.env),
      )
      const source = await store.getState(sourceRunId)
      const checkpoint = await store.getCheckpoint(checkpointDigest)
      const release = await store.getRelease(checkpoint.body.releaseDigest)
      if (source.experimentId !== experimentId || checkpoint.body.experimentId !== experimentId
        || release.body.definition.id !== experimentId) {
        return json({ error: 'terminal completion recovery experiment mismatch' }, 409)
      }
      assertReleaseEnvironmentMatchesRuntime(release.body, runtimeRelease)
      const evidence = await prepareTerminalCompletionRecovery({
        definition: release.body.definition, checkpoint, source, sourceStateGeneration, sourceStateDigest,
        targetRuntimeRelease: runtimeRelease,
      })
      await RunMachine.recoverTerminalCompletion(release.body.definition, checkpoint, source, runId, evidence)
      reservation = await this.reserveRunId(runId, requestIdentity, {
        mode: 'recover-terminal-completion', checkpointDigest, runtimeRelease,
        terminalCompletionRecovery: evidence,
      })
    }
    if (reservation.provenance.mode !== 'recover-terminal-completion') throw new Error(`run already exists: ${runId}`)
    const { runtimeRelease, terminalCompletionRecovery } = reservation.provenance
    const selectedCheckpoint = await store.getCheckpoint(checkpointDigest)
    assertReleaseEnvironmentMatchesRuntime(
      (await store.getRelease(selectedCheckpoint.body.releaseDigest)).body, runtimeRelease)
    await store.reserveRunRoute(runId, experimentId, runtimeRelease)
    if (reservation.workflowInstanceId !== undefined) {
      return json({ runId, workflowInstanceId: reservation.workflowInstanceId, checkpointDigest,
        runtimeRelease, terminalCompletionRecovery, reusedReservation: true }, 202)
    }
    const routed = await new RuntimeRouter(this.env).fetch(
      runtimeRelease, '/internal/runtime/audit-terminal-recoveries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ experimentId, childRunId: runId, sourceRunId, sourceStateGeneration,
          sourceStateDigest, checkpointDigest, runtimeRelease }),
      },
    )
    const result = await runtimeResponseBody(routed)
    if (result.workflowInstanceId !== runId
      || canonicalJson(result.terminalCompletionRecovery) !== canonicalJson(terminalCompletionRecovery)) {
      throw new Error('runtime release returned different terminal completion recovery evidence')
    }
    await this.markRunDispatched(runId, runId)
    return json({ runId, ...result }, 202)
  }

  private async reservationFor(runId: string, requestIdentity: unknown): Promise<RunReservation | undefined> {
    const existing = await this.ctx.storage.get<RunReservation>(`run-reservation:${runId}`)
    if (existing === undefined) return undefined
    if (existing.retirementProofDigest !== undefined) throw new Error(`run was archived: ${runId}`)
    if (existing.dispatchRefusedStatus !== undefined) throw new Error(`run dispatch was refused: ${runId}`)
    const requestDigest = await sha256(canonicalJson(requestIdentity))
    if (existing.requestDigest !== requestDigest) throw new Error(`run already exists: ${runId}`)
    return existing
  }

  /** A durable coordinator fence makes retirement and dispatch mutually exclusive. */
  private async claimRecoveryDispatch(runId: string, requestDigest: string): Promise<void> {
    await this.ctx.storage.transaction(async transaction => {
      const key = `run-reservation:${runId}`
      const current = await transaction.get<RunReservation>(key)
      if (current?.provenance.mode !== 'recover-failed-wave'
        || current.requestDigest !== requestDigest
        || current.workflowInstanceId !== undefined
        || current.retirementProofDigest !== undefined
        || current.dispatchRefusedStatus !== undefined
        || current.dispatchInProgress === true) {
        throw new Error(`recovery dispatch is already claimed or archived: ${runId}`)
      }
      await transaction.put(key, { ...current, dispatchInProgress: true })
    })
  }

  /** A returned runtime rejection ends the in-flight claim but never authorizes replay. */
  private async markRecoveryDispatchRefused(runId: string, status: number): Promise<void> {
    if (!Number.isSafeInteger(status) || status < 400 || status > 599) {
      throw new Error('runtime refusal status is invalid')
    }
    await this.ctx.storage.transaction(async transaction => {
      const key = `run-reservation:${runId}`
      const current = await transaction.get<RunReservation>(key)
      if (current?.provenance.mode !== 'recover-failed-wave'
        || current.workflowInstanceId !== undefined || current.dispatchInProgress !== true
        || current.retirementProofDigest !== undefined) {
        throw new Error(`recovery refusal identity changed: ${runId}`)
      }
      const { dispatchInProgress: _, ...rest } = current
      await transaction.put(key, { ...rest, dispatchRefusedStatus: status })
    })
  }

  private async reserveRunId(
    runId: string,
    requestIdentity: unknown,
    provenance: RunReservationProvenance,
    expectedPointer?: Pick<ReleasePointer, 'experimentId' | 'digest' | 'generation'>,
  ): Promise<RunReservation> {
    const requestDigest = await sha256(canonicalJson(requestIdentity))
    return this.ctx.storage.transaction(async transaction => {
      const key = `run-reservation:${runId}`
      const existing = await transaction.get<RunReservation>(key)
      if (existing !== undefined) {
        if (existing.requestDigest !== requestDigest) throw new Error(`run already exists: ${runId}`)
        return existing
      }
      if (expectedPointer !== undefined) {
        const pointer = await transaction.get<ReleasePointer>('release-pointer')
        if (pointer?.experimentId !== expectedPointer.experimentId
          || pointer.digest !== expectedPointer.digest
          || pointer.generation !== expectedPointer.generation) {
          throw new Error('active release changed before guarded reservation')
        }
      }
      const reservation: RunReservation = {
        experimentId: this.ctx.id.toString(),
        requestDigest,
        provenance,
        reservedAt: new Date().toISOString(),
      }
      await transaction.put(key, reservation)
      return reservation
    })
  }

  private async markRunDispatched(runId: string, workflowInstanceId: string): Promise<RunReservation> {
    return this.ctx.storage.transaction(async transaction => {
      const key = `run-reservation:${runId}`
      const reservation = await transaction.get<RunReservation>(key)
      if (reservation === undefined) throw new Error(`run reservation is missing: ${runId}`)
      if (reservation.workflowInstanceId !== undefined && reservation.workflowInstanceId !== workflowInstanceId) {
        throw new Error(`run dispatch identity differs: ${runId}`)
      }
      const dispatched = {
        ...reservation,
        workflowInstanceId,
        dispatchedAt: reservation.dispatchedAt ?? new Date().toISOString(),
      }
      await transaction.put(key, dispatched)
      return dispatched
    })
  }
}

function sameCursor(left: RunCursor, right: RunCursor): boolean {
  return left.stageIndex === right.stageIndex && left.waveIndex === right.waveIndex
}

export class AuditWorkflow extends WorkflowEntrypoint<Env, AuditWorkflowPayload> {
  async run(event: Readonly<WorkflowEvent<AuditWorkflowPayload>>, step: WorkflowStep): Promise<WaveProgress> {
    const payload = event.payload
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    await step.do('initialize-index', { retries: { limit: 2, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' }, async () => {
      await store.ensureSchema()
      return { ready: true }
    })
    const bootstrap = await step.do<WaveProgress | { progress: WaveProgress, maxWaveExecutionMs: number }>('bootstrap-run', {
      retries: { limit: 1, delay: '2 seconds' }, timeout: '1 minute',
    }, async () => {
      const machine = await this.bootstrap(payload, store)
      await machine.start()
      await store.putState(machine.snapshot())
      return this.progress(machine.snapshot())
    })
    let progress = workflowBootstrapProgress(bootstrap)
    if (progress.status === 'stopped' || progress.status === 'failed') {
      progress = await step.do<WaveProgress>('reconcile-terminal-workspaces', {
        retries: { limit: 10, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute',
      }, async () => this.cleanupPersistedTerminal(payload.runId, store))
    }
    const sealedWaveStepConfig = waveStepConfig()
    try {
      for (let pollCycle = 0; progress.status === 'running'; pollCycle += 1) {
        const expectedCursor = progress.cursor
        // A healthy long-running process completes this bounded polling slice
        // without advancing the cursor. The next durable step reattaches to the
        // same process; retries here cover only transient transport failures.
        let observationFailed = false
        try {
          progress = await step.do<WaveProgress>(`advance-or-poll-${pollCycle}`, {
            ...sealedWaveStepConfig,
          }, async () => {
            try {
              return await this.runOneWave(payload, expectedCursor, store)
            } catch (error) {
              throw this.workflowStepError(error)
            }
          })
        } catch (error) {
          if (error instanceof NonRetryableError || workflowFailureDisposition(error) === 'fail') throw error
          // Exhausted observation/transport retries do not revoke a durable
          // agent admission. Reload authoritative state in a new step and
          // continue the same cursor after a longer outage backoff.
          observationFailed = true
          try {
            progress = await step.do<WaveProgress>(`recover-wave-state-${pollCycle}`, {
              retries: { limit: 10, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute',
            }, async () => this.progress(await store.getState(payload.runId)))
          } catch (recoveryError) {
            if (recoveryError instanceof NonRetryableError
              || workflowFailureDisposition(recoveryError) === 'fail') throw recoveryError
            // Keep the last authoritative running cursor as unknown. A later
            // polling cycle performs a fresh state read and process lookup.
          }
        }
        const persistedFailure = failureForWorkflowProgress(progress)
        if (persistedFailure !== null) throw persistedFailure
        if (progress.status === 'running' && sameCursor(progress.cursor, expectedCursor)) {
          // Agent execution is unfinished or temporarily unobservable. Its
          // durable admission remains authoritative; back off before another
          // bounded status slice and do not cross a wave/stop boundary.
          try {
            await step.sleep(
              `agent-poll-backoff-${pollCycle}`,
              observationFailed ? '30 seconds' : '15 seconds',
            )
          } catch (error) {
            if (error instanceof NonRetryableError || workflowFailureDisposition(error) === 'fail') throw error
            // A platform fault while suspending or resuming the sleep has no
            // bearing on the admitted process. Continue into a fresh durable
            // observation step instead of ending the Workflow.
          }
          continue
        }
        if (progress.status === 'running') {
          progress = await step.do<WaveProgress>(`stop-boundary-${pollCycle}`, {
            retries: { limit: 2, delay: '1 second', backoff: 'exponential' }, timeout: '1 minute',
          }, async () => this.stopAtBoundary(payload.runId, store))
        }
      }
      const terminalFailure = failureForWorkflowProgress(progress)
      if (terminalFailure !== null) throw terminalFailure
      if (progress.status === 'completed') {
        await step.do('dispose-completed-workspaces', {
          retries: { limit: 10, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute',
        }, async () => {
          const state = await store.getState(payload.runId)
          const release = await store.getRelease(state.releaseDigest)
          const cleanup = await this.cleanupTerminalWorkspaces(release.body.definition, state)
          await store.putCompletedCleanupProof(state, cleanup)
          return { ready: true }
        })
      }
      return progress
    } catch (error) {
      // Cloudflare can surface transient platform failures outside step.do(),
      // for example while suspending or resuming a durable sleep. Those
      // failures have no agent receipt and must leave the admitted run
      // recoverable. Only an explicitly classified permanent failure may
      // terminalize authoritative run state.
      if (error instanceof NonRetryableError || workflowFailureDisposition(error) === 'fail') {
        await step.do('reconcile-terminal-failure-workspaces', {
          retries: { limit: 10, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute',
        }, async () => {
          await this.recordTerminalFailure(payload.runId, store, error)
          return { ready: true }
        })
      }
      throw this.workflowStepError(error)
    }
  }

  private async bootstrap(payload: Readonly<AuditWorkflowPayload>, store: CloudflareRunStore): Promise<RunMachine> {
    if (!runIdPattern.test(payload.runId)) throw new TypeError('run id is invalid')
    if (engineRole(this.env) === 'runtime') {
      if (payload.runtimeRelease === undefined) throw new TypeError('runtime-bound Workflow payload is required')
      assertLocalRuntime(this.env, payload.runtimeRelease)
    }
    if (payload.mode === 'start') {
      if (!digestPattern.test(payload.releaseDigest ?? '')) throw new TypeError('release digest is invalid')
      const release = await store.getRelease(payload.releaseDigest as string)
      if (release.body.definition.id !== payload.experimentId) throw new Error('release experiment mismatch')
      assertReleaseEnvironmentMatchesRuntime(release.body, payload.runtimeRelease)
      const existing = await store.getStateIfPresent(payload.runId)
      if (existing !== null) {
        this.assertBootstrapIdentity(payload, existing, {
          releaseDigest: release.digest,
          rootRunId: payload.runId,
          recoveryEpoch: 0,
          parentRunId: null,
          parentCheckpointDigest: null,
        })
        return RunMachine.fromState(release.body.definition, existing)
      }
      return RunMachine.create(
        release.body.definition, release.digest, payload.runId, new Date().toISOString(), payload.runtimeRelease,
      )
    }
    if (!digestPattern.test(payload.checkpointDigest ?? '')) throw new TypeError('checkpoint digest is invalid')
    const checkpoint = await store.getCheckpoint(payload.checkpointDigest as string)
    const release = await store.getRelease(checkpoint.body.releaseDigest)
    if (release.body.definition.id !== payload.experimentId || checkpoint.body.experimentId !== payload.experimentId) {
      throw new Error('resume experiment mismatch')
    }
    assertReleaseEnvironmentMatchesRuntime(release.body, payload.runtimeRelease)
    const existing = await store.getStateIfPresent(payload.runId)
    if (payload.mode === 'recover-failed-wave') {
      if (payload.failedWaveRecovery === undefined || payload.runtimeRelease === undefined) {
        throw new TypeError('failed-wave recovery identity is required')
      }
      if (existing !== null) {
        this.assertBootstrapIdentity(payload, existing, {
          releaseDigest: release.digest,
          rootRunId: checkpoint.body.rootRunId,
          recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
          parentRunId: payload.failedWaveRecovery.sourceRunId,
          parentCheckpointDigest: checkpoint.digest,
          rootCreatedAt: checkpoint.body.rootCreatedAt,
          modelStartedAt: checkpoint.body.modelStartedAt,
          failedWaveRecovery: payload.failedWaveRecovery,
        })
        return RunMachine.fromState(release.body.definition, existing)
      }
      const source = await store.getState(payload.failedWaveRecovery.sourceRunId)
      const unobservableNative = (source.inFlightAgentAttempts ?? []).length === 0
        ? undefined : await store.fencedUnobservableNativeEvidence(source)
      if (canonicalJson(unobservableNative ?? null)
        !== canonicalJson(payload.failedWaveRecovery.unobservableNative ?? null)) {
        throw new PermanentRunFailure('unobservable recovery fence changed before bootstrap', 'integrity-failed')
      }
      const prepared = await prepareFailedWaveRecovery({
        definition: release.body.definition,
        checkpoint,
        source,
        sourceStateGeneration: payload.failedWaveRecovery.sourceStateGeneration,
        sourceStateDigest: payload.failedWaveRecovery.sourceStateDigest,
        targetRuntimeRelease: payload.runtimeRelease,
        artifacts: new R2ArtifactStore(this.env.ARTIFACTS),
        ...(unobservableNative === undefined ? {} : { unobservableNative }),
        ...(payload.failedWaveRecovery.promotedExecution === undefined ? {} : {
          promoteExecution: {
            taskId: payload.failedWaveRecovery.promotedExecution.taskId,
            sourceAttempt: payload.failedWaveRecovery.promotedExecution.sourceAttempt,
            requestDigest: payload.failedWaveRecovery.promotedExecution.requestDigest,
            ...(payload.failedWaveRecovery.promotedExecution.quarantineOutputDigest === undefined ? {}
              : { quarantineOutputDigest: payload.failedWaveRecovery.promotedExecution.quarantineOutputDigest }),
          },
          executionReceipts: new R2AgentExecutionReceiptStore(this.env.ARTIFACTS),
          executionRequests: new R2AgentExecutionLogStore(this.env.ARTIFACTS),
          ...(payload.failedWaveRecovery.promotedExecution.quarantineOutputDigest === undefined ? {}
            : { quarantined: new R2ArtifactStore(this.env.ARTIFACTS) }),
        }),
        ...(payload.failedWaveRecovery.retainedNative === undefined ? {} : {
          retainNative: {
            taskId: payload.failedWaveRecovery.retainedNative.taskId,
            requestDigest: payload.failedWaveRecovery.retainedNative.nativeTransport.requestDigest,
            snapshotDigest: payload.failedWaveRecovery.retainedNative.nativeTransport.snapshotDigest,
            sandboxObjectId: payload.failedWaveRecovery.retainedNative.sandboxObjectId,
          },
        }),
      })
      if (canonicalJson(prepared.evidence) !== canonicalJson(payload.failedWaveRecovery)) {
        throw new PermanentRunFailure('failed-wave recovery evidence changed before bootstrap', 'integrity-failed')
      }
      return RunMachine.recoverFailedWave(
        release.body.definition,
        checkpoint,
        source,
        payload.runId,
        prepared.importedArtifacts,
        prepared.inheritedRejectedAttempts,
        prepared.evidence,
      )
    }
    if (payload.mode === 'recover-terminal-completion') {
      if (payload.terminalCompletionRecovery === undefined || payload.runtimeRelease === undefined) {
        throw new TypeError('terminal completion recovery identity is required')
      }
      if (existing !== null) {
        this.assertBootstrapIdentity(payload, existing, {
          releaseDigest: release.digest,
          rootRunId: checkpoint.body.rootRunId,
          recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
          parentRunId: payload.terminalCompletionRecovery.sourceRunId,
          parentCheckpointDigest: checkpoint.digest,
          rootCreatedAt: checkpoint.body.rootCreatedAt,
          modelStartedAt: checkpoint.body.modelStartedAt,
          terminalCompletionRecovery: payload.terminalCompletionRecovery,
        })
        return RunMachine.fromState(release.body.definition, existing)
      }
      const source = await store.getState(payload.terminalCompletionRecovery.sourceRunId)
      const evidence = await prepareTerminalCompletionRecovery({
        definition: release.body.definition,
        checkpoint,
        source,
        sourceStateGeneration: payload.terminalCompletionRecovery.sourceStateGeneration,
        sourceStateDigest: payload.terminalCompletionRecovery.sourceStateDigest,
        targetRuntimeRelease: payload.runtimeRelease,
      })
      if (canonicalJson(evidence) !== canonicalJson(payload.terminalCompletionRecovery)) {
        throw new PermanentRunFailure('terminal completion recovery evidence changed before bootstrap', 'integrity-failed')
      }
      return RunMachine.recoverTerminalCompletion(
        release.body.definition, checkpoint, source, payload.runId, evidence,
      )
    }
    let transitionSource: RunState | undefined
    let preparedResume: RunMachine | undefined
    if (payload.runtimeTransition !== undefined) {
      if (payload.mode !== 'resume' || payload.timeAmendment !== undefined || payload.revalidation !== undefined) {
        throw new PermanentRunFailure('runtime transition cannot amend time or revalidate output', 'integrity-failed')
      }
      transitionSource = await store.getState(payload.runtimeTransition.sourceRunId)
      preparedResume = await RunMachine.resume(release.body.definition, checkpoint, payload.runId,
        new Set(), new Date().toISOString(), undefined, payload.runtimeRelease, payload.runtimeTransition, transitionSource)
    }
    if (existing !== null) {
      this.assertBootstrapIdentity(payload, existing, {
          releaseDigest: release.digest,
          rootRunId: checkpoint.body.rootRunId,
          recoveryEpoch: checkpoint.body.recoveryEpoch + 1,
        parentRunId: checkpoint.body.runId,
        parentCheckpointDigest: checkpoint.digest,
        rootCreatedAt: checkpoint.body.rootCreatedAt,
        modelStartedAt: payload.timeAmendment?.amendedModelStartedAt ?? checkpoint.body.modelStartedAt,
        failedWaveRecovery: checkpoint.body.failedWaveRecovery,
        terminalCompletionRecovery: checkpoint.body.terminalCompletionRecovery,
        runtimeTransition: payload.runtimeTransition ?? checkpoint.body.runtimeTransition,
      })
      return RunMachine.fromState(release.body.definition, existing)
    }
    return preparedResume ?? RunMachine.resume(
      release.body.definition,
      checkpoint,
      payload.runId,
      new Set(),
      new Date().toISOString(),
      payload.timeAmendment,
      payload.runtimeRelease,
      payload.runtimeTransition,
      transitionSource ?? undefined,
    )
  }

  private assertBootstrapIdentity(
    payload: Readonly<AuditWorkflowPayload>,
    state: RunState,
    expected: Readonly<Pick<RunState,
      'releaseDigest' | 'rootRunId' | 'recoveryEpoch' | 'parentRunId' | 'parentCheckpointDigest'>
      & {
        rootCreatedAt?: RunState['rootCreatedAt']
        modelStartedAt?: RunState['modelStartedAt']
        failedWaveRecovery?: RunState['failedWaveRecovery']
        terminalCompletionRecovery?: RunState['terminalCompletionRecovery']
        runtimeTransition?: RunState['runtimeTransition']
      }>,
  ): void {
    const runtimeMatches = state.runtimeRelease === undefined && payload.runtimeRelease === undefined
      || state.runtimeRelease !== undefined && payload.runtimeRelease !== undefined
        && sameRuntimeRelease(state.runtimeRelease, payload.runtimeRelease)
    const recordedAmendment = state.journal.find(event => event.type === 'run.time-amended')?.payload ?? null
    const requestedAmendment = payload.mode === 'resume' ? payload.timeAmendment ?? null : null
    if (state.runId !== payload.runId || state.experimentId !== payload.experimentId
      || state.releaseDigest !== expected.releaseDigest || state.rootRunId !== expected.rootRunId
      || state.recoveryEpoch !== expected.recoveryEpoch || state.parentRunId !== expected.parentRunId
      || state.parentCheckpointDigest !== expected.parentCheckpointDigest || !runtimeMatches
      || canonicalJson(state.failedWaveRecovery ?? null) !== canonicalJson(expected.failedWaveRecovery ?? null)
      || canonicalJson(state.terminalCompletionRecovery ?? null)
        !== canonicalJson(expected.terminalCompletionRecovery ?? null)
      || canonicalJson(state.runtimeTransition ?? null) !== canonicalJson(expected.runtimeTransition ?? null)
      || (expected.rootCreatedAt !== undefined && state.rootCreatedAt !== expected.rootCreatedAt)
      || (expected.modelStartedAt !== undefined && state.modelStartedAt !== expected.modelStartedAt)) {
      throw new PermanentRunFailure('persisted bootstrap state differs from the requested run identity', 'integrity-failed')
    }
    if (canonicalJson(recordedAmendment) !== canonicalJson(requestedAmendment)) {
      throw new PermanentRunFailure('persisted bootstrap amendment differs from the requested resume', 'integrity-failed')
    }
  }

  private async runOneWave(payload: Readonly<AuditWorkflowPayload>, expectedCursor: RunCursor, store: CloudflareRunStore): Promise<WaveProgress> {
    if (payload.runtimeRelease !== undefined) assertLocalRuntime(this.env, payload.runtimeRelease)
    const state = await store.getState(payload.runId)
    if (state.runtimeRelease !== undefined && payload.runtimeRelease !== undefined
      && !sameRuntimeRelease(state.runtimeRelease, payload.runtimeRelease)) {
      throw new PermanentRunFailure('run runtime release differs from its Workflow destination', 'integrity-failed')
    }
    if (state.status === 'failed') {
      await this.cleanupPersistedTerminal(payload.runId, store)
      throw new PermanentRunFailure(state.terminalReason ?? 'audit run failed without a recorded reason', 'persisted-run-failed')
    }
    if (state.status !== 'running' || !sameCursor(state.cursor, expectedCursor)) return this.progress(state)
    const release = await store.getRelease(state.releaseDigest)
    const machine = await RunMachine.fromState(release.body.definition, state)
    const provider = new QuarantinedRevalidationProvider(
      new PromotedExecutionProvider(
        new SandboxAgentProvider(this.env),
        new R2AgentExecutionReceiptStore(this.env.ARTIFACTS),
        new R2AgentExecutionLogStore(this.env.ARTIFACTS),
        payload.failedWaveRecovery?.promotedExecution,
      ),
      new R2ArtifactStore(this.env.ARTIFACTS),
      payload.revalidation,
      payload.timeAmendment !== undefined,
    )
    const pendingCheckpoints: SealedCheckpoint[] = []
    let checkpointsPublished = false
    try {
      await advanceExperimentOneWave({
        definition: release.body.definition, machine,
        provider,
        artifactStore: new R2ArtifactStore(this.env.ARTIFACTS),
        policy: audit0RunPolicy,
        onWaveAdmission: state => store.putState(state),
        stopRequested: () => store.stopRequested(payload.runId),
        onCheckpoint: async checkpoint => { pendingCheckpoints.push(checkpoint) },
      })
      if (machine.snapshot().cursor.stageIndex >= release.body.definition.stages.length) {
        const issues = audit0RunPolicy.assessCompletion({ definition: release.body.definition, state: machine.snapshot() })
        if (issues.length > 0) {
          throw new PermanentRunFailure(`completion contract failed: ${issues.join('; ')}`, 'completion-contract-failed')
        }
        await machine.complete()
      }
      const stopRequested = release.body.definition.stages[machine.snapshot().cursor.stageIndex]?.kind === 'discovery'
        && canStopAtSealedWaveBoundary(machine.snapshot(), true)
        && await store.stopRequested(payload.runId)
      // Independent cohorts drain at unequal local wave counters. Preserve that
      // portable frontier before stopping rather than reverting resume to preflight.
      if (stopRequested) pendingCheckpoints.push(await machine.seal())
      for (const checkpoint of pendingCheckpoints) await store.putCheckpoint(checkpoint)
      checkpointsPublished = true
      if (stopRequested) await machine.stop('operator-requested-stop-at-sealed-wave-boundary')
      const next = machine.snapshot()
      await store.putState(next)
      if (next.status === 'stopped') await this.cleanupTerminalWorkspaces(release.body.definition, next)
      return this.progress(next)
    } catch (error) {
      // A sealed cursor becomes authoritative only after every checkpoint and
      // runtime route for that transition is durable. Completed executions are
      // recovered from their exact receipts when the previous state replays.
      if (pendingCheckpoints.length > 0 && !checkpointsPublished) throw error
      // Save paid attempts, validation diagnostics, and the last sealed boundary before
      // the Workflow retry or terminal-failure path reconstructs this run.
      if (isPermanentRunFailure(error) && machine.snapshot().status === 'running') {
        await machine.fail(error.message)
      }
      const terminal = machine.snapshot()
      await store.putState(terminal)
      if (terminal.status === 'failed' || terminal.status === 'stopped') {
        await this.cleanupTerminalWorkspaces(release.body.definition, terminal)
      }
      throw error
    }
  }

  private async recordTerminalFailure(runId: string, store: CloudflareRunStore, error: unknown): Promise<void> {
    try {
      const state = await store.getState(runId)
      if (state.status !== 'running') {
        if (state.status === 'failed' || state.status === 'stopped') {
          await this.cleanupPersistedTerminal(runId, store)
        }
        return
      }
      const release = await store.getRelease(state.releaseDigest)
      const machine = await RunMachine.fromState(release.body.definition, state)
      await machine.fail(error instanceof Error ? error.message : String(error))
      const failed = machine.snapshot()
      await store.putState(failed)
      await this.cleanupTerminalWorkspaces(release.body.definition, failed)
    } catch (cleanupError) {
      // Preserve the original Workflow failure, but never silently present a
      // failed run as having released its native compute.
      console.error(canonicalJson({ schemaVersion: 1, kind: 'terminal-workspace-cleanup-failed',
        runId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }))
      throw new AggregateError([error, cleanupError], 'terminal failure and cleanup both failed')
    }
  }

  private async stopAtBoundary(runId: string, store: CloudflareRunStore): Promise<WaveProgress> {
    const state = await store.getState(runId)
    if (state.status === 'stopped' || state.status === 'failed') {
      return this.cleanupPersistedTerminal(runId, store)
    }
    if (!canStopAtSealedWaveBoundary(state, await store.stopRequested(runId))) {
      return this.progress(state)
    }
    const release = await store.getRelease(state.releaseDigest)
    const machine = await RunMachine.fromState(release.body.definition, state)
    await machine.stop('operator-requested-stop-at-sealed-wave-boundary')
    const stopped = machine.snapshot()
    await store.putState(stopped)
    await this.cleanupTerminalWorkspaces(release.body.definition, stopped)
    return this.progress(stopped)
  }

  private async cleanupTerminalWorkspaces(
    definition: ReleasePackageBody['definition'],
    state: RunState,
  ): Promise<Awaited<ReturnType<typeof disposeTerminalWorkspaces>>> {
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const cleanup = await disposeTerminalWorkspaces(new SandboxAgentProvider(this.env), definition, state,
      { forceOwnedWorkspaces: state.status === 'failed' || state.status === 'stopped',
        workspaceAllocationForOwner: async workspaceKey => {
          const imported = state.failedWaveRecovery?.retainedNative?.workspaceKey === workspaceKey
            ? state.failedWaveRecovery.retainedNative.workspaceAllocationRunId : null
          const allocationRunId = imported ?? state.runId
          const claim = await store.retainedNativeWorkspaceClaim(allocationRunId, workspaceKey)
          return claim !== null && claim.childRunId !== state.runId ? null
            : imported !== null && claim?.childRunId !== state.runId ? null : allocationRunId
        } })
    console.log(canonicalJson({
      schemaVersion: 1,
      kind: 'terminal-workspace-cleanup',
      runId: state.runId,
      status: state.status,
      ...cleanup,
    }))
    if ('deferred' in cleanup && cleanup.deferred.length > 0) {
      throw new TransientRunFailure(`terminal workspace cleanup is deferred for ${cleanup.deferred.length} lane(s)`)
    }
    if (state.status === 'completed'
      && (cleanup.activeWorkspaceKeys.length > 0 || cleanup.retainedWorkspaceKeys.length > 0)) {
      throw new TransientRunFailure('completed workspace cleanup retains active or recoverable work')
    }
    return cleanup
  }

  private async cleanupPersistedTerminal(runId: string, store: CloudflareRunStore): Promise<WaveProgress> {
    const state = await store.getState(runId)
    if (state.status !== 'stopped' && state.status !== 'failed') return this.progress(state)
    const release = await store.getRelease(state.releaseDigest)
    await this.cleanupTerminalWorkspaces(release.body.definition, state)
    return this.progress(state)
  }

  private progress(state: RunState): WaveProgress {
    return workflowProgress(state)
  }

  private workflowStepError(error: unknown): Error {
    if (error instanceof NonRetryableError) return error
    if (workflowFailureDisposition(error) === 'fail' && isPermanentRunFailure(error)) {
      return new NonRetryableError(error.message, error.category)
    }
    return error instanceof Error ? error : new Error(String(error))
  }
}

async function forwardCoordinator(request: Request, env: Env, experimentId: string, action: string): Promise<Response> {
  const stub = env.COORDINATORS.get(env.COORDINATORS.idFromName(experimentId), placement(env))
  const headers = new Headers(request.headers)
  headers.set('x-ack3-experiment', experimentId)
  return stub.fetch(new Request(`https://coordinator.internal/${action}`, { method: request.method, headers, body: request.body }))
}

async function boundedFrontDoorStop(operation: Promise<Response>, ctx: ExecutionContext,
  runId: string, deadlineAt: number): Promise<Response> {
  ctx.waitUntil(operation.catch(error => {
    console.error(canonicalJson({ schemaVersion: 1, kind: 'frontdoor-stop-failed', runId,
      error: error instanceof Error ? error.message : String(error) }))
  }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<Response>(resolve => {
      timer = setTimeout(() => resolve(json({ runId, stop: 'deadline-missed',
        deadlineMet: false, physicalZeroVerified: false }, 503)), Math.max(0, deadlineAt - Date.now()))
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function dashboardWorkflowStatus(runId: string, state: RunState, env: Env): Promise<unknown> {
  if (engineRole(env) !== 'front-door') return (await env.AUDIT_WORKFLOW.get(runId)).status()
  const retired = await new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
    .retiredRunWorkflow(runId)
  if (retired !== null) return retired.workflow
  const router = new RuntimeRouter(env)
  const runtimeRelease = pinnedRuntime(state.runtimeRelease)
  const response = await router.fetch(runtimeRelease, `/internal/runtime/audit-runs/${runId}`)
  const body = await runtimeResponseBody(response)
  return body.workflow ?? null
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const internal = await runtimeServiceRoute(request, env, ctx)
    if (internal !== null) return internal
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'swarm', role: engineRole(env), workerVersionId: env.VERSION_METADATA?.id ?? null })
    }
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      if (!await dashboardAccessAllowed(request, undefined, env)) return json({ error: 'unauthorized' }, 401)
      const dashboardRequest = monitoringRequestFromDashboard(request)
      if (dashboardRequest !== null) {
        const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
        return await monitoringRoute(dashboardRequest, store, env.ARTIFACTS, env.INDEX,
          new R2ArtifactStore(env.ARTIFACTS), env.PACKAGES,
          (runId, state) => dashboardWorkflowStatus(runId, state, env))
      }
    }
    if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      const nonce = crypto.randomUUID().replaceAll('-', '')
      return new Response(dashboardHtml.replaceAll('__CSP_NONCE__', nonce), { headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      } })
    }
    if (!await authorized(request, env.CONTROL_API_TOKEN)) return json({ error: 'unauthorized' }, 401)
    const authenticatedAt = Date.now()
    const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
    try {
      if (engineRole(env) === 'front-door' && request.method === 'POST'
        && url.pathname === '/v1/runtime-slots/rotations') {
        const body = await request.json<{ intent?: string }>()
        return json(await store.lockOldestIdleRuntimeSlot(body.intent ?? ''), 201)
      }
      const rotationReadMatch = url.pathname.match(
        /^\/v1\/runtime-slots\/rotations\/([0-9a-f-]{36})$/i,
      )
      if (engineRole(env) === 'front-door' && request.method === 'GET'
        && rotationReadMatch !== null) {
        const current = await store.inspectRuntimeSlotRotation(rotationReadMatch[1]!)
        return current === null ? json({ error: 'rotation intent is unknown' }, 404)
          : json(current)
      }
      const rotationMatch = url.pathname.match(
        /^\/v1\/runtime-slots\/rotations\/([0-9a-f-]{36})\/activate$/i,
      )
      if (engineRole(env) === 'front-door' && request.method === 'POST'
        && rotationMatch !== null) {
        const body = await request.json<{
          expectedGeneration?: number, prior?: RuntimeRelease, expectedCommit?: string,
          expectedImage?: string
        }>()
        if (body.prior === undefined || body.expectedCommit === undefined
          || body.expectedGeneration === undefined) {
          return json({ error: 'exact prior release, generation and commit are required' }, 400)
        }
        const observed = await new RuntimeRouter(env).probeSlot(body.prior.id)
        return json(await store.activateRotatedRuntimeSlot(rotationMatch[1]!,
          body.expectedGeneration, body.prior, observed, body.expectedCommit,
          body.expectedImage))
      }
      const rotationCancelMatch = url.pathname.match(
        /^\/v1\/runtime-slots\/rotations\/([0-9a-f-]{36})\/cancel-unpublished$/i,
      )
      if (engineRole(env) === 'front-door' && request.method === 'POST'
        && rotationCancelMatch !== null) {
        const body = await request.json<{
          expectedGeneration?: number, prior?: RuntimeRelease,
          ownerProof?: 'upload-not-attempted'
        }>()
        if (body.prior === undefined || body.expectedGeneration === undefined
          || body.ownerProof !== 'upload-not-attempted') {
          return json({ error: 'exact prior identity and no-upload owner proof are required' }, 400)
        }
        const observed = await new RuntimeRouter(env).probeSlot(body.prior.id)
        return json(await store.cancelUnpublishedRuntimeSlot(rotationCancelMatch[1]!,
          body.expectedGeneration, body.prior, observed))
      }
      const slotIdentityMatch = url.pathname.match(
        /^\/v1\/runtime-slots\/([a-z0-9][a-z0-9-]{2,62})\/identity$/,
      )
      if (request.method === 'GET' && slotIdentityMatch !== null
        && engineRole(env) === 'front-door') {
        return json(await new RuntimeRouter(env).probeSlot(slotIdentityMatch[1]!))
      }
      if (url.pathname.startsWith('/v1/monitor/')) {
        return await monitoringRoute(request, store, env.ARTIFACTS, env.INDEX,
          new R2ArtifactStore(env.ARTIFACTS), env.PACKAGES,
          (runId, state) => dashboardWorkflowStatus(runId, state, env))
      }
      if (request.method === 'POST' && url.pathname === '/v1/releases') {
        const release = await store.putRelease(await request.json<ReleasePackageBody>())
        return json({ digest: release.digest, experimentId: release.body.definition.id }, 201)
      }
      if (request.method === 'POST' && url.pathname === '/v1/readiness/container') {
        if (engineRole(env) === 'front-door') {
          const runtimeRelease = await new RuntimeRouter(env).latest()
          return await new RuntimeRouter(env).fetch(runtimeRelease, '/internal/runtime/readiness', { method: 'POST' })
        }
        const probeId = `readiness-${crypto.randomUUID().replaceAll('-', '')}`
        const sandbox = getSandbox(env.Sandbox, probeId, {
          sleepAfter: '1m', enableDefaultSession: false, normalizeId: true, transport: 'rpc',
          labels: { purpose: 'readiness', probe: probeId },
        })
        let disposed = false
        try {
          const result = await sandbox.exec(containerReadinessCommand, { timeout: 120_000 })
          await sandbox.destroy()
          disposed = true
          return json({
            probeId,
            success: result.success,
            exitCode: result.exitCode,
            stdout: result.stdout.slice(-4_000),
            stderr: result.stderr.slice(-4_000),
            disposed,
          }, result.success ? 200 : 503)
        } finally {
          if (!disposed) await sandbox.destroy().catch(() => {})
        }
      }
      const sourceTree = url.pathname.match(/^\/v1\/sources\/([0-9a-f]{40})$/)?.[1]
      if (request.method === 'PUT' && sourceTree !== undefined) {
        const archiveSha256 = request.headers.get('x-ack3-archive-sha256') ?? ''
        const gitCommit = request.headers.get('x-ack3-git-commit') ?? ''
        if (!digestPattern.test(archiveSha256) || !/^[0-9a-f]{40}$/.test(gitCommit) || request.body === null) {
          return json({ error: 'valid archive digest, pinned commit, and body are required' }, 400)
        }
        if (request.headers.get('x-ack3-source-package-version') !== '2') {
          return json({ error: 'source package version 2 is required' }, 400)
        }
        const result = await storeSourceArchive(env.PACKAGES, {
          tree: sourceTree, commit: gitCommit, archiveSha256, body: request.body,
        })
        return json(result.body, result.status)
      }
      const experimentId = experimentFrom(url.pathname)
      if (experimentId !== null) return forwardCoordinator(request, env, experimentId, url.pathname.split('/').at(-1) ?? '')
      if (request.method === 'POST' && url.pathname === '/v1/runtime-fixtures') {
        if (engineRole(env) !== 'front-door') return json({ error: 'runtime fixture routing requires the front door' }, 409)
        const body = await request.json<{
          fixtureId?: string
          holdSeconds?: number
          runtimeId?: string
          parentCheckpointDigest?: string
          idleSurvival?: true
        }>()
        if (!runIdPattern.test(body.fixtureId ?? '') || !Number.isSafeInteger(body.holdSeconds)
          || (body.holdSeconds ?? 0) < 1 || (body.holdSeconds ?? 0) > 3_600
          || (body.parentCheckpointDigest !== undefined
            && !digestPattern.test(body.parentCheckpointDigest))
          || (body.idleSurvival !== undefined && body.idleSurvival !== true)) {
          return json({ error: 'valid fixtureId, holdSeconds, and optional parentCheckpointDigest are required' }, 400)
        }
        if (await store.retiredUnmaterializedRoute(body.fixtureId!) !== null) {
          return json({ error: 'runtime fixture identity is retired' }, 410)
        }
        const router = new RuntimeRouter(env)
        let runtimeRelease: RuntimeRelease
        if (body.parentCheckpointDigest !== undefined) {
          const parentRuntime = await store.checkpointRuntime(body.parentCheckpointDigest)
          if (parentRuntime === null) return json({ error: 'fixture parent checkpoint route is missing' }, 409)
          runtimeRelease = parentRuntime
        } else {
          runtimeRelease = await resolveRuntimeSelector(
            body.runtimeId === undefined || body.runtimeId === 'latest'
              ? { mode: 'latest' }
              : { mode: 'release', id: body.runtimeId },
            router,
          )
        }
        await store.reserveRunRoute(body.fixtureId!, 'runtime-isolation', runtimeRelease)
        const response = await router.fetch(runtimeRelease, '/internal/runtime/fixtures', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
            fixtureId: body.fixtureId,
            holdSeconds: body.holdSeconds,
            runtimeRelease,
            ...(body.idleSurvival === true ? { idleSurvival: true as const } : {}),
            ...(body.parentCheckpointDigest === undefined
              ? {} : { parentCheckpointDigest: body.parentCheckpointDigest }),
          }),
        })
        return response
      }
      const fixtureMatch = url.pathname.match(/^\/v1\/runtime-fixtures\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
      const terminalFixtureRetire = url.pathname.match(
        /^\/v1\/runtime-fixtures\/([a-z0-9][a-z0-9._-]{0,99})\/retire-terminal$/,
      )?.[1]
      if (request.method === 'POST' && terminalFixtureRetire !== undefined) {
        if (engineRole(env) !== 'front-door') return json({ error: 'fixture retirement requires the front door' }, 409)
        const proof: unknown = await request.json()
        return json(await retireTerminalFixture({ fixtureId: terminalFixtureRetire,
          proof, now: Date.now(), store,
          liveFixture: async (runtimeRelease, fixtureId) => {
            const live = await new RuntimeRouter(env).fetch(runtimeRelease,
              `/internal/runtime/fixtures/${fixtureId}`)
            if (!live.ok) throw new Error('native fixture status is unavailable')
            return live.json<{ fixtureId: string, workflow: unknown }>()
          },
        }))
      }
      if (request.method === 'GET' && fixtureMatch !== undefined) {
        if (engineRole(env) !== 'front-door') return json({ error: 'runtime fixture routing requires the front door' }, 409)
        const retired = await store.retiredUnmaterializedRoute(fixtureMatch)
        if (retired !== null) return json({ errorCode: 'historical-execution-unavailable',
          fixtureId: fixtureMatch, experimentId: retired.experimentId,
          runtimeRelease: retired.runtimeRelease, retirement: {
            auditWorkflowStatus: retired.auditWorkflowStatus,
            isolationWorkflowStatus: retired.isolationWorkflowStatus,
            proofDigest: retired.proofDigest, observedAt: retired.retiredAt,
          } }, 410)
        const router = new RuntimeRouter(env)
        const runtimeRelease = await store.runRuntime(fixtureMatch)
        if (runtimeRelease === null) return json({ error: 'runtime fixture route is missing' }, 404)
        return router.fetch(runtimeRelease, `/internal/runtime/fixtures/${fixtureMatch}`)
      }
      const diagnosticMatch = url.pathname.match(
        /^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})\/lanes\/([A-Za-z0-9._-]{1,120})\/last-result$/,
      )
      if (request.method === 'GET' && diagnosticMatch !== null) {
        const [, runId, workspaceKey] = diagnosticMatch
        if (engineRole(env) === 'front-door') {
          if (await store.retiredRunWorkflow(runId!) !== null) {
            const diagnostic = await durableLaneDiagnostic(runId!, workspaceKey!, env)
            return diagnostic === null
              ? json({ error: 'durable lane receipt is unavailable', runId, workspaceKey }, 404)
              : json({ runId, workspaceKey, ...diagnostic })
          }
          const router = new RuntimeRouter(env)
          const runtimeRelease = pinnedRuntime(await store.runRuntime(runId!))
          return router.fetch(
            runtimeRelease,
            `/internal/runtime/audit-runs/${runId}/lanes/${workspaceKey}/last-result`,
          )
        }
        const diagnostic = await durableLaneDiagnostic(runId!, workspaceKey!, env)
        return diagnostic === null
          ? json({ error: 'durable lane receipt is unavailable', runId, workspaceKey }, 404)
          : json({ runId, workspaceKey, ...diagnostic })
      }
      const runMatch = url.pathname.match(/^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})$/)?.[1]
      const stoppedRetireMatch = url.pathname.match(
        /^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})\/retire-sealed-stopped$/,
      )?.[1]
      const failedRetireMatch = url.pathname.match(
        /^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})\/retire-terminal-failed$/,
      )?.[1]
      if (request.method === 'POST' && failedRetireMatch !== undefined) {
        if (engineRole(env) !== 'front-door') return json({ error: 'failed retirement requires the front door' }, 409)
        const proof: unknown = await request.json()
        return json(await retireFailedRun({ runId: failedRetireMatch,
          proof, now: Date.now(), store,
          liveRun: async (runtimeRelease, runId) => {
            const response = await new RuntimeRouter(env).fetch(runtimeRelease,
              `/internal/runtime/audit-runs/${runId}`)
            if (!response.ok) throw new Error('native failed run is unavailable')
            return response.json<{ state: unknown, workflow: unknown }>()
          },
        }))
      }
      if (request.method === 'POST' && stoppedRetireMatch !== undefined) {
        if (engineRole(env) !== 'front-door') return json({ error: 'stopped retirement requires the front door' }, 409)
        const proof: unknown = await request.json()
        return json(await retireStoppedRun({ runId: stoppedRetireMatch,
          proof, now: Date.now(), store,
          liveRun: async (runtimeRelease, runId) => {
            const response = await new RuntimeRouter(env).fetch(runtimeRelease,
              `/internal/runtime/audit-runs/${runId}`)
            if (!response.ok) throw new Error('native stopped run is unavailable')
            return response.json<{ state: unknown, workflow: unknown }>()
          },
        }))
      }
      if (request.method === 'GET' && runMatch !== undefined) {
        if (engineRole(env) === 'front-door') {
          const unmaterialized = await store.retiredUnmaterializedRoute(runMatch)
          if (unmaterialized !== null) return json({ errorCode: 'historical-execution-unavailable',
            runId: runMatch, experimentId: unmaterialized.experimentId,
            runtimeRelease: unmaterialized.runtimeRelease, retirement: {
              auditWorkflowStatus: unmaterialized.auditWorkflowStatus,
              isolationWorkflowStatus: unmaterialized.isolationWorkflowStatus,
              proofDigest: unmaterialized.proofDigest, observedAt: unmaterialized.retiredAt,
            } }, 410)
          const retiredWorkflow = await store.retiredRunWorkflow(runMatch)
          if (retiredWorkflow !== null) {
            const state = await store.getState(runMatch)
            if (retiredWorkflow.disposition === 'terminal'
              && retiredWorkflow.cleanupProofDigest !== null) {
              await store.archiveCompletedRunAndReleaseLease(runMatch, retiredWorkflow.workflow)
            }
            return json({ state, workflow: retiredWorkflow.workflow,
              retirement: { disposition: retiredWorkflow.disposition,
                fenceProofDigest: retiredWorkflow.fenceProofDigest,
                cleanupProofDigest: retiredWorkflow.cleanupProofDigest,
                retiredAt: retiredWorkflow.retiredAt },
              runtimeRelease: state.runtimeRelease ?? null })
          }
          const router = new RuntimeRouter(env)
          const runtimeRelease = pinnedRuntime(await store.runRuntime(runMatch))
          const response = await router.fetch(
            runtimeRelease, `/internal/runtime/audit-runs/${runMatch}`,
          )
          const body = await runtimeResponseBody(response)
          if ((body.workflow as { status?: string } | undefined)?.status === 'complete'
            && (body.state as RunState | undefined)?.status === 'completed') {
            const persisted = await store.getState(runMatch)
            if (persisted.status === 'completed'
              && await store.hasCompletedCleanupProof(persisted)) {
              await store.archiveCompletedRunAndReleaseLease(runMatch, body.workflow)
            }
          }
          return json({ ...body, runtimeRelease })
        }
        const state = await store.getState(runMatch)
        const workflow = await env.AUDIT_WORKFLOW.get(runMatch)
        return json({ state, workflow: await workflow.status() })
      }
      const stopMatch = url.pathname.match(/^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})\/stop$/)?.[1]
      if (request.method === 'POST' && stopMatch !== undefined) {
        if (engineRole(env) === 'front-door') {
          const deadlineAt = authenticatedAt + 5_000
          const operation = (async () => {
            if (await store.retiredRunWorkflow(stopMatch) !== null
              || await store.retiredUnmaterializedRoute(stopMatch) !== null) {
              return json({ error: 'retired terminal run cannot be stopped' }, 409)
            }
            const router = new RuntimeRouter(env)
            const runtimeRelease = pinnedRuntime(await store.runRuntime(stopMatch))
            return router.fetch(runtimeRelease,
              `/internal/runtime/audit-runs/${stopMatch}/stop-now`, { method: 'POST',
                headers: { 'x-ack3-stop-deadline-at': String(deadlineAt) } })
          })()
          return await boundedFrontDoorStop(operation, ctx, stopMatch, deadlineAt)
        }
        await store.requestStop(stopMatch)
        return json({ runId: stopMatch, stop: 'requested-at-next-sealed-wave-boundary' }, 202)
      }
      const immediateStopMatch = url.pathname.match(/^\/v1\/runs\/([a-z0-9][a-z0-9._-]{0,99})\/stop-now$/)?.[1]
      if (request.method === 'POST' && immediateStopMatch !== undefined) {
        if (engineRole(env) !== 'front-door') return json({ error: 'front-door route required' }, 409)
        const deadlineAt = authenticatedAt + 5_000
        const operation = (async () => {
          if (await store.retiredRunWorkflow(immediateStopMatch) !== null
            || await store.retiredUnmaterializedRoute(immediateStopMatch) !== null) {
            return json({ error: 'retired run cannot be stopped again' }, 409)
          }
          const router = new RuntimeRouter(env)
          const runtimeRelease = pinnedRuntime(await store.runRuntime(immediateStopMatch))
          return router.fetch(runtimeRelease,
            `/internal/runtime/audit-runs/${immediateStopMatch}/stop-now`, { method: 'POST',
              headers: { 'x-ack3-stop-deadline-at': String(deadlineAt) } })
        })()
        return await boundedFrontDoorStop(operation, ctx, immediateStopMatch, deadlineAt)
      }
      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  },
} satisfies ExportedHandler<Env>
