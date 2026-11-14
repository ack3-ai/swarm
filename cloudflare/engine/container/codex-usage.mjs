function counter(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function firstCounter(...values) {
  for (const value of values) {
    const parsed = counter(value)
    if (parsed !== null) return parsed
  }
  return null
}

export function codexUsage(stdout) {
  let inputTokens = 0
  let rawInputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let actorId = null
  let cacheAccountingComplete = false
  let selectedRawWork = -1

  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line)
      actorId ??= event.thread_id ?? event.threadId ?? event.session_id ?? event.sessionId ?? null
      const usage = event.usage ?? event.response?.usage ?? event.item?.usage
      if (usage === null || typeof usage !== 'object') continue

      const rawInput = firstCounter(usage.input_tokens, usage.inputTokens, usage.prompt_tokens, usage.promptTokens) ?? 0
      const cached = firstCounter(
        usage.cached_input_tokens,
        usage.cachedInputTokens,
        usage.input_tokens_details?.cached_tokens,
        usage.inputTokensDetails?.cachedTokens,
        usage.prompt_tokens_details?.cached_tokens,
        usage.promptTokensDetails?.cachedTokens,
      )
      const validCached = cached !== null && cached <= rawInput
      const uncachedInput = validCached ? rawInput - cached : rawInput
      const output = firstCounter(
        usage.output_tokens, usage.outputTokens, usage.completion_tokens, usage.completionTokens) ?? 0
      const rawWork = rawInput + output
      if (rawWork < selectedRawWork) continue
      selectedRawWork = rawWork
      inputTokens = uncachedInput
      rawInputTokens = rawInput
      cachedInputTokens = validCached ? cached : 0
      outputTokens = output
      cacheAccountingComplete = validCached
    } catch {}
  }

  return { inputTokens, rawInputTokens, cachedInputTokens, outputTokens, actorId, cacheAccountingComplete }
}

// Codex prints these after its own retries; the texts are its error messages (P2-06).
const codexFailures = [
  [/\b(?:exceeded retry limit, last status:|unexpected status) (\d{3})\b/, status => status === 429 ? 'RATE_LIMIT'
    : status >= 500 && status <= 599 ? 'SERVER' : `HTTP_${status}`],
  [/^stream disconnected before completion\b|^stream closed before response\.completed\b/, () => 'STREAM_CLOSED'],
  [/^Error while reading the server response\b|^Connection failed\b/, () => 'TRANSPORT'],
  [/^request timed out\b/, () => 'TIMEOUT'],
  [/^We're currently experiencing high demand\b/, () => 'SERVER'],
  [/^Selected model is at capacity\b/, () => 'OVERLOADED'],
]

/** Provider code and HTTP status of the last failed turn, for the receipt; null when the
 * last turn did not fail or its message names no provider or transport failure. */
export function codexProviderFailure(stdout) {
  let message = null
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type === 'turn.failed') message = typeof event.error?.message === 'string' ? event.error.message : ''
    if (event?.type === 'turn.completed') message = null
  }
  if (message === null) return null
  for (const [pattern, code] of codexFailures) {
    const match = message.match(pattern)
    if (match === null) continue
    const status = match[1] === undefined ? null : Number(match[1])
    return { providerErrorCode: code(status), providerHttpStatus: status }
  }
  return null
}
