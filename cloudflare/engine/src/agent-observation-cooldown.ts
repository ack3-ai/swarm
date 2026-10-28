import { canonicalJson, sha256 } from './canonical.js'

// This limits repeat observation rate, not physical RPC concurrency: a timed
// out SDK call may still exist. Keep the delay short so a locally completed
// receipt can be picked up promptly on the next poll.
export const expiredObservationCooldownMs = 2 * 60_000

function cooldownKey(runId: string, requestDigest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('observation run id is invalid')
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('observation request digest is invalid')
  return `quarantine/execution-observation-cooldowns/${runId}/${requestDigest}.json`
}

/** Rate-limit repeated SDK observations of one exact admitted request across Workflow polls. */
export class R2AgentObservationCooldownStore {
  constructor(private readonly bucket: R2Bucket) {}

  async get(runId: string, requestDigest: string): Promise<number | null> {
    const object = await this.bucket.get(cooldownKey(runId, requestDigest))
    if (object === null) return null
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.runId !== runId
      || object.customMetadata?.requestDigest !== requestDigest
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) {
      throw new Error('agent observation cooldown provenance mismatch')
    }
    const value: unknown = JSON.parse(content)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('agent observation cooldown content is invalid')
    }
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== 1 || record.runId !== runId || record.requestDigest !== requestDigest
      || !Number.isSafeInteger(record.retryAfter)) {
      throw new Error('agent observation cooldown content is invalid')
    }
    return Number(record.retryAfter)
  }

  async put(runId: string, requestDigest: string, retryAfter: number): Promise<void> {
    if (!Number.isSafeInteger(retryAfter) || retryAfter <= Date.now()) {
      throw new TypeError('agent observation cooldown deadline is invalid')
    }
    const content = canonicalJson({ schemaVersion: 1, runId, requestDigest, retryAfter })
    const objectSha256 = await sha256(content)
    await this.bucket.put(cooldownKey(runId, requestDigest), content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { runId, requestDigest, objectSha256, disposition: 'observation-rate-limit' },
      sha256: objectSha256,
    })
  }
}
