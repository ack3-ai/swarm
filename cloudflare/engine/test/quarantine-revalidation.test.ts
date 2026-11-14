import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { R2ArtifactStore } from '../src/cloudflare-storage.js'
import { TransientRunFailure } from '../src/run-errors.js'

interface StoredObject {
  content: string
  customMetadata: Record<string, string>
  checksum: string
}

class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>()

  async put(key: string, value: string, options: R2PutOptions = {}): Promise<unknown> {
    const content = String(value)
    const checksum = typeof options.sha256 === 'string' ? options.sha256 : await sha256(content)
    this.objects.set(key, { content, customMetadata: options.customMetadata ?? {}, checksum })
    return {}
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    return {
      customMetadata: stored.customMetadata,
      checksums: { toJSON: () => ({ sha256: stored.checksum }) },
      text: async () => stored.content,
    } as unknown as R2ObjectBody
  }
}

describe('quarantined attempt revalidation', () => {
  it('classifies only a failed quarantine write as transient', async () => {
    const content = canonicalJson({ 'verification.md': 'evidence' })
    const digest = await sha256(content)
    const bucket = new FakeR2Bucket()
    const store = new R2ArtifactStore(bucket as unknown as R2Bucket)
    const record = { id: 'verification/task/attempt-1', taskId: 'verifier', contentDigest: digest }
    const originalPut = bucket.put.bind(bucket)
    bucket.put = async () => { throw new Error('synthetic R2 connection reset') }
    await expect(store.putRejected(record, content)).rejects.toBeInstanceOf(TransientRunFailure)
    await expect(store.putRejected({ ...record, contentDigest: '0'.repeat(64) }, content))
      .rejects.toThrow('rejected artifact digest mismatch')
    bucket.put = originalPut
    await expect(store.putRejected(record, content)).resolves.toContain('r2://ARTIFACTS/quarantine/')
  })

  it('rejects changed quarantine bytes and metadata', async () => {
    const bucket = new FakeR2Bucket()
    const store = new R2ArtifactStore(bucket as unknown as R2Bucket)
    const content = canonicalJson({ 'verification.md': 'evidence' })
    const digest = await sha256(content)
    const uri = await store.putRejected({ id: `verification/task/${digest}`, taskId: 'verifier', contentDigest: digest }, content)
    bucket.objects.get(uri.slice('r2://ARTIFACTS/'.length))!.customMetadata.task = 'other-task'
    await expect(store.readRejected(uri, digest, 'verifier')).rejects.toThrow('provenance mismatch')
  })

})
