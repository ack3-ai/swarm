import { describe, expect, it } from 'vitest'
import type { AgentRequest, ArtifactRecord } from '../src/contracts.js'
import type { QuarantinedRevalidation } from '../src/env.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { R2ArtifactStore } from '../src/cloudflare-storage.js'
import { QuarantinedRevalidationProvider } from '../src/revalidation-provider.js'
import { audit0Definition } from './support/audit0-config.js'
import { SUBMISSION_PATH } from '../src/submission.js'
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

  it('revalidates digest-bound bytes without invoking a model runtime', async () => {
    const stage = audit0Definition.stages.find(candidate => candidate.kind === 'verification')!
    const wave = stage.waves[0]!
    const task = { ...wave.tasks[0]!, output: { ...wave.tasks[0]!.output, schema: 'ack3.verification.policy-v2' } }
    const promptDigest = 'a'.repeat(64)
    const files = {
      'verification.md': `## Batch 1\n\nreferences: C-1\n\n- C-1 | behavior: reproduced | exploitability: supported | evidence\n`,
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: [{
        reference: 'C-1', behavior: 'reproduced', exploitability: 'supported',
        evidenceMethod: 'fresh-execution',
        evidence: 'independently reproduced evidence',
      }] }),
    }
    const content = canonicalJson(files)
    const outputDigest = await sha256(content)
    const bucket = new FakeR2Bucket()
    const artifacts = new R2ArtifactStore(bucket as unknown as R2Bucket)
    const quarantineUri = await artifacts.putRejected({
      id: `${stage.id}/${wave.id}/${task.id}/attempt-1/${outputDigest.slice(0, 16)}`,
      taskId: task.id,
      contentDigest: outputDigest,
    }, content)
    const revalidation: QuarantinedRevalidation = {
      sourceRunId: 'failed-child', stageId: stage.id, waveId: wave.id, taskId: task.id,
      promptDigest, outputDigest, quarantineUri,
      usage: {
        modelCalls: 1, inputTokens: 100, rawInputTokens: 180, cachedInputTokens: 80,
        cacheAccountingComplete: true, outputTokens: 20, costUsd: 0,
      },
    }
    const visibleArtifacts = [{
      id: 'review/union/digest', stageId: 'negative-review', waveId: 'union', taskId: 'negative-review-union',
      status: 'accepted', actorId: 'supervisor', model: 'deterministic', provider: 'deterministic-supervisor',
      promptDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64), uri: 'memory://union', files: [], assertions: [],
      protocol: { dispositionReferences: ['C-1'] },
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    }] satisfies ArtifactRecord[]
    const request: AgentRequest = {
      experimentId: audit0Definition.id, runId: 'revalidated-child', stage, wave, task,
      prompt: 'unchanged verifier prompt', promptDigest,
      visibleArtifacts, releaseDigest: 'd'.repeat(64), attempt: 1, diagnostics: [], repairFiles: {},
      freshContext: false, continuationMode: 'new', sessionId: null,
    }
    const fallback = { run: async () => { throw new Error('model runtime must not be called') } }
    const provider = new QuarantinedRevalidationProvider(fallback, artifacts, revalidation)

    const result = await provider.run(request)

    expect(result.files).toEqual(files)
    expect(result.actorId).toBe(`revalidated-${outputDigest.slice(0, 24)}`)
    expect(result.assertions).toEqual([`revalidated-quarantine:failed-child:${outputDigest}`])
    expect(result.protocol.retainedReferences).toEqual(['C-1'])
    expect(result.protocol.verificationOutcomes).toHaveLength(1)
    expect(result).toMatchObject({
      inputTokens: 100, rawInputTokens: 180, cachedInputTokens: 80,
      cacheAccountingComplete: true, outputTokens: 20, modelCalls: 1,
    })

    await expect(provider.run({ ...request, promptDigest: 'e'.repeat(64) }))
      .rejects.toThrow('revalidation prompt digest differs')

    const amendedClockProvider = new QuarantinedRevalidationProvider(fallback, artifacts, revalidation, true)
    await expect(amendedClockProvider.run({ ...request, promptDigest: 'e'.repeat(64) }))
      .resolves.toMatchObject({ actorId: `revalidated-${outputDigest.slice(0, 24)}` })
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
