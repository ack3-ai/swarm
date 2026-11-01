import type { ExperimentDefinition, RunState } from './contracts.js'

/** Preserve the original model clock; subtract only recorded native quota waits.
 * Parallel waits and inherited/replayed evidence count once. Pending admitted
 * work drains beyond the deadline; its completed waits are applied before the
 * scheduler considers any further admission or seals the phase boundary.
 */
export function discoveryDeadline(
  definition: ExperimentDefinition,
  state: Pick<RunState, 'modelStartedAt' | 'rootCreatedAt' | 'artifacts' | 'rejectedAttempts'>,
): number {
  const startedAt = Date.parse(state.modelStartedAt ?? state.rootCreatedAt)
  const discoveryIds = new Set(definition.stages.filter(stage => stage.kind === 'discovery').map(stage => stage.id))
  const intervals = [...state.artifacts, ...state.rejectedAttempts]
    .filter(record => discoveryIds.has(record.stageId))
    .flatMap(record => record.usage.subscriptionWaits ?? [])
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
