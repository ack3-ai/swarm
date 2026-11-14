import { publishImmutableObject } from './immutable-object.js'
import type { AgentRequest } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertExecutionAuthority } from './execution-authority.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

/** Private execution evidence, not configuration or permission to launch. The
 * full admitted request and its native projection have different identities. */
export interface AgentDispatch {
  schemaVersion: 1
  dispatchDigest: string
  nativeRequestDigest: string
  request: AgentRequest
}

const digestPattern = /^[a-f0-9]{64}$/
function key(runId: string, digest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId) || !digestPattern.test(digest)) {
    throw new TypeError('agent dispatch identity is invalid')
  }
  return `control/dispatches/${runId}/${digest}.json`
}

function invalid(): PermanentRunFailure {
  return new PermanentRunFailure('agent dispatch evidence is inconsistent', 'integrity-failed')
}

async function validate(value: AgentDispatch, runId: string, dispatchDigest: string): Promise<void> {
  try {
    const request = value.request
    if (value.schemaVersion !== 1 || value.dispatchDigest !== dispatchDigest
      || !digestPattern.test(value.nativeRequestDigest) || request.runId !== runId
      || request.executionAuthority === undefined || request.executionAuthority.executionId !== runId
      || request.execution === undefined || request.execution.taskExecutionId !== request.taskExecutionId
      || request.execution.releaseDigest !== request.releaseDigest
      || request.promptDigest !== await sha256(request.prompt)
      || await sha256(request) !== dispatchDigest) throw invalid()
    assertExecutionAuthority(request.executionAuthority)
  } catch { throw invalid() }
}

export class R2AgentDispatchStore {
  constructor(private readonly bucket: R2Bucket) {}

  /** Persist only the AgentRequest, never resolved credentials/process env.
   * Admission validation belongs to the caller; an orphan object is harmless. */
  async put(request: AgentRequest, nativeRequestDigest: string): Promise<void> {
    // Freeze before the first await so metadata, digest and bytes describe the
    // same request even if a caller subsequently reuses its object.
    const saved: AgentRequest = JSON.parse(canonicalJson(request))
    const dispatchDigest = await sha256(saved)
    const objectKey = key(saved.runId, dispatchDigest)
    const value: AgentDispatch = { schemaVersion: 1, dispatchDigest, nativeRequestDigest, request: saved }
    await validate(value, saved.runId, dispatchDigest)
    const content = canonicalJson(value), objectSha256 = await sha256(content)
    await publishImmutableObject(this.bucket, objectKey, content, objectSha256,
      { runId: saved.runId, dispatchDigest, nativeRequestDigest, objectSha256 })
  }

  /** Historical evidence remains readable after fencing or task completion. */
  async get(runId: string, dispatchDigest: string): Promise<AgentDispatch | null> {
    const objectKey = key(runId, dispatchDigest)
    let object: R2ObjectBody | null, content: string
    try {
      object = await this.bucket.get(objectKey)
      if (object === null) return null
      content = await object.text()
    } catch (cause) { throw new TransientRunFailure('agent dispatch evidence read failed', { cause }) }
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.runId !== runId || object.customMetadata?.dispatchDigest !== dispatchDigest
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) throw invalid()
    let value: AgentDispatch
    try { value = JSON.parse(content) } catch { throw invalid() }
    await validate(value, runId, dispatchDigest)
    if (object.customMetadata?.nativeRequestDigest !== value.nativeRequestDigest
      || canonicalJson(value) !== content) throw invalid()
    return value
  }
}
