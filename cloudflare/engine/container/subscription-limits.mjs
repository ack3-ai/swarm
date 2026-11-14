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

/** The quota waits one attempt may report: from the root runner's start to the end of its
 * last CLI launch. With Claude account rotation the root runner itself waits between
 * launches, so the window spans every launch, never one alone. A wait outside it is
 * dropped, so a stale or forged wait cannot move the discovery deadline. */
export function attemptWaitWindow(now = Date.now) {
  const startedAt = now()
  let endedAt = startedAt
  return {
    launchEnded() { endedAt = now() },
    within(waits) {
      const kept = waits?.filter(wait => Date.parse(wait.startedAt) >= startedAt && Date.parse(wait.resumedAt) <= endedAt)
      return kept === undefined || kept.length === 0 ? undefined : kept
    },
  }
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

/** Immediate Claude account switches after a quota rejection: binding names only, never token values. */
export function validSubscriptionSwitches(value) {
  return value === undefined || (Array.isArray(value) && value.every(item => item !== null
    && typeof item === 'object' && Object.keys(item).length === 6 && item.provider === 'claude'
    && typeof item.sessionId === 'string' && /^[a-zA-Z0-9._:-]{8,200}$/.test(item.sessionId)
    && ['from', 'to'].every(key => typeof item[key] === 'string' && /^CLAUDE_[A-Z0-9_]*OAUTH_TOKEN$/.test(item[key]))
    && item.from !== item.to
    && ['at', 'resetsAt'].every(key => typeof item[key] === 'string' && Number.isFinite(Date.parse(item[key])))))
}

export function subscriptionSwitches(stdout) {
  const switches = []
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'subscription_switch' && validSubscriptionSwitches([event.switch])) switches.push(event.switch)
  }
  return switches
}

/** Live Claude quota-wait status from runner stdout. A line longer than the
 * bound is skipped rather than buffered. A null reset means the wait ended. */
export function subscriptionWaitStatusReader(maxLineCharacters = 64 * 1024) {
  let pending = ''
  let skipping = false
  return text => {
    const lines = (pending + text).split('\n')
    pending = lines.pop() ?? ''
    if (skipping && lines.length > 0) { lines.shift(); skipping = false }
    if (pending.length > maxLineCharacters) { pending = ''; skipping = true }
    const statuses = []
    for (const line of lines) {
      if (!line.includes('"subscription_wait')) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'subscription_wait_started' && event.provider === 'claude'
        && typeof event.resetsAt === 'string' && Number.isFinite(Date.parse(event.resetsAt))) {
        statuses.push({ provider: 'claude', resetsAt: event.resetsAt })
      } else if (event?.type === 'subscription_wait' && event.wait?.provider === 'claude') {
        statuses.push({ provider: 'claude', resetsAt: null })
      }
    }
    return statuses
  }
}
