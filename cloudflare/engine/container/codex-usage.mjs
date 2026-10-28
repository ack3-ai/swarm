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
