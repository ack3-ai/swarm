import { dashboardHandovers } from './dashboard-handovers.js'
import { dashboardTaskBoundary } from './dashboard-waves.js'
import type { ArtifactRecord, RunState } from './contracts.js'
import { buildDashboardSnapshot } from './dashboard-projection.js'
import { dashboardHistory } from './dashboard-history.js'
import { readDashboardDefinition } from './dashboard-release.js'
import { renderDashboardMarkdown } from './dashboard-markdown.js'
import { readDashboardAgent } from './dashboard-agent.js'
import { readDashboardPerformance } from './dashboard-performance.js'
import { reconcileDashboardStatus } from './dashboard-status.js'
import { readAgentObservationHealth, type AgentObservationIdentity } from './agent-observation-health.js'

interface MonitorStore {
  getState(runId: string): Promise<RunState>
}
interface ArtifactReader { read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>> }
interface IndexRow { run_id: string; experiment_id: string; status: string; updated_at: string }
type WorkflowStatusReader = (runId: string, state: RunState) => Promise<unknown>

async function observeWorkflowStatus(reader: WorkflowStatusReader | undefined, state: RunState): Promise<unknown> {
  if (reader === undefined) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // A slow native status read must not hide the independently saved audit data.
    return await Promise.race([
      reader(state.runId, state),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000) }),
    ])
  } catch { return null }
  finally { if (timer !== undefined) clearTimeout(timer) }
}

const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
})

/** Called only after the existing operator authorization boundary. No control calls or writes. */
export async function monitoringRoute(
  request: Request,
  store: MonitorStore,
  bucket: Pick<R2Bucket, 'list' | 'get'>,
  index: Pick<D1Database, 'prepare'>,
  artifactReader: ArtifactReader,
  packages: Pick<R2Bucket, 'get'>,
  workflowStatus?: WorkflowStatusReader,
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'monitoring is read-only' }, 405)
  const url = new URL(request.url)
  if (url.pathname === '/v1/monitor/runs') {
    const rawLimit = url.searchParams.get('limit') ?? '30'
    if (!/^\d{1,2}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
      return json({ error: 'limit must be between 1 and 50' }, 400)
    }
    const limit = Number(rawLimit)
    const cursor = url.searchParams.get('before')
    let at = '9999-12-31T23:59:59.999Z'
    let id = '~'
    if (cursor !== null) {
      if (cursor.length > 300) return json({ error: 'invalid cursor' }, 400)
      const split = cursor.indexOf('|')
      at = cursor.slice(0, split)
      id = cursor.slice(split + 1)
      if (split < 0 || !Number.isFinite(Date.parse(at)) || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id)) {
        return json({ error: 'invalid cursor' }, 400)
      }
    }
    const result = await index.prepare(`SELECT run_id, experiment_id, status, updated_at
      FROM experiment_runs WHERE updated_at < ?1 OR (updated_at = ?1 AND run_id < ?2)
      ORDER BY updated_at DESC, run_id DESC LIMIT ?3`).bind(at, id, limit + 1).all<IndexRow>()
    const rows = result.results.slice(0, limit)
    const last = rows.at(-1)
    return json({
      runs: rows.map(row => ({ id: row.run_id, experimentId: row.experiment_id, status: row.status, updatedAt: row.updated_at })),
      nextCursor: result.results.length > limit && last !== undefined ? `${last.updated_at}|${last.run_id}` : null,
    })
  }
  const match = url.pathname.match(/^\/v1\/monitor\/runs\/([a-z0-9][a-z0-9._-]{0,99})(?:\/artifacts\/([a-f0-9]{64})|\/(performance|handovers)|\/agents\/([a-z0-9][a-z0-9._-]{0,159}))?$/)
  if (match === null) return json({ error: 'not found' }, 404)
  let state = await store.getState(match[1]!)
  if (match[2] !== undefined) {
    const artifact = state.artifacts.find(item => item.contentDigest === match[2] && item.status === 'accepted')
    if (artifact === undefined) return json({ error: 'artifact is not accepted in this run' }, 404)
    const files = await artifactReader.read(artifact)
    return json(url.searchParams.get('render') === 'markdown'
      ? { files, renderedFiles: renderDashboardMarkdown(files) } : { files })
  }
  if (match[4] !== undefined) {
    const offset = url.searchParams.get('offset') ?? '0'
    if (!/^\d{1,4}$/.test(offset) || Number(offset) > 2048) return json({ error: 'invalid log cursor' }, 400)
    const definition = await readDashboardDefinition(packages, state, true)
    const stage = definition.stages.find(item => item.id === url.searchParams.get('stage'))
    const wave = stage?.waves.find(item => item.id === url.searchParams.get('wave'))
    const task = wave?.tasks.find(item => item.id === match[4])
    if (!stage || !wave || !task) return json({ error: 'unknown configured wave or task' }, 404)
    return json(await readDashboardAgent({ state, definition, stage, wave, task, store, bucket,
      attempt: url.searchParams.get('attempt'), offset: Number(offset) }))
  }
  if (match[3] === 'handovers') return json(await dashboardHandovers(state))
  if (match[3] === 'performance') {
    const definition = await readDashboardDefinition(packages, state)
    const stage = definition.stages.find(item => item.id === url.searchParams.get('stage'))
    const wave = stage?.waves.find(item => item.id === url.searchParams.get('wave'))
    const taskId = url.searchParams.get('task')
    const poolId = url.searchParams.get('pool')
    const tasks = wave?.tasks.filter(task => (taskId === null || task.id === taskId) && (poolId === null || task.modelPool === poolId))
    if (stage === undefined || wave === undefined || !tasks?.length) return json({ error: 'unknown configured wave or task' }, 404)
    return json(await readDashboardPerformance(state, { stageId: stage.id, waveId: wave.id, tasks }, store, bucket))
  }
  let [definition, history, workflow] = await Promise.all([
    readDashboardDefinition(packages, state),
    dashboardHistory(state, store, bucket),
    observeWorkflowStatus(workflowStatus, state),
  ])
  // Final sealing can happen between the state and Workflow reads. Re-read once
  // after observing termination so the browser does not stop on the older state.
  if (workflow && typeof workflow === 'object' && 'status' in workflow
    && ['complete', 'errored', 'terminated'].includes(String(workflow.status))
    && ['created', 'running'].includes(state.status)) {
    const latest = await store.getState(state.runId)
    if (latest.stateGeneration !== state.stateGeneration || latest.status !== state.status) {
      state = latest
      ;[definition, history] = await Promise.all([
        readDashboardDefinition(packages, state), dashboardHistory(state, store, bucket),
      ])
    }
  }
  const live = history.runs[0]?.live ?? { entries: [], legacyCount: 0, truncated: true }
  const inherited = history.runs.slice(1).flatMap(run => run.live.entries.map(entry => {
    const task = definition.stages.find(stage => stage.id === entry.stageId)?.waves.find(wave => wave.id === entry.waveId)
      ?.tasks.find(task => task.id === entry.taskId)
    const boundary = task ? dashboardTaskBoundary(run.state, entry.stageId, entry.waveId, task) : null
    return { ...entry, originTiming: { runId: run.state.runId, startedAt: boundary?.startedAt ?? null,
      endedAt: boundary?.receipt?.completedAt ?? run.state.updatedAt } }
  })).filter(entry => state.artifacts.some(artifact =>
    artifact.stageId === entry.stageId && artifact.waveId === entry.waveId && artifact.taskId === entry.taskId
    && artifact.contentDigest === entry.outputDigest && artifact.promptDigest === entry.promptDigest && artifact.actorId === entry.actorId))
  const observations: { identity: AgentObservationIdentity }[] = (state.inFlightAgentAttempts ?? []).map(attempt => ({ identity: {
    runId: state.runId, stageId: attempt.stageId, waveId: attempt.waveId,
    taskId: attempt.taskId, attempt: attempt.attempt, promptDigest: attempt.promptDigest,
  } }))
  const observationReads = await Promise.allSettled(observations.map(({ identity }) =>
    readAgentObservationHealth(bucket, identity)))
  const observationHealth = observations.map(({ identity }, index) => {
    const result = observationReads[index]
    const health = result?.status === 'fulfilled' ? result.value : null
    return { ...identity,
      status: result?.status === 'rejected' || health === null ? 'unknown'
        : health.incidentSince !== null ? 'unresolved'
          : health.consecutiveFailures > 0 ? 'watching' : 'observing',
      firstFailedAt: health?.firstFailedAt ?? null,
      lastFailedAt: health?.lastFailedAt ?? null,
      consecutiveFailures: health?.consecutiveFailures ?? null,
      lastSuccessfulProcessAt: health?.lastSuccessfulProcessAt ?? null,
      incidentSince: health?.incidentSince ?? null,
      lastFailedOperation: health?.lastFailedOperation ?? null,
      nextObservationAfter: health?.nextObservationAfter ?? null,
    }
  })
  return json({ ...reconcileDashboardStatus(buildDashboardSnapshot(state, definition,
    { ...live, truncated: live.truncated || history.incomplete }, undefined, inherited), workflow), workflow,
    observationHealth,
    configuration: { ...definition.configuration, runtime: state.runtimeRelease ?? null, releaseDigest: state.releaseDigest } })
}
