import { canonicalJson, sha256 } from './canonical.js'

export const observationFailureSpacingMs = 2 * 60_000
export const observationIncidentMinimumMs = 10 * 60_000
export const observationIncidentFailureCount = 3
export const observationIncidentPollMs = 5 * 60_000
export const observationHealthIoMs = 2_000

export interface AgentObservationIdentity {
  runId: string
  stageId: string
  waveId: string
  taskId: string
  attempt: number
  promptDigest: string
}

export interface AgentObservationHealth {
  schemaVersion: 1
  identity: AgentObservationIdentity
  requestDigest: string
  firstFailedAt: string | null
  lastFailedAt: string | null
  consecutiveFailures: number
  lastSuccessfulProcessAt: string | null
  incidentSince: string | null
  lastFailedOperation: string | null
  nextObservationAfter: string | null
}

function validateIdentity(identity: AgentObservationIdentity): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(identity.runId)
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1
    || !/^[a-f0-9]{64}$/.test(identity.promptDigest)
    || [identity.stageId, identity.waveId, identity.taskId].some(value =>
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(value))) {
    throw new TypeError('agent observation identity is invalid')
  }
}

async function healthKey(identity: AgentObservationIdentity): Promise<string> {
  validateIdentity(identity)
  return `quarantine/execution-observation-health/${identity.runId}/${await sha256(canonicalJson(identity))}.json`
}

function fresh(identity: AgentObservationIdentity, requestDigest: string): AgentObservationHealth {
  return {
    schemaVersion: 1, identity, requestDigest,
    firstFailedAt: null, lastFailedAt: null, consecutiveFailures: 0,
    lastSuccessfulProcessAt: null, incidentSince: null,
    lastFailedOperation: null, nextObservationAfter: null,
  }
}

function validTimestamp(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validateRecord(value: unknown, identity: AgentObservationIdentity): AgentObservationHealth {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent observation health is invalid')
  const record = value as AgentObservationHealth
  if (record.schemaVersion !== 1 || canonicalJson(record.identity) !== canonicalJson(identity)
    || !/^[a-f0-9]{64}$/.test(record.requestDigest)
    || !Number.isSafeInteger(record.consecutiveFailures) || record.consecutiveFailures < 0
    || !validTimestamp(record.firstFailedAt) || !validTimestamp(record.lastFailedAt)
    || !validTimestamp(record.lastSuccessfulProcessAt) || !validTimestamp(record.incidentSince)
    || !validTimestamp(record.nextObservationAfter)
    || record.lastFailedOperation !== null && typeof record.lastFailedOperation !== 'string') {
    throw new Error('agent observation health is invalid')
  }
  return record
}

async function boundedIo<T>(operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('agent observation health I/O deadline exceeded')),
          observationHealthIoMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function loadHealth(bucket: Pick<R2Bucket, 'get'>, identity: AgentObservationIdentity): Promise<{
  record: AgentObservationHealth | null, etag: string | null,
}> {
  const key = await healthKey(identity)
  const object = await boundedIo(() => bucket.get(key))
  if (object === null) return { record: null, etag: null }
  const content = await boundedIo(() => object.text())
  const objectSha256 = await sha256(content)
  if (object.customMetadata?.objectSha256 !== objectSha256
    || object.checksums.toJSON().sha256 !== objectSha256) {
    throw new Error('agent observation health provenance mismatch')
  }
  return { record: validateRecord(JSON.parse(content) as unknown, identity), etag: object.etag }
}

/** Exact-attempt observation status. It never authorizes replacement or revocation. */
export async function readAgentObservationHealth(
  bucket: Pick<R2Bucket, 'get'>, identity: AgentObservationIdentity,
): Promise<AgentObservationHealth | null> {
  return (await loadHealth(bucket, identity)).record
}

export class R2AgentObservationHealthStore {
  constructor(private readonly bucket: Pick<R2Bucket, 'get' | 'put'>) {}

  async get(identity: AgentObservationIdentity): Promise<AgentObservationHealth | null> {
    return readAgentObservationHealth(this.bucket, identity)
  }

  private async update(identity: AgentObservationIdentity, requestDigest: string,
    change: (previous: AgentObservationHealth) => AgentObservationHealth): Promise<AgentObservationHealth> {
    for (let conflict = 0; conflict < 3; conflict += 1) {
      const loaded = await loadHealth(this.bucket, identity)
      const previous = loaded.record ?? fresh(identity, requestDigest)
      if (previous.requestDigest !== requestDigest) throw new Error('agent observation request digest changed')
      const next = change(previous)
      if (next === previous) return previous
      const content = canonicalJson(next)
      const objectSha256 = await sha256(content)
      const key = await healthKey(identity)
      const saved = await boundedIo(() => this.bucket.put(key, content, {
        onlyIf: loaded.etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: loaded.etag },
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { objectSha256, disposition: 'read-only-observation-health' },
        sha256: objectSha256,
      }))
      if (saved !== null) return next
    }
    throw new Error('agent observation health changed concurrently')
  }

  async recordFailure(identity: AgentObservationIdentity, requestDigest: string,
    operation: string, now = new Date()): Promise<AgentObservationHealth> {
    if (!/^[a-f0-9]{64}$/.test(requestDigest) || !/^[a-z][a-z-]{0,79}$/.test(operation)) {
      throw new TypeError('agent observation failure identity is invalid')
    }
    const at = now.toISOString()
    return this.update(identity, requestDigest, previous => {
      if (previous.lastSuccessfulProcessAt !== null && at <= previous.lastSuccessfulProcessAt
        || previous.lastFailedAt !== null && at < previous.lastFailedAt) return previous
      const distinct = previous.lastFailedAt === null
        || now.getTime() - Date.parse(previous.lastFailedAt) >= observationFailureSpacingMs
      const consecutiveFailures = previous.consecutiveFailures + Number(distinct)
      const firstFailedAt = previous.firstFailedAt ?? at
      const unresolved = previous.incidentSince !== null || consecutiveFailures >= observationIncidentFailureCount
        && now.getTime() - Date.parse(firstFailedAt) >= observationIncidentMinimumMs
      return { ...previous, firstFailedAt, lastFailedAt: at, consecutiveFailures,
        incidentSince: previous.incidentSince ?? (unresolved ? at : null),
        lastFailedOperation: operation,
        nextObservationAfter: new Date(now.getTime() + (unresolved
          ? observationIncidentPollMs : observationFailureSpacingMs)).toISOString(),
      }
    })
  }

  async recordProcessSuccess(identity: AgentObservationIdentity, requestDigest: string,
    now = new Date()): Promise<AgentObservationHealth> {
    return this.update(identity, requestDigest, previous => {
      const at = now.toISOString()
      if (previous.lastFailedAt !== null && at <= previous.lastFailedAt
        || previous.lastSuccessfulProcessAt !== null && at <= previous.lastSuccessfulProcessAt) return previous
    return { ...previous, firstFailedAt: null, lastFailedAt: null,
        consecutiveFailures: 0, lastSuccessfulProcessAt: at,
        incidentSince: null, lastFailedOperation: null, nextObservationAfter: null }
    })
  }
}
