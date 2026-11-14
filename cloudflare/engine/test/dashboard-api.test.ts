import { createControlledMachine } from './support/controlled-machine.js'
import { localUsageEvidence } from '../src/usage-evidence.js'
import type { SavedWork } from '../src/saved-work.js'
import { RunMachine } from '../src/machine.js'
import type { RunState } from '../src/contracts.js'
import { appendExecutionEvent } from '../src/execution-journal.js'
import { sha256 } from '../src/canonical.js'
import { R2AgentObservationHealthStore } from '../src/agent-observation-health.js'
import { R2AgentExecutionLogStore } from '../src/agent-execution-log.js'
import { audit0Definition } from './support/audit0-config.js'
import { describe, expect, it, vi } from 'vitest'
import { monitoringRoute } from '../src/dashboard-api.js'
import { dashboardHistory } from '../src/dashboard-history.js'
import { buildDashboardSnapshot } from '../src/dashboard-projection.js'
import { readDashboardDefinition } from '../src/dashboard-release.js'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { sqliteD1 } from './support/sqlite-d1.js'

vi.mock('../src/dashboard-projection.js', () => ({ buildDashboardSnapshot: vi.fn(state => ({
  schemaVersion: 1, run: { status: state.status }, stages: [], waves: [], limitations: [],
})) }))
vi.mock('../src/dashboard-release.js', () => ({ readDashboardDefinition: vi.fn(async () => ({ stages: [] })) }))
const digest = 'a'.repeat(64)
function setup(status = 'completed') {
  const store = {
    ensureRoutingSchema: vi.fn(async () => {}),
    getStateAt: vi.fn(),
    readSavedWork: vi.fn(),
    executionSources() { return Object.assign(this.getStateAt, { readSavedWork: this.readSavedWork }) },
    getState: vi.fn().mockResolvedValue({ runId: 'run-a', rootRunId: 'run-a', releaseDigest: digest, status,
      artifacts: [{ id: 'accepted', status: 'accepted', contentDigest: digest }] }),
  }
  const bucket = { get: vi.fn(), list: vi.fn().mockResolvedValue({ objects: [], truncated: false }) }
  const packages = { get: vi.fn() }
  const all = vi.fn().mockResolvedValue({ results: [
    { run_id: 'run-b', experiment_id: 'example', status: 'running', updated_at: '2026-09-22T12:00:00Z' },
    { run_id: 'run-a', experiment_id: 'example', status: 'completed', updated_at: '2026-09-22T12:00:00Z' },
  ] })
  const first = vi.fn()
  const statement: D1PreparedStatement = { bind: vi.fn(() => statement), all,
    first, run: vi.fn(), raw: vi.fn() }
  const bind = statement.bind
  const index = { prepare: vi.fn(() => statement) }
  const reader = { read: vi.fn().mockResolvedValue({ 'report.md': '<script>untrusted document</script>' }) }
  const workflowStatus = vi.fn().mockResolvedValue({ status: 'terminated' })
  const request = (path: string, method = 'GET') => monitoringRoute(new Request(`https://monitor.invalid${path}`, { method }),
    store, bucket, index, reader, packages, workflowStatus)
  return { request, store, bucket, index, first, bind, reader, packages, workflowStatus }
}

async function commandRow(auditId: string, revision: number, id: string, action: string, status: string,
  extra: Record<string, unknown> = {}) {
  const command = { id, action, ...extra }
  const operation = { auditId, revision, version: 1, command, commandDigest: await sha256(command), status }
  return { audit_id: auditId, revision, command_id: id, version: 1,
    operation_json: JSON.stringify(operation), operation_digest: await sha256(operation) }
}

describe('authorized read-only monitoring routes', () => {
  it('shows a command after saved selection until native acknowledgement finishes', async () => {
    const test = setup('running')
    test.store.getState.mockResolvedValue({ runId: 'run-a', rootRunId: 'audit-a', releaseDigest: digest,
      status: 'running', executionAuthority: {}, controls: { revision: 2,
        lastReceipt: { commandId: 'change-reviewer', outcome: { status: 'applied' } } }, artifacts: [] })
    test.first.mockResolvedValueOnce(await commandRow('audit-a', 2, 'change-reviewer', 'amend', 'applying'))
    const response = await test.request('/v1/monitor/runs/run-a')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ commandStatus: { kind: 'recorded',
      commandId: 'change-reviewer', action: 'amend', status: 'applying', revision: 2 } })
    expect(test.bind).toHaveBeenCalledWith('audit-a')
    test.first.mockRejectedValueOnce(new Error('temporary index failure'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'unavailable' }, run: { status: 'running' },
    })
    test.first.mockResolvedValueOnce(await commandRow('audit-a', 2, 'change-reviewer', 'amend', 'failed'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'recorded', commandId: 'change-reviewer', status: 'failed' },
    })
  })

  it('shows the next queued command after the saved decision is acknowledged', async () => {
    const test = setup('running')
    test.store.getState.mockResolvedValue({ runId: 'run-a', rootRunId: 'audit-a', releaseDigest: digest,
      status: 'running', executionAuthority: {}, controls: { revision: 1,
        lastReceipt: { commandId: 'prior', outcome: { status: 'applied' } } }, artifacts: [] })
    test.first.mockResolvedValueOnce(await commandRow('audit-a', 2, 'next', 'pause', 'waiting'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'recorded', commandId: 'next', status: 'waiting', revision: 2 },
    })
    test.first.mockResolvedValueOnce(await commandRow('audit-a', 1, 'prior', 'pause', 'applied'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({ commandStatus: null })
  })

  it('labels a missing saved command row unavailable', async () => {
    const test = setup('running')
    test.store.getState.mockResolvedValue({ runId: 'run-a', rootRunId: 'audit-a', releaseDigest: digest,
      status: 'running', executionAuthority: {}, controls: { revision: 1,
        lastReceipt: { commandId: 'saved', outcome: { status: 'applied' } } }, artifacts: [] })
    test.first.mockResolvedValueOnce(null)
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'unavailable' },
    })
  })
  it('does not display stale or corrupted command rows as absent', async () => {
    const test = setup('running')
    test.store.getState.mockResolvedValue({ runId: 'run-a', rootRunId: 'audit-a', releaseDigest: digest,
      status: 'running', executionAuthority: {}, controls: { revision: 2,
        lastReceipt: { commandId: 'saved', outcome: { status: 'applied' } } }, artifacts: [] })
    test.first.mockResolvedValueOnce(await commandRow('audit-a', 1, 'prior', 'pause', 'applied'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'unavailable' },
    })
    const corrupted = await commandRow('audit-a', 2, 'saved', 'pause', 'applied')
    corrupted.operation_digest = digest
    test.first.mockResolvedValueOnce(corrupted)
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      commandStatus: { kind: 'unavailable' },
    })
  })
  it('passes immutable inherited accounting evidence to the dashboard and does not cache missing history across reads', async () => {
    const test = setup()
    const initial = (await createControlledMachine(audit0Definition, digest, 'source-a')).snapshot()
    const source = await appendExecutionEvent(initial, 'run.cancelled', { proofDigest: digest }, initial.updatedAt)
    const ref = { runId: source.runId, state: { generation: source.stateGeneration, digest: await sha256(source) } }
    const exported = { sourceReference: ref, accounting: localUsageEvidence(source) } as SavedWork
    const forkOrigin = { savedWorkDigest: await sha256(exported), source: ref, stageId: 'negative-review' }
    const root = (await createControlledMachine(audit0Definition, digest, 'run-a')).snapshot()
    const child = await appendExecutionEvent({ ...root, journal: [], stateGeneration: 0, forkOrigin }, 'run.created', {
      ...(root.journal[0]!.payload as object), forkOrigin,
    }, root.updatedAt)
    test.store.getState.mockResolvedValue(child)
    test.store.getStateAt.mockRejectedValue(new Error('historical source unavailable'))
    test.store.readSavedWork.mockResolvedValue(exported)
    expect((await test.request('/v1/monitor/runs/run-a')).status).toBe(200)
    expect(test.store.getStateAt).not.toHaveBeenCalled()
    expect(test.store.readSavedWork).toHaveBeenCalledExactlyOnceWith(forkOrigin.savedWorkDigest)
    expect(buildDashboardSnapshot).toHaveBeenLastCalledWith(child, expect.anything(), expect.anything(), undefined, [],
      { costAccountingComplete: true, cacheAccountingComplete: true, historyComplete: true, interruptions: [digest] })
    test.store.readSavedWork.mockRejectedValue(new Error('export unavailable'))
    expect((await test.request('/v1/monitor/runs/run-a')).status).toBe(200)
    expect(buildDashboardSnapshot).toHaveBeenLastCalledWith(child, expect.anything(), expect.anything(), undefined, [],
      { costAccountingComplete: true, cacheAccountingComplete: true, historyComplete: false, interruptions: [] })
  })

  it('does not parse a historical fork source in the current dashboard', async () => {
    const test = setup()
    const source = (await createControlledMachine(audit0Definition, digest, 'source-a')).snapshot()
    const ref = { runId: source.runId, state: { generation: source.stateGeneration, digest: await sha256(source) } }
    const root = (await createControlledMachine(audit0Definition, digest, 'new-audit')).snapshot()
    const fork = { ...root, forkOrigin: { source: ref } } as RunState
    test.store.getStateAt.mockResolvedValue(source)
    vi.mocked(readDashboardDefinition).mockClear()
    const history = await dashboardHistory(fork, test.bucket)
    expect(history.incomplete).toBe(false)
    expect(history.runs.map(item => item.state.runId)).toEqual(['new-audit'])
    expect(history.sourceReference).toEqual(ref)
    expect(test.store.getStateAt).not.toHaveBeenCalled()
    expect(readDashboardDefinition).not.toHaveBeenCalled()
  })
  it('serves handovers without log, model or Workflow reads and rejects writes', async () => {
    const test = setup()
    test.store.getState.mockResolvedValue({ runId: 'run-a', stateGeneration: 4, artifacts: [] })
    const response = await test.request('/v1/monitor/runs/run-a/handovers')
    expect(await response.json()).toMatchObject({ runId: 'run-a', generation: 4, rows: [], packet: null })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(test.workflowStatus).not.toHaveBeenCalled()
    expect(test.bucket.get).not.toHaveBeenCalled()
    expect(test.reader.read).not.toHaveBeenCalled()
    expect((await test.request('/v1/monitor/runs/run-a/handovers', 'POST')).status).toBe(405)
  })

  it('returns saved progress when native status hangs and observes recovery on the next refresh', async () => {
    vi.useFakeTimers()
    try {
      const test = setup('running')
      let rejectStatus!: (error: Error) => void
      test.workflowStatus.mockImplementationOnce(() => new Promise((_, reject) => { rejectStatus = reject }))
      let returned = false
      const pending = test.request('/v1/monitor/runs/run-a').then(response => { returned = true; return response })
      await vi.advanceTimersByTimeAsync(1_999)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toMatchObject({
        executionStatus: 'unknown', run: { status: 'running' }, workflow: null,
      })
      expect(test.store.getState).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
      rejectStatus(new Error('late native status failure'))
      await vi.advanceTimersByTimeAsync(0)
      test.workflowStatus.mockResolvedValue({ status: 'running' })
      expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
        executionStatus: 'running', run: { status: 'running' }, workflow: { status: 'running' },
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('does not present a missing runtime or failed Workflow read as confirmed running', async () => {
    const test = setup('running')
    test.workflowStatus.mockRejectedValue(new Error('runtime-release unavailable'))
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      executionStatus: 'unknown', run: { status: 'running' }, workflow: null,
    })
    expect(test.store.getState).toHaveBeenCalledTimes(1)
    test.workflowStatus.mockResolvedValue({ status: 'running' })
    expect(await (await test.request('/v1/monitor/runs/run-a')).json()).toMatchObject({
      executionStatus: 'running', run: { status: 'running' }, workflow: { status: 'running' },
    })
  })

  it('re-reads a final seal written between the state and terminal Workflow observations', async () => {
    const test = setup('running')
    test.workflowStatus.mockResolvedValue({ status: 'complete' })
    test.store.getState.mockResolvedValueOnce({ runId: 'run-a', status: 'running', stateGeneration: 1, artifacts: [] })
      .mockResolvedValueOnce({ runId: 'run-a', status: 'completed', stateGeneration: 2, artifacts: [] })
    const response = await test.request('/v1/monitor/runs/run-a')
    expect(await response.json()).toMatchObject({ executionStatus: 'completed', run: { status: 'completed' } })
    expect(test.store.getState).toHaveBeenCalledTimes(2)
    expect(buildDashboardSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ stateGeneration: 2 }),
      expect.anything(), expect.anything(), undefined, [], { costAccountingComplete: false, cacheAccountingComplete: false, historyComplete: false, interruptions: [] })
  })

  it('rejects unknown agent scope and malformed log cursors without touching log objects', async () => {
    const test = setup()
    expect((await test.request('/v1/monitor/runs/run-a/agents/task?stage=other&wave=wave-0')).status).toBe(404)
    expect((await test.request('/v1/monitor/runs/run-a/agents/task?offset=-1')).status).toBe(400)
    expect((await test.request('/v1/monitor/runs/run-a/agents/task?offset=2049')).status).toBe(400)
    expect((await test.request('/v1/monitor/runs/run-a/agents/task', 'POST')).status).toBe(405)
    expect(test.bucket.list).not.toHaveBeenCalled()
    expect(test.bucket.get).not.toHaveBeenCalled()
  })

  it('validates performance scope before reading receipts and keeps missing timing unknown', async () => {
    const test = setup()
    expect((await test.request('/v1/monitor/runs/run-a/performance?stage=other&wave=wave-0')).status).toBe(404)
    expect(test.bucket.get).not.toHaveBeenCalled()
    expect(test.bucket.list).not.toHaveBeenCalled()
    test.store.getState.mockResolvedValueOnce({ runId: 'run-a', parentRunId: null, rootRunId: 'run-a' })
    vi.mocked(readDashboardDefinition).mockResolvedValueOnce({ stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
      { id: 'task', model: 'gpt-codex-a', providerClass: 'core', backend: 'codex-subscription' },
    ] }] }] } as unknown as Awaited<ReturnType<typeof readDashboardDefinition>>)
    const response = await test.request('/v1/monitor/runs/run-a/performance?stage=discovery&wave=wave-0&task=task')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ groups: [], inspectedReceipts: 0, inFlightKnown: false })
    expect(test.bucket.get).not.toHaveBeenCalled()
    expect((await test.request('/v1/monitor/runs/run-a/performance', 'POST')).status).toBe(405)
  })
  it('rejects a pool outside the configured wave before reading any telemetry', async () => {
    const test = setup()
    vi.mocked(readDashboardDefinition).mockResolvedValueOnce({ stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
      { id: 'task-a', modelPool: 'endpoint-a' }, { id: 'task-b', modelPool: 'endpoint-b' },
    ] }] }] } as unknown as Awaited<ReturnType<typeof readDashboardDefinition>>)
    expect((await test.request('/v1/monitor/runs/run-a/performance?stage=discovery&wave=wave-0&pool=missing')).status).toBe(404)
    expect(test.bucket.get).not.toHaveBeenCalled()
    expect(test.bucket.list).not.toHaveBeenCalled()
  })

  it('shows a live quota wait from the attempt log index and treats an unreadable index as none', async () => {
    const test = setup('running')
    const objects = new Map<string, { content: string, options: R2PutOptions, etag: string }>()
    let revision = 0
    const bucket = {
      async put(key: string, content: string, options: R2PutOptions) {
        const existing = objects.get(key), condition = options.onlyIf as R2Conditional | undefined
        if (condition?.etagMatches !== undefined && existing?.etag !== condition.etagMatches
          || condition?.etagDoesNotMatch === '*' && existing !== undefined) return null
        const etag = String(++revision)
        objects.set(key, { content, options, etag })
        return { etag }
      },
      async get(key: string) {
        const object = objects.get(key)
        return object === undefined ? null : { text: async () => object.content, etag: object.etag,
          size: object.content.length, customMetadata: object.options.customMetadata,
          checksums: { toJSON: () => ({ sha256: object.options.sha256 }) } }
      },
      async head(key: string) { return objects.has(key) ? {} : null },
      async list() { return { objects: [], delimitedPrefixes: [], truncated: false } },
    } as unknown as R2Bucket
    // The runtime's identity includes the task execution; the in-flight attempt carries it in execution.
    const identity = { runId: 'run-a', stageId: 'discovery', waveId: 'wave-0', taskExecutionId: 'task-exec-1',
      taskId: 'research-1', attempt: 1, promptDigest: digest }
    const requestDigest = 'b'.repeat(64)
    test.store.getState.mockResolvedValue({ runId: 'run-a', rootRunId: 'run-a', releaseDigest: digest,
      status: 'running', artifacts: [], inFlightAgentAttempts: [{ stageId: 'discovery', waveId: 'wave-0',
        taskId: 'research-1', attempt: 1, promptDigest: digest, execution: { taskExecutionId: 'task-exec-1' } }] })
    await new R2AgentObservationHealthStore(bucket).recordProcessSuccess(identity, requestDigest,
      new Date('2026-11-06T09:02:00.000Z'))
    await new R2AgentExecutionLogStore(bucket).sync({ runId: 'run-a', taskId: 'research-1', requestDigest,
      sourceOffset: 0, complete: false, source: `${JSON.stringify({ schemaVersion: 1, kind: 'subscription-wait',
        at: '2026-11-06T09:01:00.000Z', provider: 'claude', resetsAt: '2026-11-10T08:00:00.000Z' })}\n` })
    const read = async () => {
      const response = await monitoringRoute(new Request('https://monitor.invalid/v1/monitor/runs/run-a'),
        test.store, bucket, test.index, test.reader, test.packages, test.workflowStatus)
      expect(response.status).toBe(200)
      return (await response.json() as { observationHealth: Record<string, unknown>[] }).observationHealth
    }
    expect(await read()).toEqual([expect.objectContaining({ taskId: 'research-1', status: 'observing',
      subscriptionWait: { provider: 'claude', since: '2026-11-06T09:01:00.000Z', resetsAt: '2026-11-10T08:00:00.000Z' } })])
    objects.get(`monitor/agent-executions/run-a/research-1/${requestDigest}/index.json`)!.content += ' '
    expect(await read()).toEqual([expect.objectContaining({ status: 'observing', subscriptionWait: null })])
  })

  it('pages equal timestamps deterministically using bound parameters and no-store responses', async () => {
    const test = setup()
    const response = await test.request('/v1/monitor/runs?limit=1')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ runs: [{ id: 'run-b', experimentId: 'example', status: 'running',
      updatedAt: '2026-09-22T12:00:00Z' }], nextCursor: '2026-09-22T12:00:00Z|run-b' })
    expect(test.bind).toHaveBeenCalledWith('9999-12-31T23:59:59.999Z', '~', 2)
    await test.request('/v1/monitor/runs?limit=1&before=2026-09-22T12%3A00%3A00Z%7Crun-b')
    expect(test.bind).toHaveBeenLastCalledWith('2026-09-22T12:00:00Z', 'run-b', 2)
    expect(test.store.getState).not.toHaveBeenCalled()
    expect(test.bucket.list).not.toHaveBeenCalled()
  })

  it('lists only owned executions, creating the ownership table on an upgraded index', async () => {
    const { sqlite, d1 } = sqliteD1()
    // An index written before execution ownership has runs but no ownership table.
    sqlite.exec(ROUTING_SCHEMA_SQL[0]!)
    const run = (id: string, at: string) => sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, 'example', 'completed', ?, 1, ?)`).run(id, `state/${id}`, at)
    run('run-old', '2026-11-01T00:00:00Z')
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
    const list = async () => {
      const response = await monitoringRoute(new Request('https://monitor.invalid/v1/monitor/runs'),
        store, {} as R2Bucket, d1, { read: vi.fn() }, {} as R2Bucket)
      return (await response.json() as { runs: { id: string }[] }).runs.map(item => item.id)
    }
    expect(await list()).toEqual([])
    const owner = sqlite.prepare(`INSERT INTO audit_execution_authority
      (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at)
      VALUES ('audit-new', ?, ?, ?, ?, 'retired', '2026-11-05T00:00:00Z')`)
    owner.run(0, 'audit-new', '{"epoch":0}', digest)
    run('audit-new', '2026-11-05T00:00:00Z')
    owner.run(1, 'fork-new', '{"epoch":1}', digest)
    run('fork-new', '2026-11-06T00:00:00Z')
    expect(await list()).toEqual(['fork-new', 'audit-new'])
  })

  it('rejects writes, malformed cursors and unbounded limits before touching storage', async () => {
    const test = setup()
    expect((await test.request('/v1/monitor/runs/run-a', 'POST')).status).toBe(405)
    for (const query of ['limit=0', 'limit=51', 'limit=-1', 'before=garbage', 'before=2026-09-22%7Cbad%2Fid']) {
      expect((await test.request(`/v1/monitor/runs?${query}`)).status).toBe(400)
    }
    expect((await test.request('/v1/monitor/runs/run-a/stop')).status).toBe(404)
    expect(test.index.prepare).not.toHaveBeenCalled()
    expect(test.store.getState).not.toHaveBeenCalled()
    expect(test.bucket.list).not.toHaveBeenCalled()
  })

  it('only serves digest-bound accepted artifacts belonging to the requested run as JSON', async () => {
    const test = setup()
    expect((await test.request(`/v1/monitor/runs/run-a/artifacts/${'b'.repeat(64)}`)).status).toBe(404)
    expect(test.reader.read).not.toHaveBeenCalled()
    const response = await test.request(`/v1/monitor/runs/run-a/artifacts/${digest}`)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await response.json()).toEqual({ files: { 'report.md': '<script>untrusted document</script>' } })
    expect(test.reader.read).toHaveBeenCalledWith({ id: 'accepted', status: 'accepted', contentDigest: digest })
    test.store.getState.mockResolvedValueOnce({ runId: 'run-a', releaseDigest: digest, status: 'completed',
      artifacts: [{ id: 'rejected', status: 'rejected', contentDigest: digest }] })
    expect((await test.request(`/v1/monitor/runs/run-a/artifacts/${digest}`)).status).toBe(404)
    expect(test.reader.read).toHaveBeenCalledTimes(1)
  })

  it('loads completion metadata for finished-run timing; failed reads remain an explicit data gap', async () => {
    const completed = setup()
    const completedResponse = await completed.request('/v1/monitor/runs/run-a')
    expect(completedResponse.status).toBe(200)
    expect(await completedResponse.json()).toMatchObject({ schemaVersion: 1, executionStatus: 'stopped',
      run: { status: 'completed' }, workflow: { status: 'terminated' } })
    expect(completed.workflowStatus).toHaveBeenCalledWith('run-a', expect.objectContaining({ runId: 'run-a' }))
    expect(completed.bucket.list).toHaveBeenCalledWith(expect.objectContaining({
      prefix: 'quarantine/execution-receipts/run-a/', include: ['customMetadata'],
    }))
    expect(readDashboardDefinition).toHaveBeenLastCalledWith(completed.packages,
      expect.objectContaining({ runId: 'run-a', releaseDigest: digest }))
    const running = setup('running')
    running.bucket.list.mockRejectedValueOnce(new Error('fixture read failure'))
    expect((await running.request('/v1/monitor/runs/run-a')).status).toBe(200)
    expect(buildDashboardSnapshot).toHaveBeenLastCalledWith(expect.anything(), { stages: [] },
      { entries: [], legacyCount: 0, truncated: true }, undefined, [], { costAccountingComplete: false, cacheAccountingComplete: false, historyComplete: false, interruptions: [] })
  })

  it('formats Markdown only after accepted artifact ownership is checked and preserves source text', async () => {
    const test = setup()
    expect((await test.request(`/v1/monitor/runs/run-a/artifacts/${'b'.repeat(64)}?render=markdown`)).status).toBe(404)
    expect(test.reader.read).not.toHaveBeenCalled()
    const response = await test.request(`/v1/monitor/runs/run-a/artifacts/${digest}?render=markdown`)
    const body = await response.json() as { files: Record<string, string>; renderedFiles: Record<string, string> }
    expect(body.files['report.md']).toBe('<script>untrusted document</script>')
    expect(body.renderedFiles['report.md']).toContain('&lt;script&gt;')
    expect(body.renderedFiles['report.md']).not.toContain('<script>')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
})
