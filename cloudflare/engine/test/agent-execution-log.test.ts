import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/canonical.js'
import {
  agentLogChunkMaxBytes,
  parseLocalAgentLog,
  R2AgentExecutionLogStore,
  readAgentLogIndex,
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

  it('persists native events in bounded chunks without losing text', async () => {
    const bucket = new FakeR2(), store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const event = { at: '2026-09-26T12:00:01.000Z', stream: 'stdout' as const, text: 'x'.repeat(4 * 1024) }
    const source = (JSON.stringify({ schemaVersion: 1, ...event }) + '\n').repeat(64)
    const index = await store.sync({ runId, taskId, requestDigest, source, sourceOffset: 0, complete: true })
    const chunks = [...bucket.objects].filter(([key]) => key.includes('/chunk-')).map(([, value]) => value.content)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every(content => new TextEncoder().encode(content).byteLength <= agentLogChunkMaxBytes)).toBe(true)
    expect(chunks.flatMap(content => JSON.parse(content).events).map(item => item.text).join('')).toBe(event.text.repeat(64))
    expect(index).toMatchObject({ sourceBytes: new TextEncoder().encode(source).byteLength, complete: true, truncated: false })
  })

  it('keeps a reported quota wait in the index until it ends or the log completes', async () => {
    const bucket = new FakeR2(), store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    const wait = (at: string, resetsAt: string | null) =>
      `${JSON.stringify({ schemaVersion: 1, kind: 'subscription-wait', at, provider: 'claude', resetsAt })}\n`
    const read = () => readAgentLogIndex(bucket as unknown as R2Bucket, { runId, taskId, requestDigest })
    const before = await store.sync({ runId, taskId, requestDigest, complete: false, sourceOffset: 0,
      source: line('2026-11-06T09:00:00.000Z', 'stdout', 'working\n') })
    expect(before.subscriptionWait).toBeUndefined()
    const waiting = await store.sync({ runId, taskId, requestDigest, complete: false, sourceOffset: before.sourceBytes,
      source: wait('2026-11-06T09:01:00.000Z', '2026-11-10T08:00:00.000Z') })
    const open = { provider: 'claude', since: '2026-11-06T09:01:00.000Z', resetsAt: '2026-11-10T08:00:00.000Z' }
    expect(waiting).toMatchObject({ chunkCount: 1, eventCount: 1, subscriptionWait: open })
    // Later observations without a status line keep the open wait.
    const quiet = await store.sync({ runId, taskId, requestDigest, complete: false,
      sourceOffset: waiting.sourceBytes, source: '' })
    expect(quiet.subscriptionWait).toEqual(open)
    expect((await read())?.subscriptionWait).toEqual(open)
    const resumed = await store.sync({ runId, taskId, requestDigest, complete: false, sourceOffset: quiet.sourceBytes,
      source: wait('2026-11-10T08:00:01.000Z', null) + line('2026-11-10T08:00:02.000Z', 'stdout', 'resumed\n') })
    expect(resumed.subscriptionWait).toBeUndefined()
    expect(resumed.eventCount).toBe(2)
    const again = await store.sync({ runId, taskId, requestDigest, complete: false, sourceOffset: resumed.sourceBytes,
      source: wait('2026-11-10T08:01:00.000Z', '2026-11-10T13:00:00.000Z') })
    expect(again.subscriptionWait).toMatchObject({ resetsAt: '2026-11-10T13:00:00.000Z' })
    expect((await store.finish({ runId, taskId, requestDigest, truncated: false })).subscriptionWait).toBeUndefined()
    expect(await read()).toMatchObject({ complete: true })
    expect((await read())?.subscriptionWait).toBeUndefined()
  })

  it('treats a malformed wait status like other corrupt capture lines and reads older indexes', async () => {
    const malformed = `${JSON.stringify({ schemaVersion: 1, kind: 'subscription-wait', at: '2026-11-06T09:01:00.000Z',
      provider: 'codex', resetsAt: '2026-11-10T08:00:00.000Z' })}\n`
    expect(parseLocalAgentLog(malformed)).toMatchObject({ events: [], truncated: true })
    expect(parseLocalAgentLog(malformed).subscriptionWait).toBeUndefined()
    const bucket = new FakeR2(), store = new R2AgentExecutionLogStore(bucket as unknown as R2Bucket)
    // An index written before this field existed has no wait and stays valid.
    await store.sync({ runId, taskId, requestDigest, complete: false, sourceOffset: 0,
      source: line('2026-11-06T09:00:00.000Z', 'stdout', 'working\n') })
    expect(JSON.parse(bucket.objects.get(`${base}index.json`)!.content)).not.toHaveProperty('subscriptionWait')
    expect(await readAgentLogIndex(bucket as unknown as R2Bucket, { runId, taskId, requestDigest }))
      .toMatchObject({ chunkCount: 1, complete: false })
    expect(await readAgentLogIndex(bucket as unknown as R2Bucket, { runId, taskId: 'research-2', requestDigest })).toBeNull()
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
