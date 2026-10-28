import { describe, expect, it } from 'vitest'
import { listLiveCompletions, parseLiveCompletion, receiptMonitoringMetadata } from '../src/dashboard-receipts.js'

const request = {
  stage: { id: 'review' }, wave: { id: 'wave-1' },
  task: { id: 'reviewer-1', model: 'luna', providerClass: 'core' as const },
  attempt: 1, promptDigest: 'a'.repeat(64),
}
const receipt = {
  requestDigest: 'b'.repeat(64), exitCode: 0, actorId: 'session-1',
  files: { 'notes.md': 'Private workshop notes must not enter monitoring metadata.' },
  stderr: 'Private runtime diagnostic.', inputTokens: 80, rawInputTokens: 100,
  cachedInputTokens: 20, cacheAccountingComplete: true, costAccountingComplete: true,
  outputTokens: 10, costUsd: 0,
}

function listedObject(key: string, metadata: Record<string, string>): R2Object {
  return {
    key, customMetadata: metadata, version: '1', size: 10, etag: 'etag', httpEtag: '"etag"',
    uploaded: new Date('2026-09-22T12:00:00Z'), storageClass: 'Standard',
    checksums: { toJSON: () => ({}) }, writeHttpMetadata: () => {},
  }
}

describe('passive monitoring of existing execution receipts', () => {
  it('adds bounded usage metadata without including result files or diagnostics', async () => {
    const metadata = await receiptMonitoringMetadata(request, receipt)
    const result = parseLiveCompletion(metadata.monitorV1)
    expect(result).toMatchObject({ taskId: 'reviewer-1', model: 'luna',
      usage: { rawInputTokens: 100, cachedInputTokens: 20, costAccountingComplete: true } })
    expect(JSON.stringify(metadata)).not.toContain('Private')
    expect(new TextEncoder().encode(metadata.monitorV1).length).toBeLessThanOrEqual(1400)
    expect(receipt.files['notes.md']).toContain('Private workshop')
  })

  it('omits optional metadata when source identifiers exceed storage headroom', async () => {
    expect(await receiptMonitoringMetadata(request, { ...receipt, actorId: 'x'.repeat(3_000) })).toEqual({})
  })

  it('rejects impossible counters, secret-shaped extra fields, and inconsistent cache totals', async () => {
    const metadata = await receiptMonitoringMetadata(request, receipt)
    const valid = JSON.parse(metadata.monitorV1!)
    for (const value of [
      { ...valid, files: receipt.files },
      { ...valid, usage: { ...valid.usage, apiKey: 'not-a-real-key' } },
      { ...valid, usage: { ...valid.usage, inputTokens: -1 } },
      { ...valid, usage: { ...valid.usage, cachedInputTokens: 99 } },
      { ...valid, usage: { ...valid.usage, costAccountingComplete: 'yes' } },
      { ...valid, requestDigest: '../other-run' },
    ]) expect(parseLiveCompletion(JSON.stringify(value))).toBeNull()
    expect(parseLiveCompletion('{')).toBeNull()
  })

  it('reads metadata only, validates run ownership, and traverses bounded pages', async () => {
    const monitor = await receiptMonitoringMetadata(request, receipt)
    const prefix = 'quarantine/execution-receipts/run-1/'
    const options: R2ListOptions[] = []
    const bucket = { async list(option: R2ListOptions = {}): Promise<R2Objects> {
      options.push(option)
      if (option.cursor === undefined) return {
        objects: [listedObject(`${prefix}${receipt.requestDigest}.json`, { ...monitor, runId: 'run-1', requestDigest: receipt.requestDigest })],
        delimitedPrefixes: [], truncated: true, cursor: 'next',
      }
      return { objects: [listedObject(`${prefix}legacy.json`, {})], delimitedPrefixes: [], truncated: false }
    } }
    const result = await listLiveCompletions(bucket, 'run-1')
    expect(result.entries).toHaveLength(1)
    expect(result.legacyCount).toBe(1)
    expect(result.truncated).toBe(false)
    expect(options[0]).toEqual({ prefix, limit: 1_000, include: ['customMetadata'] })
    expect(options[1]!.cursor).toBe('next')
    await expect(listLiveCompletions(bucket, '../run-1')).rejects.toThrow('invalid run')
  })

  it('marks truncation instead of unbounded polling', async () => {
    let calls = 0
    const bucket = { async list(): Promise<R2Objects> {
      calls += 1
      return { objects: [], delimitedPrefixes: [], truncated: true, cursor: String(calls) }
    } }
    expect((await listLiveCompletions(bucket, 'run-1')).truncated).toBe(true)
    expect(calls).toBe(8)
  })
})
