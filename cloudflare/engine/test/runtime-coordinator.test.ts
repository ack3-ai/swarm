import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import {
  resolveRuntimeSelector, RuntimeRouter,
} from '../src/runtime-release.js'
import { validateNewSearchAdmission } from '../src/validation.js'

import { RunCommandConflict } from '../src/run-commands.js'
import { registerDelivery } from '../src/run-control-delivery.js'

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
  retiredSearch = false, routeCollision = false) {
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
    getAlarm(): Promise<number | null>
    setAlarm(at: number): Promise<void>
    get(key: string): Promise<unknown>
    put(key: string, value: unknown): Promise<void>
    transaction<T>(fn: (transaction: FixtureStorage) => T | Promise<T>): Promise<T>
  }
  let alarm: number | null = null
  const storage: FixtureStorage = {
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at },
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value) },
    transaction: async fn => fn(storage),
  }
  const dispatch = vi.fn(async (_env, payload: { runId: string }) => payload.runId)
  let failNext = failFirstRouteReservation
  const storeCreated = vi.fn()
  class Store {
    constructor() { storeCreated() }
    async getStateIfPresent() { return null }
    async reserveRunRoute() {
      if (failNext) {
        failNext = false
        if (routeCollision) throw new RunCommandConflict('idempotency-conflict', 'run already exists with different routing')
        throw new Error('temporary D1 failure')
      }
    }
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
      }, { headers: { 'x-ack3-runtime-worker-version': runtimeB.workerVersionId } })
    }) },
  }
  const Coordinator = new Function(
    'DurableObject',
    'CloudflareRunStore',
    'RuntimeRouter',
    'assertReleaseEnvironmentMatchesRuntime',
    'resolveRuntimeSelector',
    'sameRuntimeRelease',
    'engineRole',
    'dispatchAuditWorkflow',
    'canonicalJson',
    'sha256',
    'json',
    'runIdPattern',
    'digestPattern',
    'validateNewSearchAdmission', 'registerDelivery', 'RunCommandConflict',
    `${code}; return ExperimentCoordinator;`,
  )(
    class { env = env; ctx = { storage, id: { toString: () => 'fixture' } } },
    Store,
    RuntimeRouter,
    assertReleaseEnvironmentMatchesRuntime,
    resolveRuntimeSelector,
    (left: typeof runtimeA, right: typeof runtimeA) => JSON.stringify(left) === JSON.stringify(right),
    (value: typeof env) => value.ENGINE_ROLE,
    dispatch,
    canonicalJson,
    sha256,
    (value: unknown, status = 200, headers = {}) => Response.json(value, { status, headers }),
    /^[a-z0-9][a-z0-9._-]{0,99}$/,
    /^[a-f0-9]{64}$/,
    validateNewSearchAdmission, registerDelivery, RunCommandConflict,
  ) as new () => { fetch(request: Request): Promise<Response> }
  return {
    instance: new Coordinator(), dispatch, storeCreated, targetFetch: env.RUNTIME_B.fetch,
    reservations: () => [...data.keys()].filter(key => key.startsWith('run-reservation:')),
    setPointer: (pointer: unknown) => data.set('release-pointer', pointer),
  }
}

const startRequest = () => new Request('https://coordinator.internal/runs', {
  method: 'POST',
  body: JSON.stringify({ runId: 'new-run' }),
  headers: { 'x-ack3-experiment': 'fixture' },
})

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
    expect(failed.status).toBe(202)
    expect(await failed.json()).toMatchObject({ dispatchPending: true })
    expect(dispatch).not.toHaveBeenCalled()

    const retry = await instance.fetch(startRequest())
    expect(retry.status).toBe(202)
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ runtimeRelease: { id: runtimeB.id } })
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it.each(['resumes', 'recoveries', 'terminal-recoveries', 'discovery-waivers',
    'retire-failed-native', 'retire-unmaterialized-recovery'].flatMap(endpoint => [
      'unparsed historical proof', {}, { runtimeId: runtimeB.id }, { transition: {}, revalidate: {} },
      { revalidate: { sourceRunId: 'failed-parent', outputDigest: 'b'.repeat(64) } },
      { repairQuarantined: { taskId: 'synthesizer' } }, { promoteExecution: {} }, { retainNative: {} },
    ].map(body => ({ endpoint, body }))))('refuses obsolete $endpoint before parsing or reserving ($body)', async ({ endpoint, body }) => {
    const f = coordinator(true)
    for (let attempt = 0; attempt < 2; attempt++) {
      const request = new Request(`https://coordinator.internal/${endpoint}`, {
        method: 'POST', headers: { 'x-ack3-experiment': 'fixture' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
      const parse = vi.spyOn(request, 'json').mockRejectedValue(new Error('obsolete intent must not be read'))
      const response = await f.instance.fetch(request)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'not found' })
      expect(parse).not.toHaveBeenCalled()
    }
    expect(f.storeCreated).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    expect(f.targetFetch).not.toHaveBeenCalled()
    expect(f.reservations()).toEqual([])
  })

})

it('returns the same durable refusal on the initial POST and an identical retry after a proven collision', async () => {
  const f = coordinator(true, undefined, false, true)
  const first = await f.instance.fetch(startRequest()), second = await f.instance.fetch(startRequest())
  expect(first.status).toBe(409); expect(second.status).toBe(409)
  expect(await first.json()).toEqual(await second.json())
  expect(f.dispatch).not.toHaveBeenCalled()
})
