import type { AgentExecutionReceipt } from './agent-execution-receipt.js'
import type { AgentRequest, RejectedAttempt } from './contracts.js'
import { nativeTransportCode } from './native-session-custody.js'
import { taskBackend } from './provider-identity.js'

/**
 * Provider backoff (E2): an attempt that ended because the model provider or its transport
 * failed is not counted against the task's attempt limit. The next launch waits instead:
 * 1, 2, 5, 15, then 30 minutes, until the task has waited 2 hours in total. After that,
 * provider failures count as attempts again, so a lasting failure still ends the run.
 */
export const providerBackoffScheduleMs: readonly number[] = [1, 2, 5, 15, 30].map(minutes => minutes * 60_000)
export const providerBackoffCapMs = 120 * 60_000

export interface ProviderBackoff {
  /** Runner and failure as the receipt shows them, for example `claude:OVERLOADED` or `codex:SERVER:503`. */
  signature: string
  /** The next launch waits this long after the rejection's `rejectedAt`. */
  delayMs: number
}

const claudeCodes = new Set(['OVERLOADED', 'SERVER_ERROR'])
const codexCodes = new Set(['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'OVERLOADED'])

/**
 * The provider-side failure an exact receipt shows, or null. A quota rejection never counts:
 * it has its own wait or failure path. Claude: the SDK's assistant error after its own retries.
 * Codex: the code the runner derives from the last `turn.failed` message. DSH: the native
 * transport codes the Worker already resumes after.
 */
export function providerTransientSignature(request: Pick<AgentRequest, 'task'>,
  receipt: Pick<AgentExecutionReceipt, 'exitCode' | 'providerErrorCode' | 'providerHttpStatus' | 'subscriptionLimits'
    | 'providerRequests'>): string | null {
  if (receipt.exitCode === 0 || receipt.subscriptionLimits?.exhausted === true) return null
  const code = typeof receipt.providerErrorCode === 'string' ? receipt.providerErrorCode : null
  const status = Number.isSafeInteger(receipt.providerHttpStatus) ? receipt.providerHttpStatus! : null
  const backend = taskBackend(request.task)
  if (request.task.providerClass === 'core' && backend === 'claude') {
    if (code !== null && claudeCodes.has(code)) return `claude:${code}`
    return code === 'RATE_LIMIT' && status === 429 ? 'claude:RATE_LIMIT:429' : null
  }
  if (request.task.providerClass === 'core' && backend === 'codex') {
    if (code !== null && codexCodes.has(code) && status === null) return `codex:${code}`
    if (code === 'SERVER' && (status === null || status >= 500 && status <= 599)) {
      return status === null ? 'codex:SERVER' : `codex:SERVER:${status}`
    }
    return code === 'RATE_LIMIT' && status === 429 ? 'codex:RATE_LIMIT:429' : null
  }
  if (request.task.providerClass === 'additive') {
    const native = nativeTransportCode(request as AgentRequest, receipt as AgentExecutionReceipt)
    if (native === null) return null
    return status === null ? `dsh:${native}` : `dsh:${native}:${status}`
  }
  return null
}

export function validProviderBackoff(value: unknown): value is ProviderBackoff {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const backoff = value as ProviderBackoff
  return typeof backoff.signature === 'string' && /^[a-z]+:[A-Z0-9_]+(?::\d{3})?$/.test(backoff.signature)
    && Number.isSafeInteger(backoff.delayMs) && backoff.delayMs > 0 && backoff.delayMs <= providerBackoffCapMs
}

type BackoffRecord = Pick<RejectedAttempt, 'attempt'> & { providerBackoff?: ProviderBackoff | undefined }

/** Earlier rejections of the same task occurrence that were provider backoffs. */
export function providerBackoffs<T extends BackoffRecord>(rejections: readonly T[], beforeAttempt = Infinity): T[] {
  return rejections.filter(rejection => rejection.attempt < beforeAttempt && validProviderBackoff(rejection.providerBackoff))
}

/** The backoff for a new provider-side failure, or null once the task has spent the 2-hour cap. */
export function nextProviderBackoff(signature: string, prior: readonly BackoffRecord[]): ProviderBackoff | null {
  const earlier = providerBackoffs(prior)
  const spent = earlier.reduce((total, rejection) => total + rejection.providerBackoff!.delayMs, 0)
  const delayMs = Math.min(providerBackoffScheduleMs[Math.min(earlier.length, providerBackoffScheduleMs.length - 1)]!,
    providerBackoffCapMs - spent)
  return delayMs > 0 ? { signature, delayMs } : null
}

/** When the next launch may start: set only while the newest rejection is a provider backoff. */
export function providerBackoffUntil(rejections: readonly (BackoffRecord & Pick<RejectedAttempt, 'rejectedAt'>)[]): number | null {
  const latest = rejections.toSorted((left, right) => left.attempt - right.attempt).at(-1)
  if (latest === undefined || !validProviderBackoff(latest.providerBackoff)) return null
  const until = Date.parse(latest.rejectedAt) + latest.providerBackoff.delayMs
  return Number.isFinite(until) ? until : null
}
