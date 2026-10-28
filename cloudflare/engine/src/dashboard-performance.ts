import type { ProviderRequestTelemetry } from './agent-execution-receipt.js'
import { parseExactAgentExecutionReceipt } from './agent-execution-receipt.js'
import type { RunState, TaskDefinition } from './contracts.js'
import { sha256 } from './canonical.js'
import { listLiveCompletions } from './dashboard-receipts.js'
import { providerIdentity } from './provider-identity.js'

interface RequestSample extends ProviderRequestTelemetry { taskId: string }

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** Request-time averages exclude tool time. They are not swarm wall-time rates or decode speed. */
export function summarizeProviderPerformance(samples: readonly RequestSample[]) {
  const groups = new Map<string, RequestSample[]>()
  for (const sample of samples) {
    const key = JSON.stringify([sample.provider, sample.model, sample.thinking, sample.reasoningEffort, sample.stream])
    const group = groups.get(key) ?? []
    group.push(sample)
    groups.set(key, group)
  }
  return [...groups.values()].map(requests => {
    const first = requests[0]!
    const successful = requests.filter(item => item.providerHttpStatus !== null
      && item.providerHttpStatus >= 200 && item.providerHttpStatus < 300
      && !item.abortedByClient && item.errorCategory === undefined)
    const measured = successful.filter(item => item.outputTokens !== null && item.durationMs > 0)
    const requestDurationMs = measured.reduce((total, item) => total + item.durationMs, 0)
    const outputTokens = measured.reduce((total, item) => total + item.outputTokens!, 0)
    const firstBytes = successful.flatMap(item => item.timeToFirstByteMs !== null
      && item.timeToFirstByteMs <= item.durationMs ? [item.timeToFirstByteMs] : [])
    return {
      provider: first.provider, model: first.model, thinking: first.thinking,
      reasoningEffort: first.reasoningEffort, stream: first.stream,
      taskIds: [...new Set(requests.map(item => item.taskId))].toSorted(),
      requests: requests.length, successfulRequests: successful.length,
      failedOrAbortedRequests: requests.filter(item => item.abortedByClient || item.errorCategory !== undefined
        || item.providerHttpStatus !== null && item.providerHttpStatus >= 400).length,
      measuredRequests: measured.length,
      outputTokens: measured.length ? outputTokens : null, requestDurationMs,
      outputTokensPerSecond: requestDurationMs > 0 ? outputTokens * 1000 / requestDurationMs : null,
      medianFirstByteMs: median(firstBytes), firstByteRequests: firstBytes.length,
      medianRequestMs: median(successful.map(item => item.durationMs)),
    }
  }).sort((a, b) => a.model.localeCompare(b.model) || a.provider.localeCompare(b.provider))
}

/** On-demand, bounded receipt reads only. Never contacts an agent or starts a container. */
export async function readDashboardPerformance(
  state: RunState,
  selection: { stageId: string; waveId: string; tasks: readonly TaskDefinition[] },
  store: { getState(runId: string): Promise<RunState> },
  bucket: Pick<R2Bucket, 'list' | 'get'>,
) {
  const samples: RequestSample[] = []
  const seen = new Set<string>()
  let current: RunState | null = state
  let inspectedReceipts = 0
  let receiptsWithTelemetry = 0
  let incomplete = false
  // Scan only actual recovery parents, never a caller-supplied run or artifact key.
  while (current !== null && seen.size < 8 && inspectedReceipts < 32) {
    if (seen.has(current.runId)) { incomplete = true; break }
    seen.add(current.runId)
    const live = await listLiveCompletions(bucket, current.runId)
    incomplete ||= live.truncated || live.legacyCount > 0
    const matches = live.entries.filter(entry => entry.stageId === selection.stageId
      && entry.waveId === selection.waveId && selection.tasks.some(task => task.id === entry.taskId
        && task.model === entry.model && providerIdentity(task) === entry.provider))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || b.attempt - a.attempt)
    for (const entry of matches) {
      if (inspectedReceipts >= 32) { incomplete = true; break }
      inspectedReceipts++
      const object = await bucket.get(`quarantine/execution-receipts/${current.runId}/${entry.requestDigest}.json`)
      if (object === null) { incomplete = true; continue }
      if (object.size > 8 * 1024 * 1024) { await object.body.cancel(); incomplete = true; continue }
      const content = await object.text()
      const digest = await sha256(content)
      if (object.customMetadata?.runId !== current.runId || object.customMetadata?.requestDigest !== entry.requestDigest
        || object.customMetadata?.objectSha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
        throw new Error('provider telemetry receipt integrity mismatch')
      }
      const receipt = parseExactAgentExecutionReceipt(content, entry.requestDigest)
      if (receipt === null || receipt.actorId !== entry.actorId) throw new Error('invalid provider telemetry receipt')
      const telemetry = receipt.providerRequests ?? []
      if (telemetry.length) receiptsWithTelemetry++
      incomplete ||= telemetry.length >= 2_000
      // Keep only request measurements; raw responses, prompts, stderr and request IDs never leave this reader.
      for (const item of telemetry) samples.push({ ...item, taskId: entry.taskId })
    }
    if (current.parentRunId === null) { current = null; break }
    try {
      const parent: RunState = await store.getState(current.parentRunId)
      if (parent.runId !== current.parentRunId || parent.rootRunId !== state.rootRunId
        || parent.experimentId !== state.experimentId || parent.definitionDigest !== state.definitionDigest) {
        incomplete = true; break
      }
      current = parent
    } catch { incomplete = true; break }
  }
  if (current !== null) incomplete = true
  return {
    runId: state.runId, stageId: selection.stageId, waveId: selection.waveId,
    observedAt: new Date().toISOString(), groups: summarizeProviderPerformance(samples),
    inspectedReceipts, receiptsWithTelemetry, incomplete, inFlightKnown: false,
    note: 'Saved request telemetry across this run and its recovery parents. Output/request second = reported output tokens divided by summed successful request time, including provider queueing and network time. It excludes time between requests and is not decode speed. Output may include reasoning tokens. First byte may precede model text. Errors and missing counters are not zero-speed results. Model IDs and thinking settings remain separate; matching names do not prove identical model versions.',
  }
}
