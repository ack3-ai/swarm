import { canonicalJson, sha256 } from './canonical.js'
import type { AgentRequest } from './contracts.js'
import { receiptMonitoringMetadata } from './dashboard-receipts.js'
import { validSubscriptionLimits, type SubscriptionLimits } from '../container/subscription-limits.mjs'

export interface AgentExecutionReceipt {
  requestDigest: string
  exitCode: number
  actorId: string
  files: Record<string, string>
  inputTokens: number
  rawInputTokens?: number
  cachedInputTokens?: number
  cacheAccountingComplete?: boolean
  costAccountingComplete?: boolean
  outputTokens: number
  costUsd: number
  stderr: string
  providerHttpStatus?: number | null
  providerErrorCode?: string | null
  providerRequests?: readonly ProviderRequestTelemetry[]
  /** Captured by the trusted installed runner from paired native tool events. */
  nativeSearchEvidence?: NativeSearchEvidence
  subscriptionLimits?: SubscriptionLimits
}

export interface NativeSearchEvidence {
  schemaVersion: 1
  source: 'dsh-json' | 'codex-json' | 'codex-exa' | 'claude-json'
  /** Codex CLI item completion alone also occurs for failed searches. */
  journalStatus?: 'verified' | 'missing' | 'mismatch'
  completed: readonly { callId: string, queryDigest: string, resultDigest: string, queries?: readonly string[] }[]
  failed: number
  incomplete: number
}

export function validNativeSearchEvidence(value: NativeSearchEvidence | undefined): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return value.schemaVersion === 1 && ['dsh-json', 'codex-json', 'codex-exa', 'claude-json'].includes(value.source)
    && (value.source === 'codex-json'
      ? ['verified', 'missing', 'mismatch'].includes(value.journalStatus ?? '')
      : value.journalStatus === undefined)
    && Array.isArray(value.completed) && value.completed.length <= 64
    && value.completed.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)
      && typeof item.callId === 'string' && /^[a-zA-Z0-9._:-]{1,200}$/.test(item.callId)
      && (item.queries === undefined || (Array.isArray(item.queries) && item.queries.length > 0
        && item.queries.length <= 16 && item.queries.every((q: unknown) => typeof q === 'string' && q.trim().length > 0 && q.length <= 4000)))
      && /^[a-f0-9]{64}$/.test(item.queryDigest) && /^[a-f0-9]{64}$/.test(item.resultDigest))
    && new Set(value.completed.map(item => item.callId)).size === value.completed.length
    && Number.isSafeInteger(value.failed) && value.failed >= 0 && value.failed <= 64
    && Number.isSafeInteger(value.incomplete) && value.incomplete >= 0 && value.incomplete <= 64
}

export class AgentExecutionReceiptIntegrityError extends Error {
  override name = 'AgentExecutionReceiptIntegrityError'
}

export interface ProviderRequestTelemetry {
  schemaVersion: 1
  provider: string
  model: string
  thinking: string | null
  reasoningEffort: string | null
  stream: boolean | null
  maxOutputTokens: number | null
  startedAt: string
  durationMs: number
  timeToFirstByteMs: number | null
  providerHttpStatus: number | null
  requestId: string | null
  finishReason: string | null
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  costUsd: number | null
  abortedByClient: boolean
  errorCategory?: string
}

export type AgentExecutionReceiptMatch =
  | { status: 'exact', receipt: AgentExecutionReceipt }
  | { status: 'stale', receipt: AgentExecutionReceipt }
  | { status: 'invalid' }

export interface AgentExecutionStartClaim {
  acquired: boolean
  claimedAt: string
}

function optionalBoundedString(value: unknown, maxLength = 500): boolean {
  return value === null || (typeof value === 'string' && value.length <= maxLength)
}

function optionalNonNegativeNumber(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function validProviderRequestTelemetry(value: unknown): value is ProviderRequestTelemetry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ProviderRequestTelemetry>
  return record.schemaVersion === 1
    && typeof record.provider === 'string' && record.provider.length > 0 && record.provider.length <= 100
    && typeof record.model === 'string' && record.model.length > 0 && record.model.length <= 200
    && optionalBoundedString(record.thinking, 100)
    && optionalBoundedString(record.reasoningEffort, 100)
    && (record.stream === null || typeof record.stream === 'boolean')
    && (record.maxOutputTokens === null
      || (Number.isSafeInteger(record.maxOutputTokens) && (record.maxOutputTokens ?? -1) >= 0))
    && typeof record.startedAt === 'string' && record.startedAt.length <= 100
    && Number.isFinite(Date.parse(record.startedAt))
    && typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
    && optionalNonNegativeNumber(record.timeToFirstByteMs)
    && (record.providerHttpStatus === null
      || (Number.isSafeInteger(record.providerHttpStatus) && (record.providerHttpStatus ?? 0) >= 100
        && (record.providerHttpStatus ?? 600) <= 599))
    && optionalBoundedString(record.requestId)
    && optionalBoundedString(record.finishReason, 100)
    && optionalNonNegativeNumber(record.inputTokens)
    && optionalNonNegativeNumber(record.outputTokens)
    && optionalNonNegativeNumber(record.reasoningTokens)
    && optionalNonNegativeNumber(record.costUsd)
    && typeof record.abortedByClient === 'boolean'
    && (record.errorCategory === undefined || (typeof record.errorCategory === 'string' && record.errorCategory.length <= 100))
}

function receiptKey(runId: string, requestDigest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('receipt run id is invalid')
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('receipt request digest is invalid')
  return `quarantine/execution-receipts/${runId}/${requestDigest}.json`
}

function admissionKey(runId: string, requestDigest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId)) throw new TypeError('receipt run id is invalid')
  if (!/^[a-f0-9]{64}$/.test(requestDigest)) throw new TypeError('receipt request digest is invalid')
  return `quarantine/execution-admissions/${runId}/${requestDigest}.json`
}

export class R2AgentExecutionReceiptStore {
  constructor(private readonly bucket: R2Bucket) {}

  /** Claims the only permitted launch of this exact paid request. */
  async claimStart(
    runId: string,
    requestDigest: string,
    claimedAt = new Date().toISOString(),
  ): Promise<AgentExecutionStartClaim> {
    if (!Number.isFinite(Date.parse(claimedAt))) throw new TypeError('agent execution admission time is invalid')
    const content = canonicalJson({ schemaVersion: 1, runId, requestDigest, claimedAt })
    const objectSha256 = await sha256(content)
    const key = admissionKey(runId, requestDigest)
    const stored = await this.bucket.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { requestDigest, runId, objectSha256, disposition: 'execution-admission' },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored !== null) return { acquired: true, claimedAt }
    const existing = await this.getStart(runId, requestDigest)
    if (existing === null) throw new Error('agent execution admission provenance mismatch')
    return existing
  }

  /** Observe an existing launch without consuming its immutable claim. */
  async getStart(runId: string, requestDigest: string): Promise<AgentExecutionStartClaim | null> {
    const existing = await this.bucket.get(admissionKey(runId, requestDigest))
    if (existing === null) return null
    const existingSha256 = existing?.customMetadata?.objectSha256
    if (existing.customMetadata?.requestDigest !== requestDigest
      || existing.customMetadata?.runId !== runId
      || !/^[a-f0-9]{64}$/.test(existingSha256 ?? '')
      || existingSha256 !== existing.checksums.toJSON().sha256) {
      throw new Error('agent execution admission provenance mismatch')
    }
    const existingContent = await existing.text()
    if (await sha256(existingContent) !== existingSha256) {
      throw new Error('agent execution admission provenance mismatch')
    }
    const value: unknown = JSON.parse(existingContent)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('agent execution admission content is invalid')
    }
    const admission = value as Record<string, unknown>
    if (admission.schemaVersion !== 1 || admission.runId !== runId || admission.requestDigest !== requestDigest
      || typeof admission.claimedAt !== 'string' || !Number.isFinite(Date.parse(admission.claimedAt))) {
      throw new Error('agent execution admission content is invalid')
    }
    return { acquired: false, claimedAt: admission.claimedAt }
  }

  async get(runId: string, requestDigest: string): Promise<AgentExecutionReceipt | null> {
    const object = await this.bucket.get(receiptKey(runId, requestDigest))
    if (object === null) return null
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.requestDigest !== requestDigest
      || object.customMetadata?.runId !== runId
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) {
      throw new AgentExecutionReceiptIntegrityError('agent execution receipt provenance mismatch')
    }
    const receipt = parseExactAgentExecutionReceipt(content, requestDigest)
    if (receipt === null) throw new AgentExecutionReceiptIntegrityError('agent execution receipt content is invalid')
    return receipt
  }

  async put(runId: string, requestDigest: string, receipt: AgentExecutionReceipt, request?: AgentRequest): Promise<void> {
    if (parseExactAgentExecutionReceipt(canonicalJson(receipt), requestDigest) === null) {
      throw new TypeError('agent execution receipt is invalid')
    }
    const content = canonicalJson(receipt)
    const objectSha256 = await sha256(content)
    const monitoring = request === undefined ? {} : await receiptMonitoringMetadata(request, receipt).catch(() => ({}))
    const stored = await this.bucket.put(receiptKey(runId, requestDigest), content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { requestDigest, runId, objectSha256, disposition: 'exact-execution-receipt', ...monitoring },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored !== null) return
    const existing = await this.get(runId, requestDigest)
    if (existing === null || canonicalJson(existing) !== content) {
      throw new Error('agent execution receipt already exists with different bytes')
    }
  }
}

export const agentExecutionReceiptWrapper = `#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

const [requestPath, resultPath] = process.argv.slice(2)
if (!requestPath || !resultPath) throw new Error('request and result paths are required')
const rawResultPath = resultPath + '.raw-' + process.pid
const code = await new Promise(resolve => {
  const child = spawn('/usr/local/bin/ack3-agent-runner', [requestPath, rawResultPath], { stdio: 'inherit' })
  child.on('close', value => resolve(value ?? 1))
  child.on('error', error => { console.error(error); resolve(1) })
})
const request = JSON.parse(await readFile(requestPath, 'utf8'))
if (!/^[a-f0-9]{64}$/.test(request.requestDigest ?? '')) throw new Error('invalid request digest')
const result = JSON.parse(await readFile(rawResultPath, 'utf8'))
result.requestDigest = request.requestDigest
const temporaryPath = resultPath + '.receipt-' + process.pid
await writeFile(temporaryPath, JSON.stringify(result), { mode: 0o600 })
await rename(temporaryPath, resultPath)
await rm(rawResultPath, { force: true })
process.exitCode = code
`

export function parseExactAgentExecutionReceipt(
  input: string,
  expectedRequestDigest: string,
): AgentExecutionReceipt | null {
  const match = classifyAgentExecutionReceipt(input, expectedRequestDigest)
  return match.status === 'exact' ? match.receipt : null
}

export function classifyAgentExecutionReceipt(
  input: string,
  expectedRequestDigest: string,
): AgentExecutionReceiptMatch {
  try {
    const value = JSON.parse(input) as Partial<AgentExecutionReceipt>
    if (!/^[a-f0-9]{64}$/.test(value.requestDigest ?? '')
      || !Number.isSafeInteger(value.exitCode)
      || typeof value.actorId !== 'string'
      || value.actorId.length === 0
      || value.files === null
      || typeof value.files !== 'object'
      || Array.isArray(value.files)
      || !Object.values(value.files).every(file => typeof file === 'string')
      || typeof value.inputTokens !== 'number' || !Number.isFinite(value.inputTokens)
      || typeof value.outputTokens !== 'number' || !Number.isFinite(value.outputTokens)
      || typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd)
      || (value.costAccountingComplete !== undefined && typeof value.costAccountingComplete !== 'boolean')
      || typeof value.stderr !== 'string'
      || !validNativeSearchEvidence(value.nativeSearchEvidence)
      || !validSubscriptionLimits(value.subscriptionLimits)
      || (value.providerRequests !== undefined
        && (!Array.isArray(value.providerRequests)
          || value.providerRequests.length > 2_000
          || !value.providerRequests.every(validProviderRequestTelemetry)))) return { status: 'invalid' }
    const receipt = value as AgentExecutionReceipt
    return receipt.requestDigest === expectedRequestDigest
      ? { status: 'exact', receipt }
      : { status: 'stale', receipt }
  } catch {
    return { status: 'invalid' }
  }
}
