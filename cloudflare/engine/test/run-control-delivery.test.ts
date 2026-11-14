import { memoryR2 } from './support/memory-r2.js'
import { reconcileAuditStartup } from '../src/execution-workflow.js'
import { RunCommandConflict } from '../src/run-commands.js'
import { durableStorage } from './support/durable-storage.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { CloudflareRunStore, stateWriter } from '../src/cloudflare-storage.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { RunMachine } from '../src/machine.js'
import { rootExecutionMachine, materializeRootExecution } from '../src/root-execution.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { runControlResponse } from '../src/run-control-api.js'
import { RunControlDelivery, registerDelivery, controlDeliveryRetryMs, controlDeliverySliceSize,
  type RunControlDeliveryMarker } from '../src/run-control-delivery.js'
import { assertExecutionOwner, deliverRunControl, reconcileDeliveredRunControl } from '../src/run-control-executor.js'
import { reconcileRunControls } from '../src/run-control-reconcile.js'
import { CommandCustodyCollector } from '../src/command-custody.js'
import type { Env } from '../src/env.js'
import type { RuntimeRelease } from '../src/contracts.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const closes: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-delivery', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-delivery', workflowName: 'runtime-delivery', containerImageDigest: `sha256:${'b'.repeat(64)}`,
  workerVersionId: '11111111-1111-4111-8111-111111111111' }


async function fixture(slotControlRow = true) {
  const db = sqliteD1(); closes.push(() => db.sqlite.close())
  const { bucket } = memoryR2()
  const store = new CloudflareRunStore(bucket, bucket, db.d1), release = await store.putRelease(audit0PackageBody)
  const payload = { mode: 'start' as const, runId: 'delivery-audit', experimentId: release.body.definition.id,
    releaseDigest: release.digest, runtimeRelease: runtime }
  await store.ensureSchema()
  if (slotControlRow) {
    await db.d1.prepare('INSERT INTO runtime_slot_control (singleton, enabled, updated_at) VALUES (1, 0, ?1)')
      .bind(new Date().toISOString()).run()
  }
  await store.reserveRunRoute(payload.runId, payload.experimentId, runtime)
  const state = await materializeRootExecution(payload, store), authority = state.executionAuthority!
  const { workerVersionId, ...declaration } = runtime
  const env = { ENGINE_ROLE: 'runtime', INDEX: db.d1, PACKAGES: bucket, ARTIFACTS: bucket,
    RUNTIME_RELEASE_JSON: canonicalJson(declaration), VERSION_METADATA: { id: workerVersionId },
    AGENT_SANDBOX: { getByName: vi.fn(() => { throw new Error('must not allocate models') }),
      idFromName: vi.fn(() => { throw new Error('must not allocate models') }) },
    AUDIT_WORKFLOW: { create: vi.fn(() => { throw new Error('must not start Workflow') }),
      get: vi.fn(async () => ({ id: state.runId, status: async () => ({ status: 'complete' }) })) } } as unknown as Env
  const command = { id: 'stop-startup', expectedRevision: 0, action: 'cancel', scope: { kind: 'audit' }, reason: 'synthetic stop' }
  const marker: RunControlDeliveryMarker = { schemaVersion: 1, auditId: state.rootRunId, experimentId: state.experimentId,
    commandId: command.id, commandDigest: await sha256(command), expectedRevision: 0, authority }
  const durable = durableStorage(), delivery = new RunControlDelivery(durable.storage), journal = new RunCommandJournal(db.d1, state.rootRunId)
  const api = (value = command, hook = (m: RunControlDeliveryMarker) => delivery.register(m)) => runControlResponse(
    new Request('https://internal/', { method: 'POST', body: canonicalJson(value) }), store, db.d1,
    state.experimentId, state.rootRunId, undefined, hook)
  const alarm = async (deliver = (m: RunControlDeliveryMarker) => deliverRunControl(m, env)) => {
    durable.consumeAlarm(); await delivery.alarm(deliver)
  }
  return { ...db, store, release, state, env, authority, command, marker, durable, delivery, journal, api, alarm }
}

it('retains an early empty delivery until delayed admission commits, then cancels and retires without starting a Workflow', async () => {
  const f = await fixture()
  let resume!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), delayed = new Promise<void>(resolve => { resume = resolve })
  const response = f.api(f.command, async marker => { await f.delivery.register(marker); entered(); await delayed })
  await waiting
  expect(await f.journal.get(f.command.id)).toBeNull()
  await f.alarm()
  expect(f.durable.pending()).toBe(1)
  expect(f.durable.scheduled()).not.toBeNull()
  resume(); expect((await response).status).toBe(202)
  await f.alarm()
  expect(f.durable.pending()).toBe(0); expect(f.durable.scheduled()).toBeNull()
  expect((await f.store.getState(f.state.runId)).status).toBe('stopped')
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
  expect(f.env.AUDIT_WORKFLOW.get).toHaveBeenCalledWith(f.state.runId)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('cancels and releases a catalog-only audit when the slot pool was never seeded', async () => {
  const f = await fixture(false)
  expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_slot_control').get()).toMatchObject({ n: 0 })
  expect((await f.api()).status).toBe(202)
  await f.alarm()
  expect(f.durable.pending()).toBe(0)
  expect((await f.store.getState(f.state.runId)).status).toBe('stopped')
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id=?').get(f.state.runId))
    .toMatchObject({ released_at: expect.any(String) })
})

it('uses the same durable alarm for saved-source fork markers', async () => {
  const f = await fixture(), { authority: _authority, ...identity } = f.marker
  const marker: RunControlDeliveryMarker = { ...identity, kind: 'fork',
    source: { runId: f.state.runId, state: { generation: f.state.stateGeneration, digest: await sha256(f.state) } } }
  await f.delivery.register(marker)
  const pending = vi.fn(async (value: RunControlDeliveryMarker) => { expect(value).toEqual(marker); return false })
  await f.alarm(pending)
  expect(f.durable.pending()).toBe(1)
  await f.delivery.register(marker)
  await f.alarm(async value => { expect(value).toEqual(marker); return true })
  expect(f.durable.pending()).toBe(0)
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
})

it('retains and delivers a command whose D1 admission acknowledgement was lost', async () => {
  const f = await fixture()
  f.onAfterRun(sql => { if (sql.includes('INSERT INTO audit_run_commands')) throw new Error('admission ACK lost') })
  await expect(f.api()).rejects.toThrow('admission ACK lost')
  f.onAfterRun()
  expect(f.durable.pending()).toBe(1)
  await f.alarm()
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(f.durable.pending()).toBe(0)
})

it('rearms an existing command POST, while GET is read-only', async () => {
  const f = await fixture()
  await f.journal.admit(f.command, f.authority)
  expect(f.durable.pending()).toBe(0)
  expect((await f.api()).status).toBe(202)
  expect(f.durable.pending()).toBe(1)
  const hook = vi.fn()
  await runControlResponse(new Request('https://internal/'), f.store, f.d1, f.state.experimentId, f.state.rootRunId, undefined, hook)
  expect(hook).not.toHaveBeenCalled()
  await f.alarm()
  // Applied cancellation replay also re-verifies its cleanup; never merely drops on status.
  expect((await f.api()).status).toBe(200)
  expect(f.durable.pending()).toBe(1)
  await f.alarm()
  expect(f.durable.pending()).toBe(0)
})

it('answers a command whose expectedRevision is not the current revision with 409 and no delivery marker (E18, F8)', async () => {
  const f = await fixture()
  const ahead = { ...f.command, id: 'pause-ahead', action: 'pause', expectedRevision: 3 }
  const response = await f.api(ahead)
  expect(response.status).toBe(409)
  expect(await response.json()).toEqual({ code: 'revision-conflict', error: 'audit control revision changed: 0' })
  expect(f.durable.pending()).toBe(0)
  expect(await f.journal.get(ahead.id)).toBeNull()
  // A revision that is too low gets the same answer, also without a marker.
  expect((await f.api({ ...f.command, id: 'pause-first', action: 'pause' })).status).toBe(202)
  expect(f.durable.pending()).toBe(1)
  const behind = await f.api({ ...f.command, id: 'pause-behind', action: 'pause' })
  expect(behind.status).toBe(409)
  expect(await behind.json()).toEqual({ code: 'revision-conflict', error: 'audit control revision changed: 1' })
  expect(f.durable.pending()).toBe(1)
  expect(await f.journal.get('pause-behind')).toBeNull()
})

it('does not admit a command if its marker/alarm transaction fails', async () => {
  const f = await fixture()
  await expect(f.api(f.command, async () => { throw new Error('alarm storage unavailable') })).rejects.toThrow('alarm storage unavailable')
  expect(await f.journal.get(f.command.id)).toBeNull()
})

it('proves unresolved admission impossible only against exact ID, revision and original owner', async () => {
  const f = await fixture()
  await f.delivery.register(f.marker)
  expect(await f.journal.admissionImpossible(f.command.id, 0, f.authority)).toBe(false)
  await f.journal.admit({ ...f.command, id: 'competing', action: 'pause' }, f.authority)
  expect(await f.journal.admissionImpossible(f.command.id, 0, f.authority)).toBe(true)
  await f.alarm(); expect(f.durable.pending()).toBe(0)
  // Exact ID existence wins over revision advancement: it still needs delivery.
  expect(await f.journal.admissionImpossible('competing', 0, f.authority)).toBe(false)
})

it('keeps a late committed exact command when the first journal read was empty', async () => {
  const f = await fixture()
  await f.delivery.register(f.marker)
  const get = RunCommandJournal.prototype.get
  vi.spyOn(RunCommandJournal.prototype, 'get').mockImplementationOnce(async function (id) {
    await f.journal.admit(f.command, f.authority)
    return null
  })
  await f.alarm()
  expect(f.durable.pending()).toBe(1)
  vi.spyOn(RunCommandJournal.prototype, 'get').mockImplementation(get)
  await f.alarm()
  expect(f.durable.pending()).toBe(0)
})

it('keeps an absent cancel admission while failed until its owner is fenced', async () => {
  const f = await fixture()
  await f.delivery.register(f.marker)
  const machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  await machine.fail('synthetic framework failure')
  await (await stateWriter(f.store, f.state))(machine.view())
  await f.alarm()
  expect(f.durable.pending()).toBe(1)
  await new ExecutionAuthorityStore(f.d1).fence(f.authority, 'e'.repeat(64))
  await f.alarm()
  expect(f.durable.pending()).toBe(0)
  await expect(f.journal.admit(f.command, f.authority)).rejects.toThrow('execution changed')
})

it('delivers a delayed failed-state cancel after an empty alarm without reviving execution', async () => {
  const f = await fixture(), machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  await machine.fail('synthetic failure before command admission')
  await (await stateWriter(f.store, f.state))(machine.view())
  let resume!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve }), delayed = new Promise<void>(resolve => { resume = resolve })
  const response = f.api(f.command, async marker => { await f.delivery.register(marker); entered(); await delayed })
  await waiting; await f.alarm()
  expect(f.durable.pending()).toBe(1)
  expect((await f.store.getState(f.state.runId)).status).toBe('failed')
  resume(); expect((await response).status).toBe(202)
  await f.alarm()
  const stopped = await f.store.getState(f.state.runId)
  expect(stopped.status).toBe('stopped')
  expect(stopped.journal.slice(0, machine.view().journal.length)).toEqual(machine.view().journal)
  expect(stopped.modelStartedAt).toBeNull()
  expect(f.durable.pending()).toBe(0)
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it.each(['none', 'rejection', 'cancellation'] as const)(
  'settles a queued refusal before failed-state cancellation with %s lost state acknowledgement', async lost => {
    const f = await fixture()
    const pause = { ...f.command, id: 'pause-before-failure', action: 'pause' }
    expect((await f.api(pause)).status).toBe(202)
    const machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
    await machine.fail('synthetic framework failure after admission')
    await (await stateWriter(f.store, f.state))(machine.view())
    const failed = machine.snapshot()
    expect((await f.api({ ...f.command, expectedRevision: 1 })).status).toBe(202)
    const putState = CloudflareRunStore.prototype.putState
    let injected = false
    vi.spyOn(CloudflareRunStore.prototype, 'putState').mockImplementation(async function (this: CloudflareRunStore, ...args) {
      const result = await putState.apply(this, args)
      const state = args[0]
      if (!injected && (lost === 'rejection' && state.status === 'failed' && state.controls?.revision === 1
        || lost === 'cancellation' && state.status === 'stopped')) {
        injected = true; throw new Error('state acknowledgement lost')
      }
      return result
    })
    for (let attempt = 0; attempt < 3 && f.durable.pending() > 0; attempt++) {
      expect(f.durable.scheduled()).not.toBeNull()
      await f.alarm()
    }
    const stopped = await f.store.getState(f.state.runId)
    expect(injected).toBe(lost !== 'none')
    expect(stopped.status).toBe('stopped')
    expect(stopped.controls?.revision).toBe(2)
    expect(stopped.controls?.pauses).toEqual([])
    expect(stopped.journal.slice(0, failed.journal.length)).toEqual(failed.journal)
    expect(stopped.journal.filter(event => event.type === 'run.control-settled')).toHaveLength(2)
    expect(stopped.journal.filter(event => event.type === 'run.cancelled')).toHaveLength(1)
    expect(stopped.budget).toEqual(failed.budget)
    expect((await f.journal.get(pause.id))!.status).toBe('rejected')
    expect((await f.journal.get(f.command.id))!.status).toBe('applied')
    expect(f.durable.pending()).toBe(0)
    expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
    expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
    expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  })

it.each(['pause', 'continue', 'amend', 'restart'])(
  'refuses new %s commands after framework failure', async action => {
    const f = await fixture(), machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
    await machine.fail('synthetic terminal failure')
    await (await stateWriter(f.store, f.state))(machine.view())
    const command = { ...f.command, action,
      ...(action === 'amend' ? { releaseDigest: f.release.digest, admittedWork: 'drain' } : {}),
      ...(action === 'restart' ? { scope: { kind: 'tasks', taskIds: ['synthetic-task'] }, session: 'fresh' } : {}) }
    if (action === 'amend') delete (command as any).scope
    const response = await f.api(command as typeof f.command)
    expect(response.status).toBe(action === 'amend' || action === 'restart' ? 400 : 409)
    expect(f.durable.pending()).toBe(0)
    expect(await f.journal.get(command.id)).toBeNull()
    expect(await f.store.getState(f.state.runId)).toEqual(machine.view())
  })

it('keeps cancellation delivery after applied-state acknowledgement until retirement is verified', async () => {
  const f = await fixture(); await f.api()
  const retire = ExecutionAuthorityStore.prototype.retire
  vi.spyOn(ExecutionAuthorityStore.prototype, 'retire').mockRejectedValueOnce(new Error('retirement unavailable'))
  await f.alarm()
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('fenced')
  expect(f.durable.pending()).toBe(1)
  vi.spyOn(ExecutionAuthorityStore.prototype, 'retire').mockImplementation(retire)
  await f.alarm()
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
  expect(f.durable.pending()).toBe(0)
})

it('recovers lost cleanup acknowledgement without duplicating a terminal effect', async () => {
  const f = await fixture(); await f.api()
  const retire = ExecutionAuthorityStore.prototype.retire
  vi.spyOn(ExecutionAuthorityStore.prototype, 'retire').mockImplementationOnce(async function (this: ExecutionAuthorityStore, ...args) {
    await retire.apply(this, args); throw new Error('retirement ACK lost')
  })
  await f.alarm()
  const state = await f.store.getState(f.state.runId)
  expect(f.durable.pending()).toBe(1)
  await f.alarm()
  expect(f.durable.pending()).toBe(0)
  expect(await f.store.getState(f.state.runId)).toEqual(state)
})

it('Workflow and delivery collide on the same cancellation without losing state or issuing model calls', async () => {
  const f = await fixture(); await f.api()
  const machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  await Promise.allSettled([f.alarm(), reconcileRunControls({ machine, journal: f.journal,
    persist: await stateWriter(f.store, f.state), native: new CommandCustodyCollector(f.env) })])
  await f.alarm()
  const state = await f.store.getState(f.state.runId)
  expect(state.status).toBe('stopped')
  expect(state.journal.filter(event => event.type === 'run.cancelled')).toHaveLength(1)
  expect(state.modelStartedAt).toBeNull()
  expect(state.artifacts).toEqual(f.state.artifacts)
  expect(f.durable.pending()).toBe(0)
})

it('refuses another local runtime without changing command or audit state', async () => {
  const f = await fixture(); await f.api()
  const env = { ...f.env, VERSION_METADATA: { id: '22222222-2222-4222-8222-222222222222' } } as Env
  await expect(reconcileDeliveredRunControl(f.marker, env)).rejects.toThrow('runtime identity differs')
  await f.alarm(marker => deliverRunControl(marker, env))
  expect(f.durable.pending()).toBe(1)
  expect(await f.store.getState(f.state.runId)).toEqual(f.state)
  expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
})

it('does not clear another POST registered while an alarm finishes its old page', async () => {
  const f = await fixture(); await f.delivery.register(f.marker)
  const next = { ...f.marker, commandId: 'next-command', commandDigest: 'd'.repeat(64) }
  await f.alarm(async () => { await f.delivery.register(next); return true })
  expect(f.durable.pending()).toBe(1)
  expect(f.durable.values()).toContainEqual(next)
  expect(f.durable.scheduled()!).toBeLessThanOrEqual(Date.now() + 1)
})

it('rotates bounded pages and preserves uncertain deliveries without aging them out', async () => {
  vi.useFakeTimers()
  const f = await fixture()
  const markers = Array.from({ length: controlDeliverySliceSize + 2 }, (_, n) => ({ ...f.marker,
    auditId: `audit-${String(n).padStart(3, '0')}`, authority: { ...f.authority, auditId: `audit-${String(n).padStart(3, '0')}` } }))
  for (const marker of markers) await f.delivery.register(marker)
  const first = vi.fn(async () => false)
  await f.alarm(first); expect(first).toHaveBeenCalledTimes(controlDeliverySliceSize)
  expect(f.durable.scheduled()).toBe(Date.now() + controlDeliveryRetryMs)
  const next = vi.fn(async (_marker: RunControlDeliveryMarker) => false)
  await f.alarm(next); expect(next).toHaveBeenCalledTimes(2)
  expect(next.mock.calls.map(([marker]) => marker.auditId)).toEqual(markers.slice(controlDeliverySliceSize).map(marker => marker.auditId))
  await vi.advanceTimersByTimeAsync(365 * 86400_000)
  await f.alarm(async () => false)
  expect(f.durable.pending()).toBe(markers.length)
})

it.each(['execution', 'fork'] as const)('keeps slow %s delivery attached while other audits settle', async kind => {
  vi.useFakeTimers()
  const f = await fixture(), { authority: _authority, ...identity } = f.marker
  const marker: RunControlDeliveryMarker = kind === 'execution' ? f.marker : { ...identity, kind: 'fork',
    source: { runId: f.state.runId, state: { generation: f.state.stateGeneration, digest: await sha256(f.state) } } }
  const other = { ...f.marker, commandId: 'other-command' }
  await f.delivery.register(marker); await f.delivery.register(other)
  let finish!: (value: boolean) => void, returned = false
  const pending = new Promise<boolean>(resolve => { finish = resolve })
  const deliver = vi.fn((value: RunControlDeliveryMarker) => value.commandId === marker.commandId ? pending : Promise.resolve(true))
  const firing = f.alarm(deliver).then(() => { returned = true })
  await vi.advanceTimersByTimeAsync(2 * controlDeliveryRetryMs)
  expect(returned).toBe(false)
  expect(f.durable.pending()).toBe(1)
  expect(f.durable.values()).toContainEqual(marker)
  expect(f.durable.values()).not.toContainEqual(other)
  expect(f.durable.scheduled()).not.toBeNull()
  finish(true); await firing
  expect(deliver).toHaveBeenCalledTimes(2)
  expect(f.durable.pending()).toBe(0)
  expect(f.durable.scheduled()).toBeNull()
})

it('rejects marker identity reuse and inline configuration without touching admission', async () => {
  const f = await fixture()
  await f.delivery.register(f.marker)
  await expect(f.delivery.register({ ...f.marker, commandDigest: 'f'.repeat(64) })).rejects.toThrow('different content')
  await expect(f.delivery.register({ ...f.marker, models: [] } as any)).rejects.toThrow('invalid command delivery')
  expect(await f.journal.get(f.command.id)).toBeNull()
})

it('wires POST and the actual coordinator alarm through the pinned runtime route, never latest', async () => {
  const f = await fixture(), { workerVersionId: _version, ...declaration } = runtime
  const newer = { ...declaration, id: 'runtime-newer', workerService: 'runtime-newer', workflowName: 'runtime-newer' }
  const runtimeSource = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const runtimeCode = stripTypeScriptTypes(runtimeSource.slice(runtimeSource.indexOf('export async function runtimeServiceRoute('))
    .replace('export async', 'async'))
  const runtimeRoute = new Function('engineRole', 'reconcileDeliveredRunControl', 'response',
    `${runtimeCode}; return runtimeServiceRoute;`)((env: Env) => env.ENGINE_ROLE, reconcileDeliveredRunControl,
    (_env: Env, value: unknown, status = 200) => Response.json(value, { status,
      headers: { 'x-ack3-runtime-worker-version': runtime.workerVersionId } }))
  const pinned = vi.fn(async (url: string, init: RequestInit) => runtimeRoute(new Request(url, init), f.env))
  const latest = vi.fn(() => { throw new Error('must not select latest') })
  const env = { ...f.env, ENGINE_ROLE: 'front-door', RUNTIME_PINNED: { fetch: pinned }, RUNTIME_NEWER: { fetch: latest },
    RUNTIME_CATALOG_JSON: canonicalJson({ schemaVersion: 1, latest: newer.id, releases: {
      [runtime.id]: { ...declaration, binding: 'RUNTIME_PINNED' }, [newer.id]: { ...newer, binding: 'RUNTIME_NEWER' },
    } }) } as unknown as Env
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class ExperimentCoordinator'),
    source.indexOf('function sameCursor')).replace('export class', 'class'))
  const dependencies = { DurableObject: class { ctx = { storage: f.durable.storage }; env = env },
    CloudflareRunStore, RunControlDelivery, runControlResponse, deliverRunControl,
    json: (value: unknown, status = 200) => Response.json(value, { status }) }
  const Coordinator = new Function(...Object.keys(dependencies), `${code}; return ExperimentCoordinator;`)(...Object.values(dependencies))
  const coordinator = new Coordinator()
  const request = () => new Request(`https://internal/audits/${f.state.rootRunId}/commands`, {
    method: 'POST', headers: { 'x-ack3-experiment': f.state.experimentId }, body: canonicalJson(f.command) })
  expect((await coordinator.fetch(request())).status).toBe(202)
  expect(f.durable.pending()).toBe(1)
  f.durable.consumeAlarm(); await coordinator.alarm()
  expect(f.durable.pending()).toBe(0)
  expect((await f.store.getState(f.state.runId)).status).toBe('stopped')
  expect(pinned).toHaveBeenCalledOnce(); expect(latest).not.toHaveBeenCalled()
  expect(pinned.mock.calls[0]![0]).toBe('https://runtime.internal/internal/runtime/audit-controls/reconcile')
  expect(JSON.parse(pinned.mock.calls[0]![1].body as string)).toEqual(f.marker)
})

it('keeps an old queued command on its original owner when a historical successor exists', async () => {
  const f = await fixture(); await f.api()
  const authorities = new ExecutionAuthorityStore(f.d1)
  await authorities.fence(f.authority, 'a'.repeat(64))
  await authorities.retire(f.authority, 'b'.repeat(64))
  // Seed a historical successor; direct non-root activation is forbidden.
  const successor = { ...f.authority, epoch: 1, executionId: 'replacement-executor' }
  await f.d1.prepare(`INSERT INTO audit_execution_authority
    (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at)
    VALUES (?1, 1, ?2, ?3, ?4, 'active', ?5)`)
    .bind(successor.auditId, successor.executionId, canonicalJson(successor), 'c'.repeat(64), new Date().toISOString()).run()
  await expect(assertExecutionOwner(f.state, f.env)).rejects.toThrow('historical app version')
  await expect(reconcileDeliveredRunControl(f.marker, f.env)).rejects.toThrow('command delivery cannot change execution owner')
  await f.alarm()
  expect(f.durable.pending()).toBe(1)
  expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
  expect(await f.store.getState(f.state.runId)).toEqual(f.state)
  expect(f.env.AUDIT_WORKFLOW.get).not.toHaveBeenCalled()
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})


it.each(['running', 'failed'] as const)('refuses a fabricated cancellation of %s work without a recorded native intent', async status => {
  const f = await fixture(), machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  if (status === 'failed') {
    await machine.fail('synthetic preserved failure')
    await (await stateWriter(f.store, f.state))(machine.view())
  }
  const before = machine.snapshot()
  await f.journal.admit(f.command, f.authority)
  const operation = await f.journal.beginEffect(f.command.id, 1, before)
  const proof = { inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
  await machine.cancelAudit({ ...operation, nativeEffect: { kind: 'revoke-admission', inventoryDigest: proof.inventoryDigest } }, proof)
  await expect((await stateWriter(f.store, before))(machine.view())).rejects.toThrow()
  expect(await f.store.getState(f.state.runId)).toEqual(before)
  expect((await f.journal.get(f.command.id))!.nativeEffect).toBeUndefined()
})

it('refuses a coherent cancellation built from a different failed predecessor', async () => {
  const f = await fixture(), machine = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  await machine.fail('selected failure')
  await (await stateWriter(f.store, f.state))(machine.view())
  const before = machine.snapshot()
  await f.journal.admit(f.command, f.authority)
  const operation = await f.journal.beginEffect(f.command.id, 1, before)
  const alternate = await RunMachine.fromState(f.release.body.definition, f.state, undefined, f.store.executionSources())
  await alternate.fail('different failure')
  const proof = { inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
  await alternate.cancelAudit({ ...operation, source: { authority: f.authority,
    state: { generation: alternate.view().stateGeneration, digest: await sha256(alternate.view()) } },
    nativeEffect: { kind: 'revoke-admission', inventoryDigest: proof.inventoryDigest } }, proof)
  await expect((await stateWriter(f.store, before))(alternate.view())).rejects.toThrow('exact predecessor')
  expect(await f.store.getState(f.state.runId)).toEqual(before)
})


it.each(['complete', 'errored', 'terminated'])('keeps cancellation delivery until native %s and releases without GET', async terminal => {
  const f = await fixture()
  const status = vi.fn(async () => ({ status: 'running' }))
  vi.mocked(f.env.AUDIT_WORKFLOW.get).mockResolvedValue({ id: f.state.runId, status } as any)
  const lease = () => f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id=?').get(f.state.runId)
  await f.api(); await f.alarm()
  expect((await f.journal.get(f.command.id))?.status).toBe('applied')
  expect(f.durable.pending()).toBe(1); expect(lease()).toMatchObject({ released_at: null })
  status.mockResolvedValue({ status: terminal })
  await f.alarm()
  expect(f.durable.pending()).toBe(0); expect(lease()).toMatchObject({ released_at: expect.any(String) })
  expect(await f.store.retiredRunWorkflow(f.state.runId)).toMatchObject({ workflow: { status: terminal }, disposition: 'terminal' })
  expect(f.env.AUDIT_WORKFLOW.create).not.toHaveBeenCalled()
})

it('does not treat unavailable native Workflow evidence as terminal', async () => {
  const f = await fixture()
  vi.mocked(f.env.AUDIT_WORKFLOW.get).mockRejectedValue(new Error('observation unavailable'))
  await f.api(); await f.alarm()
  expect(f.durable.pending()).toBe(1)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: null })
  expect(await f.store.retiredRunWorkflow(f.state.runId)).toBeNull()
})

it('reconciles cancellation archive ACK loss and serves stopped retirement through the actual GET route', async () => {
  const f = await fixture(); await f.api()
  let lost = false
  f.onAfterRun(sql => { if (!lost && sql.includes('INSERT INTO retired_runtime_runs')) { lost = true; throw new Error('archive ACK lost') } })
  await f.alarm(); expect(lost).toBe(true); expect(f.durable.pending()).toBe(1)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: null })
  f.onAfterRun(); await f.alarm(); expect(f.durable.pending()).toBe(0)
  const completed = vi.spyOn(f.store, 'archiveCompletedRunAndReleaseLease')
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = source.indexOf("      if (request.method === 'GET' && runMatch !== undefined)")
  const end = source.indexOf("      return json({ error: 'not found' }, 404)", start)
  const handler = new Function('store', 'engineRole', 'json',
    stripTypeScriptTypes(`async function handle(request, env, runMatch) { ${source.slice(start, end)} }`) + '\nreturn handle;')(
    f.store, () => 'front-door', (body: unknown, status = 200) => Response.json(body, { status }))
  const response = await handler(new Request('https://internal/v1/runs/' + f.state.runId), f.env, f.state.runId)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ state: { status: 'stopped' }, retirement: { disposition: 'terminal' } })
  expect(completed).not.toHaveBeenCalled()
})

it('retains a cancelled lease if its route changes between archive and release', async () => {
  const f = await fixture(); await f.api()
  f.onAfterRun(sql => { if (sql.includes('INSERT INTO retired_runtime_runs')) {
    f.sqlite.prepare('UPDATE run_runtime_routes SET runtime_release_json=? WHERE run_id=?')
      .run(canonicalJson({ ...runtime, workerVersionId: '22222222-2222-4222-8222-222222222222' }), f.state.runId)
  } })
  await f.alarm(); expect(f.durable.pending()).toBe(1)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: null })
})


it('ensures only the original Workflow when cancellation wins before native creation, never after retirement', async () => {
  const f = await fixture()
  let exists = false, status = 'running'
  const get = vi.mocked(f.env.AUDIT_WORKFLOW.get).mockImplementation(async id => {
    expect(id).toBe(f.state.runId)
    if (!exists) throw new Error('native instance unavailable')
    return { id, status: async () => ({ status }) } as any
  })
  const create = vi.mocked(f.env.AUDIT_WORKFLOW.create).mockImplementation(async input => {
    if (input === undefined) throw new Error('missing Workflow input')
    expect(input.id).toBe(f.state.runId)
    expect(input.params).toEqual({ mode: 'start', runId: f.state.runId, experimentId: f.state.experimentId,
      releaseDigest: f.release.digest, runtimeRelease: runtime })
    const machine = await rootExecutionMachine(input.params!, f.store)
    await machine.start()
    expect(machine.view().status).toBe('stopped')
    expect(machine.view().modelStartedAt).toBeNull()
    exists = true
    return { id: input.id } as any
  })
  await f.api(); await f.alarm()
  expect(create).toHaveBeenCalledOnce(); expect(f.durable.pending()).toBe(1)
  const stopped = await f.store.getState(f.state.runId)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: null })
  status = 'complete'; await f.alarm()
  expect(f.durable.pending()).toBe(0)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: expect.any(String) })
  exists = false // Native retention expired; the durable archive remains authoritative.
  get.mockClear(); await f.delivery.register(f.marker); await f.alarm()
  expect(f.durable.pending()).toBe(0); expect(create).toHaveBeenCalledOnce(); expect(get).not.toHaveBeenCalled()
  expect(await f.store.getState(f.state.runId)).toEqual(stopped)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

// Current delivery refuses historical replacement envelopes without routing or mutation.
it.each([{ released: false, started: false }, { released: true, started: false }, { released: true, started: true }])(
  'refuses historical restart with released=$released, started=$started', async ({ released, started }) => {
  const f = await fixture(), destination = { ...runtime, id: 'runtime-old-target', workerService: 'runtime-old-target',
    workflowName: 'runtime-old-target', workerVersionId: '22222222-2222-4222-8222-222222222222' }
  const command = { ...f.command, action: 'restart', session: 'fresh', runtimeRelease: destination }
  const digest = await sha256(command), authority = { auditId: f.state.rootRunId,
    executionId: `exec-${(await sha256({ source: f.authority, commandDigest: digest })).slice(0, 48)}`,
    epoch: 1, runtimeDigest: await sha256(destination) }
  const at = f.state.updatedAt, operation = { auditId: f.state.rootRunId, revision: 1, version: 1,
    command, commandDigest: digest, admittedAuthority: f.authority, status: 'applying', acceptedAt: at, updatedAt: at,
    source: { authority: f.authority, state: { generation: f.state.stateGeneration, digest: await sha256(f.state) } },
    target: { authority, runtimeRelease: destination, experimentId: f.state.experimentId },
    prepared: { authority, state: { generation: 1, digest: 'c'.repeat(64) }, activatedAt: at },
    nativeEffect: { kind: 'revoke-admission', inventoryDigest: 'd'.repeat(64) },
    ...(started ? { status: 'applied', receiptDigest: 'e'.repeat(64),
      startup: { status: 'started', state: { generation: 2, digest: 'b'.repeat(64) }, at } } : {}) }
  f.sqlite.prepare('INSERT INTO audit_run_commands VALUES (?, ?, ?, ?, ?, ?)')
    .run(operation.auditId, 1, command.id, 1, canonicalJson(operation), await sha256(operation))
  await f.store.reserveRunRoute(authority.executionId, f.state.experimentId, destination)
  f.sqlite.prepare(`INSERT INTO audit_execution_authority
    (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at) VALUES (?,1,?,?,?,'active',?)`)
    .run(authority.auditId, authority.executionId, canonicalJson(authority), digest, at)
  f.sqlite.prepare(`INSERT INTO experiment_runs
    (run_id,experiment_id,status,state_key,state_generation,updated_at) VALUES (?,?,'running','historical-state-not-loaded',1,?)`)
    .run(authority.executionId, f.state.experimentId, at)
  if (released) f.sqlite.prepare('UPDATE runtime_slot_run_leases SET released_at=? WHERE run_id=?').run(at, authority.executionId)
  const marker = { ...f.marker, commandDigest: digest }
  const target = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ markerDigest: await sha256(marker), settled: true },
    { headers: { 'x-ack3-runtime-worker-version': destination.workerVersionId } }))
  const original = vi.fn(() => { throw new Error('activated replacement must use target') })
  const { workerVersionId: _targetVersion, ...targetDeclaration } = destination
  const { workerVersionId: _sourceVersion, ...sourceDeclaration } = runtime
  const env = { ...f.env, ENGINE_ROLE: 'front-door', RUNTIME_SOURCE: { fetch: original }, RUNTIME_TARGET: { fetch: target },
    RUNTIME_CATALOG_JSON: canonicalJson({ schemaVersion: 1, latest: runtime.id, releases: {
      [runtime.id]: { ...sourceDeclaration, binding: 'RUNTIME_SOURCE' },
      [destination.id]: { ...targetDeclaration, binding: 'RUNTIME_TARGET' },
    } }) } as unknown as Env
  await expect(deliverRunControl(marker, env)).rejects.toThrow('command journal integrity failed')
  await expect(reconcileDeliveredRunControl(marker, f.env)).rejects.toThrow('command journal integrity failed')
  expect(target).not.toHaveBeenCalled(); expect(original).not.toHaveBeenCalled()
  const saved = f.sqlite.prepare('SELECT operation_json FROM audit_run_commands WHERE command_id=?').get(command.id) as { operation_json: string }
  expect(JSON.parse(saved.operation_json)).toEqual(operation)
})

it('loads the pinned audit once when forwarding a command, without reconstructing a second owner', async () => {
  const f = await fixture(), { workerVersionId: _, ...declaration } = runtime
  await f.api()
  const fetch = vi.fn(async () => new Response(canonicalJson({ markerDigest: await sha256(f.marker), settled: false }),
    { headers: { 'content-type': 'application/json', 'x-ack3-runtime-worker-version': runtime.workerVersionId } }))
  const env = { ...f.env, ENGINE_ROLE: 'front-door', RUNTIME_PINNED: { fetch },
    RUNTIME_CATALOG_JSON: canonicalJson({ schemaVersion: 1, latest: runtime.id,
      releases: { [runtime.id]: { ...declaration, binding: 'RUNTIME_PINNED' } } }) } as unknown as Env
  const read = vi.spyOn(CloudflareRunStore.prototype, 'getState')
  expect(await deliverRunControl(f.marker, env)).toBe(false)
  expect(read).toHaveBeenCalledExactlyOnceWith(f.state.runId)
  expect(fetch).toHaveBeenCalledOnce()
  expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
})

it('rejects an unowned current Workflow before reading or mutating storage', async () => {
  const f = await fixture(), state = structuredClone(f.state)
  // @ts-expect-error Deliberately remove required ownership to test rejection.
  delete state.executionAuthority
  const prepare = vi.fn(() => { throw new Error('unexpected storage access') })
  await expect(assertExecutionOwner(state, { INDEX: { prepare } } as any)).rejects.toThrow('historical app version')
  expect(prepare).not.toHaveBeenCalled()
})

async function launchCoordinatorFixture() {
  const f = await fixture()
  const storage = Object.assign(f.durable.storage, {
    get: (key: string) => f.durable.storage.transaction(tx => tx.get(key)),
  })
  const dispatch = vi.fn<(...args: unknown[]) => Promise<string>>()
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class ExperimentCoordinator'),
    source.indexOf('function sameCursor')).replace('export class', 'class'))
  const dependencies = { DurableObject: class { ctx = { storage, id: { toString: () => 'coordinator' } }; env = f.env },
    CloudflareRunStore, RunControlDelivery, registerDelivery, canonicalJson, sha256, deliverRunControl, RunCommandConflict, dispatchAuditWorkflow: dispatch, reconcileAuditStartup }
  const Coordinator = new Function(...Object.keys(dependencies), `${code}; return ExperimentCoordinator;`)(...Object.values(dependencies))
  const coordinator = new Coordinator()
  const identity = { runId: f.state.runId }
  const provenance = { mode: 'start', releaseDigest: f.release.digest, runtimeRelease: runtime }
  await coordinator.reserveRunId(f.state.runId, identity, provenance)
  return { ...f, coordinator, dispatch, identity, provenance }
}

it('atomically admits root launch delivery and retries the exact destination after a lost dispatch response', async () => {
  const f = await launchCoordinatorFixture()
  vi.mocked(f.env.AUDIT_WORKFLOW.get).mockResolvedValue({ id: f.state.runId, status: async () => ({ status: 'running' }) } as any)
  expect(f.durable.pending()).toBe(1)
  expect(f.durable.scheduled()).not.toBeNull()
  f.dispatch.mockRejectedValueOnce(new Error('lost dispatch acknowledgement')).mockResolvedValue(f.state.runId)
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.durable.pending()).toBe(1)
  expect(f.durable.scheduled()).not.toBeNull()
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.durable.pending()).toBe(1)
  await f.store.recordExecutionBootstrap(await f.store.getState(f.state.runId))
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.durable.pending()).toBe(0)
  expect(f.dispatch).toHaveBeenCalledTimes(2)
  expect(f.dispatch.mock.calls[0]).toEqual(f.dispatch.mock.calls[1])
  expect(f.dispatch.mock.calls[0]![1]).toEqual({ mode: 'start', runId: f.state.runId,
    experimentId: f.state.experimentId, releaseDigest: f.release.digest, runtimeRelease: runtime })
  expect((await f.coordinator.reservationFor(f.state.runId, f.identity)).workflowInstanceId).toBe(f.state.runId)
})

it('settles queued launch through the existing cancellation custody path without dispatch', async () => {
  const f = await launchCoordinatorFixture()
  await f.api()
  vi.mocked(f.env.AUDIT_WORKFLOW.get).mockRejectedValueOnce(new Error('Workflow not materialized'))
  vi.mocked(f.env.AUDIT_WORKFLOW.create).mockResolvedValue({ id: f.state.runId } as WorkflowInstance)
  // Cancellation may ensure the same cancelled Workflow solely for terminal cleanup.
  await deliverRunControl(f.marker, f.env)
  expect((await f.store.getState(f.state.runId)).status).toBe('stopped')
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(f.durable.pending()).toBe(0)
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
  await deliverRunControl(f.marker, f.env)
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.env.AUDIT_WORKFLOW.create).toHaveBeenCalledOnce()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('keeps launch delivery distinct from an operator command named launch', async () => {
  const f = await launchCoordinatorFixture()
  await f.delivery.register({ ...f.marker, commandId: 'launch' })
  expect(f.durable.pending()).toBe(2)
})

it('settles a proven route collision as an observable refusal without retrying or dispatching', async () => {
  const f = await launchCoordinatorFixture()
  await f.d1.prepare('UPDATE run_runtime_routes SET experiment_id = ?1 WHERE run_id = ?2')
    .bind('other-experiment', f.state.runId).run()
  f.durable.consumeAlarm(); await f.coordinator.alarm()
  expect(f.dispatch).not.toHaveBeenCalled()
  expect(f.durable.pending()).toBe(0)
  await expect(f.coordinator.reservationFor(f.state.runId, f.identity)).rejects.toThrow('run already exists with different routing')
  expect((await f.store.getState(f.state.runId)).artifacts).toEqual(f.state.artifacts)
})
