import type { RuntimeRelease } from './contracts.js'
import { sha256 } from './canonical.js'
const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/

export interface RuntimeFixtureCheckpointBody {
  schemaVersion: 1
  fixtureId: string
  runtimeRelease: RuntimeRelease
  parentCheckpointDigest: string | null
  containerBuildFingerprint: string
  finishedAt: string
}

export const fixtureCheckpointKey = (digest: string) => `checkpoints/sha256/${digest}.runtime-isolation.json`

export async function readFixtureCheckpoint(bucket: R2Bucket, digest: string): Promise<RuntimeFixtureCheckpointBody> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('runtime fixture checkpoint digest is invalid')
  const object = await bucket.get(fixtureCheckpointKey(digest))
  if (object === null) throw new Error(`runtime fixture checkpoint is missing: ${digest}`)
  const content = await object.text()
  const objectDigest = await sha256(content)
  const sealed = JSON.parse(content) as { digest?: string, body?: RuntimeFixtureCheckpointBody }
  if (sealed.digest !== digest || sealed.body === undefined || await sha256(sealed.body) !== digest
    || object.customMetadata?.bodySha256 !== digest
    || object.customMetadata?.objectSha256 !== objectDigest
    || object.checksums.toJSON().sha256 !== objectDigest) {
    throw new Error(`runtime fixture checkpoint integrity failed: ${digest}`)
  }
  if (sealed.body.schemaVersion !== 1 || !runIdPattern.test(sealed.body.fixtureId)
    || !/^[0-9a-f]{64}$/.test(sealed.body.containerBuildFingerprint)) {
    throw new Error(`runtime fixture checkpoint is invalid: ${digest}`)
  }
  return sealed.body
}
