const validCount = value => Number.isSafeInteger(value) && value >= 0
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value >= 0

// A receipt records an estimate at the sealed connection's rate card, not a provider invoice.
// Missing retry or cache samples cannot be priced reliably from the native projection.
export function dshCost(usage, rates, separateNativeSearch = false) {
  if (!rates || ![rates.uncachedInputUsdPerMillion, rates.cachedInputUsdPerMillion,
    rates.outputUsdPerMillion].every(validRate)
    || usage.usageComplete !== true || usage.cacheAccountingComplete !== true
    || !validCount(usage.rawInputTokens) || !validCount(usage.cachedInputTokens)
    || !validCount(usage.outputTokens) || usage.cachedInputTokens > usage.rawInputTokens) {
    return { costUsd: 0, costAccountingComplete: false }
  }
  // DSH's raw input already includes cache writes; only cache reads receive the cached rate.
  const uncached = usage.rawInputTokens - usage.cachedInputTokens
  const costUsd = (uncached * rates.uncachedInputUsdPerMillion
    + usage.cachedInputTokens * rates.cachedInputUsdPerMillion
    + usage.outputTokens * rates.outputUsdPerMillion) / 1_000_000
  return {
    costUsd,
    // The native web-search connection uses a separate model and rate card;
    // this projection prices only the parent DSH request.
    costAccountingComplete: !separateNativeSearch,
  }
}
