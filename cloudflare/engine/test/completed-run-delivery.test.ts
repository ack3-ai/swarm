import { memoryR2 } from './support/memory-r2.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { RunMachine } from '../src/machine.js'
import { audit0Definition } from './support/audit0-config.js'
import { runExperiment, MemoryArtifactStore } from './support/memory-runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { audit0RunPolicy } from '../src/runner.js'
import { assertLocalRuntime } from '../src/runtime-release.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { assertCompletedRunDelivery, deliverCompletedRun, registerCompletedRunDelivery,
  type CompletedRunDeliveryMarker } from '../src/completed-run-delivery.js'
import { RunControlDelivery } from '../src/run-control-delivery.js'
import type { RunState, RuntimeRelease } from '../src/contracts.js'
import type { Env } from '../src/env.js'
import { assertExecutionOwner } from '../src/run-control-executor.js'
import { failureForWorkflowProgress, workflowProgress } from '../src/workflow-outcome.js'
import { waveStepConfig } from '../src/workflow-step-config.js'
import { durableStorage } from './support/durable-storage.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
async function fixture(slotPool = true) {
  const db = sqliteD1(); closes.push(() => db.sqlite.close())
  const { objects, bucket } = memoryR2()
  const store = new CloudflareRunStore(bucket, bucket, db.d1); await store.ensureSchema()
  const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-terminal', frameworkCommit: 'a'.repeat(40),
    workerService: 'runtime-terminal', workflowName: 'runtime-terminal', workerVersionId: '11111111-1111-4111-8111-111111111111',
    containerImageDigest: `sha256:${'b'.repeat(64)}` }
  const authority = { auditId: 'terminal-execution', executionId: 'terminal-execution', epoch: 0,
    runtimeDigest: await sha256(runtime) }
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), authority.executionId,
    '2026-11-03T00:00:00Z', runtime, authority)
  await runExperiment({ machine, definition: audit0Definition, artifactStore: new MemoryArtifactStore(),
    provider: new DeterministicAuditProvider(), policy: audit0RunPolicy })
  const state = machine.view()
  if (slotPool) {
    await db.d1.prepare('INSERT INTO runtime_slots (slot_id,runtime_release_json,generation,deployed_at) VALUES (?1,?2,1,?3)')
      .bind(runtime.id, canonicalJson(runtime), state.updatedAt).run()
    await db.d1.prepare('INSERT INTO runtime_slot_control (singleton,enabled,latest_slot_id,updated_at) VALUES (1,1,?1,?2)')
      .bind(runtime.id, state.updatedAt).run()
  }
  await store.reserveRunRoute(state.runId, state.experimentId, runtime); await new ExecutionAuthorityStore(db.d1).activate(state.executionAuthority!, 'a'.repeat(64)); await store.putState(state, null)
  const cleanup = { mode: 'provider-attempted', activeWorkspaceKeys: [], retainedWorkspaceKeys: [], deferred: [] }
  await store.putCompletedCleanupProof(state, cleanup)
  const durable = durableStorage(), delivery = new RunControlDelivery<CompletedRunDeliveryMarker>(durable.storage)
  let status = 'running', lostRegistration = false
  const workflow = { id: state.runId, status: vi.fn(async () => ({ status })) }
  const coordinator = { fetch: vi.fn(async (_url: string, init: RequestInit) => {
    const marker = JSON.parse(String(init.body)); assertCompletedRunDelivery(marker); await delivery.register(marker)
    if (lostRegistration) { lostRegistration = false; throw new Error('registration reply lost') }
    return Response.json({ markerDigest: await sha256(marker) })
  }) }
  const { workerVersionId, ...declaration } = runtime
  const env = { ENGINE_ROLE: 'runtime', INDEX: db.d1, ARTIFACTS: bucket, PACKAGES: bucket,
    RUNTIME_RELEASE_JSON: canonicalJson(declaration), VERSION_METADATA: { id: workerVersionId },
    COORDINATORS: { idFromName: vi.fn(() => 'coordinator-id'), get: vi.fn(() => coordinator) },
    AUDIT_WORKFLOW: { get: vi.fn(async () => workflow), create: vi.fn(() => { throw new Error('no Workflow dispatch') }) } } as unknown as Env
  const lease = () => db.sqlite.prepare('SELECT released_at,terminal_workflow_status FROM runtime_slot_run_leases WHERE run_id=?').get(state.runId)
  const errors: unknown[] = []
  const alarm = async () => { errors.length = 0; durable.consumeAlarm(); await delivery.alarm(async marker => {
    try { return await deliverCompletedRun(marker, env) } catch (error) { errors.push(String(error)); throw error }
  }) }
  return { objects, errors, db, store, state, runtime, env, workflow, coordinator, durable, delivery, cleanup, lease, alarm,
    complete: () => { status = 'complete' }, loseRegistration: () => { lostRegistration = true } }
}

it('releases a completed run on a catalog-only install that never seeded the slot pool', async () => {
  const f = await fixture(false)
  expect(f.db.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_slot_control').get()).toMatchObject({ n: 0 })
  await registerCompletedRunDelivery(f.state, f.env)
  f.complete(); await f.alarm(); expect(f.errors).toEqual([])
  expect(f.lease()).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'complete' })
  expect(await f.store.retiredRunWorkflow(f.state.runId)).toMatchObject({ disposition: 'terminal' })
})

it('releases the exact lease autonomously only after native completion, without a status GET', async () => {
  const f = await fixture()
  await registerCompletedRunDelivery(f.state, f.env)
  await f.alarm()
  expect(f.lease()).toMatchObject({ released_at: null }); expect(f.durable.pending()).toBe(1)
  expect(f.durable.scheduled()).not.toBeNull()
  f.complete(); await f.alarm(); expect(f.errors).toEqual([])
  expect(f.lease()).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'complete' })
  expect(f.durable.pending()).toBe(0); expect(f.durable.scheduled()).toBeNull()
  expect(await f.store.retiredRunWorkflow(f.state.runId)).toMatchObject({ disposition: 'terminal' })
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
})

it('reconciles lost registration and archive acknowledgements through the same marker', async () => {
  const f = await fixture(); f.loseRegistration()
  await expect(registerCompletedRunDelivery(f.state, f.env)).rejects.toThrow('registration reply lost')
  await registerCompletedRunDelivery(f.state, f.env)
  expect(f.durable.pending()).toBe(1)
  let lost = false
  f.db.onAfterRun(sql => { if (!lost && sql.includes('INSERT INTO retired_runtime_runs')) { lost = true; throw new Error('archive reply lost') } })
  f.complete(); await f.alarm(); expect(f.lease()).toMatchObject({ released_at: null }); expect(f.durable.pending()).toBe(1)
  f.db.onAfterRun(); await f.alarm(); expect(f.lease()).toMatchObject({ released_at: expect.any(String) })
  await registerCompletedRunDelivery(f.state, f.env); await f.alarm(); expect(f.durable.pending()).toBe(0)
})

it.each(['source', 'runtime', 'workflow', 'proof', 'route'] as const)('retains the lease when exact %s evidence differs', async damage => {
  const f = await fixture(); f.complete(); await registerCompletedRunDelivery(f.state, f.env)
  const marker = f.durable.values().find((value: any) => value.kind === 'completed') as CompletedRunDeliveryMarker
  if (damage === 'source') marker.source.state.digest = 'c'.repeat(64)
  if (damage === 'runtime') marker.runtimeRelease.workerVersionId = '22222222-2222-4222-8222-222222222222'
  if (damage === 'workflow') f.workflow.id = 'different-workflow'
  if (damage === 'proof') vi.spyOn(CloudflareRunStore.prototype, 'verifyCompletedCleanupProof').mockRejectedValueOnce(new Error('proof missing'))
  if (damage === 'route') f.db.sqlite.prepare('UPDATE run_runtime_routes SET runtime_release_json=? WHERE run_id=?')
    .run(canonicalJson({ ...f.runtime, workerVersionId: '22222222-2222-4222-8222-222222222222' }), f.state.runId)
  await expect(deliverCompletedRun(marker, f.env)).rejects.toThrow()
  expect(f.lease()).toMatchObject({ released_at: null })
})

it('registers terminal delivery in the actual Workflow cleanup step before it returns', async () => {
  const f = await fixture()
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
  const Workflow = new Function('WorkflowEntrypoint', 'CloudflareRunStore', 'failureForWorkflowProgress', 'registerCompletedRunDelivery', 'waveStepConfig', 'assertExecutionOwner', 'workflowProgress', `${code}\nreturn AuditWorkflow;`)(
    class { env = f.env }, function Store() { return f.store }, failureForWorkflowProgress, registerCompletedRunDelivery, waveStepConfig, assertExecutionOwner, workflowProgress)
  const workflow = new Workflow()
  workflow.cleanupTerminalWorkspaces = vi.fn(async () => f.cleanup)
  vi.spyOn(f.store, 'getRelease').mockResolvedValue({ body: { definition: {} } } as any)
  const step = { do: async (name: string, _config: unknown, fn: () => Promise<unknown>) => {
    if (name === 'initialize-index') return { ready: true }
    if (name === 'bootstrap-run') return { status: 'completed', cursor: f.state.cursor, terminalReason: null }
    return fn()
  } }
  await workflow.run({ payload: { runId: f.state.runId } }, step)
  expect(f.coordinator.fetch).toHaveBeenCalledOnce(); expect(f.durable.pending()).toBe(1)
  expect(f.lease()).toMatchObject({ released_at: null })
  f.complete(); await f.alarm(); expect(f.lease()).toMatchObject({ released_at: expect.any(String) })
})


it('registers through the real coordinator route and refuses another runtime or experiment', async () => {
  const f = await fixture()
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class ExperimentCoordinator'),
    source.indexOf('function sameCursor')).replace('export class', 'class'))
  const Coordinator = new Function('DurableObject', 'RunControlDelivery', 'assertCompletedRunDelivery',
    'assertLocalRuntime', 'engineRole', 'sha256', 'json', `${code}\nreturn ExperimentCoordinator;`)(
    class { constructor(public ctx: unknown, public env: unknown) {} }, RunControlDelivery, assertCompletedRunDelivery,
    assertLocalRuntime, (env: Env) => env.ENGINE_ROLE, sha256, (body: unknown, status = 200) => Response.json(body, { status }))
  const coordinator = new Coordinator({ storage: f.durable.storage }, f.env)
  await registerCompletedRunDelivery(f.state, f.env)
  const marker = JSON.parse(String(f.coordinator.fetch.mock.calls[0]![1].body))
  const post = (value: unknown) => coordinator.fetch(new Request('https://coordinator/completed-executions', {
    method: 'POST', headers: { 'x-ack3-experiment': f.state.experimentId }, body: canonicalJson(value) }))
  expect((await post(marker)).status).toBe(200)
  expect((await post(marker)).status).toBe(200)
  expect((await post({ ...marker, experimentId: 'other-experiment' })).status).toBe(409)
  expect((await post({ ...marker, runtimeRelease: { ...marker.runtimeRelease,
    workerVersionId: '22222222-2222-4222-8222-222222222222' } })).status).toBe(409)
  expect(f.durable.pending()).toBe(1)
})

it('refuses an unowned completion instead of silently skipping autonomous delivery', async () => {
  const state = structuredClone((await fixture()).state)
  // @ts-expect-error Deliberately remove required ownership to test rejection.
  delete state.executionAuthority
  const idFromName = vi.fn(() => { throw new Error('unexpected coordinator access') })
  await expect(registerCompletedRunDelivery(state, { COORDINATORS: { idFromName } } as any))
    .rejects.toThrow('historical app version')
  expect(idFromName).not.toHaveBeenCalled()
})

it('reconciles a lost cleanup-proof write acknowledgement before autonomous retirement', async () => {
  const f = await fixture()
  for (const key of f.objects.keys()) if (key.includes('/terminal-cleanup/')) f.objects.delete(key)
  const original = f.env.ARTIFACTS.put.bind(f.env.ARTIFACTS)
  const put = vi.spyOn(f.env.ARTIFACTS, 'put').mockImplementation(async (...args: any[]) => {
    const result = await (original as any)(...args)
    if (args[0].includes('/terminal-cleanup/')) throw new Error('cleanup acknowledgement lost')
    return result
  })
  await f.store.putCompletedCleanupProof(f.state, f.cleanup)
  await f.store.putCompletedCleanupProof(f.state, f.cleanup)
  expect(put.mock.calls.filter(call => call[0].includes('/terminal-cleanup/'))).toHaveLength(1)
  await registerCompletedRunDelivery(f.state, f.env)
  f.complete(); await f.alarm()
  expect(f.errors).toEqual([])
  expect(f.lease()).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'complete' })
})
