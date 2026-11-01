export function claudeUsage(stdout) {
  let actorId = null
  const results = new Map()
  let queryIndex = 0
  let providerErrorCode = null
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'claude_query_started' && Number.isSafeInteger(event.queryIndex)) {
      queryIndex = event.queryIndex
      providerErrorCode = null
      results.set(queryIndex, undefined)
    }
    if (event.type === 'system' && event.subtype === 'init') actorId = event.session_id
    if (event.type === 'result') { results.set(queryIndex, event); actorId = event.session_id ?? actorId }
    if (event.type === 'assistant' && typeof event.error === 'string') {
      providerErrorCode = event.error.toUpperCase()
    }
  }
  // Each SDK query reports cumulative usage for that query, not the session.
  // Count one result per query; assistant events and duplicate result frames
  // must not double count work completed before a quota wait.
  const count = value => Number.isSafeInteger(value) && value >= 0
  let inputTokens = 0, cachedInputTokens = 0, outputTokens = 0
  let cacheAccountingComplete = results.size > 0
  for (const result of results.values()) {
    const usage = result?.usage
    cacheAccountingComplete &&= ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
      .every(key => count(usage?.[key]))
    inputTokens += (count(usage?.input_tokens) ? usage.input_tokens : 0)
      + (count(usage?.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : 0)
    cachedInputTokens += count(usage?.cache_read_input_tokens) ? usage.cache_read_input_tokens : 0
    outputTokens += count(usage?.output_tokens) ? usage.output_tokens : 0
  }
  const rawInputTokens = inputTokens + cachedInputTokens
  return {
    actorId, inputTokens: cacheAccountingComplete ? inputTokens : rawInputTokens, cachedInputTokens, rawInputTokens,
    outputTokens, cacheAccountingComplete, costAccountingComplete: false,
    providerErrorCode, providerHttpStatus: providerErrorCode === 'RATE_LIMIT' ? 429 : null,
  }
}
