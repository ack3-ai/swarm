import { memoryR2 } from './support/memory-r2.js'
import { expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { R2ArtifactStore } from '../src/cloudflare-storage.js'
import { TransientRunFailure } from '../src/run-errors.js'

function fixture() {
  const { objects, r2: bucket } = memoryR2()
  return { objects, bucket, store: new R2ArtifactStore(bucket as unknown as R2Bucket) }
}

it('stores a canonical content-addressed read set with conditional immutable writes', async () => {
  const { store, objects, bucket } = fixture()
  const writes = vi.spyOn(bucket, 'put')
  const refs = [{ id: 'z', contentDigest: 'a'.repeat(64) }, { id: 'a', contentDigest: 'b'.repeat(64) }]
  const digest = await store.putExecutionInputs(refs)
  expect(await store.putExecutionInputs([...refs].reverse())).toBe(digest)
  expect(objects.size).toBe(1)
  expect(writes.mock.calls.every(([, , options]) => options?.onlyIf !== undefined
    && (options.onlyIf as R2Conditional).etagDoesNotMatch === '*')).toBe(true)
  expect(await store.readExecutionInputs(digest)).toEqual([...refs].reverse())
  expect(digest).toBe(await sha256([...refs].reverse()))
})

it('rejects missing or corrupted read sets rather than making selective reuse assumptions', async () => {
  for (const corruption of ['content', 'metadata', 'checksum', 'missing'] as const) {
    const { store, objects } = fixture()
    const digest = await store.putExecutionInputs([{ id: 'a', contentDigest: 'b'.repeat(64) }])
    const [key, object] = [...objects.entries()][0]!
    if (corruption === 'content') object.content = '[]'
    if (corruption === 'metadata') object.customMetadata.sha256 = 'f'.repeat(64)
    if (corruption === 'checksum') object.checksum = 'f'.repeat(64)
    if (corruption === 'missing') objects.delete(key)
    await expect(store.readExecutionInputs(digest)).rejects.toThrow(/missing|digest mismatch/)
  }
})

it('rejects structurally invalid manifests even with matching checksums', async () => {
  const { store, objects } = fixture()
  for (const refs of [null, [{ id: 'a', contentDigest: 'invalid' }],
    [{ id: 'a', contentDigest: 'b'.repeat(64), unexpected: true }]]) {
    const content = canonicalJson(refs), digest = await sha256(content)
    objects.set(`execution-inputs/sha256/${digest}.json`, { content, customMetadata: { sha256: digest }, checksum: digest })
    await expect(store.readExecutionInputs(digest)).rejects.toThrow('manifest is invalid')
  }
})

it('classifies write unavailability as transient without changing input identity', async () => {
  const { store, bucket } = fixture()
  bucket.put = async () => { throw new Error('injected unavailable storage') }
  await expect(store.putExecutionInputs([])).rejects.toBeInstanceOf(TransientRunFailure)
})


it('reuses committed immutable artifact bytes after a lost state write or racing locked put', async () => {
  const { store, bucket, objects } = fixture()
  const content = canonicalJson({ report: 'saved output' })
  const digest = await sha256(content)
  const record = { id: 'reporting/report/reporter/' + digest.slice(0, 16),
    taskId: 'reporter', contentDigest: digest } as Parameters<typeof store.put>[0]
  const key = `artifacts/${record.id}.json`
  const value = { content, customMetadata: { sha256: digest, task: record.taskId }, checksum: digest }
  let writes = 0
  const lockedBucket = bucket as typeof bucket & { head: (key: string) => Promise<unknown> }
  lockedBucket.head = async key => objects.has(key) ? {} : null
  bucket.put = async () => {
    writes++
    objects.set(key, value)
    throw new Error('put: The object is locked by the bucket policy. (10069)')
  }
  await expect(store.put(record, content)).resolves.toMatchObject({ contentDigest: digest })
  await expect(store.put(record, content)).resolves.toMatchObject({ contentDigest: digest })
  expect(writes).toBe(1)
  await expect(store.put(record, canonicalJson({ report: 'different output' }))).rejects.toThrow('artifact submission digest mismatch')
  value.content = 'corrupted'
  await expect(store.put(record, content)).rejects.toThrow('artifact content digest mismatch')
  objects.clear()
  bucket.put = async () => { throw new Error('storage unavailable') }
  await expect(store.put(record, content)).rejects.toThrow('storage unavailable')
})

it.each(['inputs', 'quarantine'] as const)('reconciles a lost %s write and refuses conflicting metadata without overwriting', async kind => {
  const { store, bucket, objects } = fixture()
  const content = canonicalJson({ report: 'quarantined output' }), digest = await sha256(content)
  const publish = () => kind === 'inputs'
    ? store.putExecutionInputs([{ id: 'retained', contentDigest: digest }])
    : store.putRejected({ id: 'rejected-output', taskId: 'reporter', contentDigest: digest }, content)
  const put = bucket.put.bind(bucket)
  let writes = 0
  bucket.put = async (key, bytes, options) => {
    writes++
    await put(key, bytes, options)
    throw new Error('lost write acknowledgement')
  }
  const first = await publish()
  expect(await publish()).toBe(first)
  expect(writes).toBe(1)
  const object = [...objects.values()][0]!
  const original = object.content
  if (kind === 'inputs') object.customMetadata.sha256 = 'f'.repeat(64)
  else object.customMetadata.task = 'unrelated-task'
  await expect(publish()).rejects.toThrow('metadata differs')
  expect(object.content).toBe(original)
  expect(writes).toBe(1)
})
