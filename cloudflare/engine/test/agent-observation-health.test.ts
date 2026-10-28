import { expect, it } from 'vitest'
import {
  observationHealthIoMs, observationIncidentPollMs, readAgentObservationHealth, R2AgentObservationHealthStore,
  type AgentObservationIdentity,
} from '../src/agent-observation-health.js'

class FakeR2 {
  readonly objects = new Map<string, { content: string, options: R2PutOptions, etag: string }>()
  private revision = 0
  async put(key: string, content: string, options: R2PutOptions): Promise<object | null> {
    const existing = this.objects.get(key)
    const condition = options.onlyIf as R2Conditional | undefined
    if (condition?.etagMatches !== undefined && existing?.etag !== condition.etagMatches
      || condition?.etagDoesNotMatch === '*' && existing !== undefined) return null
    const etag = String(++this.revision)
    this.objects.set(key, { content, options, etag })
    return { etag }
  }
  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key)
    if (object === undefined) return null
    return { text: async () => object.content, customMetadata: object.options.customMetadata,
      etag: object.etag,
      checksums: { toJSON: () => ({ sha256: object.options.sha256 }) } } as unknown as R2ObjectBody
  }
}

const identity: AgentObservationIdentity = {
  runId: 'run-1', stageId: 'discovery', waveId: 'wave-4', taskId: 'research-2',
  attempt: 1, promptDigest: 'a'.repeat(64),
}
const requestDigest = 'b'.repeat(64)
const start = new Date('2026-10-07T00:00:00.000Z')
const at = (minutes: number) => new Date(start.getTime() + minutes * 60_000)

it('persists exact-attempt failures, deduplicates close observations, and flags a sustained incident', async () => {
  const bucket = new FakeR2()
  const first = new R2AgentObservationHealthStore(bucket as unknown as R2Bucket)
  const second = new R2AgentObservationHealthStore(bucket as unknown as R2Bucket)
  expect(await first.get(identity)).toBeNull()
  await first.recordFailure(identity, requestDigest, 'receipt-exists', at(0))
  await second.recordFailure(identity, requestDigest, 'receipt-exists', at(1))
  expect((await first.get(identity))?.consecutiveFailures).toBe(1)
  await first.recordFailure(identity, requestDigest, 'process-missing', at(5))
  const incident = await second.recordFailure(identity, requestDigest, 'process-missing', at(11))
  expect(incident.consecutiveFailures).toBe(3)
  expect(incident.firstFailedAt).toBe(at(0).toISOString())
  expect(incident.lastFailedAt).toBe(at(11).toISOString())
  expect(incident.incidentSince).toBe(at(11).toISOString())
  expect(incident.nextObservationAfter).toBe(new Date(at(11).getTime() + observationIncidentPollMs).toISOString())
  const deferred = await second.recordFailure(identity, requestDigest, 'process-missing', at(17))
  expect(deferred.consecutiveFailures).toBe(4)
  expect(deferred.nextObservationAfter).toBe(new Date(at(17).getTime() + observationIncidentPollMs).toISOString())
  expect(deferred.incidentSince).toBe(at(11).toISOString())
  expect(await readAgentObservationHealth(bucket as unknown as R2Bucket, identity)).toEqual(deferred)
  expect(await first.get({ ...identity, taskId: 'another-task' })).toBeNull()
})

it('clears an incident only after an authoritative exact process observation', async () => {
  const bucket = new FakeR2()
  const store = new R2AgentObservationHealthStore(bucket as unknown as R2Bucket)
  await store.recordFailure(identity, requestDigest, 'receipt-exists', at(0))
  await store.recordFailure(identity, requestDigest, 'process-lookup', at(5))
  await store.recordFailure(identity, requestDigest, 'process-status', at(11))
  const recovered = await store.recordProcessSuccess(identity, requestDigest, at(12))
  expect(recovered.consecutiveFailures).toBe(0)
  expect(recovered.incidentSince).toBeNull()
  expect(recovered.lastSuccessfulProcessAt).toBe(at(12).toISOString())
  expect((await store.recordFailure(identity, requestDigest, 'receipt-exists', at(13))).consecutiveFailures).toBe(1)
  await expect(store.recordFailure(identity, 'c'.repeat(64), 'receipt-exists', at(14)))
    .rejects.toThrow('request digest changed')
})

it('rejects modified persisted evidence', async () => {
  const bucket = new FakeR2()
  const store = new R2AgentObservationHealthStore(bucket as unknown as R2Bucket)
  await store.recordFailure(identity, requestDigest, 'receipt-exists', at(0))
  const object = [...bucket.objects.values()][0]!
  object.content += ' '
  await expect(store.get(identity)).rejects.toThrow('provenance mismatch')
})

it('does not let delayed success or failure events rewrite newer custody evidence', async () => {
  const store = new R2AgentObservationHealthStore(new FakeR2() as unknown as R2Bucket)
  await store.recordFailure(identity, requestDigest, 'receipt-exists', at(0))
  await store.recordFailure(identity, requestDigest, 'process-lookup', at(5))
  await store.recordFailure(identity, requestDigest, 'process-status', at(11))
  const incident = await store.get(identity)
  await store.recordProcessSuccess(identity, requestDigest, at(1))
  expect(await store.get(identity)).toEqual(incident)
  await store.recordProcessSuccess(identity, requestDigest, at(12))
  const recovered = await store.get(identity)
  await store.recordFailure(identity, requestDigest, 'receipt-exists', at(3))
  expect(await store.get(identity)).toEqual(recovered)
})

it('records each confirmed healthy status so an older delayed failure cannot reopen it', async () => {
  const store = new R2AgentObservationHealthStore(new FakeR2() as unknown as R2Bucket)
  await store.recordProcessSuccess(identity, requestDigest, at(0))
  await store.recordProcessSuccess(identity, requestDigest, at(4))
  const current = await store.get(identity)
  expect(current?.lastSuccessfulProcessAt).toBe(at(4).toISOString())
  await store.recordFailure(identity, requestDigest, 'process-status-unavailable', at(2))
  expect(await store.get(identity)).toEqual(current)
})

it('uses a conditional update when two observations read the same prior record', async () => {
  const bucket = new FakeR2()
  const store = new R2AgentObservationHealthStore(bucket as unknown as R2Bucket)
  await store.recordFailure(identity, requestDigest, 'receipt-exists', at(0))
  const [older, newer] = await Promise.all([
    store.recordFailure(identity, requestDigest, 'process-lookup', at(5)),
    store.recordFailure(identity, requestDigest, 'process-status', at(11)),
  ])
  expect(older.consecutiveFailures).toBeGreaterThanOrEqual(1)
  expect(newer.consecutiveFailures).toBeGreaterThanOrEqual(2)
  const latest = await store.get(identity)
  expect(latest?.lastFailedAt).toBe(at(11).toISOString())
  expect(latest?.consecutiveFailures).toBeGreaterThanOrEqual(2)
})

it('bounds unavailable health storage so diagnostics cannot hang an observation step', async () => {
  const bucket = { get: async () => await new Promise<never>(() => {}) }
  const started = Date.now()
  await expect(readAgentObservationHealth(bucket as unknown as R2Bucket, identity))
    .rejects.toThrow('I/O deadline exceeded')
  expect(Date.now() - started).toBeGreaterThanOrEqual(observationHealthIoMs)
  expect(Date.now() - started).toBeLessThan(observationHealthIoMs + 1_000)
})
