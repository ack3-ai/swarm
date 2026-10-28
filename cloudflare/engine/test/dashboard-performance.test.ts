import { expect, it, vi } from 'vitest'
import type { AgentExecutionReceipt, ProviderRequestTelemetry } from '../src/agent-execution-receipt.js'
import type { RunState, TaskDefinition } from '../src/contracts.js'
import { sha256 } from '../src/canonical.js'
import { receiptMonitoringMetadata } from '../src/dashboard-receipts.js'
import { readDashboardPerformance, summarizeProviderPerformance } from '../src/dashboard-performance.js'

const sample = (changes: Partial<ProviderRequestTelemetry> = {}) => ({
  schemaVersion: 1 as const, provider: 'provider-c', model: 'same-model', thinking: 'disabled',
  reasoningEffort: null, stream: true, maxOutputTokens: 4096, startedAt: '2026-09-26T00:00:00Z',
  durationMs: 10_000, timeToFirstByteMs: 1000, providerHttpStatus: 200,
  requestId: 'private-request-id', finishReason: 'stop', inputTokens: 100, outputTokens: 100,
  reasoningTokens: null, costUsd: null, abortedByClient: false, ...changes,
})
const task = { id: 'agent', workspaceKey: 'lane', providerClass: 'additive', model: 'same-model',
  backend: 'dsh-chat-completions', provider: 'provider-c' } as TaskDefinition
const selection = { stageId: 'discovery', waveId: 'wave-0', tasks: [task] }
const state = (runId: string, parentRunId: string | null = null) => ({
  runId, parentRunId, rootRunId: 'root', experimentId: 'synthetic', definitionDigest: 'd'.repeat(64),
}) as RunState

it('weights request rates by time and separates endpoint, model and thinking settings', () => {
  const groups = summarizeProviderPerformance([
    { ...sample(), taskId: 'one' },
    { ...sample({ durationMs: 90_000, outputTokens: 9000, timeToFirstByteMs: 3000 }), taskId: 'two' },
    { ...sample({ provider: 'provider-a', outputTokens: 300 }), taskId: 'three' },
    { ...sample({ thinking: 'enabled' }), taskId: 'four' },
    { ...sample({ model: 'different-model' }), taskId: 'five' },
  ])
  expect(groups).toHaveLength(4)
  const providerC = groups.find(g => g.provider === 'provider-c' && g.model === 'same-model' && g.thinking === 'disabled')!
  expect(providerC).toMatchObject({ requests: 2, measuredRequests: 2, outputTokensPerSecond: 91,
    medianFirstByteMs: 2000, medianRequestMs: 50_000, taskIds: ['one', 'two'] })
  expect(groups.find(g => g.provider === 'provider-a')?.outputTokensPerSecond).toBe(30)
})

it('keeps missing usage, failed requests, impossible TTFT and zero-duration samples out of measured rates', () => {
  const g = summarizeProviderPerformance([
    { ...sample({ outputTokens: null }), taskId: 'one' },
    { ...sample({ providerHttpStatus: 429 }), taskId: 'one' },
    { ...sample({ abortedByClient: true }), taskId: 'one' },
    { ...sample({ durationMs: 0 }), taskId: 'one' },
    { ...sample({ timeToFirstByteMs: 20_000 }), taskId: 'one' },
  ])[0]!
  expect(g).toMatchObject({ requests: 5, measuredRequests: 1, failedOrAbortedRequests: 2,
    outputTokensPerSecond: 10, firstByteRequests: 1 })
  expect(summarizeProviderPerformance([{ ...sample({ outputTokens: null }), taskId: 'one' }])[0])
    .toMatchObject({ outputTokens: null, outputTokensPerSecond: null })
  expect(summarizeProviderPerformance([{ ...sample({ outputTokens: 0 }), taskId: 'one' }])[0]?.outputTokensPerSecond).toBe(0)
})

async function object(runId: string, n: number, requests?: ProviderRequestTelemetry[]) {
  const requestDigest = String(n).repeat(64)
  const receipt: AgentExecutionReceipt = {
    requestDigest, actorId: 'actor', exitCode: 0,
    files: { 'private.md': 'PRIVATE AUDIT EVIDENCE' }, stderr: 'PRIVATE STDERR',
    inputTokens: 100, outputTokens: 100, costUsd: 0,
    ...(requests === undefined ? {} : { providerRequests: requests }),
  }
  const content = JSON.stringify(receipt), digest = await sha256(content)
  return {
    key: `quarantine/execution-receipts/${runId}/${requestDigest}.json`, size: content.length,
    customMetadata: { runId, requestDigest, objectSha256: digest, ...await receiptMonitoringMetadata({
      task, stage: { id: 'discovery' }, wave: { id: 'wave-0' }, attempt: n, promptDigest: 'a'.repeat(64),
    }, receipt) },
    checksums: { toJSON: () => ({ sha256: digest }) }, text: async () => content,
    body: { cancel: vi.fn() },
  }
}

it('reads exact receipts across recovery parents and returns only aggregate operational fields', async () => {
  const childObject = await object('child', 2, [sample()]), parentObject = await object('root', 1, [sample()])
  const objects = [childObject, parentObject]
  const bucket = {
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: objects.filter(o => o.key.startsWith(prefix)), truncated: false })),
    get: vi.fn(async (key: string) => objects.find(o => o.key === key) ?? null),
  } as any
  const result = await readDashboardPerformance(state('child', 'root'), selection,
    { getState: async () => state('root') }, bucket)
  expect(result).toMatchObject({ inspectedReceipts: 2, receiptsWithTelemetry: 2, incomplete: false, inFlightKnown: false })
  expect(result.groups[0]?.requests).toBe(2)
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|private-request-id/)
  expect(bucket.get).toHaveBeenCalledTimes(2)
})

it('marks unavailable history and refuses corrupted receipts or unrelated recovery parents', async () => {
  const saved = await object('root', 1)
  const bucket = { list: async () => ({ objects: [saved], truncated: false }), get: async () => saved } as any
  expect(await readDashboardPerformance(state('root'), selection, { getState: vi.fn() }, bucket))
    .toMatchObject({ groups: [], receiptsWithTelemetry: 0, inspectedReceipts: 1 })
  saved.customMetadata.objectSha256 = 'b'.repeat(64)
  await expect(readDashboardPerformance(state('root'), selection, { getState: vi.fn() }, bucket))
    .rejects.toThrow('integrity mismatch')
  const list = vi.fn(async () => ({ objects: [], truncated: false }))
  const result = await readDashboardPerformance(state('child', 'foreign'), selection,
    { getState: async () => ({ ...state('foreign'), rootRunId: 'unrelated' }) }, { list, get: vi.fn() } as any)
  expect(result.incomplete).toBe(true)
  expect(list).toHaveBeenCalledOnce()
})
