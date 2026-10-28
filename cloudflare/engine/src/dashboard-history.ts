import type { RunState } from './contracts.js'
import { listLiveCompletions } from './dashboard-receipts.js'

/** Follow only real recovery ancestry. No caller-selected ancestor or Sandbox reads. */
export async function dashboardHistory(
  state: RunState,
  store: { getState(runId: string): Promise<RunState> },
  bucket: Pick<R2Bucket, 'list'>,
) {
  const runs: { state: RunState; live: Awaited<ReturnType<typeof listLiveCompletions>> }[] = []
  const seen = new Set<string>()
  let current: RunState | null = state
  let incomplete = false
  while (current !== null && seen.size < 8) {
    if (seen.has(current.runId)) { incomplete = true; break }
    seen.add(current.runId)
    const live = await listLiveCompletions(bucket, current.runId)
      .catch(() => ({ entries: [], legacyCount: 0, truncated: true }))
    incomplete ||= live.truncated
    runs.push({ state: current, live })
    if (!current.parentRunId) { current = null; break }
    try {
      const parent: RunState = await store.getState(current.parentRunId)
      if (parent.runId !== current.parentRunId || parent.rootRunId !== state.rootRunId
        || parent.experimentId !== state.experimentId || parent.definitionDigest !== state.definitionDigest) {
        incomplete = true; break
      }
      current = parent
    } catch { incomplete = true; break }
  }
  return { runs, incomplete: incomplete || current !== null }
}
