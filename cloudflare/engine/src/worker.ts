import { RunCommandConflict } from './run-commands.js'
import { dispatchAuditWorkflow, reconcileAuditStartup } from './execution-workflow.js'
import { requestSavedWorkExport } from './source-export.js'
import { observeExpiredFixture } from './fixture-native-observation.js'
import { assertCompletedRunDelivery, deliverCompletedRun, registerCompletedRunDelivery } from './completed-run-delivery.js'
import type { CoordinatorDeliveryMarker, LaunchDeliveryMarker } from './run-control-delivery.js'
import { verifiedCleanupWorkspaces } from './command-custody.js'
import { RunControlDelivery, registerDelivery } from './run-control-delivery.js'
import { deliverRunControl, settleCancelledExecution, settleControlledFailure, assertExecutionOwner } from './run-control-executor.js'
import { bootstrapExecution } from './root-execution.js'
import { CommandCustodyCollector } from './command-custody.js'
import { runControlResponse } from './run-control-api.js'
import { RunCommandJournal } from './run-command-journal.js'
import { hasPendingNativeControl, reconcileRunControls, settleTerminalControlsAndDispose } from './run-control-reconcile.js'
import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import { getAgentSandbox } from './agent-sandbox-client.js'
import { resolveTargetEnvironment } from './target-environment.js'
import { assertReleaseEnvironmentMatchesRuntime } from './environment-image.js'
import type { AuditWorkflowPayload, Env } from './env.js'
import type {
  ReleasePackageBody,
  RunCursor, RunState, RuntimeRelease, SealedCheckpoint,
} from './contracts.js'
import { CloudflareRunStore, R2ArtifactStore, stateWriter } from './cloudflare-storage.js'
import { canonicalJson, sha256 } from './canonical.js'
import { containerReadinessCommand } from './container-readiness.js'
import { RunMachine } from './machine.js'
import { SandboxAgentProvider } from './sandbox-provider.js'
import { advanceExperimentOneWave, audit0RunPolicy, disposeTerminalWorkspaces } from './runner.js'
import dashboardHtml from './dashboard.html'
import { monitoringRoute } from './dashboard-api.js'
import { dashboardAccessAllowed, monitoringRequestFromDashboard } from './dashboard-access.js'
import { storeSourceArchive } from './source-provenance.js'
import { isPermanentRunFailure, PermanentRunFailure, TransientRunFailure } from './run-errors.js'
import {
  failureForWorkflowProgress,
  type WaveProgress,
  workflowFailureDisposition,
  workflowProgress,
} from './workflow-outcome.js'
import { waveStepConfig } from './workflow-step-config.js'
import {
  pinnedRuntime, resolveRuntimeSelector, RuntimeRouter, sameRuntimeRelease, type RuntimeSelector,
} from './runtime-release.js'
import { assertLocalRuntime, engineRole, runtimeServiceRoute } from './runtime-service.js'
import { placement } from './placement.js'
import { durableLaneDiagnostic } from './lane-diagnostics.js'
import { retireTerminalFixture } from './terminal-fixture-retirement.js'
import { validateNewSearchAdmission } from './validation.js'

export { AgentSandbox, Sandbox } from './agent-sandbox.js'
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
  const value = pathname.match(/^\/v1\/experiments\/([a-z0-9][a-z0-9._-]{0,99})\/(?:release|activate|runs)$/)?.[1]
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

type RunReservationProvenance = Readonly<{ mode: 'start', releaseDigest: string, runtimeRelease?: RuntimeRelease }>

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
  dispatchRefusedReason?: string
}

async function runtimeResponseBody(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`runtime release returned an invalid response: ${response.status}`)
  }
  if (!response.ok) throw new Error(`runtime release request failed: ${String((value as Record<string, unknown>).error ?? response.status)}`)
  return value as Record<string, unknown>
}

export class ExperimentCoordinator extends DurableObject<Env> {
  async alarm(): Promise<void> {
    await new RunControlDelivery<CoordinatorDeliveryMarker>(this.ctx.storage).alarm(marker =>
      'kind' in marker && marker.kind === 'launch' ? this.deliverLaunch(marker)
        : 'kind' in marker && marker.kind === 'completed' ? deliverCompletedRun(marker, this.env) : deliverRunControl(marker, this.env))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const experimentId = request.headers.get('x-ack3-experiment') ?? ''
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(experimentId)) return json({ error: 'invalid experiment id' }, 400)
    try {
      const controls = url.pathname.match(/^\/audits\/([a-z0-9][a-z0-9._-]{0,99})\/commands(?:\/([a-z0-9][a-z0-9._-]{0,99}))?$/)
      if (controls !== null) return await runControlResponse(request,
        new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX),
        this.env.INDEX, experimentId, controls[1]!, controls[2],
        marker => new RunControlDelivery(this.ctx.storage).register(marker),
        command => requestSavedWorkExport(this.env, command))
      if (request.method === 'POST' && url.pathname === '/completed-executions') {
        const marker: unknown = await request.json()
        assertCompletedRunDelivery(marker)
        if (engineRole(this.env) !== 'runtime' || marker.experimentId !== experimentId) throw new Error('completed delivery destination differs')
        assertLocalRuntime(this.env, marker.runtimeRelease)
        await new RunControlDelivery<CoordinatorDeliveryMarker>(this.ctx.storage).register(marker)
        return json({ markerDigest: await sha256(marker) })
      }
      if (request.method === 'GET' && url.pathname === '/release') return await this.release(experimentId)
      if (request.method === 'POST' && url.pathname === '/activate') return await this.activate(request, experimentId)
      if (request.method === 'POST' && url.pathname === '/runs') return await this.start(request, experimentId)
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
    try {
      if (runtimeRelease !== undefined) await this.reserveLaunchRoute(store, runId, experimentId, runtimeRelease)
      if (reservation.workflowInstanceId !== undefined) {
        const dispatchMs = performance.now() - started
        return json({
          runId, workflowInstanceId: reservation.workflowInstanceId, releaseDigest, runtimeRelease,
          dispatchMs, reusedReservation: true,
        }, 202, { 'server-timing': `dispatch;dur=${dispatchMs.toFixed(1)}` })
      }
      const workflowInstanceId = await dispatchAuditWorkflow(this.env, {
        mode: 'start', experimentId, runId, releaseDigest,
        ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
      })
      await this.markRunDispatched(runId, workflowInstanceId)
      const dispatchMs = performance.now() - started
      return json({ runId, workflowInstanceId, releaseDigest, runtimeRelease, dispatchMs }, 202,
        { 'server-timing': `dispatch;dur=${dispatchMs.toFixed(1)}` })
    } catch (error) {
      if (error instanceof RunCommandConflict) return json({ error: error.message }, 409)
      return json({ runId, releaseDigest, runtimeRelease, dispatchPending: true }, 202)
    }
  }

  private async reservationFor(runId: string, requestIdentity: unknown): Promise<RunReservation | undefined> {
    const existing = await this.ctx.storage.get<RunReservation>(`run-reservation:${runId}`)
    if (existing === undefined) return undefined
    if (existing.retirementProofDigest !== undefined) throw new Error(`run was archived: ${runId}`)
    if (existing.dispatchRefusedStatus !== undefined) throw new Error(existing.dispatchRefusedReason ?? `run dispatch was refused: ${runId}`)
    const requestDigest = await sha256(canonicalJson(requestIdentity))
    if (existing.requestDigest !== requestDigest) throw new Error(`run already exists: ${runId}`)
    return existing
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
      await registerDelivery(transaction, { kind: 'launch', auditId: runId, requestDigest })
      return reservation
    })
  }

  private async reserveLaunchRoute(store: CloudflareRunStore, runId: string, experimentId: string, runtime: RuntimeRelease) {
    try { await store.reserveRunRoute(runId, experimentId, runtime) }
    catch (error) {
      if (error instanceof RunCommandConflict) {
        await this.ctx.storage.transaction(async tx => {
          const key = `run-reservation:${runId}`, reservation = await tx.get<RunReservation>(key)
          if (reservation === undefined || reservation.workflowInstanceId !== undefined) throw new Error('launch refusal conflicts with dispatch')
          await tx.put(key, { ...reservation, dispatchRefusedStatus: 409, dispatchRefusedReason: error.message })
        })
      }
      throw error
    }
  }

  private async deliverLaunch(marker: LaunchDeliveryMarker): Promise<boolean> {
    const reservation = await this.ctx.storage.get<RunReservation>(`run-reservation:${marker.auditId}`)
    if (reservation === undefined || reservation.requestDigest !== marker.requestDigest) throw new Error('launch reservation differs')
    if (reservation.dispatchRefusedStatus !== undefined) return true
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const state = await store.getStateIfPresent(marker.auditId)
    if (state?.status === 'stopped') {
      const receipt = state.controls?.lastReceipt
      if (receipt === undefined || state.executionAuthority === undefined) throw new Error('cancelled launch has no control receipt')
      return deliverRunControl({ schemaVersion: 1, auditId: state.rootRunId, experimentId: state.experimentId,
        commandId: receipt.commandId, commandDigest: receipt.commandDigest,
        expectedRevision: receipt.revision - 1, authority: state.executionAuthority }, this.env)
    }
    const { releaseDigest, runtimeRelease } = reservation.provenance
    const release = await store.getRelease(releaseDigest)
    try {
      if (runtimeRelease !== undefined) await this.reserveLaunchRoute(store, marker.auditId, release.body.definition.id, runtimeRelease)
    } catch (error) {
      if (error instanceof RunCommandConflict) return true
      throw error
    }
    const payload: AuditWorkflowPayload = {
      mode: 'start', experimentId: release.body.definition.id, runId: marker.auditId, releaseDigest,
      ...(runtimeRelease === undefined ? {} : { runtimeRelease }),
    }
    if (reservation.workflowInstanceId === undefined) {
      await this.markRunDispatched(marker.auditId, await dispatchAuditWorkflow(this.env, payload))
    }
    return reconcileAuditStartup(this.env, payload)
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
    let progress = await step.do<WaveProgress>('bootstrap-run', {
      retries: { limit: 1, delay: '2 seconds' }, timeout: '1 minute',
    }, async () => {
      const predecessor = await store.getStateIfPresent(payload.runId)
      if (predecessor !== null) await assertExecutionOwner(predecessor, this.env)
      const persist = await stateWriter(store, predecessor)
      const machine = await this.bootstrap(payload, store, predecessor)
      await machine.start()
      if (predecessor === null || machine.view().stateGeneration !== predecessor.stateGeneration) {
        await persist(machine.view())
      }
      await store.recordExecutionBootstrap(machine.view())
      return this.progress(machine.view())
    })
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
            }, async () => {
              const recovered = await store.getState(payload.runId)
              await assertExecutionOwner(recovered, this.env)
              return recovered.status === 'stopped' ? this.cleanupPersistedTerminal(payload.runId, store) : this.progress(recovered)
            })
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
          // bounded status slice before advancing the wave. A pause with nothing
          // in flight waits longer, so a long pause does not use up Workflow steps.
          try {
            await step.sleep(
              `agent-poll-backoff-${pollCycle}`,
              progress.pausedIdle === true ? '5 minutes' : observationFailed ? '30 seconds' : '15 seconds',
            )
          } catch (error) {
            if (error instanceof NonRetryableError || workflowFailureDisposition(error) === 'fail') throw error
            // Give a transient sleep fault one distinct durable recovery wait.
            // If that also fails, propagate instead of spinning on more failed
            // operations. The outer catch preserves nonterminal agent work.
            await step.sleep(`agent-poll-backoff-retry-${pollCycle}`, '30 seconds')
          }
          continue
        }
      }
      const terminalFailure = failureForWorkflowProgress(progress)
      if (terminalFailure !== null) throw terminalFailure
      if (progress.status === 'completed' || progress.status === 'stopped') {
        progress = await step.do<WaveProgress>(progress.status === 'completed'
          ? 'dispose-completed-workspaces' : 'reconcile-stopped-workspaces', {
          retries: { limit: 10, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute',
        }, async () => this.cleanupPersistedTerminal(payload.runId, store))
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

  private async bootstrap(payload: Readonly<AuditWorkflowPayload>, store: CloudflareRunStore, initialState?: RunState | null): Promise<RunMachine> {
    if (!runIdPattern.test(payload.runId)) throw new TypeError('run id is invalid')
    if (engineRole(this.env) === 'runtime') {
      if (payload.runtimeRelease === undefined) throw new TypeError('runtime-bound Workflow payload is required')
      assertLocalRuntime(this.env, payload.runtimeRelease)
    }
    if (payload.mode === 'start') return bootstrapExecution(payload, store, this.env, initialState)
    throw new PermanentRunFailure('legacy Workflow mode is retired; use audit controls', 'invalid-configuration')
  }

  private async runOneWave(payload: Readonly<AuditWorkflowPayload>, expectedCursor: RunCursor, store: CloudflareRunStore): Promise<WaveProgress> {
    if (payload.runtimeRelease !== undefined) assertLocalRuntime(this.env, payload.runtimeRelease)
    const state = await store.getState(payload.runId)
    const persist = await stateWriter(store, state)
    if (state.runtimeRelease !== undefined && payload.runtimeRelease !== undefined
      && !sameRuntimeRelease(state.runtimeRelease, payload.runtimeRelease)) {
      throw new PermanentRunFailure('run runtime release differs from its Workflow destination', 'integrity-failed')
    }
    await assertExecutionOwner(state, this.env)
    if (state.status === 'stopped') return this.cleanupPersistedTerminal(payload.runId, store)
    if (state.status === 'failed') {
      await this.cleanupPersistedTerminal(payload.runId, store)
      throw new PermanentRunFailure(state.terminalReason ?? 'audit run failed without a recorded reason', 'persisted-run-failed')
    }
    if (state.status !== 'running' || !sameCursor(state.cursor, expectedCursor)) return this.progress(state)
    const release = await store.getRelease(state.releaseDigest)
    const machine = await RunMachine.fromState(release.body.definition, state, digest => store.getRelease(digest), store.executionSources())
    const provider = new SandboxAgentProvider(this.env)
    const pendingCheckpoints: SealedCheckpoint[] = []
    let checkpointsPublished = false
    let controlsReady = true
    const reconcileControls = async () => {
      controlsReady = await reconcileRunControls({ machine, persist,
        journal: new RunCommandJournal(this.env.INDEX, machine.view().rootRunId),
        native: new CommandCustodyCollector(this.env) })
      return controlsReady
    }
    try {
      if (!await reconcileControls()) {
        if (machine.view().status === 'stopped') await this.cleanupTerminalWorkspaces(machine.definition, machine.view())
        return this.progress(machine.view())
      }
      await advanceExperimentOneWave({
        definition: machine.definition, machine,
        provider,
        artifactStore: new R2ArtifactStore(this.env.ARTIFACTS),
        loadOwnedWorkspaces: current => verifiedCleanupWorkspaces(this.env, current),
        policy: audit0RunPolicy,
        onWaveAdmission: persist,
        reconcileControls,
        onCheckpoint: async checkpoint => { pendingCheckpoints.push(checkpoint) },
      })
      if (!controlsReady || machine.view().status !== 'running') {
        if (machine.view().status === 'stopped') await this.cleanupTerminalWorkspaces(machine.definition, machine.view())
        return this.progress(machine.view())
      }
      if (machine.view().cursor.stageIndex >= machine.definition.stages.length) {
        const issues = audit0RunPolicy.assessCompletion({ definition: machine.definition, state: machine.view() })
        if (issues.length > 0) {
          throw new PermanentRunFailure(`completion contract failed: ${issues.join('; ')}`, 'completion-contract-failed')
        }
        await machine.complete()
      }
      for (const checkpoint of pendingCheckpoints) await store.putCheckpoint(checkpoint)
      checkpointsPublished = true
      const next = machine.view()
      await persist(next)
      if (next.status === 'stopped') await this.cleanupTerminalWorkspaces(machine.definition, next)
      return this.progress(next, state.stateGeneration)
    } catch (error) {
      // A sealed cursor becomes authoritative only after every checkpoint and
      // runtime route for that transition is durable. Completed executions are
      // recovered from their exact receipts when the previous state replays.
      if (pendingCheckpoints.length > 0 && !checkpointsPublished) throw error
      // Save paid attempts, validation diagnostics, and the last sealed boundary before
      // the Workflow retry or terminal-failure path reconstructs this run.
      if (machine.view().journal?.at(-2)?.type === 'run.cancelled') {
        await this.cleanupTerminalWorkspaces(machine.definition, machine.view())
        return this.progress(machine.view())
      }
      if (isPermanentRunFailure(error) && machine.view().status === 'running') {
        if (await hasPendingNativeControl(machine.view(), new RunCommandJournal(this.env.INDEX, machine.view().rootRunId))) {
          await persist(machine.view())
          throw new TransientRunFailure('native control reconciliation must finish before terminal failure', { cause: error })
        }
        await machine.fail(error.message)
      }
      const terminal = machine.view()
      await persist(terminal)
      if (terminal.status === 'failed' || terminal.status === 'stopped') {
        await this.cleanupTerminalWorkspaces(machine.definition, terminal)
      }
      throw error
    }
  }

  private async recordTerminalFailure(runId: string, store: CloudflareRunStore, error: unknown): Promise<void> {
    try {
      const state = await store.getState(runId)
      await assertExecutionOwner(state, this.env)
      if (state.status !== 'running') {
        if (state.status === 'failed' || state.status === 'stopped') {
          await this.cleanupPersistedTerminal(runId, store)
        }
        return
      }
      if (await hasPendingNativeControl(state, new RunCommandJournal(this.env.INDEX, state.rootRunId))) {
        throw new TransientRunFailure('native control reconciliation must finish before terminal failure', { cause: error })
      }
      const release = await store.getRelease(state.releaseDigest)
      const persist = await stateWriter(store, state)
      const machine = await RunMachine.fromState(release.body.definition, state, digest => store.getRelease(digest), store.executionSources())
      await machine.fail(error instanceof Error ? error.message : String(error))
      const failed = machine.view()
      await persist(failed)
      await this.cleanupTerminalWorkspaces(release.body.definition, failed)
    } catch (cleanupError) {
      // Preserve the original Workflow failure, but never silently present a
      // failed run as having released its native compute.
      console.error(canonicalJson({ schemaVersion: 1, kind: 'terminal-workspace-cleanup-failed',
        runId, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }))
      throw new AggregateError([error, cleanupError], 'terminal failure and cleanup both failed')
    }
  }

  private async cleanupTerminalWorkspaces(
    definition: ReleasePackageBody['definition'],
    state: RunState,
  ): Promise<Awaited<ReturnType<typeof disposeTerminalWorkspaces>> | {
    mode: 'command-cancelled'; workspaceKeys: string[]; activeWorkspaceKeys: string[]; retainedWorkspaceKeys: string[]; proofDigest: string
  } | Awaited<ReturnType<typeof settleControlledFailure>>> {
    if (state.status === 'failed') return settleControlledFailure(state.runId, this.env)
    if (state.journal?.at(-2)?.type === 'run.cancelled') {
      return settleCancelledExecution(state, this.env)
    }
    const store = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const cleanup = await settleTerminalControlsAndDispose(state,
      new RunCommandJournal(this.env.INDEX, state.rootRunId), () =>
      disposeTerminalWorkspaces(new SandboxAgentProvider(this.env), definition, state,
      { loadRelease: digest => store.getRelease(digest), loadExecution: store.executionSources(),
      loadOwnedWorkspaces: current => verifiedCleanupWorkspaces(this.env, current),
      }))
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
    await assertExecutionOwner(state, this.env)
    if (state.status === 'created' || state.status === 'running') return this.progress(state)
    const release = await store.getRelease(state.releaseDigest)
    const cleanup = await this.cleanupTerminalWorkspaces(release.body.definition, state)
    if (state.status === 'completed') {
      await store.putCompletedCleanupProof(state, cleanup)
      await registerCompletedRunDelivery(state, this.env)
    }
    return this.progress(await store.getState(runId))
  }

  private progress(state: RunState, polledGeneration?: number): WaveProgress {
    return workflowProgress(state, polledGeneration)
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
    const internal = await runtimeServiceRoute(request, env)
    if (internal !== null) return internal
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'swarm', role: engineRole(env), workerVersionId: env.VERSION_METADATA?.id ?? null })
    }
    if (url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')) {
      if (!await dashboardAccessAllowed(request, undefined, env)) return json({ error: 'unauthorized' }, 401)
      const dashboardRequest = monitoringRequestFromDashboard(request)
      if (dashboardRequest !== null) {
        try {
          const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
          return await monitoringRoute(dashboardRequest, store, env.ARTIFACTS, env.INDEX,
            new R2ArtifactStore(env.ARTIFACTS), env.PACKAGES,
            (runId, state) => dashboardWorkflowStatus(runId, state, env))
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : String(error) }, 400)
        }
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
        const sandbox = getAgentSandbox(env.AGENT_SANDBOX, probeId, {
          inactivityTimeoutMs: 60_000, labels: { purpose: 'readiness', probe: probeId },
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
      const controlPath = url.pathname.match(/^\/v1\/experiments\/([a-z0-9][a-z0-9._-]{0,99})\/(audits\/[a-z0-9][a-z0-9._-]{0,99}\/commands(?:\/[a-z0-9][a-z0-9._-]{0,99})?)$/)
      if (controlPath !== null) return forwardCoordinator(request, env, controlPath[1]!, controlPath[2]!)
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
          accountId: typeof env.ACK3_CLOUDFLARE_ACCOUNT_ID === 'string' ? env.ACK3_CLOUDFLARE_ACCOUNT_ID : undefined,
          observeExpired: proof => observeExpiredFixture(env, proof), proof, now: Date.now(), store,
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
          return json({ ...body, runtimeRelease })
        }
        const state = await store.getState(runMatch)
        const workflow = await env.AUDIT_WORKFLOW.get(runMatch)
        return json({ state, workflow: await workflow.status() })
      }
      return json({ error: 'not found' }, 404)
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400)
    }
  },
} satisfies ExportedHandler<Env>
