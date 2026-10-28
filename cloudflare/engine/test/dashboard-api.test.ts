import { describe, expect, it, vi } from 'vitest'
import { monitoringRoute } from '../src/dashboard-api.js'
import { buildDashboardSnapshot } from '../src/dashboard-projection.js'
import { readDashboardDefinition } from '../src/dashboard-release.js'

vi.mock('../src/dashboard-projection.js', () => ({ buildDashboardSnapshot: vi.fn(state => ({
  schemaVersion: 1, run: { status: state.status }, stages: [], waves: [], limitations: [],
})) }))
vi.mock('../src/dashboard-release.js', () => ({ readDashboardDefinition: vi.fn(async () => ({ stages: [] })) }))
const digest = 'a'.repeat(64)
function setup(status = 'completed') {
  const store = {
    getState: vi.fn().mockResolvedValue({ runId: 'run-a', releaseDigest: digest, status,
      artifacts: [{ id: 'accepted', status: 'accepted', contentDigest: digest }] }),
  }
  const bucket = { get: vi.fn(), list: vi.fn().mockResolvedValue({ objects: [], truncated: false }) }
  const packages = { get: vi.fn() }
  const all = vi.fn().mockResolvedValue({ results: [
    { run_id: 'run-b', experiment_id: 'example', status: 'running', updated_at: '2026-09-22T12:00:00Z' },
    { run_id: 'run-a', experiment_id: 'example', status: 'completed', updated_at: '2026-09-22T12:00:00Z' },
  ] })
  const statement: D1PreparedStatement = { bind: vi.fn(() => statement), all,
    first: vi.fn(), run: vi.fn(), raw: vi.fn() }
  const bind = statement.bind
  const index = { prepare: vi.fn(() => statement) }
  const reader = { read: vi.fn().mockResolvedValue({ 'report.md': '<script>untrusted document</script>' }) }
  const workflowStatus = vi.fn().mockResolvedValue({ status: 'terminated' })
  const request = (path: string, method = 'GET') => monitoringRoute(new Request(`https://monitor.invalid${path}`, { method }),
    store, bucket, index, reader, packages, workflowStatus)
  return { request, store, bucket, index, bind, reader, packages, workflowStatus }
}

describe('authorized read-only monitoring routes', () => {
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
      expect.anything(), expect.anything(), undefined, [])
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
      { entries: [], legacyCount: 0, truncated: true }, undefined, [])
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
