import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import failure from './fixtures/workflow-internal-failure.json' with { type: 'json' }
import {
  agentExecutionReceiptWrapper,
  classifyAgentExecutionReceipt,
  parseExactAgentExecutionReceipt,
  R2AgentExecutionReceiptStore,
} from '../src/agent-execution-receipt.js'
import { sha256 } from '../src/canonical.js'
import {
  agentProcessWaitSliceMs,
  waveStepConfig,
  workflowAttemptTimeoutMs,
  workflowBootstrapProgress,
} from '../src/workflow-step-config.js'
import { providerDiagnosticsAreAgentActionable } from '../src/provider-failure.js'

const digest = 'a'.repeat(64)
const receipt = {
  requestDigest: digest,
  exitCode: 0,
  actorId: 'session-exact-request',
  files: { 'waves/wave-5-agent-1.md': '# complete' },
  inputTokens: 12,
  outputTokens: 3,
  costUsd: 0,
  stderr: '',
  providerRequests: [{
    schemaVersion: 1 as const,
    provider: 'provider-c',
    model: 'deepseek/v4-flash',
    thinking: 'enabled',
    reasoningEffort: 'max',
    stream: true,
    maxOutputTokens: 256_000,
    startedAt: '2026-09-23T12:00:00.000Z',
    durationMs: 321,
    timeToFirstByteMs: 12,
    providerHttpStatus: 200,
    requestId: 'rw-1',
    finishReason: 'stop',
    inputTokens: 12,
    outputTokens: 3,
    reasoningTokens: 2,
    costUsd: 0.00001,
    abortedByClient: false,
  }],
}

class FakeR2Bucket {
  readonly objects = new Map<string, { content: string, customMetadata: Record<string, string>, checksum: string }>()

  async put(key: string, value: string, options: R2PutOptions = {}): Promise<unknown | null> {
    if (this.objects.has(key) && options.onlyIf !== undefined) return null
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

describe('exact Sandbox execution receipts', () => {
  it('reuses only a structurally valid receipt bound to the exact request', () => {
    expect(parseExactAgentExecutionReceipt(JSON.stringify(receipt), digest)).toEqual(receipt)
    expect(parseExactAgentExecutionReceipt(JSON.stringify(receipt), 'b'.repeat(64))).toBeNull()
    expect(classifyAgentExecutionReceipt(JSON.stringify(receipt), digest)).toEqual({ status: 'exact', receipt })
    expect(classifyAgentExecutionReceipt(JSON.stringify(receipt), 'b'.repeat(64))).toEqual({ status: 'stale', receipt })
    expect(classifyAgentExecutionReceipt(JSON.stringify({ ...receipt, files: { bad: 7 } }), digest))
      .toEqual({ status: 'invalid' })
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt, files: { bad: 7 } }), digest)).toBeNull()
    expect(parseExactAgentExecutionReceipt(JSON.stringify({
      ...receipt,
      providerRequests: [{ ...receipt.providerRequests[0], durationMs: -1 }],
    }), digest)).toBeNull()
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt, providerRequests: [{}] }), digest)).toBeNull()
    const proof = { schemaVersion: 1, source: 'dsh-json', completed: [{
      callId: 'search-1', queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
    }], failed: 0, incomplete: 0 }
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt, nativeSearchEvidence: proof }), digest))
      .toEqual({ ...receipt, nativeSearchEvidence: proof })
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt, nativeSearchEvidence: null }), digest)).toBeNull()
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt,
      nativeSearchEvidence: { ...proof, completed: [proof.completed[0], proof.completed[0]] },
    }), digest)).toBeNull()
    expect(parseExactAgentExecutionReceipt(JSON.stringify({ ...receipt,
      nativeSearchEvidence: { ...proof, completed: [null] },
    }), digest)).toBeNull()
    expect(parseExactAgentExecutionReceipt('{', digest)).toBeNull()
  })

  it('makes the unchanged-state platform failure retryable without duplicate completed calls', () => {
    expect(failure).toEqual({
      message: 'Attempt failed due to internal workflows error',
      stateChanged: false,
      providerCallsAdded: 0,
      artifactsAdded: 0,
      checkpointChildrenAdded: 0,
      sandboxReceiptSurvivedRetry: false,
    })
    expect(agentExecutionReceiptWrapper).toContain("result.requestDigest = request.requestDigest")
    expect(agentExecutionReceiptWrapper).toContain("const rawResultPath = resultPath + '.raw-' + process.pid")
    expect(agentExecutionReceiptWrapper).toContain("[requestPath, rawResultPath]")
    expect(agentExecutionReceiptWrapper).toContain("readFile(rawResultPath, 'utf8')")
    expect(agentExecutionReceiptWrapper).toContain('await rename(temporaryPath, resultPath)')
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    expect(worker).not.toContain("'resolve-wave-execution-window'")
    expect(worker).toContain('const sealedWaveStepConfig = waveStepConfig()')
    expect(worker).toContain('...sealedWaveStepConfig')
    expect(worker).not.toContain("timeout: '2 hours'")
    expect(worker).toContain('canStopAtSealedWaveBoundary(state, await store.stopRequested(runId))')
    expect(worker).toContain("observationFailed ? '30 seconds' : '15 seconds'")
    expect(worker).toContain('`recover-wave-state-${pollCycle}`')
    const progress = { status: 'running', cursor: { stageIndex: 1, waveIndex: 0 } }
    expect(workflowBootstrapProgress(progress)).toBe(progress)
    expect(workflowBootstrapProgress({ progress, maxWaveExecutionMs: 3_600_000 })).toBe(progress)
    expect(waveStepConfig()).toEqual({
      retries: { limit: 3, delay: '2 seconds', backoff: 'exponential' },
      timeout: workflowAttemptTimeoutMs,
    })
    expect(agentProcessWaitSliceMs).toBe(2 * 60_000)
    const provider = readFileSync(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
    const durableAt = provider.indexOf('this.executionReceipts.get(request.runId, requestDigest)')
    const sandboxAt = provider.indexOf('sandbox.readFile(resultPath)')
    expect(durableAt).toBeGreaterThan(-1)
    expect(sandboxAt).toBeGreaterThan(durableAt)
    expect(provider).toContain('waitForAgentProcess(process, agentProcessWaitSliceMs, 1_000, {')
    expect(provider).toContain("if (exitCode === 'running')")
    expect(provider).toContain("if (exitCode === 'unavailable') throw new AgentObservationExpired")
    expect(provider).toContain('if (durableCached !== null)')
    expect(provider).toContain('await this.executionReceipts.put(request.runId, requestDigest, result, request)')
    expect(provider).not.toContain('receiptIsReusable')
  })

  it('persists an immutable exact receipt outside the disposable Sandbox', async () => {
    const bucket = new FakeR2Bucket()
    const store = new R2AgentExecutionReceiptStore(bucket as unknown as R2Bucket)
    expect(await store.get('receipt-run', digest)).toBeNull()
    await store.put('receipt-run', digest, receipt)
    expect(await store.get('receipt-run', digest)).toEqual(receipt)
    await store.put('receipt-run', digest, receipt)
    await expect(store.put('receipt-run', digest, { ...receipt, outputTokens: 4 }))
      .rejects.toThrow('different bytes')
  })

  it('allows only one launch claim for an exact paid request', async () => {
    const bucket = new FakeR2Bucket()
    const store = new R2AgentExecutionReceiptStore(bucket as unknown as R2Bucket)
    const claimedAt = '2026-09-25T10:00:00.000Z'
    await expect(store.claimStart('receipt-run', digest, claimedAt)).resolves.toEqual({ acquired: true, claimedAt })
    await expect(store.claimStart('receipt-run', digest, '2026-09-25T10:01:00.000Z'))
      .resolves.toEqual({ acquired: false, claimedAt })
    expect([...bucket.objects.keys()]).toContain(`quarantine/execution-admissions/receipt-run/${digest}.json`)
  })

  it('observes launch claims without creating them and preserves admission integrity checks', async () => {
    const bucket = new FakeR2Bucket(), store = new R2AgentExecutionReceiptStore(bucket as unknown as R2Bucket)
    expect(await store.getStart('receipt-run', digest)).toBeNull()
    expect(bucket.objects.size).toBe(0)
    const claimedAt = '2026-09-25T10:00:00.000Z'
    await store.claimStart('receipt-run', digest, claimedAt)
    expect(await store.getStart('receipt-run', digest)).toEqual({ acquired: false, claimedAt })
    expect(bucket.objects.size).toBe(1)
    const saved = [...bucket.objects.values()][0]!
    saved.customMetadata.runId = 'different-owner'
    await expect(store.getStart('receipt-run', digest)).rejects.toThrow('provenance mismatch')
    expect(bucket.objects.size).toBe(1)
  })

  it('keeps structured provider infrastructure evidence out of agent repair instructions', () => {
    const providerRequest = receipt.providerRequests[0]!
    expect(providerDiagnosticsAreAgentActionable({
      providerHttpStatus: 503,
      providerRequests: [{ ...providerRequest, providerHttpStatus: 503 }],
    })).toBe(false)
    expect(providerDiagnosticsAreAgentActionable({
      providerHttpStatus: 401,
      providerRequests: [{ ...providerRequest, providerHttpStatus: 401 }],
    })).toBe(false)
    expect(providerDiagnosticsAreAgentActionable({
      providerHttpStatus: 403,
      providerRequests: [{ ...providerRequest, providerHttpStatus: 403 }],
    })).toBe(false)
    expect(providerDiagnosticsAreAgentActionable({
      providerHttpStatus: null,
      providerRequests: [{ ...providerRequest, errorCategory: 'transport' }],
    })).toBe(false)
    expect(providerDiagnosticsAreAgentActionable(receipt)).toBe(true)
  })
})
