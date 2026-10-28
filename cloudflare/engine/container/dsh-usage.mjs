// DSH --json reports usage once per step, including the step's internal retries.
// Both use disjoint input/cache counts; Swarm's rawInputTokens includes cache reads.
export function dshUsage(stdout) {
  let actorId = null
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let complete = true
  let cacheComplete = true
  let final = false
  let providerHttpStatus = null
  let providerErrorCode = null
  const started = new Set()
  const steps = new Map()
  const count = value => Number.isSafeInteger(value) && value >= 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { complete = false; continue }
    if (event?.type === 'session') {
      actorId = typeof event.sessionId === 'string' ? event.sessionId : null
      continue
    }
    if (event?.type === 'final') { final = true; continue }
    if (event?.type === 'status' && event.phase === 'turn_end' && event.reason?.kind === 'error') {
      const error = event.reason.error
      if (Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599) providerHttpStatus = error.status
      if (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code)) providerErrorCode = error.code
    }
    if (event?.type !== 'status' || !['step_start', 'step_end'].includes(event.phase)) continue
    if (!actorId || !count(event.turn) || !count(event.step)) { complete = false; continue }
    const key = JSON.stringify([actorId, event.turn, event.step])
    if (event.phase === 'step_start') { started.add(key); continue }
    if (steps.has(key)) {
      if (JSON.stringify(steps.get(key)) !== JSON.stringify(event.usage)) complete = false
      continue
    }
    const usage = event.usage
    steps.set(key, usage)
    if (!usage || !count(usage.inputTokens) || !count(usage.outputTokens)
      || (usage.cacheReadTokens !== undefined && !count(usage.cacheReadTokens))
      || (usage.cacheWriteTokens !== undefined && !count(usage.cacheWriteTokens))) {
      complete = false
      cacheComplete = false
      continue
    }
    // A missing cache breakdown must not turn known total input into zero.
    const knownInput = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    const input = usage.totalTokens === undefined ? knownInput : usage.totalTokens - usage.outputTokens
    if (!count(input) || input < knownInput || !count(inputTokens + input) || !count(outputTokens + usage.outputTokens)
      || (usage.cacheReadTokens !== undefined && input !== knownInput)) {
      complete = false
      cacheComplete = false
      continue
    }
    inputTokens += input
    outputTokens += usage.outputTokens
    cachedInputTokens += usage.cacheReadTokens ?? 0
    cacheComplete &&= count(usage.cacheReadTokens)
  }
  const usageComplete = complete && final && steps.size > 0 && [...started].every(key => steps.has(key))
  const cacheAccountingComplete = usageComplete && cacheComplete
  return {
    actorId,
    inputTokens: cacheAccountingComplete ? inputTokens - cachedInputTokens : inputTokens,
    rawInputTokens: inputTokens,
    cachedInputTokens,
    outputTokens,
    providerHttpStatus,
    providerErrorCode,
    usageComplete,
    cacheAccountingComplete,
  }
}
