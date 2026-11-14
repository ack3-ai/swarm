import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { RunMachine } from '../src/machine.js'
import { loadPreparedStageFork } from '../src/stage-fork-command.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { target, runtime } from './support/successor-fixture.js'

const closes: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// Built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
async function fixture(controlled = true) {
  const f = await forks.restore(fn => closes.push(fn))
  const operation = await f.admit(), child = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  return { ...f, operation, child, activate: () => f.store.activatePreparedExecution(f.auditId, f.command.id, target),
    publication: () => f.publication(child.runId), owners: new ExecutionAuthorityStore(f.d1) }
}
const absent = { audit_execution_authority: 0, experiment_runs: 0, run_runtime_routes: 0, runtime_slot_run_leases: 0 }
const present = { audit_execution_authority: 1, experiment_runs: 1, run_runtime_routes: 1, runtime_slot_run_leases: 1 }

it.each([true])('publishes only the new fork with independent child execution authority (controlled source=%s)', async controlled => {
  const f = await fixture(controlled), source = canonicalJson(await f.store.getState(f.source.runId))
  expect(f.publication()).toEqual(absent)
  const activated = await f.activate()
  expect(activated).toMatchObject({ status: 'applied', version: 2, prepared: f.operation.prepared! })
  expect(activated.prepared!.activatedAt).toBeTypeOf('string')
  expect(f.publication()).toEqual(present)
  expect(await f.store.getState(f.child.runId)).toEqual(f.child)
  expect(await f.owners.current(f.child.runId)).toEqual(f.child.executionAuthority)
  expect((await f.store.runRuntime(f.child.runId))!).toEqual(target)
  expect(await f.store.getCheckpoint(f.child.checkpoints[0]!.digest)).toEqual(f.child.checkpoints[0])
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(source)
  expect(f.child.controls).toBeUndefined()
  await expect(f.owners.admitLaunch(f.child.executionAuthority!, 'synthetic-task', 'a'.repeat(64), f.operation.prepared!.state))
    .resolves.toBe(true)
  expect(await f.owners.pendingLaunches(f.child.executionAuthority!)).toHaveLength(1)
}, 60_000)

it('refuses a previous native claim after the child authority is fenced', async () => {
  const f = await fixture(); await f.activate()
  await f.owners.fence(f.child.executionAuthority!, 'b'.repeat(64))
  f.sqlite.prepare('INSERT INTO audit_execution_launches (audit_id, epoch, task_execution_id, request_digest, admitted_at) VALUES (?, 0, ?, ?, ?)')
    .run(f.child.runId, 'synthetic-late-task', 'a'.repeat(64), f.child.updatedAt)
  await expect(f.owners.admitLaunch(f.child.executionAuthority!, 'synthetic-late-task', 'a'.repeat(64), f.operation.prepared!.state))
    .rejects.toThrow('no active execution authority')
}, 60_000)

it.each(['slot-rotating', 'slot-changed', 'state', 'owner', 'route', 'lease'])
  ('publishes no sibling state if activation loses to %s', async change => {
    const f = await fixture()
    f.sqlite.prepare('INSERT INTO runtime_slot_control (singleton, enabled, latest_slot_id, updated_at) VALUES (1, 1, ?, ?)').run(target.id, f.child.updatedAt)
    f.sqlite.prepare('INSERT INTO runtime_slots (slot_id, runtime_release_json, generation, deployed_at) VALUES (?, ?, 1, ?)').run(target.id, canonicalJson(target), f.child.updatedAt)
    if (change === 'slot-rotating') f.sqlite.prepare('UPDATE runtime_slot_control SET rotating_slot_id = ?').run(target.id)
    if (change === 'slot-changed') f.sqlite.prepare('UPDATE runtime_slots SET runtime_release_json = ?').run(canonicalJson(runtime))
    if (change === 'state') f.sqlite.prepare("INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, updated_at) VALUES (?, ?, 'running', 'other', 1, ?)")
      .run(f.child.runId, f.child.experimentId, f.child.updatedAt)
    if (change === 'owner') await f.store.activateRootExecution(f.child.runId, target, { unrelatedStart: true })
    if (change === 'route') f.sqlite.prepare('INSERT INTO run_runtime_routes VALUES (?, ?, ?, ?)').run(f.child.runId, f.child.experimentId, canonicalJson(target), f.child.updatedAt)
    if (change === 'lease') f.sqlite.prepare('INSERT INTO runtime_slot_run_leases (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled) VALUES (?, ?, ?, ?, ?, 1)')
      .run(f.child.runId, f.child.experimentId, target.id, canonicalJson(target), f.child.updatedAt)
    const before = f.publication()
    await expect(f.activate()).rejects.toThrow('lost its operation or destination')
    expect(f.publication()).toEqual(before)
    expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
  }, 60_000)

it.each(['audit_execution_authority', 'experiment_runs', 'run_runtime_routes', 'runtime_slot_run_leases'])
  ('rolls back the command witness and all siblings when %s insertion fails', async table => {
    const f = await fixture()
    f.sqlite.exec(`CREATE TRIGGER abort_fork BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic insertion fault'); END`)
    await expect(f.activate()).rejects.toThrow('synthetic insertion fault')
    expect(f.publication()).toEqual(absent)
    expect(await f.journal.get(f.command.id)).toEqual(f.operation)
    f.sqlite.exec('DROP TRIGGER abort_fork')
    expect((await f.activate()).prepared!.activatedAt).toBeTypeOf('string')
    expect(f.publication()).toEqual(present)
  }, 60_000)

it('adopts a committed activation whose response was lost, including concurrent duplicate requests', async () => {
  const f = await fixture(), batch = f.d1.batch.bind(f.d1)
  let lost = true
  vi.spyOn(f.d1, 'batch').mockImplementation(async statements => {
    const result = await batch(statements)
    if (lost) { lost = false; throw new Error('activation response lost') }
    return result
  })
  const [one, two] = await Promise.all([f.activate(), f.activate()])
  expect(one).toEqual(two)
  expect(f.publication()).toEqual(present)
  expect(await f.journal.get(f.command.id)).toEqual(one)
  expect(await f.store.getState(f.child.runId)).toEqual(f.child)
}, 60_000)

it('replays activation after child failure, retirement and lease release without reopening it', async () => {
  const f = await fixture(), batch = f.d1.batch.bind(f.d1)
  let stale: D1PreparedStatement[] | undefined
  vi.spyOn(f.d1, 'batch').mockImplementation(async statements => { stale = statements; return batch(statements) })
  const activated = await f.activate()
  const machine = await RunMachine.fromState((await f.loadRelease(f.child.releaseDigest)).body.definition, f.child, f.loadRelease, f.loadState)
  await machine.fail('synthetic failure before startup')
  const failed = machine.snapshot()
  await f.store.putState(machine.view(), f.operation.prepared!.state)
  await f.owners.fence(f.child.executionAuthority!, 'a'.repeat(64)); await f.owners.retire(f.child.executionAuthority!, 'b'.repeat(64))
  f.sqlite.prepare('UPDATE runtime_slot_run_leases SET released_at = ? WHERE run_id = ?').run(failed.updatedAt, failed.runId)
  // Replay the actual stale transaction, not only a new call that re-reads the
  // activated operation first. Sibling INSERTs must not become destructive upserts.
  await expect(batch(stale!)).rejects.toThrow(/UNIQUE/)
  expect(await f.activate()).toEqual(activated)
  expect(await f.store.getState(f.child.runId)).toEqual(failed)
  await expect(f.owners.assertActive(f.child.executionAuthority!)).rejects.toThrow('no longer active')
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?').get(f.child.runId)!.released_at).toBe(failed.updatedAt)
}, 60_000)

it('keeps the admission source pinned and refuses a different observed destination', async () => {
  const f = await fixture()
  await expect(f.store.activatePreparedExecution(f.auditId, f.command.id, runtime)).rejects.toThrow('runtime identity differs')
  expect(f.publication()).toEqual(absent)
  // Selection is proved at admission. Later source metadata does not redirect
  // the fork to a new state or require inventing a source retirement operation.
  expect(() => f.sqlite.prepare('UPDATE experiment_runs SET state_key = ? WHERE run_id = ?')
    .run('new-unrelated-source-pointer', f.source.runId)).toThrow('state selection receipts are immutable')
  const activated = await f.activate()
  expect(activated.prepared!).toMatchObject(f.operation.prepared!)
  expect(await sha256(await f.store.getState(f.child.runId))).toBe(f.operation.prepared!.state.digest)
}, 60_000)

it('rejects activation predating admission before publishing any execution rows', async () => {
  const f = await fixture()
  const beforeAdmission = new Date(Date.parse(f.operation.acceptedAt) - 1).toISOString()
  await expect(f.journal.activatePreparedExecution(f.command.id, f.loadState, target, beforeAdmission))
    .rejects.toThrow('fork activation time is invalid')
  expect(f.publication()).toEqual(absent)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
}, 60_000)
