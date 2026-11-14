import type { RunState } from './contracts.js'
import { listLiveCompletions } from './dashboard-receipts.js'
import { assertCurrentExecutionFormat } from './run-state-pointer.js'

/** Show this execution's attempts; a fork's source remains with its owning app version. */
export async function dashboardHistory(state: RunState, bucket: Pick<R2Bucket, 'list'>) {
  assertCurrentExecutionFormat(state)
  const live = await listLiveCompletions(bucket, state.runId)
    .catch(() => ({ entries: [], legacyCount: 0, truncated: true }))
  return { runs: [{ state, live }], sourceReference: state.forkOrigin?.source ?? null,
    incomplete: live.truncated || state.parentRunId !== null }
}
