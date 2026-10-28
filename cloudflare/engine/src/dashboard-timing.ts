import type { ProviderUsage } from './contracts.js'
import type { DashboardThroughput, DashboardTiming } from './dashboard-types.js'

/** Observation time only. Missing evidence never becomes a zero-duration execution. */
export function dashboardTiming(
  startedAt: string | null,
  finishedAt: string | null,
  live: boolean,
  observedAt: string,
  basis: DashboardTiming['basis'],
): DashboardTiming {
  const start = Date.parse(startedAt ?? '')
  const end = Date.parse(finishedAt ?? (live ? observedAt : ''))
  const known = Number.isFinite(start) && Number.isFinite(end) && end >= start
  return { startedAt, finishedAt, elapsedMs: known ? end - start : null, live: known && live && finishedAt === null, basis }
}

/** Aggregate parallel work over one wall-clock span; never average lane rates. */
export function dashboardThroughput(
  usage: ProviderUsage,
  timing: DashboardTiming | undefined,
  provisional = false,
  partial = false,
): DashboardThroughput | null {
  const elapsedMs = timing?.elapsedMs
  const input = usage.rawInputTokens ?? usage.inputTokens
  const output = usage.outputTokens
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs <= 0
    || !Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0
    || input + output <= 0) return null
  const seconds = elapsedMs / 1000
  return { elapsedMs, inputTokensPerSecond: input / seconds,
    outputTokensPerSecond: output / seconds, totalTokensPerSecond: (input + output) / seconds,
    provisional, partial }
}
