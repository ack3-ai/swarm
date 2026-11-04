import { expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { R2ArtifactStore } from '../src/cloudflare-storage.js'

function fixture() {
  const objects = new Map<string, { content: string; metadata: Record<string, string>; checksum: string }>()
  const writes: R2PutOptions[] = []
  const bucket = {
    async put(key: string, content: string, options: R2PutOptions) {
      writes.push(options)
      if (objects.has(key)) return null
      objects.set(key, { content, metadata: options.customMetadata!, checksum: options.sha256 as string })
      return {}
    },
    async get(key: string) {
      const object = objects.get(key)
      return object === undefined ? null : { text: async () => object.content,
        customMetadata: object.metadata, checksums: { toJSON: () => ({ sha256: object.checksum }) } }
    },
  }
  return { objects, writes, bucket, store: new R2ArtifactStore(bucket as unknown as R2Bucket) }
}
it('reuses committed immutable artifact bytes after a lost state write or racing locked put', async () => {
  const { store, bucket, objects } = fixture()
  const content = canonicalJson({ report: 'saved output' })
  const digest = await sha256(content)
  const record = { id: 'reporting/report/reporter/' + digest.slice(0, 16),
    taskId: 'reporter', contentDigest: digest } as Parameters<typeof store.put>[0]
  const key = `artifacts/${record.id}.json`
  const value = { content, metadata: { sha256: digest }, checksum: digest }
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
