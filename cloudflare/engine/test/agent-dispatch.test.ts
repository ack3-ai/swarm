import { memoryR2 } from './support/memory-r2.js'
import { expect, it, vi } from 'vitest'
import { R2AgentDispatchStore } from '../src/agent-dispatch.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import type { AgentRequest } from '../src/contracts.js'
import { PermanentRunFailure, TransientRunFailure } from '../src/run-errors.js'

async function fixture() {
  const { objects, r2: bucket } = memoryR2()
  bucket.put = vi.fn(bucket.put); bucket.get = vi.fn(bucket.get)
  const request = { runId: 'synthetic-run', experimentId: 'synthetic',
    executionAuthority: { auditId: 'synthetic-audit', executionId: 'synthetic-run', epoch: 0, runtimeDigest: 'a'.repeat(64) },
    taskExecutionId: 'task-1', releaseDigest: 'b'.repeat(64),
    execution: { taskExecutionId: 'task-1', releaseDigest: 'b'.repeat(64) },
    task: { id: 'research-1', connection: { apiKeyEnv: 'SYNTHETIC_API_KEY' } },
    stage: { id: 'discovery' }, wave: { id: 'wave-1' }, prompt: 'synthetic instructions',
    promptDigest: await sha256('synthetic instructions'), attempt: 1,
    visibleArtifacts: [], diagnostics: [], repairFiles: {}, freshContext: true, continuationMode: 'new', sessionId: null,
  } as unknown as AgentRequest
  return { objects, bucket: vi.mocked(bucket), store: new R2AgentDispatchStore(bucket as unknown as R2Bucket), request,
    digest: await sha256(request), native: 'c'.repeat(64) }
}

it('preserves exact private dispatch bytes and refuses another native projection for the same admission', async () => {
  const f = await fixture()
  await f.store.put(f.request, f.native)
  const before = structuredClone([...f.objects])
  await f.store.put(structuredClone(f.request), f.native)
  expect([...f.objects]).toEqual(before)
  expect(f.bucket.put).toHaveBeenCalledTimes(1)
  expect(f.bucket.put.mock.calls[0]![2]!.onlyIf).toEqual({ etagDoesNotMatch: '*' })
  expect(await f.store.get(f.request.runId, f.digest)).toEqual({ schemaVersion: 1,
    dispatchDigest: f.digest, nativeRequestDigest: f.native, request: f.request })
  await expect(f.store.put(f.request, 'd'.repeat(64))).rejects.toBeInstanceOf(PermanentRunFailure)
  expect([...f.objects]).toEqual(before)
  expect(await f.store.get('another-run', f.digest)).toBeNull()
  expect(await f.store.get(f.request.runId, 'e'.repeat(64))).toBeNull()
})

it.each([false, true])('reconciles a lost PUT acknowledgement only when exact bytes exist (committed: %s)', async committed => {
  const f = await fixture(), put = f.bucket.put.getMockImplementation()!
  f.bucket.put.mockImplementation(async (...args) => {
    if (committed) await put(...args)
    throw new Error('lost PUT response')
  })
  if (committed) await f.store.put(f.request, f.native)
  else await expect(f.store.put(f.request, f.native)).rejects.toBeInstanceOf(TransientRunFailure)
  expect(f.bucket.put).toHaveBeenCalledTimes(1)
  expect(f.bucket.get).toHaveBeenCalledTimes(2)
})

it('does not confuse unreadable evidence with missing evidence', async () => {
  const f = await fixture()
  f.bucket.get.mockRejectedValue(new Error('R2 unavailable'))
  await expect(f.store.get(f.request.runId, f.digest)).rejects.toBeInstanceOf(TransientRunFailure)
})

it.each(['body', 'metadata', 'checksum', 'native', 'request', 'schema', 'identity'])('rejects altered %s evidence', async field => {
  const f = await fixture()
  await f.store.put(f.request, f.native)
  const object = [...f.objects.values()][0]!
  if (field === 'body') object.content += ' '
  if (field === 'metadata') object.customMetadata.dispatchDigest = 'e'.repeat(64)
  if (field === 'checksum') object.checksum = 'e'.repeat(64)
  if (field === 'native') object.customMetadata.nativeRequestDigest = 'e'.repeat(64)
  if (['request', 'schema', 'identity'].includes(field)) {
    const value = JSON.parse(object.content)
    if (field === 'request') value.request.prompt = 'changed'
    if (field === 'schema') value.schemaVersion = 2
    if (field === 'identity') value.request.runId = 'another-run'
    object.content = canonicalJson(value)
    object.checksum = object.customMetadata.objectSha256 = await sha256(object.content)
  }
  await expect(f.store.get(f.request.runId, f.digest)).rejects.toBeInstanceOf(PermanentRunFailure)
  await expect(f.store.put(f.request, f.native)).rejects.toBeInstanceOf(PermanentRunFailure)
})

it('freezes the full request before asynchronous storage', async () => {
  const f = await fixture(), original = structuredClone(f.request)
  const write = f.store.put(f.request, f.native)
  f.request.prompt = 'later caller mutation'
  await write
  expect((await f.store.get(original.runId, f.digest))!.request).toEqual(original)
})

it('refuses requests without controlled execution provenance before writing', async () => {
  const f = await fixture()
  delete f.request.executionAuthority
  await expect(f.store.put(f.request, f.native)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect(f.bucket.put).not.toHaveBeenCalled()
})
