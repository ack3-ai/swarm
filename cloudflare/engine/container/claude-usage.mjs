export function claudeUsage(stdout) {
  let actorId = null
  let result
  let providerErrorCode = null
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'system' && event.subtype === 'init') actorId = event.session_id
    if (event.type === 'result') { result = event; actorId = event.session_id ?? actorId }
    if (event.type === 'assistant' && typeof event.error === 'string') {
      providerErrorCode = event.error.toUpperCase()
    }
  }
  // SDK result usage is cumulative for this query, including native tool turns.
  // Summing assistant events as well would double count.
  const usage = result?.usage
  const count = value => Number.isSafeInteger(value) && value >= 0
  const cacheAccountingComplete = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
    .every(key => count(usage?.[key]))
  const inputTokens = (count(usage?.input_tokens) ? usage.input_tokens : 0)
    + (count(usage?.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0)
  const cachedInputTokens = count(usage?.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0
  return {
    actorId, inputTokens, cachedInputTokens, rawInputTokens: inputTokens + cachedInputTokens,
    outputTokens: count(usage?.output_tokens) ? usage.output_tokens : 0,
    cacheAccountingComplete, costAccountingComplete: false,
    providerErrorCode, providerHttpStatus: providerErrorCode === 'RATE_LIMIT' ? 429 : null,
  }
}
