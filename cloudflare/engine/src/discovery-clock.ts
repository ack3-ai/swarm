import type { ExperimentDefinition, RunState, ProviderUsage } from './contracts.js'
import { reconDurationMs } from './recon.js'
import { validProviderBackoff } from './provider-backoff.js'

/** A provider backoff (P2-06): from the rejection to the earliest next launch. */
export interface ProviderBackoffWait { kind: 'provider-backoff', taskId: string, startedAt: string, resumedAt: string }
export type DiscoveryWaits = readonly (NonNullable<ProviderUsage['subscriptionWaits']>[number] | ProviderBackoffWait)[]

export function discoveryWaits(definition: ExperimentDefinition, state: Pick<RunState, 'artifacts' | 'rejectedAttempts'>): DiscoveryWaits {
  const ids = new Set(definition.stages.filter(stage => stage.kind === 'discovery').map(stage => stage.id))
  const quota = [...state.artifacts, ...state.rejectedAttempts].filter(record => ids.has(record.stageId))
    .flatMap(record => record.usage.subscriptionWaits ?? [])
  const backoff = state.rejectedAttempts.flatMap(record => !ids.has(record.stageId)
    || !validProviderBackoff(record.providerBackoff) || !Number.isFinite(Date.parse(record.rejectedAt)) ? []
    : [{ kind: 'provider-backoff' as const, taskId: record.taskId, startedAt: record.rejectedAt,
      resumedAt: new Date(Date.parse(record.rejectedAt) + record.providerBackoff.delayMs).toISOString() }])
  return [...quota, ...backoff]
}

/** Preserve the original model clock; subtract only recorded native quota waits,
 * provider backoffs, and the optional recon stage, which runs before discovery.
 * Parallel waits and inherited/replayed evidence count once. Pending admitted
 * work drains beyond the deadline; its completed waits are applied before the
 * scheduler considers any further admission or seals the phase boundary.
 */
export function discoveryDeadline(
  definition: ExperimentDefinition,
  state: Pick<RunState, 'modelStartedAt' | 'rootCreatedAt' | 'artifacts' | 'rejectedAttempts'> & Partial<Pick<RunState, 'stageEndReceipts'>>,
  inherited: DiscoveryWaits = [],
): number {
  const startedAt = Date.parse(state.modelStartedAt ?? state.rootCreatedAt) + reconDurationMs(definition, state)
  const intervals = [...inherited, ...discoveryWaits(definition, state)]
    .map(wait => [Math.max(startedAt, Date.parse(wait.startedAt)), Date.parse(wait.resumedAt)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0])
  let pausedMs = 0
  let end = startedAt
  for (const [start, resumedAt] of intervals) {
    pausedMs += Math.max(0, resumedAt - Math.max(start, end))
    end = Math.max(end, resumedAt)
  }
  return startedAt + definition.limits.phaseMinutes.discovery * 60_000 + pausedMs
}
