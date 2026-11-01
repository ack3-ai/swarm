import { sha256 } from './canonical.js'

export interface NativeQuotaWait {
  provider: 'claude'
  sessionId: string
  window: string
  /** Null when capture ends inside the wait marker; never inferred from rejection time. */
  startedAt: string | null
  resetsAt: string
  rejectionDigest: string
  resultDigest: string
  waitDigest: string
  waitCapture: 'complete' | 'partial'
}

/** Bind rejection/error/session and the actual wait marker. Partial capture stays explicit. */
export async function nativeQuotaWait(stdout: string): Promise<NativeQuotaWait | null> {
  let rejected: Record<string, any> | null = null
  let result: Record<string, any> | null = null
  let pending: NativeQuotaWait | null = null
  const boundResult = () => rejected !== null && result?.is_error === true
    && result.session_id === rejected.session_id && /^[a-zA-Z0-9._:-]{8,200}$/.test(rejected.session_id ?? '')
    && Number.isFinite(rejected.rate_limit_info?.resetsAt)
    && typeof rejected.rate_limit_info?.rateLimitType === 'string' && rejected.rate_limit_info.rateLimitType.length <= 100
  const evidence = async (waitDigest: string, startedAt: string | null, waitCapture: 'complete' | 'partial'): Promise<NativeQuotaWait> => ({
    provider: 'claude', sessionId: rejected!.session_id, window: rejected!.rate_limit_info.rateLimitType,
    startedAt, resetsAt: new Date(rejected!.rate_limit_info.resetsAt * 1000).toISOString(),
    rejectionDigest: await sha256(rejected), resultDigest: await sha256(result), waitDigest, waitCapture,
  })
  const lines = stdout.split('\n')
  for (const [index, line] of lines.entries()) {
    let event: Record<string, any>
    try { event = JSON.parse(line) } catch {
      // Some durable captures end inside the next native stdout event. Only the
      // exact runner marker after a complete matching rejection/error is usable;
      // no missing timestamp or session suffix is reconstructed as observed data.
      const marker = '{"type":"subscription_wait_started","provider":"claude","sessionId":"'
      const suffix = line.startsWith(marker) ? line.slice(marker.length) : ''
      if (index === lines.length - 1 && boundResult() && /^[a-zA-Z0-9._:-]{8,199}$/.test(suffix)
        && rejected!.session_id.startsWith(suffix)) pending = await evidence(await sha256(line), null, 'partial')
      continue
    }
    if (event === null || typeof event !== 'object' || Array.isArray(event)) continue
    if (event.type === 'rate_limit_event') {
      rejected = event.rate_limit_info?.status === 'rejected' ? event : null
      result = null
      pending = null
    }
    if (event.type === 'result') result = event
    if (event.type === 'subscription_wait' || event.type === 'claude_query_started') {
      pending = null; rejected = null; result = null
    }
    if (event.type !== 'subscription_wait_started' || event.provider !== 'claude' || !boundResult()) continue
    if (rejected!.session_id !== event.sessionId || !Number.isFinite(Date.parse(event.startedAt))
      || !Number.isFinite(Date.parse(event.resetsAt))
      || rejected!.rate_limit_info.resetsAt * 1000 !== Date.parse(event.resetsAt)) continue
    pending = await evidence(await sha256(event), event.startedAt, 'complete')
  }
  return pending
}
