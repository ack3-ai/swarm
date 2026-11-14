import type { ExecutionSourceLoader } from './execution-lineage.js'
import { resolveUsageEvidence } from './usage-evidence.js'
import type { RunStatePointer } from './run-state-pointer.js'
import { dashboardHandovers } from './dashboard-handovers.js'
import type { ArtifactRecord, RunState } from './contracts.js'
import { buildDashboardSnapshot } from './dashboard-projection.js'
import { dashboardHistory } from './dashboard-history.js'
import { readDashboardDefinition } from './dashboard-release.js'
import { renderDashboardMarkdown } from './dashboard-markdown.js'
import { readDashboardAgent } from './dashboard-agent.js'
import { readDashboardPerformance } from './dashboard-performance.js'
import { reconcileDashboardStatus } from './dashboard-status.js'
import { readAgentObservationHealth, type AgentObservationIdentity } from './agent-observation-health.js'
import { readAgentLogIndex } from './agent-execution-log.js'
import { sha256 } from './canonical.js'
import type { DashboardSnapshot } from './dashboard-types.js'

interface MonitorStore {
  ensureRoutingSchema(): Promise<void>
  executionSources?(): ExecutionSourceLoader
  getState(runId: string): Promise<RunState>
  getStateAt?(runId: string, pointer: RunStatePointer): Promise<RunState>
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

/** Read the latest command for this audit. Native acknowledgement can remain
 * pending after the logical receipt is saved, and a completed source can admit
 * later fork commands without changing its immutable state. */
async function observeCommandStatus(state: RunState, index: Pick<D1Database, 'prepare'>): Promise<DashboardSnapshot['commandStatus']> {
  try {
    const auditId = state.rootRunId
    const savedRevision = state.controls?.revision ?? 0
    const row = await index.prepare(`SELECT audit_id, revision, command_id, version, operation_json, operation_digest
      FROM audit_run_commands WHERE audit_id = ?1 ORDER BY revision DESC, version DESC LIMIT 1`)
      .bind(auditId).first<{ audit_id: string; revision: number; command_id: string; version: number;
        operation_json: string; operation_digest: string }>()
    if (row === null) return savedRevision === 0 ? null : { kind: 'unavailable' }
    const operation: unknown = JSON.parse(row.operation_json)
    if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) return { kind: 'unavailable' }
    const record = operation as Record<string, unknown>
    const command = record.command
    if (command === null || typeof command !== 'object' || Array.isArray(command)) return { kind: 'unavailable' }
    const fields = command as Record<string, unknown>
    if (row.audit_id !== auditId || record.auditId !== auditId || record.revision !== row.revision
      || record.version !== row.version || fields.id !== row.command_id
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || row.revision < savedRevision
      || !Number.isSafeInteger(row.version) || row.version < 1
      || typeof fields.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(fields.id)
      || typeof fields.action !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(fields.action)
      || typeof record.status !== 'string' || !['accepted', 'waiting', 'applying', 'applied', 'rejected', 'failed', 'superseded'].includes(record.status)
      || typeof record.commandDigest !== 'string' || record.commandDigest !== await sha256(command)
      || typeof row.operation_digest !== 'string' || row.operation_digest !== await sha256(operation)) {
      return { kind: 'unavailable' }
    }
    const status = record.status as Extract<DashboardSnapshot['commandStatus'], { kind: 'recorded' }>['status']
    const reflected = row.revision === savedRevision && fields.id === state.controls?.lastReceipt.commandId
      && status === state.controls.lastReceipt.outcome.status
    return reflected ? null : { kind: 'recorded', commandId: fields.id, action: fields.action,
      status, revision: row.revision }
  } catch { return { kind: 'unavailable' } }
}

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
  const sourceReads = new Map<string, Promise<RunState>>()
  const readAt: ExecutionSourceLoader | undefined = store.getStateAt === undefined ? undefined : (runId: string, pointer: RunStatePointer) => {
    const key = `${runId}/${pointer.generation}/${pointer.digest}`
    let pending = sourceReads.get(key)
    if (pending === undefined) {
      pending = store.getStateAt!(runId, pointer)
      sourceReads.set(key, pending)
    }
    return pending
  }
  const readExport = store.executionSources?.().readSavedWork
  if (readAt !== undefined && readExport !== undefined) readAt.readSavedWork = readExport
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
    // Runs recorded before execution ownership cannot be opened by this version.
    // Their saved state stays in storage; the list starts with owned executions.
    // An upgraded index may not have the ownership table until the store creates it.
    await store.ensureRoutingSchema()
    const result = await index.prepare(`SELECT run_id, experiment_id, status, updated_at
      FROM experiment_runs WHERE (updated_at < ?1 OR (updated_at = ?1 AND run_id < ?2))
        AND EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = experiment_runs.run_id)
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
    const stageId = url.searchParams.get('stage'), waveId = url.searchParams.get('wave'), taskId = match[4]
    let stage = definition.stages.find(item => item.id === stageId)
    let wave = stage?.waves.find(item => item.id === waveId)
    let task = wave?.tasks.find(item => item.id === taskId)
    if (!task && !state.forkOrigin) {
      return json({ error: 'unknown configured wave or task' }, 404)
    }
    const history = await dashboardHistory(state, bucket)
    if (!task) {
      for (const run of history.runs) {
        const recorded = [...(run.state.artifacts ?? []), ...(run.state.rejectedAttempts ?? []),
          ...(run.state.inFlightAgentAttempts ?? [])].some(item => item.stageId === stageId
            && item.waveId === waveId && item.taskId === taskId)
          || run.live.entries.some(item => item.stageId === stageId && item.waveId === waveId && item.taskId === taskId)
        if (!recorded) continue
        const original = await readDashboardDefinition(packages, run.state, true)
        for (const release of original.releases?.values() ?? [original]) {
          stage = release.stages.find(item => item.id === stageId)
          wave = stage?.waves.find(item => item.id === waveId)
          task = wave?.tasks.find(item => item.id === taskId)
          if (task) break
        }
        if (task) break
      }
    }
    if (!stage || !wave || !task) return json({ error: 'unknown configured wave or task' }, 404)
    return json(await readDashboardAgent({ state, definition, stage, wave, task, bucket,
      packages, history, attempt: url.searchParams.get('attempt'), offset: Number(offset) }))
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
    return json(await readDashboardPerformance(state, { stageId: stage.id, waveId: wave.id, tasks }, bucket))
  }
  let [definition, history, workflow] = await Promise.all([
    readDashboardDefinition(packages, state),
    dashboardHistory(state, bucket),
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
        readDashboardDefinition(packages, state), dashboardHistory(state, bucket),
      ])
    }
  }
  const usageEvidence = await resolveUsageEvidence(state, readAt)
  const live = history.runs[0]?.live ?? { entries: [], legacyCount: 0, truncated: true }
  const observations: { identity: AgentObservationIdentity }[] = (state.inFlightAgentAttempts ?? []).map(attempt => ({ identity: {
    runId: state.runId, stageId: attempt.stageId, waveId: attempt.waveId,
    // The runtime keys observation health by the exact task execution when the request has one.
    ...(attempt.execution?.taskExecutionId === undefined ? {} : { taskExecutionId: attempt.execution.taskExecutionId }),
    taskId: attempt.taskId, attempt: attempt.attempt, promptDigest: attempt.promptDigest,
  } }))
  const observationReads = await Promise.allSettled(observations.map(({ identity }) =>
    readAgentObservationHealth(bucket, identity)))
  // A live quota wait is recorded in the attempt's log index; an unreadable index shows none.
  const waitReads = await Promise.allSettled(observations.map(({ identity }, index) => {
    const result = observationReads[index]
    return result?.status === 'fulfilled' && result.value !== null
      ? readAgentLogIndex(bucket, { runId: identity.runId, taskId: identity.taskId, requestDigest: result.value.requestDigest })
      : Promise.resolve(null)
  }))
  const observationHealth = observations.map(({ identity }, index) => {
    const result = observationReads[index]
    const health = result?.status === 'fulfilled' ? result.value : null
    const wait = waitReads[index]
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
      subscriptionWait: wait?.status === 'fulfilled' ? wait.value?.subscriptionWait ?? null : null,
    }
  })
  return json({ ...reconcileDashboardStatus(buildDashboardSnapshot(state, definition,
    { ...live, truncated: live.truncated || history.incomplete }, undefined, [], usageEvidence), workflow), workflow,
    commandStatus: await observeCommandStatus(state, index),
    observationHealth,
    configuration: { ...definition.configuration, runtime: state.runtimeRelease ?? null, releaseDigest: state.releaseDigest } })
}
