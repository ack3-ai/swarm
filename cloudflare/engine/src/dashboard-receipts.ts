import type { AgentRequest } from './contracts.js'
import type { AgentExecutionReceipt } from './agent-execution-receipt.js'
import type { LiveCompletion } from './dashboard-types.js'
import { canonicalJson, sha256 } from './canonical.js'
import { providerIdentity } from './provider-identity.js'

const digest = /^[a-f0-9]{64}$/
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const count = (value: unknown): value is number => finite(value) && Number.isSafeInteger(value)

/** Optional observation metadata only: no receipt bytes, request identity, or execution decisions change. */
export async function receiptMonitoringMetadata(
  request: Pick<AgentRequest, 'attempt' | 'promptDigest'> & {
    stage: { id: string }; wave: { id: string }
    task: Pick<AgentRequest['task'], 'id' | 'model' | 'providerClass' | 'backend'>
  },
  receipt: AgentExecutionReceipt,
): Promise<Record<string, string>> {
  const value: LiveCompletion = {
    requestDigest: receipt.requestDigest,
    stageId: request.stage.id,
    waveId: request.wave.id,
    taskId: request.task.id,
    attempt: request.attempt,
    model: request.task.model,
    provider: providerIdentity(request.task),
    actorId: receipt.actorId,
    promptDigest: request.promptDigest,
    outputDigest: await sha256(canonicalJson(receipt.files)),
    recordedAt: new Date().toISOString(),
    usage: {
      modelCalls: 1,
      inputTokens: receipt.inputTokens,
      outputTokens: receipt.outputTokens,
      costUsd: receipt.costUsd,
      ...(receipt.rawInputTokens === undefined ? {} : { rawInputTokens: receipt.rawInputTokens }),
      ...(receipt.cachedInputTokens === undefined ? {} : { cachedInputTokens: receipt.cachedInputTokens }),
      ...(receipt.cacheAccountingComplete === undefined ? {} : { cacheAccountingComplete: receipt.cacheAccountingComplete }),
      ...(receipt.costAccountingComplete === undefined ? {} : { costAccountingComplete: receipt.costAccountingComplete }),
    },
  }
  const serialized = JSON.stringify(value)
  // Leave headroom under R2's 2 KiB metadata limit for the existing integrity fields.
  if (new TextEncoder().encode(serialized).byteLength > 1_400 || parseLiveCompletion(serialized) === null) return {}
  return { monitorV1: serialized }
}

export function parseLiveCompletion(input: string | undefined): LiveCompletion | null {
  if (input === undefined || input.length > 1_400) return null
  try {
    const value: unknown = JSON.parse(input)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    const v = value as Record<string, unknown>
    const allowed = ['requestDigest', 'stageId', 'waveId', 'taskId', 'attempt', 'model', 'provider', 'actorId', 'promptDigest', 'outputDigest', 'recordedAt', 'usage']
    if (Object.keys(v).some(key => !allowed.includes(key))) return null
    for (const name of ['stageId', 'waveId', 'taskId', 'model', 'provider', 'actorId', 'recordedAt']) {
      if (typeof v[name] !== 'string' || v[name].length === 0 || v[name].length > 160) return null
    }
    for (const name of ['requestDigest', 'promptDigest', 'outputDigest']) {
      if (typeof v[name] !== 'string' || !digest.test(v[name])) return null
    }
    if (!count(v.attempt) || v.attempt < 1 || !Number.isFinite(Date.parse(String(v.recordedAt)))) return null
    if (v.usage === null || typeof v.usage !== 'object' || Array.isArray(v.usage)) return null
    const usage = v.usage as Record<string, unknown>
    if (Object.keys(usage).some(key => !['modelCalls', 'inputTokens', 'outputTokens', 'costUsd', 'rawInputTokens', 'cachedInputTokens', 'cacheAccountingComplete', 'costAccountingComplete'].includes(key))) return null
    if (!count(usage.modelCalls) || !count(usage.inputTokens) || !count(usage.outputTokens) || !finite(usage.costUsd)) return null
    if (usage.rawInputTokens !== undefined && !count(usage.rawInputTokens)) return null
    if (usage.cachedInputTokens !== undefined && !count(usage.cachedInputTokens)) return null
    if (usage.cacheAccountingComplete !== undefined && typeof usage.cacheAccountingComplete !== 'boolean') return null
    if (usage.costAccountingComplete !== undefined && typeof usage.costAccountingComplete !== 'boolean') return null
    if (usage.cacheAccountingComplete === true
      && (usage.rawInputTokens === undefined || usage.cachedInputTokens === undefined
        || Number(usage.rawInputTokens) !== Number(usage.inputTokens) + Number(usage.cachedInputTokens))) return null
    return value as LiveCompletion
  } catch { return null }
}

/** Bounded, metadata-only reads; private receipt files/stderr are never fetched for polling. */
export async function listLiveCompletions(bucket: Pick<R2Bucket, 'list'>, runId: string): Promise<{
  entries: LiveCompletion[]; legacyCount: number; truncated: boolean
}> {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('invalid run id')
  const prefix = `quarantine/execution-receipts/${runId}/`
  const entries: LiveCompletion[] = []
  let cursor: string | undefined
  let legacyCount = 0
  for (let page = 0; page < 8; page += 1) {
    const result = await bucket.list({ prefix, limit: 1_000, include: ['customMetadata'], ...(cursor === undefined ? {} : { cursor }) })
    for (const object of result.objects) {
      const metadata = object.customMetadata
      const value = parseLiveCompletion(metadata?.monitorV1)
      if (value === null || metadata?.runId !== runId || metadata.requestDigest !== value.requestDigest
        || object.key !== `${prefix}${value.requestDigest}.json`) { legacyCount += 1; continue }
      entries.push(value)
    }
    if (!result.truncated) return { entries, legacyCount, truncated: false }
    cursor = result.cursor
  }
  return { entries, legacyCount, truncated: true }
}
