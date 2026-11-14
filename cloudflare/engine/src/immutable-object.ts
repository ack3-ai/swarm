import { sha256 } from './canonical.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

/** Exact immutable writes reconcile lost acknowledgements without repeating their caller’s effect. */
export async function publishImmutableObject(bucket: R2Bucket, key: string, content: string, digest: string, metadata: Record<string, string>): Promise<void> {
  const expected = { ...metadata }
  let object: R2ObjectBody | null, saved: string
  try {
    object = await bucket.get(key)
    if (object === null) {
      try {
        await bucket.put(key, content, { httpMetadata: { contentType: 'application/json' },
          customMetadata: expected, sha256: digest, onlyIf: { etagDoesNotMatch: '*' } })
      } catch { /* A lost acknowledgement or bucket lock is reconciled by exact readback. */ }
      object = await bucket.get(key)
    }
    if (object === null) throw new Error('immutable write has no durable object')
    saved = await object.text()
  } catch (cause) { throw new TransientRunFailure('immutable artifact storage unavailable', { cause }) }
  if (saved !== content || await sha256(saved) !== digest || object.checksums.toJSON().sha256 !== digest
    || Object.entries(expected).some(([key, value]) => object.customMetadata?.[key] !== value)) {
    throw new PermanentRunFailure('artifact content digest mismatch or metadata differs', 'integrity-failed')
  }
}

