import { memoryR2 } from './support/memory-r2.js'
import { startLocalAuditWorkflow } from '../src/execution-workflow.js'
import { assertExecutionOwner } from '../src/run-control-executor.js'
import { deliverRunControl, settleCancelledExecution, settleControlledFailure } from '../src/run-control-executor.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { bootstrapExecution, materializeRootExecution, rootExecutionMachine } from '../src/root-execution.js'
import { CloudflareRunStore, stateWriter } from '../src/cloudflare-storage.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { RunMachine } from '../src/machine.js'
import type { AuditWorkflowPayload } from '../src/env.js'
import type { RuntimeRelease } from '../src/contracts.js'
import type { Env } from '../src/env.js'
import { runControlResponse } from '../src/run-control-api.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { CommandCustodyCollector } from '../src/command-custody.js'
import { reconcileRunControls, settleTerminalAdmissionControls } from '../src/run-control-reconcile.js'
import { workflowProgress, failureForWorkflowProgress } from '../src/workflow-outcome.js'
import { waveStepConfig } from '../src/workflow-step-config.js'
import { canonicalJson } from '../src/canonical.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-root', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-root', workflowName: 'runtime-root',
  workerVersionId: '11111111-1111-4111-8111-111111111111', containerImageDigest: `sha256:${'b'.repeat(64)}` }

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })

async function fixture() {
  const db = sqliteD1(); closes.push(() => db.sqlite.close())
  const { objects, bucket } = memoryR2()
  const store = new CloudflareRunStore(bucket, bucket, db.d1)
  const release = await store.putRelease(structuredClone(audit0PackageBody))
  const payload: AuditWorkflowPayload = { mode: 'start', runId: 'root-startup',
    experimentId: release.body.definition.id, releaseDigest: release.digest, runtimeRelease: runtime }
  const { workerVersionId, ...declaration } = runtime
  const env = { ENGINE_ROLE: 'runtime', INDEX: db.d1, PACKAGES: bucket, ARTIFACTS: bucket,
    RUNTIME_RELEASE_JSON: JSON.stringify(declaration), VERSION_METADATA: { id: workerVersionId },
    AGENT_SANDBOX: { idFromName: vi.fn(() => { throw new Error('unexpected actor allocation') }),
      getByName: vi.fn(() => { throw new Error('unexpected actor RPC') }) } } as unknown as Env
  return { ...db, store, release, payload, objects, env }
}

it('materializes control authority before Workflow creation without starting the model clock', async () => {
  const { store, payload, d1, sqlite } = await fixture()
  const state = await materializeRootExecution(payload, store)
  expect(await store.getState(payload.runId)).toEqual(state)
  expect(state.status).toBe('running')
  expect(state.modelStartedAt).toBeNull()
  expect(state.artifacts).toEqual([])
  expect(state.inFlightAgentAttempts).toEqual([])
  await new ExecutionAuthorityStore(d1).assertActive(state.executionAuthority!)
  expect(sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  expect((await rootExecutionMachine(payload, store)).snapshot()).toEqual(state)
  expect(await materializeRootExecution(payload, store)).toEqual(state)
})

it('adopts the single committed origin when initial writers collide with different birth times', async () => {
  const { store, payload } = await fixture()
  const put = store.putState.bind(store)
  let entered!: () => void, release!: () => void
  const firstEntered = new Promise<void>(resolve => { entered = resolve })
  const firstReleased = new Promise<void>(resolve => { release = resolve })
  let writes = 0
  vi.spyOn(store, 'putState').mockImplementation(async (...args) => {
    if (++writes === 1) { entered(); await firstReleased }
    return put(...args)
  })
  const first = materializeRootExecution(payload, store)
  await firstEntered
  const selected = await materializeRootExecution(payload, store)
  release()
  expect(await first).toEqual(selected)
  expect(await store.getState(payload.runId)).toEqual(selected)
  expect(writes).toBe(2)
})

it('reconciles a lost raw storage acknowledgement against verified durable state', async () => {
  const { store, payload } = await fixture()
  const put = store.putState.bind(store)
  vi.spyOn(store, 'putState').mockImplementationOnce(async (...args) => {
    await put(...args)
    throw new Error('D1 response connection lost after commit')
  })
  const state = await materializeRootExecution(payload, store)
  expect(state).toEqual(await store.getState(payload.runId))
  const putCount = vi.mocked(store.putState).mock.calls.length
  expect(await materializeRootExecution(payload, store)).toEqual(state)
  expect(vi.mocked(store.putState).mock.calls.length).toBe(putCount)
})

it('does not invent a committed origin on storage failure and can retry the exact activation', async () => {
  const { store, payload } = await fixture()
  vi.spyOn(store, 'putState').mockRejectedValueOnce(new Error('R2 unavailable before write'))
  await expect(materializeRootExecution(payload, store)).rejects.toThrow('R2 unavailable')
  expect(await store.getStateIfPresent(payload.runId)).toBeNull()
  const state = await materializeRootExecution(payload, store)
  expect(state.executionAuthority!.epoch).toBe(0)
  expect(state.modelStartedAt).toBeNull()
})

it.each(['parent', 'runtime', 'release', 'authority', 'missing-authority', 'clock-amendment'] as const)(
  'refuses a persisted origin with changed %s', async change => {
    const { store, payload } = await fixture()
    const state = structuredClone(await materializeRootExecution(payload, store))
    if (change === 'parent') state.parentRunId = 'unexpected-parent'
    if (change === 'runtime') state.runtimeRelease = { schemaVersion: 1, id: 'runtime-test',
      frameworkCommit: 'a'.repeat(40), workerService: 'runtime-test', workflowName: 'runtime-test',
      workerVersionId: '11111111-1111-4111-8111-111111111111', containerImageDigest: `sha256:${'b'.repeat(64)}` }
    if (change === 'release') payload.releaseDigest = 'd'.repeat(64)
    if (change === 'authority') state.executionAuthority!.epoch = 1
  // @ts-expect-error Deliberately remove required ownership to test rejection.
    if (change === 'missing-authority') delete state.executionAuthority
    if (change === 'clock-amendment') state.journal = [...state.journal, { type: 'run.time-amended' } as any]
    await expect(rootExecutionMachine(payload, store, state)).rejects.toThrow()
    vi.spyOn(store, 'getStateIfPresent').mockResolvedValue(state)
    await expect(materializeRootExecution(payload, store)).rejects.toThrow()
  },
)

it('does not adopt corrupted committed bytes after an ambiguous write', async () => {
  const { store, payload, objects, sqlite } = await fixture()
  const put = store.putState.bind(store)
  vi.spyOn(store, 'putState').mockImplementationOnce(async (...args) => {
    await put(...args)
    const key = sqlite.prepare('SELECT state_key FROM experiment_runs').get()!.state_key as string
    objects.get(key)!.content = '{}'
    throw new Error('lost acknowledgement')
  })
  await expect(materializeRootExecution(payload, store)).rejects.toThrow('digest mismatch')
})

// Execute the real runtime boundary, substituting only the platform/store bindings.
function runtimeStart(store: CloudflareRunStore) {
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('async function createAuditRun('), source.indexOf('async function auditRunStatus('))
  const dependencies = { startLocalAuditWorkflow, runIdPattern: /^[a-z0-9][a-z0-9._-]{0,99}$/, assertLocalRuntime: () => {},
    CloudflareRunStore: class { constructor() { return store } }, sameRuntimeRelease: () => true,
    assertReleaseEnvironmentMatchesRuntime: () => {}, resolveTargetEnvironment: () => {},
    assertReleaseProviderCredentials: async () => {},
    response: (_env: unknown, value: unknown, status = 200) => Response.json(value, { status }) }
  return new Function(...Object.keys(dependencies), `${stripTypeScriptTypes(body)}; return createAuditRun;`)(
    ...Object.values(dependencies)) as (request: Request, env: unknown) => Promise<Response>
}

it('persists before the native create, and reconciles its lost acknowledgement without a second identity', async () => {
  const { store, payload, env } = await fixture()
  // Runtime route check is isolated here; origin and storage use the real root implementation.
  vi.spyOn(store, 'runRuntime').mockResolvedValue(runtime)
  const instance = { id: payload.runId, status: vi.fn(async () => ({ status: 'running' })) }
  const binding = { create: vi.fn(async () => {
    expect((await store.getState(payload.runId)).modelStartedAt).toBeNull()
    throw new Error('create ACK lost')
  }), get: vi.fn(async () => instance) }
  const response = await runtimeStart(store)(new Request('https://internal/', {
    method: 'POST', body: canonicalJson(payload),
  }), { ...env, AUDIT_WORKFLOW: binding })
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ workflowInstanceId: payload.runId, reusedWorkflow: true })
  expect(binding.create).toHaveBeenCalledOnce()
  expect(binding.get).toHaveBeenCalledExactlyOnceWith(payload.runId)
})

it('never creates a native Workflow on a failed root dispatch retry', async () => {
  const { store, payload, release, env } = await fixture()
  const before = await materializeRootExecution(payload, store)
  const machine = await RunMachine.fromState(release.body.definition, before, digest => store.getRelease(digest), store.executionSources())
  await machine.fail('synthetic framework failure')
  await (await stateWriter(store, before))(machine.view())
  const selected = await store.getState(payload.runId)
  vi.spyOn(store, 'runRuntime').mockResolvedValue(runtime)
  const binding = { create: vi.fn(), get: vi.fn(async () => ({ id: payload.runId,
    status: async () => ({ status: 'complete' }) })) }
  const request = () => new Request('https://internal/', { method: 'POST', body: canonicalJson(payload) })
  expect((await runtimeStart(store)(request(), { ...env, AUDIT_WORKFLOW: binding })).status).toBe(202)
  expect(binding.create).not.toHaveBeenCalled()
  binding.get.mockRejectedValueOnce(new Error('native instance missing'))
  await expect(runtimeStart(store)(request(), { ...env, AUDIT_WORKFLOW: binding })).rejects.toThrow('native instance missing')
  expect(binding.create).not.toHaveBeenCalled()
  expect(await store.getState(payload.runId)).toEqual(selected)
})

it('a create already in flight adopts a winning cancellation and admits no work on late bootstrap', async () => {
  const { store, payload, release, env, sqlite } = await fixture()
  vi.spyOn(store, 'runRuntime').mockResolvedValue(runtime)
  let entered!: () => void, complete!: () => void
  const creating = new Promise<void>(resolve => { entered = resolve })
  const delayed = new Promise<void>(resolve => { complete = resolve })
  await store.ensureSchema()
  await env.INDEX.prepare('INSERT INTO runtime_slot_control (singleton, enabled, updated_at) VALUES (1, 0, ?1)')
    .bind(new Date().toISOString()).run()
  await store.reserveRunRoute(payload.runId, payload.experimentId, runtime)
  let creates = 0, instances = 0, exists = false, status = 'running'
  const binding = { create: vi.fn(async (input: { id: string; params: AuditWorkflowPayload }) => {
    expect(input.id).toBe(payload.runId); expect(input.params).toEqual(payload)
    if (++creates === 1) { entered(); await delayed }
    if (exists) throw new Error('native duplicate Workflow')
    exists = true; instances++
    return { id: payload.runId }
  }), get: vi.fn(async (id: string) => {
    expect(id).toBe(payload.runId)
    if (!exists) throw new Error('native Workflow not created')
    return { id, status: async () => ({ status }) }
  }) }
  env.AUDIT_WORKFLOW = binding as unknown as Env['AUDIT_WORKFLOW']
  env.ENGINE_ROLE = 'runtime'
  const dispatch = runtimeStart(store)(new Request('https://internal/', {
    method: 'POST', body: canonicalJson(payload),
  }), { ...env, AUDIT_WORKFLOW: binding })
  await creating
  const before = await store.getState(payload.runId)
  const command = { id: 'cancel-before-bootstrap', action: 'cancel', scope: { kind: 'audit' },
    expectedRevision: 0, reason: 'synthetic startup cancellation' }
  const response = await runControlResponse(new Request('https://internal/commands', {
    method: 'POST', body: canonicalJson(command),
  }), store, env.INDEX, payload.experimentId, payload.runId)
  expect(response.status).toBe(202)
  const machine = await RunMachine.fromState(release.body.definition, before, digest => store.getRelease(digest), store.executionSources())
  const journal = new RunCommandJournal(env.INDEX, payload.runId), native = new CommandCustodyCollector(env)
  expect(await reconcileRunControls({ machine, journal, native, persist: await stateWriter(store, before) })).toBe(false)
  const stopped = await store.getState(payload.runId)
  expect(stopped.status).toBe('stopped')
  expect((await journal.get(command.id))!.status).toBe('applied')
  const proof = await native.acknowledgeCancellation(stopped)
  const authority = new ExecutionAuthorityStore(env.INDEX)
  await authority.fence(stopped.executionAuthority!, proof.operation.commandDigest)
  await authority.retire(stopped.executionAuthority!, proof.proofDigest)
  const marker = { schemaVersion: 1 as const, experimentId: payload.experimentId, auditId: payload.runId,
    commandId: command.id, commandDigest: proof.operation.commandDigest, expectedRevision: 0,
    authority: stopped.executionAuthority! }
  // Cancellation delivery creates the original identity while the original create is delayed.
  expect(await deliverRunControl(marker, env)).toBe(false)
  expect(instances).toBe(1)
  expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()!.released_at).toBeNull()
  complete()
  const dispatched = await dispatch
  expect(dispatched.status).toBe(202)
  expect(await dispatched.json()).toMatchObject({ workflowInstanceId: payload.runId, reusedWorkflow: true })
  expect(creates).toBe(2); expect(instances).toBe(1)

  // Execute the real Workflow entry point and cancellation cleanup after native create finishes.
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
  const deps = { assertExecutionOwner, WorkflowEntrypoint: class { env = env },
    CloudflareRunStore: class { constructor() { return store } }, bootstrapExecution,
    stateWriter, workflowProgress, waveStepConfig, failureForWorkflowProgress,
    CommandCustodyCollector, ExecutionAuthorityStore, RunCommandJournal, settleTerminalAdmissionControls, settleCancelledExecution, settleControlledFailure,
    runIdPattern: /^[a-z0-9._-]+$/, engineRole: () => 'legacy-monolith',
  }
  const Workflow = new Function(...Object.keys(deps), `${code}; return AuditWorkflow;`)(...Object.values(deps))
  const workflow = new Workflow()
  const runOneWave = vi.spyOn(workflow, 'runOneWave')
  const put = vi.spyOn(store, 'putState')
  const names: string[] = []
  const result = await workflow.run({ payload }, { do: async (name: string, _options: unknown, fn: () => unknown) => {
    names.push(name); return fn()
  }, sleep: vi.fn(() => { throw new Error('unexpected model polling') }) })
  expect(result.status).toBe('stopped')
  expect(runOneWave).not.toHaveBeenCalled()
  expect(put).not.toHaveBeenCalled()
  expect(names).toEqual(['initialize-index', 'bootstrap-run', 'reconcile-terminal-workspaces', 'reconcile-stopped-workspaces'])
  expect(await store.getState(payload.runId)).toEqual(stopped)
  expect(stopped.modelStartedAt).toBeNull()
  expect(env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  expect(sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  expect(sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
  expect(await deliverRunControl(marker, env)).toBe(false)
  expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()!.released_at).toBeNull()
  status = 'complete'
  expect(await deliverRunControl(marker, env)).toBe(true)
  expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()!.released_at).toEqual(expect.any(String))
  expect(instances).toBe(1); expect(await store.getState(payload.runId)).toEqual(stopped)
})
