const percent = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
const reset = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null

export function validSubscriptionLimits(value) {
  return value === undefined || (value !== null && typeof value === 'object'
    && ['codex', 'claude'].includes(value.provider) && typeof value.observedAt === 'string'
    && Number.isFinite(Date.parse(value.observedAt)) && typeof value.exhausted === 'boolean'
    && Array.isArray(value.windows) && value.windows.length <= 16
    && value.windows.every(window => window !== null && typeof window === 'object'
      && typeof window.name === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(window.name)
      && (window.usedPercent === null || percent(window.usedPercent))
      && (window.resetsAt === null || (typeof window.resetsAt === 'string' && Number.isFinite(Date.parse(window.resetsAt))))))
}

/** Native observations only. Missing windows never mean unused quota. */
export function codexSubscriptionLimits(response, observedAt = new Date().toISOString()) {
  const bucket = response?.rateLimitsByLimitId?.codex ?? response?.rateLimits
  const windows = [bucket?.primary, bucket?.secondary].filter(Boolean).map(window => ({
    name: `${window.windowDurationMins}-minutes`,
    usedPercent: percent(window.usedPercent) ? window.usedPercent : null,
    resetsAt: typeof window.resetsAt === 'number' ? reset(window.resetsAt * 1000) : null,
  }))
  return { provider: 'codex', observedAt, windows,
    exhausted: windows.some(window => window.usedPercent === 100) }
}

export function claudeSubscriptionLimits(info, observedAt = new Date().toISOString()) {
  // SDK rate_limit_event utilization is a fraction; /usage uses percentages.
  const used = typeof info?.utilization === 'number' ? info.utilization * 100 : null
  return { provider: 'claude', observedAt,
    windows: info?.rateLimitType ? [{
      name: info.rateLimitType, usedPercent: percent(used) ? used : null,
      resetsAt: typeof info.resetsAt === 'number' ? reset(info.resetsAt * 1000) : null,
    }] : [],
    exhausted: info?.status === 'rejected',
  }
}

export function latestSubscriptionLimits(stdout) {
  let latest
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'subscription_limits' && validSubscriptionLimits(event.limits)) latest = event.limits
  }
  return latest
}

/** Completed native quota waits; overlapping agents must not extend the clock twice. */
export function validSubscriptionWaits(value) {
  return value === undefined || (Array.isArray(value) && value.every(wait => wait !== null
    && typeof wait === 'object' && ['claude', 'dsh'].includes(wait.provider)
    && typeof wait.sessionId === 'string' && /^[a-zA-Z0-9._:-]{8,200}$/.test(wait.sessionId)
    && ['startedAt', 'resumedAt', 'resetsAt'].every(key => typeof wait[key] === 'string'
      && Number.isFinite(Date.parse(wait[key])))
    && Date.parse(wait.resumedAt) >= Date.parse(wait.startedAt)
    && Date.parse(wait.resumedAt) >= Date.parse(wait.resetsAt)))
}

export function subscriptionWaits(stdout) {
  const waits = []
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'subscription_wait' && validSubscriptionWaits([event.wait])) waits.push(event.wait)
  }
  return waits.length === 0 ? undefined : waits
}
