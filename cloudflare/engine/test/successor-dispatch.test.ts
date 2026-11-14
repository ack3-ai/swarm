import { assertExecutionOwner } from '../src/run-control-executor.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { target, runtime } from './support/successor-fixture.js'
import { assertReleaseProviderCredentials } from '../src/release-provider-credentials.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import { bootstrapExecution } from '../src/root-execution.js'
import { dispatchAuditWorkflow, startLocalAuditWorkflow } from '../src/execution-workflow.js'
import { deliverRunControl, reconcileDeliveredRunControl, settleCancelledExecution, settleControlledFailure } from '../src/run-control-executor.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { hasPendingNativeControl, reconcileRunControls, settleTerminalAdmissionControls } from '../src/run-control-reconcile.js'
import { CloudflareRunStore, stateWriter } from '../src/cloudflare-storage.js'
import { RunMachine } from '../src/machine.js'
import { CommandCustodyCollector } from '../src/command-custody.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { localRuntimeRelease, sameRuntimeRelease } from '../src/runtime-release.js'
import { waveStepConfig } from '../src/workflow-step-config.js'
import { workflowProgress, failureForWorkflowProgress } from '../src/workflow-outcome.js'
import type { Env } from '../src/env.js'
import { createForkStartupFixture } from './support/successor-dispatch-fixture.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// The completed audit is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
const fixture = () => createForkStartupFixture(close => closes.push(close), undefined, forks)

it('reconciles ambiguous Workflow creation by the same identity without changing publication or model state', async () => {
  const f = await fixture()
  const restore = vi.spyOn(RunMachine, 'fromState')
  f.binding.create.mockRejectedValueOnce(new Error('ambiguous create'))
  expect(await dispatchAuditWorkflow(f.env, f.payload)).toBe(f.successor.runId)
  expect(restore).not.toHaveBeenCalled()
  expect(f.binding.get).toHaveBeenCalledWith(f.successor.runId)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(await hasPendingNativeControl(f.successor, f.controls)).toBe(false)
  expect((await f.start()).snapshot()).toEqual(f.successor)
  expect(restore).toHaveBeenCalledOnce()
  expect(f.binding.create).toHaveBeenCalledOnce()
  expect(f.binding.create.mock.calls[0]![0]).toMatchObject({ id: f.successor.runId, params: f.payload })
})

it.each(['release', 'runtime', 'run', 'extra'])('refuses %s bootstrap identity changes', async change => {
  const f = await fixture(), payload = structuredClone(f.payload)
  if (change === 'release') payload.releaseDigest = '1'.repeat(64)
  if (change === 'runtime') payload.runtimeRelease = runtime
  if (change === 'run') payload.runId = 'different-executor'
  if (change === 'extra') Object.assign(payload, { control: { commandDigest: '1'.repeat(64) } })
  await expect(bootstrapExecution(payload, f.store, f.env)).rejects.toThrow()
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.binding.create).not.toHaveBeenCalled()
})

it('routes fork delivery to the pinned runtime ordinary audit endpoint, regardless of latest', async () => {
  const f = await fixture()
  const pinned = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'GET') return Response.json({ runId: f.successor.runId, workflow: { status: 'running' } },
      { headers: { 'x-ack3-runtime-worker-version': target.workerVersionId } })
    expect(new URL(String(input)).pathname).toBe('/internal/runtime/audit-runs')
    const payload = JSON.parse(init!.body as string)
    expect(payload).toEqual(f.payload)
    return Response.json({ workflowInstanceId: await dispatchAuditWorkflow(f.env, payload) },
      { headers: { 'x-ack3-runtime-worker-version': target.workerVersionId } })
  })
  const old = vi.fn(() => { throw new Error('old runtime must not dispatch successor') })
  const front = { ...f.env, ENGINE_ROLE: 'front-door', RUNTIME_CATALOG_JSON: JSON.stringify({ schemaVersion: 1,
    latest: runtime.id, releases: Object.fromEntries([runtime, target].map(({ workerVersionId: _version, ...release }) => [release.id, { ...release, binding: release.id === runtime.id ? 'RUNTIME_OLD' : 'RUNTIME_TARGET' }])) }),
    RUNTIME_OLD: { fetch: old }, RUNTIME_TARGET: { fetch: pinned } } as unknown as Env
  expect(await deliverRunControl(f.marker, front)).toBe(false)
  expect(old).not.toHaveBeenCalled(); expect(pinned).toHaveBeenCalledTimes(2)
  await f.store.recordExecutionBootstrap(f.successor)
  expect(await deliverRunControl(f.marker, front)).toBe(true)
  expect(pinned).toHaveBeenCalledTimes(2)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})

it('rejects a forged old marker and a request routed to the wrong target', async () => {
  const f = await fixture()
  await expect(reconcileDeliveredRunControl({ ...f.marker, source: { ...f.command.source, runId: 'different-source' } }, f.env)).rejects.toThrow()
  const { workerVersionId, ...declaration } = runtime
  await expect(reconcileDeliveredRunControl(f.marker, { ...f.env, RUNTIME_RELEASE_JSON: canonicalJson(declaration), VERSION_METADATA: { id: workerVersionId, tag: '', timestamp: '' } }))
    .rejects.toThrow('runtime release destination mismatch')
  expect(f.binding.create).not.toHaveBeenCalled()
})

it('the actual delayed Workflow entry point observes cancellation without starting a wave or a model', async () => {
  const f = await fixture(), native = new CommandCustodyCollector(f.env)
  const command = { id: 'cancel-delayed-workflow', expectedRevision: 0, reason: 'synthetic cancellation', action: 'cancel' as const, scope: { kind: 'audit' as const } }
  await f.controls.admit(command, f.successor.executionAuthority!)
  const machine = await RunMachine.fromState(f.release.body.definition, f.successor, digest => f.store.getRelease(digest), f.store.executionSources())
  await reconcileRunControls({ machine, journal: f.controls, persist: await stateWriter(f.store, f.successor), native })
  const stopped = await f.store.getState(f.successor.runId)
  await settleCancelledExecution(stopped, f.env)
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
  const deps = { assertExecutionOwner, WorkflowEntrypoint: class { env = f.env }, CloudflareRunStore: class { constructor() { return f.store } },
    bootstrapExecution, stateWriter, workflowProgress, waveStepConfig, failureForWorkflowProgress,
    CommandCustodyCollector, ExecutionAuthorityStore, RunCommandJournal, settleTerminalAdmissionControls, settleCancelledExecution, settleControlledFailure,
    runIdPattern: /^[a-z0-9._-]+$/, engineRole: () => 'runtime',
    assertLocalRuntime: (env: Env, runtime: typeof target) => { expect(sameRuntimeRelease(localRuntimeRelease(env), runtime)).toBe(true) } }
  const Workflow = new Function(...Object.keys(deps), `${code}; return AuditWorkflow;`)(...Object.values(deps))
  const workflow = new Workflow(), runOneWave = vi.spyOn(workflow, 'runOneWave'), put = vi.spyOn(f.store, 'putState')
  const names: string[] = []
  const result = await workflow.run({ payload: f.payload }, { do: async (name: string, _options: unknown, fn: () => unknown) => {
    names.push(name); return fn()
  }, sleep: vi.fn(() => { throw new Error('unexpected model polling') }) })
  expect(result.status).toBe('stopped')
  expect(await f.store.executionBootstrapped(stopped)).toBe(true)
  expect(runOneWave).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled()
  expect(names).toEqual(['initialize-index', 'bootstrap-run', 'reconcile-terminal-workspaces', 'reconcile-stopped-workspaces'])
  expect(await f.store.getState(f.successor.runId)).toEqual(stopped)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it('does not mask a wrong create identity with an unrelated successful GET', async () => {
  const f = await fixture()
  f.binding.create.mockResolvedValueOnce({ id: 'wrong-execution' })
  await expect(dispatchAuditWorkflow(f.env, f.payload)).rejects.toThrow('Workflow identity differs')
  expect(f.binding.get).not.toHaveBeenCalled()
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})

it.each(['errored', 'terminated', 'complete'])('observes %s Workflow identity without claiming audit completion or physical cleanup', async status => {
  const f = await fixture()
  f.binding.create.mockRejectedValue(new Error('already exists'))
  f.binding.get.mockResolvedValue({ id: f.successor.runId, status: vi.fn(async () => ({ status })) })
  expect(await dispatchAuditWorkflow(f.env, f.payload)).toBe(f.successor.runId)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority WHERE execution_id = ?').get(f.successor.runId)!.status).toBe('active')
  expect(f.binding.create).toHaveBeenCalledOnce()
  expect(await f.owners.pendingLaunches(f.successor.executionAuthority!)).toEqual([])
})

it('an admitted native cancellation prevents model claims even after bootstrap has read state', async () => {
  const f = await fixture(), machine = await f.start()
  const command = { id: 'cancel-cutoff', expectedRevision: 0, reason: 'synthetic cancellation', action: 'cancel' as const, scope: { kind: 'audit' as const } }
  let operation = await f.controls.admit(command, f.successor.executionAuthority!)
  operation = await f.controls.beginEffect(command.id, operation.version, f.successor)
  await f.controls.beginNativeEffect(command.id, operation.version, 'a'.repeat(64))
  await expect(f.owners.admitLaunch(machine.view().executionAuthority!, 'task-synthetic', 'a'.repeat(64),
    { generation: machine.view().stateGeneration, digest: await sha256(machine.view()) })).rejects.toThrow('no active execution authority')
  expect(await f.owners.pendingLaunches(f.successor.executionAuthority!)).toEqual([])
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})


it('refuses local native creation on the front door before touching selected state or Workflow', async () => {
  const f = await fixture()
  await expect(startLocalAuditWorkflow({ ...f.env, ENGINE_ROLE: 'front-door' }, f.payload))
    .rejects.toThrow('local Workflow dispatch requires an execution runtime')
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.binding.get).not.toHaveBeenCalled()
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})


it('dispatches a retained-work fork without credentials used only by earlier stages', async () => {
  const f = await fixture()
  delete (f.env as unknown as Record<string, unknown>).PROVIDER_A_API_KEY
  await expect(assertReleaseProviderCredentials(f.release.body.definition, f.env))
    .rejects.toThrow('additive provider credential is missing')
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('async function createAuditRun('), source.indexOf('async function auditRunStatus(')))
  const deps = { runIdPattern: /^[a-z0-9][a-z0-9._-]{0,99}$/,
    assertLocalRuntime: (env: Env, value: typeof target) => { expect(sameRuntimeRelease(localRuntimeRelease(env), value)).toBe(true) },
    CloudflareRunStore: class { constructor() { return f.store } }, sameRuntimeRelease,
    assertReleaseEnvironmentMatchesRuntime, startLocalAuditWorkflow,
    response: (_env: Env, value: unknown, status = 200) => Response.json(value, { status }) }
  const start = new Function(...Object.keys(deps), `${code}; return createAuditRun;`)(...Object.values(deps))
  const response = await start(new Request('https://runtime.internal/internal/runtime/audit-runs', {
    method: 'POST', body: JSON.stringify(f.payload),
  }), f.env)
  expect(response.status).toBe(202)
  expect(f.binding.create).toHaveBeenCalledOnce()
  const machine = await f.start()
  expect(machine.view().status).toBe('running')
  expect(machine.view().artifacts).toEqual(f.successor.artifacts)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})
