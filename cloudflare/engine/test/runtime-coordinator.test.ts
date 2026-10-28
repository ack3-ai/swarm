import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import {
  pinnedRuntime, resolveRuntimeSelector, RuntimeRouter,
} from '../src/runtime-release.js'
import { validateNewSearchAdmission } from '../src/validation.js'

const engine = new URL('..', import.meta.url).pathname
const declarationA = {
  schemaVersion: 1 as const,
  id: 'runtime-a',
  frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-a',
  workflowName: 'audit-a',
  containerImageDigest: `sha256:${'a'.repeat(64)}`,
}
const runtimeA = {
  ...declarationA,
  workerVersionId: '11111111-1111-4111-8111-111111111111',
}
const declarationB = {
  ...declarationA,
  id: 'runtime-b',
  frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-b',
  workflowName: 'audit-b',
}
const runtimeB = {
  ...declarationB,
  workerVersionId: '22222222-2222-4222-8222-222222222222',
}

function coordinator(failFirstRouteReservation = false, requestedImageDigest?: string,
  retiredSearch = false, unobservable = false) {
  const source = readFileSync(join(engine, 'src/worker.ts'), 'utf8')
  const code = stripTypeScriptTypes(source.slice(
    source.indexOf('export class ExperimentCoordinator'),
    source.indexOf('function sameCursor'),
  ).replace('export class', 'class'))
  const data = new Map<string, unknown>([['release-pointer', {
    experimentId: 'fixture',
    digest: 'c'.repeat(64),
    generation: 1,
    runtimeSelector: { mode: 'latest' },
  }]])
  interface FixtureStorage {
    get(key: string): Promise<unknown>
    put(key: string, value: unknown): Promise<void>
    transaction<T>(fn: (transaction: FixtureStorage) => T | Promise<T>): Promise<T>
  }
  const storage: FixtureStorage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value) },
    transaction: async fn => fn(storage),
  }
  const dispatch = vi.fn(async (_env, payload: { runId: string }) => payload.runId)
  let failNext = failFirstRouteReservation
  const checkpointRuntime = vi.fn(async () => runtimeA)
  const failedWaveRecovery = {
    sourceRunId: 'failed-source', sourceStateGeneration: 70, sourceStateDigest: 'f'.repeat(64),
    checkpointDigest: 'e'.repeat(64), importedTaskIds: ['negative-review-primary'],
    inheritedRejectedAttemptCount: 2, unknownUsageAttemptCount: 2,
    sourceRuntimeRelease: runtimeA, targetRuntimeRelease: runtimeB,
    ...(unobservable ? { unobservableNative: {
      stageId: 'discovery', waveId: 'wave-1', taskId: 'core-wave-1-research-1',
      attempt: 1, promptDigest: '1'.repeat(64), requestDigest: '2'.repeat(64),
      fenceProofDigest: '3'.repeat(64),
    } } : {}),
  }
  const fenced = vi.fn(async () => failedWaveRecovery.unobservableNative)
  const prepareFailedWaveRecovery = vi.fn(async (_input?: Record<string, unknown>) => ({
    importedArtifacts: [{}], inheritedRejectedAttempts: [], evidence: failedWaveRecovery,
  }))
  const terminalCompletionRecovery = {
    sourceRunId: 'terminal-source', sourceStateGeneration: 106, sourceStateDigest: '9'.repeat(64),
    checkpointDigest: '8'.repeat(64), sourceRuntimeRelease: runtimeA, targetRuntimeRelease: runtimeB,
  }
  const prepareTerminalCompletionRecovery = vi.fn(async () => terminalCompletionRecovery)
  const runtimeTransition = { ...terminalCompletionRecovery, sourceRunId: 'stopped-source',
    checkpointDigest: 'e'.repeat(64), inheritedRecoveryDigest: '7'.repeat(64) }
  const prepareCheckpointRuntimeTransition = vi.fn(async () => runtimeTransition)
  const validateResume = vi.fn(async () => ({}))
  class Store {
    async retiredUnmaterializedRoute() { return null }
    async getStateIfPresent() { return null }
    async reserveRunRoute() {
      if (failNext) {
        failNext = false
        throw new Error('temporary D1 failure')
      }
    }
    checkpointRuntime = checkpointRuntime
    async getState() { return { experimentId: 'fixture',
      ...(unobservable ? { inFlightAgentAttempts: [{}] } : {}) } }
    fencedUnobservableNativeEvidence = fenced
    async getCheckpoint() { return { digest: 'e'.repeat(64), body: { releaseDigest: 'c'.repeat(64), experimentId: 'fixture' } } }
    async getRelease() { return { body: { definition: { id: 'fixture', pools: [],
      ...(retiredSearch ? { forceSearch: { enabled: true, promptSet: 'native-exa-v1' } } : {}),
    },
      ...(requestedImageDigest === undefined ? {} : {
        environment: { image: `registry.cloudflare.com/${'e'.repeat(32)}/swarm-sandbox@${requestedImageDigest}` },
      }),
    } } }
  }
  const env = {
    ENGINE_ROLE: 'front-door',
    RUNTIME_CATALOG_JSON: JSON.stringify({
      schemaVersion: 1,
      latest: runtimeB.id,
      releases: {
        [runtimeA.id]: { ...declarationA, binding: 'RUNTIME_A' },
        [runtimeB.id]: { ...declarationB, binding: 'RUNTIME_B' },
      },
    }),
    RUNTIME_A: { fetch: async (url: string) => Response.json(
      url.endsWith('/identity') ? runtimeA : { workflowInstanceId: 'child-run', runtimeRelease: runtimeA },
      { headers: { 'x-ack3-runtime-worker-version': runtimeA.workerVersionId } },
    ) },
    RUNTIME_B: { fetch: vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/identity')) return Response.json(runtimeB, {
        headers: { 'x-ack3-runtime-worker-version': runtimeB.workerVersionId },
      })
      const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
      return Response.json({
        workflowInstanceId: body.childRunId ?? body.runId ?? 'new-run', runtimeRelease: runtimeB,
        ...(url.endsWith('/audit-recoveries') ? { failedWaveRecovery } : {}),
        ...(url.endsWith('/audit-terminal-recoveries') ? { terminalCompletionRecovery } : {}),
      }, { headers: { 'x-ack3-runtime-worker-version': runtimeB.workerVersionId } })
    }) },
  }
  const Coordinator = new Function(
    'DurableObject',
    'CloudflareRunStore',
    'RuntimeRouter',
    'assertReleaseEnvironmentMatchesRuntime',
    'pinnedRuntime',
    'resolveRuntimeSelector',
    'sameRuntimeRelease',
    'engineRole',
    'dispatchAuditWorkflow',
    'runtimeResponseBody',
    'canonicalJson',
    'sha256',
    'json',
    'runIdPattern',
    'digestPattern',
    'R2ArtifactStore',
    'prepareFailedWaveRecovery',
    'prepareTerminalCompletionRecovery',
    'prepareCheckpointRuntimeTransition',
    'RunMachine',
    'validateNewSearchAdmission',
    `${code}; return ExperimentCoordinator;`,
  )(
    class { env = env; ctx = { storage, id: { toString: () => 'fixture' } } },
    Store,
    RuntimeRouter,
    assertReleaseEnvironmentMatchesRuntime,
    pinnedRuntime,
    resolveRuntimeSelector,
    (left: typeof runtimeA, right: typeof runtimeA) => JSON.stringify(left) === JSON.stringify(right),
    (value: typeof env) => value.ENGINE_ROLE,
    dispatch,
    async (response: Response) => {
      const value = await response.json() as Record<string, unknown>
      if (!response.ok) throw new Error(String(value.error ?? response.status))
      return value
    },
    canonicalJson,
    sha256,
    (value: unknown, status = 200, headers = {}) => Response.json(value, { status, headers }),
    /^[a-z0-9][a-z0-9._-]{0,99}$/,
    /^[a-f0-9]{64}$/,
    class {},
    prepareFailedWaveRecovery,
    prepareTerminalCompletionRecovery,
    prepareCheckpointRuntimeTransition,
    { recoverFailedWave: async () => ({}), recoverTerminalCompletion: async () => ({}), resume: validateResume },
    validateNewSearchAdmission,
  ) as new () => { fetch(request: Request): Promise<Response> }
  return {
    instance: new Coordinator(), dispatch, checkpointRuntime, fenced,
    prepareFailedWaveRecovery, prepareTerminalCompletionRecovery,
    prepareCheckpointRuntimeTransition, validateResume, targetFetch: env.RUNTIME_B.fetch,
    setPointer: (pointer: unknown) => data.set('release-pointer', pointer),
  }
}

const startRequest = () => new Request('https://coordinator.internal/runs', {
  method: 'POST',
  body: JSON.stringify({ runId: 'new-run' }),
  headers: { 'x-ack3-experiment': 'fixture' },
})

const resumeRequest = () => new Request('https://coordinator.internal/resumes', {
  method: 'POST',
  body: JSON.stringify({ childRunId: 'child-run', checkpointDigest: 'd'.repeat(64) }),
  headers: { 'x-ack3-experiment': 'fixture' },
})

const recoveryRequest = (overrides: Record<string, unknown> = {}) => new Request('https://coordinator.internal/recoveries', {
  method: 'POST',
  body: JSON.stringify({
    childRunId: 'recovery-child', sourceRunId: 'failed-source', sourceStateGeneration: 70,
    sourceStateDigest: 'f'.repeat(64), checkpointDigest: 'e'.repeat(64), runtimeId: runtimeB.id,
    ...overrides,
  }),
  headers: { 'x-ack3-experiment': 'fixture' },
})

const terminalRecoveryRequest = (overrides: Record<string, unknown> = {}) => new Request(
  'https://coordinator.internal/terminal-recoveries', {
    method: 'POST',
    body: JSON.stringify({
      childRunId: 'terminal-child', sourceRunId: 'terminal-source', sourceStateGeneration: 106,
      sourceStateDigest: '9'.repeat(64), checkpointDigest: '8'.repeat(64), runtimeId: runtimeB.id,
      ...overrides,
    }),
    headers: { 'x-ack3-experiment': 'fixture' },
  },
)

describe('front-door runtime reservation', () => {
  it('does not dispatch a new run through a historical pointer without a runtime selector', async () => {
    const f = coordinator()
    f.setPointer({ experimentId: 'fixture', digest: 'c'.repeat(64), generation: 1,
      runtimeRelease: runtimeA })
    const response = await f.instance.fetch(startRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'new runs require an explicit runtime selector' })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('rejects a retired release at new start before reservation or dispatch', async () => {
    const f = coordinator(false, undefined, true)
    const response = await f.instance.fetch(startRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'native Exa search is required when forceSearch is enabled' })
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('guards exact release generation and runtime before a new dispatch', async () => {
    const guarded = (runtimeRelease = runtimeB) => new Request('https://coordinator.internal/runs', {
      method: 'POST', headers: { 'x-ack3-experiment': 'fixture' },
      body: JSON.stringify({ runId: 'guarded-run', expectedReleaseDigest: 'c'.repeat(64),
        expectedGeneration: 1, expectedRuntimeRelease: runtimeRelease }),
    })
    const changed = coordinator()
    changed.setPointer({ experimentId: 'fixture', digest: 'd'.repeat(64), generation: 2,
      runtimeSelector: { mode: 'latest' } })
    expect((await changed.instance.fetch(guarded())).status).toBe(409)
    expect(changed.dispatch).not.toHaveBeenCalled()
    const wrongRuntime = coordinator()
    expect((await wrongRuntime.instance.fetch(guarded(runtimeA))).status).toBe(409)
    expect(wrongRuntime.dispatch).not.toHaveBeenCalled()
    const exact = coordinator()
    expect((await exact.instance.fetch(guarded())).status).toBe(202)
    expect((await exact.instance.fetch(guarded())).status).toBe(202)
    expect(exact.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched manifest image before run reservation or Workflow dispatch', async () => {
    const f = coordinator(false, `sha256:${'f'.repeat(64)}`)
    const response = await f.instance.fetch(startRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'audit environment image does not match the selected runtime' })
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.targetFetch).toHaveBeenCalledTimes(1) // runtime identity only
    const matched = coordinator(false, runtimeB.containerImageDigest)
    expect((await matched.instance.fetch(startRequest())).status).toBe(202)
    expect(matched.dispatch).toHaveBeenCalledTimes(1)
  })

  it('rejects a mismatched image before checkpoint recovery work or child dispatch', async () => {
    const f = coordinator(false, `sha256:${'f'.repeat(64)}`)
    const response = await f.instance.fetch(recoveryRequest())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'audit environment image does not match the selected runtime' })
    expect(f.prepareFailedWaveRecovery).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
  })

  it('reserves an explicit validated checkpoint upgrade once and binds retries to its original evidence', async () => {
    const f = coordinator()
    const body = { childRunId: 'upgraded-child', checkpointDigest: 'e'.repeat(64), runtimeId: runtimeB.id,
      transition: { sourceRunId: 'stopped-source', sourceStateGeneration: 106, sourceStateDigest: '9'.repeat(64) } }
    const request = (value = body) => new Request('https://coordinator.internal/resumes', {
      method: 'POST', body: JSON.stringify(value), headers: { 'x-ack3-experiment': 'fixture' },
    })
    const first = await f.instance.fetch(request())
    expect(first.status).toBe(202)
    const routed = f.targetFetch.mock.calls.find(([url]) => url.endsWith('/audit-resumes'))!
    expect(JSON.parse(String(routed[1]!.body))).toMatchObject({ childRunId: 'upgraded-child',
      runtimeRelease: runtimeB, runtimeTransition: { sourceRunId: 'stopped-source', inheritedRecoveryDigest: '7'.repeat(64) } })
    expect((await f.instance.fetch(request())).status).toBe(202)
    expect(f.targetFetch.mock.calls.filter(([url]) => url.endsWith('/audit-resumes'))).toHaveLength(1)
    expect(f.prepareCheckpointRuntimeTransition).toHaveBeenCalledTimes(1)
    expect(f.validateResume).toHaveBeenCalledTimes(1)
    expect((await f.instance.fetch(request({ ...body, transition: { ...body.transition, sourceStateGeneration: 107 } }))).status).toBe(409)
  })

  it('rejects an implicit target override or an upgrade combined with output revalidation before reservation', async () => {
    const f = coordinator()
    for (const body of [
      { childRunId: 'new-child', checkpointDigest: 'e'.repeat(64), runtimeId: runtimeB.id },
      { childRunId: 'new-child', checkpointDigest: 'e'.repeat(64), runtimeId: runtimeB.id,
        transition: { sourceRunId: 'stopped-source', sourceStateGeneration: 1, sourceStateDigest: 'a'.repeat(64) },
        revalidate: { sourceRunId: 'old', outputDigest: 'b'.repeat(64) } },
    ]) expect((await f.instance.fetch(new Request('https://coordinator.internal/resumes', {
      method: 'POST', body: JSON.stringify(body), headers: { 'x-ack3-experiment': 'fixture' },
    }))).status).toBe(400)
    expect(f.targetFetch).not.toHaveBeenCalled()
    expect(f.prepareCheckpointRuntimeTransition).not.toHaveBeenCalled()
  })

  it('resolves latest at fresh run reservation and keeps one dispatch for identical retries', async () => {
    const { instance, dispatch } = coordinator()
    const first = await instance.fetch(startRequest())
    expect(first.status).toBe(202)
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ runtimeRelease: { id: runtimeB.id } })

    const retry = await instance.fetch(startRequest())
    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({ reusedReservation: true, runtimeRelease: { id: runtimeB.id } })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('reconciles a transient route-persistence failure without resolving a different owner', async () => {
    const { instance, dispatch } = coordinator(true)
    const failed = await instance.fetch(startRequest())
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: 'temporary D1 failure' })
    expect(dispatch).not.toHaveBeenCalled()

    const retry = await instance.fetch(startRequest())
    expect(retry.status).toBe(202)
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ runtimeRelease: { id: runtimeB.id } })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('reconciles the same pre-dispatch failure for a checkpoint child', async () => {
    const { instance, checkpointRuntime } = coordinator(true)
    const failed = await instance.fetch(resumeRequest())
    expect(failed.status).toBe(409)
    expect(await failed.json()).toMatchObject({ error: 'temporary D1 failure' })

    const retry = await instance.fetch(resumeRequest())
    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({
      workflowInstanceId: 'child-run',
      runtimeRelease: { id: runtimeA.id },
    })
    expect(checkpointRuntime).toHaveBeenCalledTimes(1)
  })

  it('binds failed-wave recovery to one exact source state and target runtime', async () => {
    const { instance, prepareFailedWaveRecovery } = coordinator()
    const first = await instance.fetch(recoveryRequest())
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({
      workflowInstanceId: 'recovery-child',
      failedWaveRecovery: { sourceRunId: 'failed-source', sourceStateGeneration: 70 },
      runtimeRelease: { id: runtimeB.id },
    })

    const retry = await instance.fetch(recoveryRequest())
    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({ reusedReservation: true, runtimeRelease: { id: runtimeB.id } })
    expect(prepareFailedWaveRecovery).toHaveBeenCalledTimes(1)

    const changedSource = await instance.fetch(recoveryRequest({ sourceStateDigest: '0'.repeat(64) }))
    expect(changedSource.status).toBe(409)
    expect(await changedSource.json()).toMatchObject({ error: 'run already exists: recovery-child' })

    const changedRuntime = await instance.fetch(recoveryRequest({ runtimeId: runtimeA.id }))
    expect(changedRuntime.status).toBe(409)
    expect(await changedRuntime.json()).toMatchObject({ error: 'run already exists: recovery-child' })
  })

  it('rechecks a fenced unobservable task before reservation and route dispatch', async () => {
    const { instance, fenced, prepareFailedWaveRecovery, targetFetch } = coordinator(false, undefined, false, true)
    const result = await instance.fetch(recoveryRequest())
    expect(result.status).toBe(202)
    expect(fenced).toHaveBeenCalledTimes(3)
    expect(prepareFailedWaveRecovery.mock.calls[0]?.[0]).toMatchObject({
      unobservableNative: { taskId: 'core-wave-1-research-1', fenceProofDigest: '3'.repeat(64) },
    })
    expect(targetFetch).toHaveBeenCalled()
  })

  it('dispatches an identical terminal completion recovery once', async () => {
    const { instance, prepareTerminalCompletionRecovery } = coordinator()
    const first = await instance.fetch(terminalRecoveryRequest())
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({
      workflowInstanceId: 'terminal-child',
      terminalCompletionRecovery: { sourceRunId: 'terminal-source', sourceStateGeneration: 106 },
      runtimeRelease: { id: runtimeB.id },
    })
    const retry = await instance.fetch(terminalRecoveryRequest())
    expect(retry.status).toBe(202)
    expect(await retry.json()).toMatchObject({ reusedReservation: true })
    expect(prepareTerminalCompletionRecovery).toHaveBeenCalledTimes(1)

    const changed = await instance.fetch(terminalRecoveryRequest({ sourceStateGeneration: 107 }))
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ error: 'run already exists: terminal-child' })
  })
})
