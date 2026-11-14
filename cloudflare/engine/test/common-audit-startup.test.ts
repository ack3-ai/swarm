import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createForkStartupFixture } from './support/successor-dispatch-fixture.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { bootstrapExecution } from '../src/root-execution.js'
import { RunMachine } from '../src/machine.js'
import { stateWriter } from '../src/cloudflare-storage.js'
import { reconcileRunControls } from '../src/run-control-reconcile.js'
import { deliverStageFork } from '../src/stage-fork-delivery.js'
import { deliverRunControl } from '../src/run-control-executor.js'
import { CommandCustodyCollector } from '../src/command-custody.js'

const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))
// The completed audit is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
const fixture = () => createForkStartupFixture(close => closes.push(close), undefined, forks)

it('publishes the fork once and bootstraps its selected state using the ordinary start payload', async () => {
  const f = await fixture(), before = await f.store.getState(f.successor.runId)
  expect(f.operation.status).toBe('applied')
  expect(f.operation).not.toHaveProperty('startup')
  expect(f.payload).toEqual({ mode: 'start', experimentId: before.experimentId, runId: before.runId,
    releaseDigest: before.releaseDigest, runtimeRelease: before.runtimeRelease })
  const machine = await f.start()
  expect(machine.snapshot()).toEqual(before)
  expect((await f.start()).snapshot()).toEqual(before)
  expect(f.binding.create).not.toHaveBeenCalled()
})

it.each(['missing', 'changed'])('refuses startup when exported accepted bytes are %s', async damage => {
  const f = await fixture(), record = f.successor.artifacts[0]!, key = record.uri.slice('r2://ARTIFACTS/'.length)
  if (damage === 'missing') f.objects.delete(key)
  else await f.bucket.put(key, 'changed retained bytes', {})
  await expect(f.start()).rejects.toThrow(/artifact content/)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.binding.create).not.toHaveBeenCalled()
})

it('refuses a different runtime without changing selected state', async () => {
  const f = await fixture()
  await expect(bootstrapExecution({ ...f.payload, runtimeRelease: { ...f.payload.runtimeRelease!,
    workerVersionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, f.store, f.env)).rejects.toThrow()
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})

it('preserves a pause applied before common bootstrap, without a second startup command', async () => {
  const f = await fixture(), state = await f.store.getState(f.successor.runId)
  await f.controls.admit({ id: 'pause-before-start', action: 'pause', expectedRevision: 0,
    scope: { kind: 'audit' }, reason: 'synthetic pause' }, state.executionAuthority!)
  const machine = await RunMachine.fromState(f.release.body.definition, state,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  await reconcileRunControls({ machine, journal: f.controls, persist: await stateWriter(f.store, state),
    native: new CommandCustodyCollector(f.env) })
  const paused = await f.store.getState(state.runId)
  expect((await f.start()).snapshot()).toEqual(paused)
  expect(paused.controls!.pauses).toEqual([{ kind: 'audit' }])
  expect(paused.artifacts).toEqual(state.artifacts)
  expect(paused.modelStartedAt).toBe(state.modelStartedAt)
})

it('reports missing credentials through the ordinary failed run state and preserves the imported prefix', async () => {
  const f = await fixture()
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const machine = await f.start()
  expect(machine.view().status).toBe('failed')
  expect(machine.view().artifacts).toEqual(f.successor.artifacts)
  expect(machine.view().budget).toEqual(f.successor.budget)
  expect(machine.view().modelStartedAt).toBe(f.successor.modelStartedAt)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})

it('reconciles cancellation before Workflow creation using the same cancelled start identity', async () => {
  const f = await fixture(), before = await f.store.getState(f.successor.runId)
  await f.d1.prepare('INSERT INTO runtime_slot_control (singleton, enabled, updated_at) VALUES (1, 0, ?1)')
    .bind(new Date().toISOString()).run()
  await f.controls.admit({ id: 'cancel-before-start', action: 'cancel', expectedRevision: 0,
    scope: { kind: 'audit' }, reason: 'synthetic cancellation' }, before.executionAuthority!)
  const machine = await RunMachine.fromState(f.release.body.definition, before,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  await reconcileRunControls({ machine, journal: f.controls, persist: await stateWriter(f.store, before),
    native: new CommandCustodyCollector(f.env) })
  const cancelled = await f.store.getState(before.runId), receipt = cancelled.controls!.lastReceipt
  let exists = false, status = 'running'
  vi.mocked(f.env.AUDIT_WORKFLOW.get).mockImplementation(async id => {
    expect(id).toBe(before.runId)
    if (!exists) throw new Error('native instance unavailable')
    return { id, status: async () => ({ status }) } as any
  })
  f.binding.create.mockImplementation(async (input: any) => {
    expect(input.id).toBe(before.runId); expect(input.params).toEqual(f.payload)
    expect((await bootstrapExecution(input.params, f.store, f.env)).snapshot()).toEqual(cancelled)
    exists = true
    return { id: before.runId } as any
  })
  const marker = { schemaVersion: 1 as const, experimentId: before.experimentId, auditId: before.rootRunId,
    commandId: receipt.commandId, commandDigest: receipt.commandDigest,
    expectedRevision: receipt.revision - 1, authority: before.executionAuthority! }
  expect(await deliverRunControl(marker, f.env)).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
  status = 'complete'; expect(await deliverRunControl(marker, f.env)).toBe(true)
  expect(await f.store.getState(before.runId)).toEqual(cancelled)
  exists = false; expect(await deliverRunControl(marker, f.env)).toBe(true)
  expect(f.binding.create).toHaveBeenCalledOnce()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('delivers a published fork through ordinary dispatch and reconciles a lost create response by exact identity', async () => {
  const f = await fixture(), state = await f.store.getState(f.successor.runId)
  f.binding.create.mockRejectedValueOnce(new Error('create acknowledgement lost'))
  expect(await deliverStageFork(f.marker as any, f.env)).toBe(false)
  await f.store.recordExecutionBootstrap(state)
  expect(await deliverStageFork(f.marker as any, f.env)).toBe(true)
  expect(f.binding.create).toHaveBeenCalledOnce()
  expect(f.binding.create.mock.calls[0]![0]).toMatchObject({ id: state.runId, params: f.payload })
  expect(f.binding.get).toHaveBeenCalledWith(state.runId)
  expect(await f.store.getState(state.runId)).toEqual(state)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})


it.each(['run_runtime_routes', 'runtime_slot_run_leases'])('refuses bootstrap without its published %s', async table => {
  const f = await fixture()
  await f.d1.prepare(`DELETE FROM ${table} WHERE run_id = ?1`).bind(f.successor.runId).run()
  await expect(f.start()).rejects.toThrow(/execution publication/)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it.each(['pause', 'cancel'] as const)('a delayed readiness failure cannot overwrite a committed %s', async action => {
  const f = await fixture(), before = await f.store.getState(f.successor.runId)
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const failed = await f.start(), persistFailure = await stateWriter(f.store, before)
  expect(failed.view().status).toBe('failed')
  await f.controls.admit({ id: `${action}-during-readiness`, action, expectedRevision: 0,
    scope: { kind: 'audit' }, reason: 'synthetic concurrent control' }, before.executionAuthority!)
  const controlled = await RunMachine.fromState(f.release.body.definition, before,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  await reconcileRunControls({ machine: controlled, journal: f.controls,
    persist: await stateWriter(f.store, before), native: new CommandCustodyCollector(f.env) })
  const selected = await f.store.getState(before.runId)
  await expect(persistFailure(failed.view())).rejects.toThrow()
  expect(await f.store.getState(before.runId)).toEqual(selected)
  expect(selected.artifacts).toEqual(before.artifacts)
  expect(selected.modelStartedAt).toBe(before.modelStartedAt)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('a failed state cannot be selected before its immutable bytes are stored', async () => {
  const f = await fixture(), before = await f.store.getState(f.successor.runId)
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const failed = await f.start(), persist = await stateWriter(f.store, before)
  const put = vi.spyOn(f.bucket, 'put').mockRejectedValueOnce(new Error('archive unavailable'))
  try {
    await expect(persist(failed.view())).rejects.toThrow('archive unavailable')
    expect(await f.store.getState(before.runId)).toEqual(before)
    expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  } finally { put.mockRestore() }
  await persist(failed.view())
  expect((await f.store.getState(before.runId)).status).toBe('failed')
  expect((await f.start()).snapshot()).toEqual(failed.snapshot())
})

it('transient credential lookup errors leave the selected run and publication unchanged', async () => {
  const f = await fixture()
  f.env.ACK3_CODEX_AUTH_JSON = { get: async () => { throw new Error('temporary unavailability') } } as any
  await expect(f.start()).rejects.toThrow('temporarily unavailable')
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})
