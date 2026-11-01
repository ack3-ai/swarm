import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/canonical.js'
import {
  agentLogChunkMaxBytes,
  chunkAgentLogEvents,
  parseLocalAgentLog,
  R2AgentExecutionLogStore,
} from '../src/agent-execution-log.js'

interface Stored {
  content: string
  metadata: Record<string, string>
  digest: string
}

class FakeR2 {
  readonly objects = new Map<string, Stored>()

  async put(key: string, content: string, options: any) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null
    const value = { content, metadata: options.customMetadata ?? {}, digest: options.sha256 }
    this.objects.set(key, value)
    return this.object(key, value)
  }

  async get(key: string) {
    const value = this.objects.get(key)
    return value === undefined ? null : this.object(key, value)
  }

  async head(key: string) {
    const value = this.objects.get(key)
    return value === undefined ? null : this.object(key, value)
  }

  async list(options: any = {}) {
    const matching = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .sort(([left], [right]) => left.localeCompare(right))
    if (options.delimiter === '/') {
      return { objects: [], delimitedPrefixes: [...new Set(matching.map(([key]) => (
        key.slice(0, key.indexOf('/', (options.prefix ?? '').length) + 1)
      )))], truncated: false }
    }
    const values = matching
      .map(([key, value]) => this.object(key, value))
    return { objects: values, delimitedPrefixes: [], truncated: false }
  }

  private object(key: string, value: Stored) {
    return {
      key,
      size: new TextEncoder().encode(value.content).byteLength,
      customMetadata: value.metadata,
      checksums: { toJSON: () => ({ sha256: value.digest }) },
      text: async () => value.content,
    }
  }
}

const runId = 'run-1'
const taskId = 'research-1'
const requestDigest = 'a'.repeat(64)
const base = `monitor/agent-executions/${runId}/${taskId}/${requestDigest}/`

async function request(prompt = 'Inspect the target') {
  return {
    schemaVersion: 1 as const,
    runId,
    stageId: 'discovery',
    waveId: 'wave-0',
    taskId,
    requestDigest,
    promptDigest: await sha256(prompt),
    prompt,
    model: 'fixture-model',
    provider: 'fixture-provider',
    attempt: 1,
    startedAt: '2026-09-26T12:00:00.000Z',
    startedAtBasis: 'execution-admission' as const,
    researcherProtocol: 'Private research protocol',
  }
}

function line(at: string, stream: 'stdout' | 'stderr', text: string): string {
  return `${JSON.stringify({ schemaVersion: 1, at, stream, text })}\n`
}

describe('private agent execution logs', () => {
  it('lists exact immutable admitted requests without mixing task siblings', async () => {
    const bucket = new FakeR2(), store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const first = await request(), second = { ...first, requestDigest: 'b'.repeat(64), attempt: 2 }
    await store.putRequest(first)
    await store.putRequest(second)
    expect((await store.listRequests(runId, taskId)).map(value => value.requestDigest).toSorted())
      .toEqual([first.requestDigest, second.requestDigest])
    expect(await store.listRequests(runId, 'unrelated')).toEqual([])
  })
  it('seals setup-failure diagnostics beside the exact private request without overwriting them', async () => {
    const bucket = new FakeR2()
    const store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const content = JSON.stringify({ schemaVersion: 1, kind: 'workspace-preparation-failure',
      runId, taskId, requestDigest, receipt: { code: 'exit-1', stderr: 'compiler failed' } })
    const input = { runId, taskId, requestDigest, content }
    await store.putWorkspacePreparationFailure(input)
    await store.putWorkspacePreparationFailure(input)
    const object = bucket.objects.get(`${base}workspace-preparation-failure-${await sha256(content)}.json`)
    expect(object?.content).toBe(content)
    expect(object?.digest).toBe(await sha256(content))
    await store.putWorkspacePreparationFailure({ ...input, content: content + 'changed' })
    expect([...bucket.objects.keys()].filter(key => key.includes('workspace-preparation-failure-')))
      .toHaveLength(2)
  })
  it('publishes immutable request metadata and rejects changed bytes', async () => {
    const bucket = new FakeR2()
    const store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const original = await request()
    await store.putRequest(original)
    await expect(store.putRequest(original)).resolves.toBeUndefined()
    const changed = await request('Changed prompt')
    await expect(store.putRequest(changed)).rejects.toThrow('differs from existing bytes')
    const stored = bucket.objects.get(`${base}request.json`)!
    expect(stored.metadata).toMatchObject({ runId, requestDigest, objectSha256: await sha256(stored.content) })
    expect(JSON.parse(stored.content)).toMatchObject({
      prompt: 'Inspect the target',
      startedAtBasis: 'execution-admission',
      researcherProtocol: 'Private research protocol',
    })
  })

  it('appends immutable chunks, resumes from its durable cursor, and seals completion', async () => {
    const bucket = new FakeR2()
    const store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const first = line('2026-09-26T12:00:01.000Z', 'stdout', 'first')
    const second = line('2026-09-26T12:00:02.000Z', 'stderr', 'second')
    const initial = await store.sync({ runId, taskId, requestDigest, source: first, sourceOffset: 0, complete: false })
    expect(initial).toMatchObject({ chunkCount: 1, eventCount: 1, complete: false, truncated: false })
    const completed = await store.sync({ runId, taskId, requestDigest, source: second,
      sourceOffset: initial.sourceBytes, complete: true })
    expect(completed).toMatchObject({ chunkCount: 2, eventCount: 2, complete: true, truncated: false })
    expect([...bucket.objects.keys()].filter(key => key.includes('/chunk-'))).toEqual([
      `${base}chunk-000000.json`,
      `${base}chunk-000001.json`,
    ])
    expect(JSON.parse(bucket.objects.get(`${base}index.json`)!.content)).toEqual(completed)
  })

  it('recovers its cursor from immutable chunk metadata when the rolling index is absent', async () => {
    const bucket = new FakeR2()
    const store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const first = line('2026-09-26T12:00:01.000Z', 'stdout', 'first')
    const second = line('2026-09-26T12:00:02.000Z', 'stdout', 'second')
    const initial = await store.sync({ runId, taskId, requestDigest, source: first, sourceOffset: 0, complete: false })
    bucket.objects.delete(`${base}index.json`)
    const cursor = await store.cursor({ runId, taskId, requestDigest })
    const recovered = await store.sync({ runId, taskId, requestDigest, source: second,
      sourceOffset: cursor.index.sourceBytes, complete: false })
    expect(recovered).toMatchObject({ chunkCount: 2, eventCount: 2 })
    expect(cursor.index.sourceBytes).toBe(initial.sourceBytes)
  })

  it('reconciles an immutable chunk written after the rolling index before appending later output', async () => {
    const bucket = new FakeR2()
    const store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const first = line('2026-09-26T12:00:01.000Z', 'stdout', 'first')
    const second = line('2026-09-26T12:00:02.000Z', 'stdout', 'second')
    const third = line('2026-09-26T12:00:03.000Z', 'stdout', 'third')
    const initial = await store.sync({ runId, taskId, requestDigest, source: first, sourceOffset: 0, complete: false })
    const withSecond = await store.sync({ runId, taskId, requestDigest, source: second,
      sourceOffset: initial.sourceBytes, complete: false })
    const staleIndex = bucket.objects.get(`${base}index.json`)!
    staleIndex.content = JSON.stringify(initial)
    staleIndex.digest = await sha256(staleIndex.content)
    staleIndex.metadata.objectSha256 = staleIndex.digest
    const recovered = await store.sync({ runId, taskId, requestDigest, source: third,
      sourceOffset: withSecond.sourceBytes, complete: true })
    expect(recovered).toMatchObject({ chunkCount: 3, eventCount: 3, complete: true, truncated: false })
    expect(JSON.parse(bucket.objects.get(`${base}chunk-000001.json`)!.content).events[0].text).toBe('second')
    expect(JSON.parse(bucket.objects.get(`${base}chunk-000002.json`)!.content).events[0].text).toBe('third')
  })

  it('splits oversized events into valid bounded chunk objects without losing text', () => {
    const event = { at: '2026-09-26T12:00:01.000Z', stream: 'stdout' as const, text: 'x'.repeat(200_000) }
    const chunks = chunkAgentLogEvents([event])
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(chunk => new TextEncoder().encode(JSON.stringify({ schemaVersion: 1, events: chunk.events })).byteLength
      <= agentLogChunkMaxBytes)).toBe(true)
    expect(chunks.flatMap(chunk => chunk.events).map(item => item.text).join('')).toBe(event.text)
    expect(chunks.reduce((total, chunk) => total + chunk.sourceEventsConsumed, 0))
      .toBe(chunks.flatMap(chunk => chunk.events).length)
  })

  it('ignores an unfinished line until the next observation and marks terminal corruption', () => {
    const completeLine = line('2026-09-26T12:00:01.000Z', 'stdout', 'complete')
    const partial = '{"schemaVersion":1'
    expect(parseLocalAgentLog(completeLine + partial, false)).toMatchObject({
      events: [expect.objectContaining({ text: 'complete' })],
      truncated: false,
    })
    expect(parseLocalAgentLog(completeLine + partial, true)).toMatchObject({ truncated: true })
  })
})


describe('fenced native log snapshots', () => {
  it('hashes all captured chunks without promoting incomplete logs to a terminal receipt', async () => {
    const bucket = new FakeR2(), store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    await store.putRequest(await request())
    await store.sync({ runId, taskId, requestDigest,
      source: line('2026-09-26T12:00:01Z', 'stdout', 'subscription wait'), sourceOffset: 0, complete: false })
    const before = JSON.stringify([...bucket.objects])
    const custody = await store.custodySnapshot({ runId, taskId, requestDigest })
    expect(custody.index.complete).toBe(false)
    expect(custody.chunkDigests).toHaveLength(1)
    expect(custody.requestDigest).toBe(await sha256(await request()))
    expect(JSON.stringify([...bucket.objects])).toBe(before)
    bucket.objects.get(`${base}chunk-000000.json`)!.content += 'corruption'
    await expect(store.custodySnapshot({ runId, taskId, requestDigest })).rejects.toThrow()
  })
})
