export interface SubscriptionLimits {
  provider: 'codex' | 'claude'
  observedAt: string
  windows: { name: string, usedPercent: number | null, resetsAt: string | null }[]
  exhausted: boolean
}
export function codexSubscriptionLimits(response: unknown, observedAt?: string): SubscriptionLimits
export function claudeSubscriptionLimits(info: unknown, observedAt?: string): SubscriptionLimits
export function latestSubscriptionLimits(stdout: string): SubscriptionLimits | undefined
export function validSubscriptionLimits(value: unknown): value is SubscriptionLimits | undefined

export interface SubscriptionWait {
  provider: 'claude' | 'dsh'
  sessionId: string
  startedAt: string
  resumedAt: string
  resetsAt: string
}
export function validSubscriptionWaits(value: unknown): value is readonly SubscriptionWait[] | undefined
export function subscriptionWaits(stdout: string): SubscriptionWait[] | undefined
