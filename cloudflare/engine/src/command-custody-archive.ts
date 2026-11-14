import type { RunOperation } from './run-command-journal.js'
import { canonicalJson, sha256 } from './canonical.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

export async function readCustodyArchive(bucket: R2Bucket, operation: RunOperation, digest: string): Promise<unknown> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new PermanentRunFailure('command proof digest is invalid', 'integrity-failed')
  const object = await bucket.get(`control/custody/${operation.auditId}/${operation.commandDigest}/${digest}.json`)
  if (object === null) throw new TransientRunFailure('command custody proof is unavailable')
  const content = await object.text()
  let value: unknown
  try { value = JSON.parse(content) }
  catch (cause) { throw new PermanentRunFailure('command custody proof is invalid', 'integrity-failed', { cause }) }
  if (await sha256(content) !== digest || canonicalJson(value) !== content
    || object.customMetadata?.auditId !== operation.auditId || object.customMetadata?.commandDigest !== operation.commandDigest
    || object.customMetadata?.sha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
    throw new PermanentRunFailure('command custody proof bytes differ', 'integrity-failed')
  }
  return value
}

