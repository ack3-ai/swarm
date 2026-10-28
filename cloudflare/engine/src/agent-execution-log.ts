import { canonicalJson, sha256 } from './canonical.js'

export const agentLogChunkMaxBytes = 64 * 1024
export const agentLogTotalMaxBytes = 32 * 1024 * 1024
export const agentLogMaxChunks = 2_048

export interface AgentLogEvent {
  at: string
  stream: 'stdout' | 'stderr'
  text: string
}

export interface AgentLogRequest {
  schemaVersion: 1
  runId: string
  stageId: string
  waveId: string
  taskId: string
  requestDigest: string
  promptDigest: string
  prompt: string
  model: string
  provider: string
  attempt: number
  startedAt: string
  startedAtBasis: 'execution-admission'
  researcherProtocol?: string
}

export interface AgentLogIndex {
  schemaVersion: 1
  chunkCount: number
  eventCount: number
  sourceBytes: number
  storedBytes: number
  complete: boolean
  truncated: boolean
  updatedAt: string
}

interface ParsedLocalLog {
  events: AgentLogEvent[]
  eventSourceBytes: (number | null)[]
  sourceBytes: number
  truncated: boolean
}

const encoder = new TextEncoder()
const maxEventCharacters = 4 * 1024

function validRunId(value: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value)) throw new TypeError('agent log run id is invalid')
}

function validSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(value)) throw new TypeError(`agent log ${label} is invalid`)
}

function validDigest(value: string, label: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`agent log ${label} is invalid`)
}

function prefix(runId: string, taskId: string, requestDigest: string): string {
  validRunId(runId)
  validSegment(taskId, 'task id')
  validDigest(requestDigest, 'request digest')
  return `monitor/agent-executions/${runId}/${taskId}/${requestDigest}/`
}

function parseEvent(value: unknown, requireSchemaVersion = true): AgentLogEvent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if ((requireSchemaVersion ? record.schemaVersion !== 1 : record.schemaVersion !== undefined)
    || !['stdout', 'stderr'].includes(String(record.stream))
    || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))
    || typeof record.text !== 'string') return null
  return { at: record.at, stream: record.stream as AgentLogEvent['stream'], text: record.text }
}

function splitEvent(event: AgentLogEvent): AgentLogEvent[] {
  if (event.text === '') return [event]
  const events: AgentLogEvent[] = []
  let remaining = event.text
  while (remaining !== '') {
    let length = Math.min(maxEventCharacters, remaining.length)
    if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1] ?? '')) length -= 1
    events.push({ ...event, text: remaining.slice(0, length) })
    remaining = remaining.slice(length)
  }
  return events
}

export function parseLocalAgentLog(source: string, complete = false): ParsedLocalLog {
  const lastNewline = source.lastIndexOf('\n')
  const completeSource = lastNewline < 0 ? '' : source.slice(0, lastNewline + 1)
  const events: AgentLogEvent[] = []
  const eventSourceBytes: (number | null)[] = []
  let consumedBytes = 0
  let truncated = complete && completeSource.length !== source.length
  for (const line of completeSource.slice(0, -1).split('\n')) {
    consumedBytes += encoder.encode(`${line}\n`).byteLength
    if (line === '') continue
    try {
      const value: unknown = JSON.parse(line)
      if (value !== null && typeof value === 'object' && !Array.isArray(value)
        && (value as Record<string, unknown>).schemaVersion === 1
        && (value as Record<string, unknown>).kind === 'capture-truncated') {
        truncated = true
        continue
      }
      const event = parseEvent(value)
      if (event === null) truncated = true
      else {
        const fragments = splitEvent(event)
        events.push(...fragments)
        eventSourceBytes.push(...fragments.map((_, index) => index === fragments.length - 1 ? consumedBytes : null))
      }
    } catch {
      truncated = true
    }
  }
  return { events, eventSourceBytes, sourceBytes: encoder.encode(complete ? source : completeSource).byteLength, truncated }
}

function chunkContent(events: readonly AgentLogEvent[]): string {
  return canonicalJson({ schemaVersion: 1, events })
}

interface PendingChunk {
  events: AgentLogEvent[]
  sourceEventsConsumed: number
  sourceBytesEnd: number | null
}

function chunkEvents(events: readonly AgentLogEvent[], sourceBytes: readonly (number | null)[]): PendingChunk[] {
  const chunks: PendingChunk[] = []
  let current: AgentLogEvent[] = []
  let consumed = 0
  let sourceBytesEnd: number | null = null
  const flush = () => {
    if (current.length === 0) return
    chunks.push({ events: current, sourceEventsConsumed: consumed, sourceBytesEnd })
    current = []
    consumed = 0
    sourceBytesEnd = null
  }
  const normalized = events.flatMap((event, index) => splitEvent(event).map((fragment, fragmentIndex, fragments) => ({
    event: fragment,
    sourceBytesEnd: fragmentIndex === fragments.length - 1 ? sourceBytes[index] ?? null : null,
  })))
  for (const sourceEvent of normalized) {
    const candidate = [...current, sourceEvent.event]
    if (encoder.encode(chunkContent(candidate)).byteLength > agentLogChunkMaxBytes) flush()
    current.push(sourceEvent.event)
    consumed += 1
    if (sourceEvent.sourceBytesEnd !== null) sourceBytesEnd = sourceEvent.sourceBytesEnd
  }
  flush()
  return chunks
}

export function chunkAgentLogEvents(events: readonly AgentLogEvent[]): PendingChunk[] {
  return chunkEvents(events, events.map(() => null))
}

function parseIndex(value: unknown): AgentLogIndex | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Partial<AgentLogIndex>
  if (record.schemaVersion !== 1
    || !Number.isSafeInteger(record.chunkCount) || (record.chunkCount ?? -1) < 0 || (record.chunkCount ?? 0) > agentLogMaxChunks
    || !Number.isSafeInteger(record.eventCount) || (record.eventCount ?? -1) < 0
    || !Number.isSafeInteger(record.sourceBytes) || (record.sourceBytes ?? -1) < 0
    || !Number.isSafeInteger(record.storedBytes) || (record.storedBytes ?? -1) < 0 || (record.storedBytes ?? 0) > agentLogTotalMaxBytes
    || typeof record.complete !== 'boolean' || typeof record.truncated !== 'boolean'
    || typeof record.updatedAt !== 'string' || !Number.isFinite(Date.parse(record.updatedAt))) return null
  return record as AgentLogIndex
}

export class R2AgentExecutionLogStore {
  constructor(private readonly bucket: R2Bucket) {}

  /** Enumerate one task's immutable admitted requests for historical prompt custody. */
  async listRequests(runId: string, taskId: string): Promise<AgentLogRequest[]> {
    validRunId(runId)
    validSegment(taskId, 'task id')
    const base = `monitor/agent-executions/${runId}/${taskId}/`
    const listed = await this.bucket.list({ prefix: base, delimiter: '/', limit: 128 })
    if (listed.truncated || listed.objects.length !== 0 || listed.delimitedPrefixes.length > 64) {
      throw new Error('historical agent request listing is incomplete or ambiguous')
    }
    const requests: AgentLogRequest[] = []
    const seen = new Set<string>()
    for (const directory of listed.delimitedPrefixes) {
      if (!directory.startsWith(base) || !directory.endsWith('/')) throw new Error('historical request path is invalid')
      const digest = directory.slice(base.length, -1)
      validDigest(digest, 'request digest')
      if (seen.has(digest)) throw new Error('historical request appears more than once')
      seen.add(digest)
      const request = await this.getRequest(runId, taskId, digest)
      if (request === null) throw new Error('historical admitted request is missing')
      requests.push(request)
    }
    return requests
  }

  /** Preserve bounded setup diagnostics beside this request's private logs. */
  async putWorkspacePreparationFailure(input: {
    runId: string
    taskId: string
    requestDigest: string
    content: string
  }): Promise<void> {
    if (new TextEncoder().encode(input.content).byteLength > 64 * 1024) {
      throw new TypeError('workspace preparation failure receipt is too large')
    }
    const objectSha256 = await sha256(input.content)
    // Each failed zero-model setup can have different bounded diagnostics.
    // Immutable content keys keep a retry from blocking custody of another.
    const key = `${prefix(input.runId, input.taskId, input.requestDigest)}workspace-preparation-failure-${objectSha256}.json`
    const stored = await this.bucket.put(key, input.content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { runId: input.runId, requestDigest: input.requestDigest, objectSha256 },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored !== null) return
    await this.assertObject(key, input.runId, input.requestDigest, objectSha256, input.content)
  }

  async getRequest(runId: string, taskId: string, requestDigest: string): Promise<AgentLogRequest | null> {
    const key = `${prefix(runId, taskId, requestDigest)}request.json`
    const object = await this.bucket.get(key)
    if (object === null) return null
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.runId !== runId
      || object.customMetadata?.requestDigest !== requestDigest
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) {
      throw new Error('agent log request provenance mismatch')
    }
    const value: unknown = JSON.parse(content)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('agent log request content is invalid')
    }
    const record = value as Partial<AgentLogRequest>
    const keys = Object.keys(record)
    const allowed = new Set([
      'schemaVersion', 'runId', 'stageId', 'waveId', 'taskId', 'requestDigest', 'promptDigest', 'prompt',
      'model', 'provider', 'attempt', 'startedAt', 'startedAtBasis', 'researcherProtocol',
    ])
    if (keys.some(name => !allowed.has(name))
      || record.schemaVersion !== 1 || record.runId !== runId || record.taskId !== taskId
      || record.requestDigest !== requestDigest
      || typeof record.stageId !== 'string' || typeof record.waveId !== 'string'
      || typeof record.promptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(record.promptDigest)
      || typeof record.prompt !== 'string' || await sha256(record.prompt) !== record.promptDigest
      || typeof record.model !== 'string' || record.model.length === 0
      || typeof record.provider !== 'string' || record.provider.length === 0
      || !Number.isSafeInteger(record.attempt) || (record.attempt ?? 0) < 1
      || typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))
      || record.startedAtBasis !== 'execution-admission'
      || (record.researcherProtocol !== undefined && typeof record.researcherProtocol !== 'string')) {
      throw new Error('agent log request content is invalid')
    }
    return record as AgentLogRequest
  }

  async putRequest(request: AgentLogRequest): Promise<void> {
    validDigest(request.promptDigest, 'prompt digest')
    validSegment(request.stageId, 'stage id')
    validSegment(request.waveId, 'wave id')
    if (!Number.isSafeInteger(request.attempt) || request.attempt < 1
      || !Number.isFinite(Date.parse(request.startedAt)) || request.startedAtBasis !== 'execution-admission') {
      throw new TypeError('agent log request metadata is invalid')
    }
    if (await sha256(request.prompt) !== request.promptDigest) throw new TypeError('agent log prompt digest is invalid')
    const base = prefix(request.runId, request.taskId, request.requestDigest)
    const content = canonicalJson(request)
    const objectSha256 = await sha256(content)
    const stored = await this.bucket.put(`${base}request.json`, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { runId: request.runId, requestDigest: request.requestDigest, objectSha256 },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored !== null) return
    await this.assertObject(`${base}request.json`, request.runId, request.requestDigest, objectSha256, content)
  }

  async sync(input: {
    runId: string
    taskId: string
    requestDigest: string
    source: string
    sourceOffset: number
    complete: boolean
    updatedAt?: string
  }): Promise<AgentLogIndex> {
    const base = prefix(input.runId, input.taskId, input.requestDigest)
    const cursor = await this.cursor(input)
    if (!cursor.ready) return cursor.index
    const index = cursor.index
    if (!Number.isSafeInteger(input.sourceOffset) || input.sourceOffset !== index.sourceBytes) {
      throw new Error('agent log source offset differs from its durable cursor')
    }
    const parsed = parseLocalAgentLog(input.source, input.complete)
    let eventCount = index.eventCount
    let chunkCount = index.chunkCount
    let storedBytes = index.storedBytes
    let sourceBytes = index.sourceBytes
    let truncated = index.truncated || parsed.truncated
    const chunks = chunkEvents(parsed.events, parsed.eventSourceBytes)
    for (const chunk of chunks) {
      const content = chunkContent(chunk.events)
      const contentBytes = encoder.encode(content).byteLength
      if (chunkCount >= agentLogMaxChunks || storedBytes + contentBytes > agentLogTotalMaxBytes) {
        truncated = true
        sourceBytes = input.sourceOffset + parsed.sourceBytes
        break
      }
      const chunkSourceBytesEnd = input.sourceOffset + (chunk.sourceBytesEnd ?? 0)
      if (chunkSourceBytesEnd <= sourceBytes) throw new Error('agent log chunk does not end at a complete source event')
      const objectSha256 = await sha256(content)
      const key = `${base}chunk-${String(chunkCount).padStart(6, '0')}.json`
      const stored = await this.bucket.put(key, content, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: {
          runId: input.runId,
          requestDigest: input.requestDigest,
          objectSha256,
          sourceEventsConsumed: String(chunk.sourceEventsConsumed),
          sourceBytesEnd: String(chunkSourceBytesEnd),
        },
        sha256: objectSha256,
        onlyIf: { etagDoesNotMatch: '*' },
      })
      if (stored === null) await this.assertObject(key, input.runId, input.requestDigest, objectSha256, content)
      chunkCount += 1
      storedBytes += contentBytes
      eventCount += chunk.sourceEventsConsumed
      sourceBytes = chunkSourceBytesEnd
    }
    sourceBytes = Math.max(sourceBytes, input.sourceOffset + parsed.sourceBytes)
    const updatedAt = input.updatedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError('agent log update time is invalid')
    const next: AgentLogIndex = {
      schemaVersion: 1,
      chunkCount,
      eventCount,
      sourceBytes,
      storedBytes,
      complete: index.complete || input.complete,
      truncated,
      updatedAt,
    }
    await this.putIndex(base, input.runId, input.requestDigest, next)
    return next
  }

  async cursor(input: { runId: string, taskId: string, requestDigest: string }): Promise<{
    index: AgentLogIndex
    ready: boolean
  }> {
    const base = prefix(input.runId, input.taskId, input.requestDigest)
    let index = await this.getIndex(base, input.runId, input.requestDigest)
    if (index === null) index = await this.recoverIndex(base, input.runId, input.requestDigest)
    const reconciled = await this.reconcileSuffix(base, input.runId, input.requestDigest, index)
    if (reconciled.index.chunkCount !== index.chunkCount) {
      await this.putIndex(base, input.runId, input.requestDigest, reconciled.index)
    }
    return reconciled
  }

  async finish(input: {
    runId: string
    taskId: string
    requestDigest: string
    truncated: boolean
    updatedAt?: string
  }): Promise<AgentLogIndex> {
    const base = prefix(input.runId, input.taskId, input.requestDigest)
    const cursor = await this.cursor(input)
    if (!cursor.ready) throw new Error('agent log immutable suffix is not fully reconciled')
    const updatedAt = input.updatedAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(updatedAt))) throw new TypeError('agent log update time is invalid')
    const next = { ...cursor.index, complete: true, truncated: cursor.index.truncated || input.truncated, updatedAt }
    await this.putIndex(base, input.runId, input.requestDigest, next)
    return next
  }

  private async getIndex(base: string, runId: string, requestDigest: string): Promise<AgentLogIndex | null> {
    const object = await this.bucket.get(`${base}index.json`)
    if (object === null) return null
    const content = await object.text()
    const digest = await sha256(content)
    if (object.customMetadata?.runId !== runId || object.customMetadata?.requestDigest !== requestDigest
      || object.customMetadata?.objectSha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
      throw new Error('agent log index provenance mismatch')
    }
    const value = parseIndex(JSON.parse(content) as unknown)
    if (value === null) throw new Error('agent log index content is invalid')
    return value
  }

  private async recoverIndex(base: string, runId: string, requestDigest: string): Promise<AgentLogIndex> {
    // Missing-index recovery is deliberately bounded. cursor() reconciles the
    // next immutable suffix in fixed batches on later observation slices.
    const page = await this.bucket.list({ prefix: `${base}chunk-`, limit: 32, include: ['customMetadata'] })
    const objects = [...page.objects].sort((left, right) => left.key.localeCompare(right.key))
    let eventCount = 0
    let storedBytes = 0
    let sourceBytes = 0
    for (const [position, object] of objects.entries()) {
      const expected = `${base}chunk-${String(position).padStart(6, '0')}.json`
      if (object.key !== expected || object.customMetadata?.runId !== runId
        || object.customMetadata?.requestDigest !== requestDigest) throw new Error('agent log chunk sequence is invalid')
      const chunk = await this.readChunk(object.key, runId, requestDigest)
      if (chunk.sourceBytesEnd <= sourceBytes) throw new Error('agent log chunk source cursor is invalid')
      eventCount += chunk.sourceEventsConsumed
      storedBytes += chunk.storedBytes
      sourceBytes = chunk.sourceBytesEnd
    }
    return {
      schemaVersion: 1,
      chunkCount: objects.length,
      eventCount,
      sourceBytes,
      storedBytes,
      complete: false,
      truncated: objects.length >= agentLogMaxChunks || storedBytes >= agentLogTotalMaxBytes,
      updatedAt: new Date(0).toISOString(),
    }
  }

  private async reconcileSuffix(
    base: string,
    runId: string,
    requestDigest: string,
    index: AgentLogIndex,
  ): Promise<{ index: AgentLogIndex, ready: boolean }> {
    let next = index
    for (let count = 0; count < 32 && next.chunkCount < agentLogMaxChunks; count += 1) {
      const key = `${base}chunk-${String(next.chunkCount).padStart(6, '0')}.json`
      if (await this.bucket.head(key) === null) return { index: next, ready: true }
      const chunk = await this.readChunk(key, runId, requestDigest)
      if (chunk.sourceBytesEnd <= next.sourceBytes) throw new Error('agent log orphaned chunk source cursor is invalid')
      next = {
        ...next,
        chunkCount: next.chunkCount + 1,
        eventCount: next.eventCount + chunk.sourceEventsConsumed,
        sourceBytes: chunk.sourceBytesEnd,
        storedBytes: next.storedBytes + chunk.storedBytes,
        truncated: next.truncated || next.storedBytes + chunk.storedBytes >= agentLogTotalMaxBytes,
        updatedAt: new Date().toISOString(),
      }
    }
    const following = `${base}chunk-${String(next.chunkCount).padStart(6, '0')}.json`
    return { index: next, ready: await this.bucket.head(following) === null }
  }

  private async readChunk(key: string, runId: string, requestDigest: string): Promise<{
    sourceEventsConsumed: number
    sourceBytesEnd: number
    storedBytes: number
  }> {
    const body = await this.bucket.get(key)
    if (body === null) throw new Error('agent log chunk disappeared during recovery')
    const content = await body.text()
    const digest = await sha256(content)
    const storedBytes = encoder.encode(content).byteLength
    const consumed = Number(body.customMetadata?.sourceEventsConsumed)
    const sourceBytesEnd = Number(body.customMetadata?.sourceBytesEnd)
    if (body.customMetadata?.runId !== runId || body.customMetadata?.requestDigest !== requestDigest
      || body.customMetadata?.objectSha256 !== digest || body.checksums.toJSON().sha256 !== digest
      || storedBytes > agentLogChunkMaxBytes || !Number.isSafeInteger(consumed) || consumed < 1
      || !Number.isSafeInteger(sourceBytesEnd) || sourceBytesEnd < 1) {
      throw new Error('agent log chunk provenance mismatch')
    }
    const value: unknown = JSON.parse(content)
    const chunkEvents = value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>).events
      : undefined
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (value as Record<string, unknown>).schemaVersion !== 1
      || !Array.isArray(chunkEvents)
      || !chunkEvents.every(event => parseEvent(event, false) !== null)
      || consumed !== chunkEvents.length) throw new Error('agent log chunk content is invalid')
    return { sourceEventsConsumed: consumed, sourceBytesEnd, storedBytes }
  }

  private async putIndex(base: string, runId: string, requestDigest: string, index: AgentLogIndex): Promise<void> {
    const content = canonicalJson(index)
    const objectSha256 = await sha256(content)
    await this.bucket.put(`${base}index.json`, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { runId, requestDigest, objectSha256 },
      sha256: objectSha256,
    })
  }

  private async assertObject(
    key: string,
    runId: string,
    requestDigest: string,
    expectedSha256: string,
    expectedContent: string,
  ): Promise<void> {
    const object = await this.bucket.get(key)
    if (object === null) throw new Error('agent log immutable object disappeared')
    const content = await object.text()
    if (content !== expectedContent || object.customMetadata?.runId !== runId
      || object.customMetadata?.requestDigest !== requestDigest
      || object.customMetadata?.objectSha256 !== expectedSha256
      || object.checksums.toJSON().sha256 !== expectedSha256) {
      throw new Error('agent log immutable object differs from existing bytes')
    }
  }
}
