import type { DashboardSnapshot, DashboardThroughput, DashboardTiming } from './dashboard-types.js'

/** Reconcile observation only. Never change the stored run or infer a final seal. */
export function reconcileDashboardStatus(snapshot: DashboardSnapshot, workflow: unknown): DashboardSnapshot {
  const native = workflow && typeof workflow === 'object' && 'status' in workflow ? workflow.status : null
  const unverified = (typeof native !== 'string' || native === 'unknown')
    && ['created', 'running'].includes(snapshot.run.status)
  const status = native === 'errored' ? 'failed' : native === 'terminated' ? 'stopped'
    : native === 'complete' && snapshot.run.status !== 'completed' ? 'incomplete'
    : native === 'paused' && ['created', 'running'].includes(snapshot.run.status) ? 'paused'
    : unverified ? 'unknown' : snapshot.run.status
  snapshot.executionStatus = status
  if (!['failed', 'stopped', 'completed', 'incomplete'].includes(status)) return snapshot

  // Native status has no termination timestamp. A live span computed from stale
  // saved state is not a measured duration; retain receipt-backed timings only.
  const stopClock = (item: { timing?: DashboardTiming; throughput?: DashboardThroughput | null }) => {
    if (item.timing?.live) {
      item.timing = { ...item.timing, live: false, elapsedMs: null, finishedAt: null }
      item.throughput = null
    }
  }
  stopClock(snapshot)
  const ended = status === 'failed' || status === 'stopped' ? status : 'incomplete'
  for (const stage of snapshot.stages) {
    stopClock(stage)
    if (stage.status === 'current') stage.status = ended
    else if (stage.status === 'pending') stage.status = 'not-run'
  }
  for (const wave of snapshot.waves) {
    stopClock(wave)
    if (wave.status === 'current') wave.status = ended
    else if (wave.status === 'pending') wave.status = 'not-run'
    for (const task of wave.tasks) {
      stopClock(task)
      if (task.status === 'awaiting-result') task.status = 'interrupted'
      else if (task.status === 'pending') task.status = 'not-run'
    }
  }
  if (snapshot.run.status !== status) snapshot.limitations.push(
    'Workflow execution ended before saved run status reconciled. Unfinished durations and throughput are unavailable because the termination time was not recorded. Accepted results and measured receipt times are preserved.',
  )
  return snapshot
}
