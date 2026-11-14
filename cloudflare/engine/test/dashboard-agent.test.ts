import { describe, expect, it, vi } from 'vitest'
import type { RunState } from '../src/contracts.js'
import { readDashboardAgent } from '../src/dashboard-agent.js'
import { dashboardHistory } from '../src/dashboard-history.js'
import { sha256 } from '../src/canonical.js'
import { receiptMonitoringMetadata } from '../src/dashboard-receipts.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { providerIdentity } from '../src/provider-identity.js'
import { R2AgentExecutionLogStore } from '../src/agent-execution-log.js'
import { audit0Definition } from './support/audit0-config.js'

const definition = audit0Definition
const stage = definition.stages.find(s => s.kind === 'discovery')!
const wave = stage.waves[0]!, task = wave.tasks[0]!
const startedAt = '2026-09-26T00:00:00Z', requestDigest = 'a'.repeat(64)
const state = (runId: string, parentRunId: string | null = null) => ({
  runId, parentRunId, rootRunId: 'root', experimentId: definition.id, definitionDigest: 'd'.repeat(64),
  artifacts: [], rejectedAttempts: [], waveReceipts: [], stageEndReceipts: [], rootCreatedAt: startedAt,
  createdAt: startedAt, modelStartedAt: startedAt,
}) as unknown as RunState

async function setup(captured = false, chunks = 1, scope = { stage, wave, task }) {
  const { stage, wave, task } = scope
  const objects = new Map<string, any>()
  const put = async (key: string, value: unknown, metadata = {}) => {
    const text = JSON.stringify(value), digest = await sha256(text)
    const object = { key, size: new TextEncoder().encode(text).length,
      customMetadata: { runId: 'root', requestDigest, objectSha256: digest, ...metadata },
      checksums: { toJSON: () => ({ sha256: digest }) }, text: async () => text,
      body: { cancel: vi.fn() } }
    objects.set(key, object); return object
  }
  const prompt = renderTaskPrompt({ definition, task, visibleArtifacts: [], deadline: startedAt })
  const promptDigest = await sha256(prompt)
  const receipt = { requestDigest, actorId: 'actor', exitCode: 0, files: {}, stderr: 'legacy stderr tail',
    inputTokens: 1, outputTokens: 1, costUsd: 0 }
  await put(`quarantine/execution-receipts/root/${requestDigest}.json`, receipt,
    await receiptMonitoringMetadata({ task, stage, wave, attempt: 1, promptDigest }, receipt))
  const prefix = `monitor/agent-executions/root/${task.id}/${requestDigest}/`
  if (captured) {
    await put(`${prefix}request.json`, { schemaVersion: 1, runId: 'root', requestDigest, stageId: stage.id,
      waveId: wave.id, taskId: task.id, prompt, promptDigest, model: task.model, provider: providerIdentity(task),
      attempt: 1, startedAt, startedAtBasis: 'execution-admission' })
    await put(`${prefix}index.json`, { schemaVersion: 1, chunkCount: chunks, complete: true, truncated: false, updatedAt: startedAt,
      eventCount: chunks, sourceBytes: 100 })
    for (let i = 0; i < chunks; i++) await put(`${prefix}chunk-${String(i).padStart(6, '0')}.json`, {
      schemaVersion: 1, events: [{ at: startedAt, stream: 'stdout', text: `chunk ${i} <script>untrusted output</script>` }],
    })
  }
  const bucket = {
    list: vi.fn(async ({ prefix, delimiter }: { prefix: string; delimiter?: string }) => {
      const found = [...objects.values()].filter(o => o.key.startsWith(prefix))
      return { objects: delimiter ? [] : found, truncated: false,
        delimitedPrefixes: delimiter ? [...new Set(found.map(o => prefix + o.key.slice(prefix.length).split('/')[0] + '/'))] : [] }
    }),
    get: vi.fn(async (key: string) => objects.get(key) ?? null),
  } as any
  const input = { state: state('root'), definition: { stages: definition.stages, historical: definition },
    stage, wave, task, bucket, attempt: null, offset: 0 }
  return { input, objects, prefix, put, prompt, promptDigest }
}

describe('private agent prompt and log reader', () => {
  it.each(definition.stages.flatMap(stage => {
    const wave = stage.waves.find(wave => wave.tasks.length > 0)
    return wave ? [{ stage, wave, task: wave.tasks[0]!, label: stage.kind }] : []
  }))('retains exact prompt and output for the $label stage', async scope => {
    const { input, prompt } = await setup(true, 1, scope)
    const result = await readDashboardAgent(input)
    expect(result.prompt).toMatchObject({ status: 'recorded', text: prompt })
    expect(result.logs).toMatchObject({ mode: 'captured', complete: true, chunkCount: 1 })
    expect(result.logs.events[0]?.text).toContain('untrusted output')
  })

  it('reads the native session header even when viewing later log pages; ignores tool-embedded IDs', async () => {
    const { input, put, prefix } = await setup(true, 9)
    const id = '11111111-2222-3333-4444-555555555555'
    const line = JSON.stringify({ type: 'thread.started', thread_id: id }) + '\n'
    await put(`${prefix}chunk-000000.json`, { schemaVersion: 1, events: [
      { at: startedAt, stream: 'stdout', text: line.slice(0, 20) },
      { at: startedAt, stream: 'stdout', text: line.slice(20) },
      { at: startedAt, stream: 'stdout', text: JSON.stringify({ type: 'item.completed', thread_id: 'aaaaaaaa-2222-3333-4444-555555555555' }) + '\n' },
    ] })
    const result = await readDashboardAgent({ ...input, offset: 8 })
    expect(result.context).toMatchObject({ sessionId: id, sessionSource: 'native-log', mode: 'unknown' })
    expect(result.logs.events).toHaveLength(1)
  })

  it('reads the publisher contract incrementally without changing prompt bytes', async () => {
    const { input, objects, prompt, promptDigest } = await setup()
    const bucket = input.bucket as any
    bucket.head = async (key: string) => objects.get(key) ?? null
    bucket.put = async (key: string, text: string, options: any) => {
      if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null
      const object = { key, size: new TextEncoder().encode(text).length,
        customMetadata: options.customMetadata, checksums: { toJSON: () => ({ sha256: options.sha256 }) },
        text: async () => text, body: { cancel: vi.fn() } }
      objects.set(key, object)
      return object
    }
    const publisher = new R2AgentExecutionLogStore(bucket)
    await publisher.putRequest({ schemaVersion: 1, runId: 'root', stageId: stage.id, waveId: wave.id,
      taskId: task.id, requestDigest, promptDigest, prompt, model: task.model, provider: providerIdentity(task),
      attempt: 1, startedAt, startedAtBasis: 'execution-admission' })
    const first = `${JSON.stringify({ schemaVersion: 1, at: startedAt, stream: 'stdout', text: 'first output' })}\n`
    const firstIndex = await publisher.sync({ runId: 'root', taskId: task.id, requestDigest,
      source: first, sourceOffset: 0, complete: false })
    const page1 = await readDashboardAgent(input)
    expect(page1.prompt).toMatchObject({ text: prompt, status: 'recorded' })
    expect(page1.logs).toMatchObject({ mode: 'captured', complete: false, nextOffset: 1 })
    const second = `${JSON.stringify({ schemaVersion: 1, at: startedAt, stream: 'stderr', text: 'completion' })}\n`
    await publisher.sync({ runId: 'root', taskId: task.id, requestDigest,
      source: second, sourceOffset: firstIndex.sourceBytes, complete: true })
    const page2 = await readDashboardAgent({ ...input, attempt: page1.selectedAttempt, offset: page1.logs.nextOffset })
    expect(page2.logs).toMatchObject({ mode: 'captured', complete: true, nextOffset: 2 })
    expect(page2.logs.events.map(event => event.text)).toEqual(['completion'])
  })

  it('reconstructs the current prompt only when its recorded digest matches', async () => {
    const { input, prompt } = await setup()
    const result = await readDashboardAgent(input)
    expect(result.sourceRunId).toBe('root')
    expect(result.filesystem).toMatchObject({ sourceRunId: 'root', allocationId: null, usage: 'unknown' })
    expect(result.prompt).toMatchObject({ status: 'verified-reconstruction', text: prompt })
    expect(result.logs).toMatchObject({ mode: 'stderr-tail-only', complete: true, truncated: true,
      events: [{ at: null, stream: 'stderr', text: 'legacy stderr tail' }] })
    const changed = structuredClone(definition)
    changed.policy.outcome += ' A later edit.'
    expect((await readDashboardAgent({ ...input, definition: { stages: definition.stages, historical: changed } })).prompt)
      .toMatchObject({ text: null, status: 'unavailable' })
  })

  it('keeps a pinned fork source separate from this runtime’s agent transcript', async () => {
    const { input, put } = await setup(true)
    const otherDigest = 'b'.repeat(64)
    const otherPrompt = 'Recorded prompt from the earlier model'
    await put(`monitor/agent-executions/root/${task.id}/${otherDigest}/request.json`, {
      schemaVersion: 1, runId: 'root', requestDigest: otherDigest, stageId: stage.id, waveId: wave.id,
      taskId: task.id, prompt: otherPrompt, promptDigest: await sha256(otherPrompt),
      model: 'earlier-model', provider: providerIdentity(task), attempt: 2,
      startedAt: '2026-09-26T01:00:00Z', startedAtBasis: 'execution-admission',
    }, { requestDigest: otherDigest })
    const source = { ...state('root'), stateGeneration: 7 }
    const pointer = { generation: 7, digest: await sha256(source) }
    const forked = { ...state('child', null), forkOrigin: { source: { runId: 'root', state: pointer } } } as RunState
    const result = await readDashboardAgent({ ...input, state: forked })
    expect(result).toMatchObject({ sourceReference: { runId: 'root', state: pointer },
      sourceRunId: null, selectedModel: null, prompt: { status: 'unavailable', text: null } })
    expect(result.attempts).toEqual([])
  })

  it('shows the exact source reference without traversing the historical audit', async () => {
    const { input } = await setup()
    const sourceChild = { ...state('source-child', 'source-root'), rootRunId: 'source-root', stateGeneration: 4 }
    const pointer = { generation: 4, digest: await sha256(sourceChild) }
    const fork = { ...state('new-audit', null), rootRunId: 'new-audit',
      forkOrigin: { source: { runId: 'source-child', state: pointer } } } as RunState
    const history = await dashboardHistory(fork, input.bucket)
    expect(history.incomplete).toBe(false)
    expect(history.runs.map(item => item.state.runId)).toEqual(['new-audit'])
    expect(history.sourceReference).toEqual({ runId: 'source-child', state: pointer })
  })

  it('leaves historical replacement sessions to their owning app version', async () => {
    const { input } = await setup()
    const historical = { ...state('restart-execution', 'fork-root'), journal: [
      { sequence: 1, type: 'run.executor-replaced', at: startedAt, previousDigest: null,
        digest: 'a'.repeat(64), payload: {} },
    ] } as unknown as RunState
    await expect(dashboardHistory(historical, input.bucket)).rejects.toThrow('historical app version')
  })

  it('pages immutable captured chunks and accepts passive-capture cursor metadata without inventing output', async () => {
    const { input } = await setup(true, 9)
    const first = await readDashboardAgent(input)
    expect(first.prompt.status).toBe('recorded')
    expect(first.logs).toMatchObject({ mode: 'captured', nextOffset: 8, chunkCount: 9, complete: true, truncated: false })
    expect(first.logs.events).toHaveLength(8)
    expect(first.logs.events[0]?.text).toContain('<script>')
    const last = await readDashboardAgent({ ...input, attempt: first.selectedAttempt, offset: 8 })
    expect(last.logs.events).toHaveLength(1)
    expect(last.logs.nextOffset).toBe(9)
    await expect(readDashboardAgent({ ...input, offset: 10 })).rejects.toThrow('cursor exceeds')
  })

  it('refuses foreign attempts and corrupted chunks instead of following arbitrary R2 paths', async () => {
    const { input, objects, prefix } = await setup(true)
    await expect(readDashboardAgent({ ...input, attempt: `foreign/${'b'.repeat(64)}` })).rejects.toThrow('does not belong')
    expect(input.bucket.get.mock.calls.every(([key]: [string]) => !key.includes('foreign/'))).toBe(true)
    objects.get(`${prefix}chunk-000000.json`).customMetadata.objectSha256 = 'c'.repeat(64)
    await expect(readDashboardAgent(input)).rejects.toThrow('integrity mismatch')
  })

  it('marks an unexpected parent as incomplete without reading another execution', async () => {
    const { input } = await setup()
    const unexpected = state('child', 'root')
    expect(await dashboardHistory(unexpected, input.bucket)).toMatchObject({ incomplete: true,
      sourceReference: null, runs: [{ state: unexpected }] })
  })
})
