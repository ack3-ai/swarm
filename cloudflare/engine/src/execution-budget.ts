import { validSubscriptionSwitches, validSubscriptionWaits } from '../container/subscription-limits.mjs'
import type { BudgetUsage, ProviderUsage, RejectedAttempt } from './contracts.js'
import { normalizedCostUsd } from './discovery-cost.js'

export const zeroBudget = (): BudgetUsage => ({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })

export function addBudget(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
  return {
    modelCalls: left.modelCalls + right.modelCalls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    costUsd: normalizedCostUsd(left.costUsd + right.costUsd),
  }
}

export function assertBudgetShape(budget: BudgetUsage & Pick<ProviderUsage, 'subscriptionWaits' | 'subscriptionSwitches'>): void {
  if (!validSubscriptionWaits(budget.subscriptionWaits)) throw new Error('checkpoint subscription waits are invalid')
  if (!validSubscriptionSwitches(budget.subscriptionSwitches)) throw new Error('checkpoint subscription switches are invalid')
  if (!Number.isSafeInteger(budget.modelCalls) || budget.modelCalls < 0
    || !Number.isSafeInteger(budget.inputTokens) || budget.inputTokens < 0
    || !Number.isSafeInteger(budget.outputTokens) || budget.outputTokens < 0
    || !Number.isFinite(budget.costUsd) || budget.costUsd < 0) {
    throw new Error('checkpoint budget is invalid')
  }
}

export function rejectionConsumesRepairAttempt(
  rejection: Pick<RejectedAttempt, 'outputDigest' | 'usage'>,
): boolean {
  return rejection.outputDigest !== null || rejection.usage.modelCalls > 0
}
