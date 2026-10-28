import type { ExperimentDefinition, RunState, StageDefinition, TaskDefinition, WaveDefinition } from './contracts.js'
import type { DashboardDefinition } from './dashboard-release.js'
import { sha256 } from './canonical.js'
import { dashboardHistory } from './dashboard-history.js'
import { parseExactAgentExecutionReceipt } from './agent-execution-receipt.js'
import { renderTaskPrompt, selectVisibleArtifacts } from './prompts.js'
import { taskPromptDeadline } from './runner.js'
import { dashboardContext, nativeSessionId } from './dashboard-context.js'
import { dashboardFilesystem } from './dashboard-filesystem.js'
import { providerIdentity } from './provider-identity.js'

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const digestPattern = /^[a-f0-9]{64}$/
const maxChunks = 2048
export interface AgentLogEvent { at: string | null; stream: 'stdout' | 'stderr'; text: string }

async function privateObject(bucket: Pick<R2Bucket, 'get'>, key: string, runId: string, requestDigest: string, maxSize: number) {
  const object = await bucket.get(key)
  if (object === null) return null
  if (object.size > maxSize) { await object.body.cancel(); throw new Error('agent record exceeds its size limit') }
  const text = await object.text(), digest = await sha256(text)
  if (object.customMetadata?.runId !== runId || object.customMetadata?.requestDigest !== requestDigest
    || object.customMetadata?.objectSha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
    throw new Error('agent record integrity mismatch')
  }
  const value: unknown = JSON.parse(text)
  if (!record(value)) throw new Error('invalid agent record')
  return { value, text }
}

function historicalPrompt(definition: ExperimentDefinition | undefined, state: RunState,
  stage: StageDefinition, wave: WaveDefinition, task: TaskDefinition, expectedDigest: string | undefined) {
  if (!definition || !expectedDigest) return null
  try {
    const stageIndex = definition.stages.findIndex(item => item.id === stage.id)
    const originalStage = definition.stages[stageIndex]!
    const waveIndex = originalStage.waves.findIndex(item => item.id === wave.id)
    const originalWave = originalStage.waves[waveIndex]!
    return renderTaskPrompt({ definition, task,
      visibleArtifacts: selectVisibleArtifacts(task, state.artifacts, state.waveReceipts, stageIndex, waveIndex, definition),
      deadline: taskPromptDeadline(definition, state, originalStage, originalWave),
    })
  } catch { return null }
}

/** Private read-only agent view; only configured tasks and real recovery ancestors can be selected. */
export async function readDashboardAgent(input: {
  state: RunState; definition: DashboardDefinition; stage: StageDefinition; wave: WaveDefinition; task: TaskDefinition
  store: { getState(runId: string): Promise<RunState> }; bucket: Pick<R2Bucket, 'list' | 'get'>
  attempt: string | null; offset: number
}) {
  const { state, definition, stage, wave, task, store, bucket } = input
  const history = await dashboardHistory(state, store, bucket)
  const attempts = new Map<string, { id: string; source: RunState; requestDigest: string; attempt: number;
    recordedAt: string; promptDigest?: string; actorId?: string | undefined; capture: Record<string, unknown> | null }>()
  let incomplete = history.incomplete
  let remainingReads = 32
  for (const run of history.runs) {
    for (const entry of run.live.entries.filter(entry => entry.stageId === stage.id && entry.waveId === wave.id
      && entry.taskId === task.id && entry.model === task.model && entry.provider === providerIdentity(task))) {
      const id = `${run.state.runId}/${entry.requestDigest}`
      attempts.set(id, { id, source: run.state, requestDigest: entry.requestDigest, attempt: entry.attempt,
        recordedAt: entry.recordedAt, promptDigest: entry.promptDigest, actorId: entry.actorId, capture: null })
    }
    const prefix = `monitor/agent-executions/${run.state.runId}/${task.id}/`
    const listing = await bucket.list({ prefix, delimiter: '/', limit: 100 })
    incomplete ||= listing.truncated
    const folders = (listing.delimitedPrefixes ?? []).filter(folder => folder.startsWith(prefix)
      && digestPattern.test(folder.slice(prefix.length, -1)) && folder.endsWith('/'))
    const selectedFolders = folders.slice(0, remainingReads)
    incomplete ||= selectedFolders.length < folders.length
    remainingReads -= selectedFolders.length
    for (let i = 0; i < selectedFolders.length; i += 4) {
      const records = await Promise.all(selectedFolders.slice(i, i + 4).map(async folder => {
        const requestDigest = folder.slice(prefix.length, -1)
        return { requestDigest, saved: await privateObject(bucket, `${folder}request.json`, run.state.runId, requestDigest, 512 * 1024) }
      }))
      for (const { requestDigest, saved } of records) {
        const value = saved?.value
        if (!value) continue
        if (value.schemaVersion !== 1 || value.runId !== run.state.runId || value.requestDigest !== requestDigest
          || value.taskId !== task.id || value.stageId !== stage.id || value.waveId !== wave.id
          || value.model !== task.model || value.provider !== providerIdentity(task)) continue
        if (typeof value.prompt !== 'string' || typeof value.promptDigest !== 'string'
          || await sha256(value.prompt) !== value.promptDigest || !Number.isSafeInteger(value.attempt)
          || Number(value.attempt) < 1 || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))) {
          throw new Error('invalid agent prompt record')
        }
        const id = `${run.state.runId}/${requestDigest}`
        const prior = attempts.get(id)
        if (prior && (prior.promptDigest !== value.promptDigest || prior.attempt !== value.attempt)) {
          throw new Error('agent capture differs from its execution receipt')
        }
        attempts.set(id, { id, source: run.state, requestDigest, attempt: Number(value.attempt),
          recordedAt: value.startedAt, promptDigest: value.promptDigest, actorId: prior?.actorId, capture: value })
      }
    }
  }
  const ordered = [...attempts.values()].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.attempt - a.attempt)
  const chosen = input.attempt === null ? ordered[0] : attempts.get(input.attempt)
  if (input.attempt !== null && chosen === undefined) throw new Error('attempt does not belong to this configured task and run history')
  const contexts = new Map(ordered.map(item => [item.id, dashboardContext(item.source, {
    stageId: stage.id, waveId: wave.id, taskId: task.id, attempt: item.attempt,
    promptDigest: item.promptDigest, actorId: item.actorId,
  })]))
  const base = { runId: state.runId, taskId: task.id, stageId: stage.id, waveId: wave.id, incomplete,
    attempts: ordered.map(item => ({ id: item.id, sourceRunId: item.source.runId, attempt: item.attempt, recordedAt: item.recordedAt, context: contexts.get(item.id) })),
    selectedAttempt: chosen?.id ?? null, sourceRunId: chosen?.source.runId ?? null,
    context: chosen ? contexts.get(chosen.id)! : null,
    filesystem: dashboardFilesystem(chosen?.source ?? state, definition, task, chosen ? {
      stageId: stage.id, waveId: wave.id, attempt: chosen.attempt,
      ...(chosen.promptDigest ? { promptDigest: chosen.promptDigest } : {}),
    } : null) }
  const protocol = definition.historical?.prompts?.researcherProtocol
  let promptText: string | null = null
  let promptStatus: 'recorded' | 'verified-reconstruction' | 'unavailable' = 'unavailable'
  if (chosen?.capture) { promptText = String(chosen.capture.prompt); promptStatus = 'recorded' }
  else if (chosen) {
    const candidate = historicalPrompt(definition.historical, chosen.source, stage, wave, task, chosen.promptDigest)
    if (candidate !== null && await sha256(candidate) === chosen.promptDigest) {
      promptText = candidate; promptStatus = 'verified-reconstruction'
    }
  }
  const prompt = { text: promptText, status: promptStatus, digest: chosen?.promptDigest ?? null,
    researcherProtocol: typeof chosen?.capture?.researcherProtocol === 'string' ? chosen.capture.researcherProtocol
      : task.promptKind === 'research' && typeof protocol === 'string' ? protocol : null }
  const events: AgentLogEvent[] = []
  if (chosen?.capture) {
    const prefix = `monitor/agent-executions/${chosen.source.runId}/${task.id}/${chosen.requestDigest}/`
    const saved = await privateObject(bucket, `${prefix}index.json`, chosen.source.runId, chosen.requestDigest, 16 * 1024)
    const index = saved?.value
    if (index && (index.schemaVersion !== 1 || !Number.isSafeInteger(index.chunkCount)
      || Number(index.chunkCount) < 0 || Number(index.chunkCount) > maxChunks || typeof index.complete !== 'boolean'
      || typeof index.truncated !== 'boolean' || typeof index.updatedAt !== 'string' || !Number.isFinite(Date.parse(index.updatedAt)))) {
      throw new Error('invalid agent log index')
    }
    const count = Number(index?.chunkCount ?? 0)
    const first = count > 0 ? await privateObject(bucket, `${prefix}chunk-000000.json`, chosen.source.runId, chosen.requestDigest, 64 * 1024) : null
    if (count > 0 && (!first || first.value.schemaVersion !== 1 || !Array.isArray(first.value.events))) throw new Error('agent log chunk is unavailable')
    // Only native session-start events count, never IDs embedded in tool output.
    const firstEvents = Array.isArray(first?.value.events) ? first.value.events : []
    const stdout = firstEvents.filter((e): e is Record<string, unknown> => record(e) && e.stream === 'stdout' && typeof e.text === 'string')
      .map(e => e.text).join('')
    const ids = new Set<string>()
    for (const line of stdout.split('\n')) {
      try {
        const event = JSON.parse(line)
        const id = event?.type === 'thread.started' ? nativeSessionId(event.thread_id)
          : event?.type === 'session' ? nativeSessionId(event.sessionId) : null
        if (id) ids.add(id)
      } catch { /* A split or unavailable header is explicitly unknown. */ }
    }
    if (ids.size === 1 && base.context) {
      const id = [...ids][0]!
      if (base.context.sessionSource === 'receipt' && base.context.sessionId !== id) base.context.mismatch = true
      else { base.context.sessionId = id; base.context.sessionSource = 'native-log' }
      base.context.mismatch ||= !!(base.context.requestedSessionId && base.context.requestedSessionId !== id)
    } else if (ids.size > 1 && base.context) base.context.mismatch = true
    if (input.offset > count) throw new Error('log cursor exceeds the recorded stream')
    const end = Math.min(count, input.offset + 8)
    for (let i = input.offset; i < end; i++) {
      const chunk = i === 0 ? first : await privateObject(bucket, `${prefix}chunk-${String(i).padStart(6, '0')}.json`, chosen.source.runId, chosen.requestDigest, 64 * 1024)
      if (!chunk || chunk.value.schemaVersion !== 1 || !Array.isArray(chunk.value.events)) throw new Error('agent log chunk is unavailable')
      for (const event of chunk.value.events) {
        if (!record(event) || !['stdout', 'stderr'].includes(String(event.stream)) || typeof event.text !== 'string'
          || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('invalid agent log event')
        events.push({ at: event.at, stream: event.stream as 'stdout' | 'stderr', text: event.text })
      }
    }
    return { ...base, prompt, logs: { events, nextOffset: end, chunkCount: count, complete: index?.complete ?? false,
      truncated: index?.truncated ?? false, publishedAt: index?.updatedAt ?? null, mode: 'captured' } }
  }
  if (chosen && input.offset === 0) {
    const object = await privateObject(bucket,
      `quarantine/execution-receipts/${chosen.source.runId}/${chosen.requestDigest}.json`, chosen.source.runId, chosen.requestDigest, 8 * 1024 * 1024)
    const receipt = object && parseExactAgentExecutionReceipt(object.text, chosen.requestDigest)
    if (object && !receipt) throw new Error('invalid agent receipt')
    if (receipt?.stderr) events.push({ at: null, stream: 'stderr', text: receipt.stderr })
  }
  return { ...base, prompt, logs: { events, nextOffset: 0, chunkCount: 0, complete: true, truncated: true,
    publishedAt: chosen?.recordedAt ?? null, mode: chosen ? 'stderr-tail-only' : 'not-recorded' } }
}
