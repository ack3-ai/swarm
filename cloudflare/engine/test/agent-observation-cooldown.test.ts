import { expect, it } from 'vitest'
import { R2AgentObservationCooldownStore } from '../src/agent-observation-cooldown.js'

class FakeR2 {
  readonly objects = new Map<string, { content: string, options: R2PutOptions }>()

  async put(key: string, content: string, options: R2PutOptions): Promise<object> {
    this.objects.set(key, { content, options })
    return {}
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key)
    if (object === undefined) return null
    return {
      text: async () => object.content,
      customMetadata: object.options.customMetadata,
      checksums: { toJSON: () => ({ sha256: object.options.sha256 }) },
    } as unknown as R2ObjectBody
  }
}

it('retains a request-bound cooldown across store reconstruction', async () => {
  const bucket = new FakeR2()
  const first = new R2AgentObservationCooldownStore(bucket as unknown as R2Bucket)
  const second = new R2AgentObservationCooldownStore(bucket as unknown as R2Bucket)
  const digest = 'a'.repeat(64)
  const retryAfter = Date.now() + 60_000
  await first.put('run-1', digest, retryAfter)
  expect(await second.get('run-1', digest)).toBe(retryAfter)
  expect(await second.get('run-1', 'b'.repeat(64))).toBeNull()
  bucket.objects.get(`quarantine/execution-observation-cooldowns/run-1/${digest}.json`)!.content += ' '
  await expect(second.get('run-1', digest)).rejects.toThrow('provenance mismatch')
})
