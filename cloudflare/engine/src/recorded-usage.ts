import type { BudgetUsage, ProviderUsage } from './contracts.js'

/** Adds receipt counters without converting missing cache evidence into an attested cache miss. */
export function sumRecordedUsage(items: readonly ProviderUsage[]): ProviderUsage {
  const usage: ProviderUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    rawInputTokens: 0, cachedInputTokens: 0, cacheAccountingComplete: true,
    costAccountingComplete: true }
  for (const item of items) {
    usage.modelCalls += item.modelCalls
    usage.inputTokens += item.inputTokens
    usage.outputTokens += item.outputTokens
    usage.costUsd += item.costUsd
    usage.rawInputTokens = (usage.rawInputTokens ?? 0) + (item.rawInputTokens ?? item.inputTokens)
    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (item.cachedInputTokens ?? 0)
    if (item.cacheAccountingComplete === false || ((item.modelCalls > 0 || item.inputTokens > 0 || item.outputTokens > 0)
      && item.cacheAccountingComplete !== true)) usage.cacheAccountingComplete = false
    if (item.costAccountingComplete === false
      || ((item.modelCalls > 0 || item.inputTokens > 0 || item.outputTokens > 0
        || item.costUsd > 0 || (item.rawInputTokens ?? 0) > 0 || (item.cachedInputTokens ?? 0) > 0)
        && item.costAccountingComplete !== true)) usage.costAccountingComplete = false
  }
  usage.costUsd = Number(usage.costUsd.toFixed(12))
  return usage
}


export function recordedUsageMatches(receipts: BudgetUsage, budget: BudgetUsage): boolean {
  return (['modelCalls', 'inputTokens', 'outputTokens', 'costUsd'] as const)
    .every(key => Math.abs(receipts[key] - budget[key]) <= 1e-10)
}
