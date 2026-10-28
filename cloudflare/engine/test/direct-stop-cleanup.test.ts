import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'

function directStopHarness(deferred: string[] = []) {
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function stopAuditRunNow('),
    source.indexOf('\nasync function laneResult(')))
  const state: any = { runId: 'owned-run', status: 'running', stateGeneration: 7,
    releaseDigest: 'a'.repeat(64), artifacts: [{ id: 'saved', status: 'accepted' }],
    inFlightAgentAttempts: [{ taskId: 'active' }] }
  let workflowStatus = 'running'
  let delayedTerminalReads = 0
  const terminate = vi.fn(async () => { workflowStatus = 'terminated' })
  const cleanup = vi.fn(async () => ({ mode: 'provider-attempted', workspaceKeys: ['active-lane'],
    activeWorkspaceKeys: ['active-lane'], retainedWorkspaceKeys: [], deferred }))
  const store = { requestStop: vi.fn(async () => {}), getState: vi.fn(async () => structuredClone(state)),
    getRelease: vi.fn(async () => ({ body: { definition: { stages: [] } } })),
    retainedNativeWorkspaceClaim: vi.fn(async () => null),
    putState: vi.fn(async (next: any) => Object.assign(state, next)) }
  const workflow = { status: vi.fn(async () => {
    if (workflowStatus === 'terminated' && delayedTerminalReads-- > 0) return { status: 'running' }
    return { status: workflowStatus }
  }), terminate }
  const stop = new Function('assertStoredRunOwner', 'CloudflareRunStore', 'RunMachine',
    'SandboxAgentProvider', 'disposeTerminalWorkspaces', 'response',
    `${code}\nreturn stopAuditRunNow;`)(
      async () => {}, function Store() { return store },
      { fromState: async () => ({ stop: async () => {}, snapshot: () =>
        ({ ...state, status: 'stopped', stateGeneration: state.stateGeneration + 1,
          terminalReason: 'operator-requested-immediate-stop' }) }) },
      class {}, cleanup, (_env: unknown, body: unknown, status = 200) => Response.json(body, { status }),
    ) as (runId: string, env: unknown) => Promise<Response>
  return { stop, store, workflow, terminate, cleanup, state,
    setWorkflowStatus: (value: string) => { workflowStatus = value },
    delayTerminalReads: (count: number) => { delayedTerminalReads = count },
    env: { AUDIT_WORKFLOW: { get: async () => workflow } } }
}

it('terminates exact Workflow before fencing state and attempts owned in-flight disposal', async () => {
  const fixture = directStopHarness()
  const response = await fixture.stop('owned-run', fixture.env)
  expect(response.status).toBe(200)
  const body = await response.json() as any
  expect(body.stop).toBe('stopped')
  expect(body.physicalZeroVerified).toBe(false)
  expect(fixture.terminate).toHaveBeenCalledOnce()
  expect(fixture.store.putState).toHaveBeenCalledOnce()
  expect(fixture.cleanup).toHaveBeenCalledWith(expect.anything(), expect.anything(),
    expect.objectContaining({ status: 'stopped', artifacts: [{ id: 'saved', status: 'accepted' }] }),
    expect.objectContaining({ forceOwnedWorkspaces: true, workspaceAllocationForOwner: expect.any(Function) }))
  const again = await fixture.stop('owned-run', fixture.env)
  expect(again.status).toBe(200)
  expect(fixture.terminate).toHaveBeenCalledOnce()
  expect(fixture.cleanup).toHaveBeenCalledTimes(2)
})

it('reports deferred native teardown as failure without claiming physical zero', async () => {
  const fixture = directStopHarness(['active-lane'])
  const response = await fixture.stop('owned-run', fixture.env)
  expect(response.status).toBe(503)
  const body = await response.json() as any
  expect(body.cleanup.deferred).toEqual(['active-lane'])
  expect(body.physicalZeroVerified).toBe(false)
  expect(fixture.state.status).toBe('stopped')
  fixture.cleanup.mockResolvedValueOnce({ mode: 'provider-attempted', workspaceKeys: ['active-lane'],
    activeWorkspaceKeys: ['active-lane'], retainedWorkspaceKeys: [], deferred: [] })
  const retried = await fixture.stop('owned-run', fixture.env)
  expect(retried.status).toBe(200)
  expect(fixture.terminate).toHaveBeenCalledOnce()
  expect(fixture.store.putState).toHaveBeenCalledOnce()
})

it('reports a five-second miss as a failed control response', async () => {
  const fixture = directStopHarness()
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6_000)
  try {
    const response = await fixture.stop('owned-run', fixture.env)
    expect(response.status).toBe(503)
    const body = await response.json() as any
    expect(body.deadlineMet).toBe(false)
    expect(body.elapsedMs).toBe(6_000)
    expect(body.physicalZeroVerified).toBe(false)
  } finally {
    clock.mockRestore()
  }
})

it('re-reads a winning admitted result after a generation race before cleanup', async () => {
  const fixture = directStopHarness()
  fixture.store.putState.mockImplementationOnce(async () => {
    fixture.state.stateGeneration += 1
    fixture.state.artifacts.push({ id: 'late-accepted', status: 'accepted' })
    throw new Error('stale run-state generation rejected')
  })
  const response = await fixture.stop('owned-run', fixture.env)
  expect(response.status).toBe(200)
  expect(fixture.store.putState).toHaveBeenCalledTimes(2)
  expect(fixture.cleanup).toHaveBeenCalledWith(expect.anything(), expect.anything(),
    expect.objectContaining({ artifacts: [
      { id: 'saved', status: 'accepted' }, { id: 'late-accepted', status: 'accepted' },
    ] }), expect.anything())
})

it('keeps a completed result and retries only its cleanup', async () => {
  const fixture = directStopHarness()
  fixture.state.status = 'completed'
  fixture.setWorkflowStatus('complete')
  const response = await fixture.stop('owned-run', fixture.env)
  expect(response.status).toBe(200)
  expect(fixture.terminate).not.toHaveBeenCalled()
  expect(fixture.store.putState).not.toHaveBeenCalled()
  expect(fixture.cleanup).toHaveBeenCalledOnce()
  expect((await response.json() as any).stop).toBe('completed')
})

it('continues the same stop operation until the native termination fence settles', async () => {
  const fixture = directStopHarness()
  fixture.delayTerminalReads(1)
  const response = await fixture.stop('owned-run', fixture.env)
  expect(response.status).toBe(200)
  expect(fixture.workflow.status).toHaveBeenCalledTimes(3)
  expect(fixture.store.putState).toHaveBeenCalledOnce()
  expect(fixture.cleanup).toHaveBeenCalledOnce()
})

it('bounds the HTTP stop request while retaining its cleanup operation', async () => {
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function boundedImmediateStop('),
    source.indexOf('\nasync function laneResult(')))
  let finish!: (value: Response) => void
  const operation = new Promise<Response>(resolve => { finish = resolve })
  const stop = new Function('stopAuditRunNow', 'response', 'canonicalJson',
    `${code}\nreturn boundedImmediateStop;`)(
      async () => operation,
      (_env: unknown, body: unknown, status = 200) => Response.json(body, { status }),
      JSON.stringify,
    ) as (runId: string, env: unknown, ctx: unknown) => Promise<Response>
  const pending: Promise<unknown>[] = []
  vi.useFakeTimers()
  try {
    const request = stop('owned-run', {}, { waitUntil: (value: Promise<unknown>) => pending.push(value) })
    await vi.advanceTimersByTimeAsync(5_000)
    const response = await request
    expect(response.status).toBe(503)
    expect((await response.json() as any).physicalZeroVerified).toBe(false)
    expect(pending).toHaveLength(1)
    finish(Response.json({ stopped: true }))
    await pending[0]
  } finally {
    vi.useRealTimers()
  }
})

it('bounds the authenticated frontdoor path with the same deadline', async () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function boundedFrontDoorStop('),
    source.indexOf('\nasync function dashboardWorkflowStatus(')))
  const bound = new Function('json', 'canonicalJson', `${code}\nreturn boundedFrontDoorStop;`)(
    (body: unknown, status = 200) => Response.json(body, { status }), JSON.stringify,
  ) as (operation: Promise<Response>, ctx: unknown, runId: string, deadlineAt: number) => Promise<Response>
  let finish!: (response: Response) => void
  const operation = new Promise<Response>(resolve => { finish = resolve })
  const pending: Promise<unknown>[] = []
  vi.useFakeTimers()
  try {
    const responsePromise = bound(operation, { waitUntil: (value: Promise<unknown>) => pending.push(value) },
      'owned-run', Date.now() + 5_000)
    await vi.advanceTimersByTimeAsync(5_000)
    const response = await responsePromise
    expect(response.status).toBe(503)
    expect((await response.json() as any).physicalZeroVerified).toBe(false)
    expect(pending).toHaveLength(1)
    finish(Response.json({ stopped: true }))
    await pending[0]
  } finally {
    vi.useRealTimers()
  }
})
