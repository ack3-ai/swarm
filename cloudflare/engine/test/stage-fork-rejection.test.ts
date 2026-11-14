import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { runStateKey } from '../src/run-state-pointer.js'
import { assertStageForkDecision, loadPreparedStageFork, stageForkRejectionDigest } from '../src/stage-fork-command.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { target, runtime } from './support/successor-fixture.js'

const closes: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// Built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
async function fixture() {
  const f = await forks.restore(close => closes.push(close))
  const operation = await f.admit(), child = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  return { ...f, operation, child, reject: () => f.journal.rejectStageFork(f.command.id, operation.version,
    { kind: 'runtime-unavailable', observed: null }), activate: () => f.store.activatePreparedExecution(f.auditId, f.command.id, target) }
}

it('records a rejected publication without changing the source or creating a child, then replays it', async () => {
  const f = await fixture(), source = await sha256(await f.store.getState(f.source.runId))
  const before = f.publication(f.child.runId), rejected = await f.reject()
  expect(rejected).toMatchObject({ status: 'rejected', fork: { rejection: { kind: 'runtime-unavailable', observed: null } } })
  expect(rejected).not.toHaveProperty('startup'); expect(rejected.prepared!.activatedAt).toBeUndefined()
  expect(await f.activate()).toEqual(rejected)
  expect(await f.reject()).toEqual(rejected)
  expect(f.publication(f.child.runId)).toEqual(before)
  expect(await sha256(await f.store.getState(f.source.runId))).toBe(source)
}, 60_000)

it.each(['activation', 'rejection'])('adopts %s winning the publication transaction', async winner => {
  const f = await fixture()
  if (winner === 'rejection') {
    const batch = f.d1.batch.bind(f.d1)
    vi.spyOn(f.d1, 'batch').mockImplementationOnce(async statements => { await f.reject(); return batch(statements) })
    expect((await f.activate()).status).toBe('rejected')
    expect(f.publication(f.child.runId)).toEqual({ audit_execution_authority: 0, experiment_runs: 0, run_runtime_routes: 0, runtime_slot_run_leases: 0 })
  } else {
    const get = f.journal.get.bind(f.journal)
    vi.spyOn(f.journal, 'get').mockImplementationOnce(async id => { const old = await get(id); await f.activate(); return old })
    expect((await f.reject()).prepared!.activatedAt).toBeDefined()
    expect((await f.journal.get(f.command.id))!.status).toBe('applied')
    expect(await f.store.getState(f.child.runId)).toEqual(f.child)
  }
}, 60_000)

it('adopts a lost rejection reply without replacing its original evidence', async () => {
  const f = await fixture()
  f.onAfterRun(sql => { if (sql.startsWith('INSERT INTO audit_run_commands')) { f.onAfterRun(); throw new Error('lost rejection reply') } })
  const rejected = await f.reject()
  expect(rejected.status).toBe('rejected')
  expect(await f.journal.rejectStageFork(f.command.id, 1, { kind: 'runtime-unavailable', observed: runtime })).toEqual(rejected)
  expect(await f.activate()).toEqual(rejected)
}, 60_000)

it('requires a positive unrelated owner for a collision and preserves its rows', async () => {
  const f = await fixture()
  const authority = await f.store.activateRootExecution(f.child.runId, target, { unrelated: true })
  const row = f.sqlite.prepare('SELECT command_digest FROM audit_execution_authority WHERE execution_id = ?').get(f.child.runId)!
  const before = f.publication(f.child.runId)
  const rejection = { kind: 'child-conflict' as const, authority, commandDigest: String(row.command_digest) }
  expect((await f.journal.rejectStageFork(f.command.id, 1, rejection)).status).toBe('rejected')
  expect(f.publication(f.child.runId)).toEqual(before)
  expect(await f.owners.current(f.child.runId)).toEqual(authority)
}, 60_000)

it.each(['route', 'prepared-state', 'same-command-owner'])('refuses an ambiguous or fork-owned %s without an activation witness', async orphan => {
  const f = await fixture()
  if (orphan === 'route') f.sqlite.prepare('INSERT INTO run_runtime_routes VALUES (?, ?, ?, ?)')
    .run(f.child.runId, f.child.experimentId, canonicalJson(target), f.child.updatedAt)
  if (orphan === 'prepared-state') f.sqlite.prepare(`INSERT INTO experiment_runs
    (run_id, experiment_id, status, state_key, state_generation, updated_at) VALUES (?, ?, 'running', ?, ?, ?)`)
    .run(f.child.runId, f.child.experimentId,
      runStateKey(f.child.runId, f.operation.prepared!.state.generation, f.operation.prepared!.state.digest),
      f.child.stateGeneration, f.child.updatedAt)
  if (orphan === 'same-command-owner') f.sqlite.prepare(`INSERT INTO audit_execution_authority
    (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at) VALUES (?, 0, ?, ?, ?, 'active', ?)`)
    .run(f.child.runId, f.child.runId, canonicalJson(f.child.executionAuthority), f.operation.commandDigest, f.child.updatedAt)
  const before = f.publication(f.child.runId)
  await expect(f.reject()).rejects.toThrow('unclaimed or independently owned destination')
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.publication(f.child.runId)).toEqual(before)
}, 60_000)

it('rejects forged rejection receipts and contradictions with activation or startup', async () => {
  const f = await fixture(), rejected = await f.reject()
  await expect(f.journal.rejectStageFork(f.command.id, 1, { kind: 'runtime-unavailable', observed: target })).resolves.toEqual(rejected)
  await expect(stageForkRejectionDigest(f.operation, { kind: 'runtime-unavailable', observed: target })).rejects.toThrow('matches its requested runtime')
  await expect(assertStageForkDecision({ ...rejected, receiptDigest: 'a'.repeat(64) })).rejects.toThrow('receipt differs')
  await expect(assertStageForkDecision({ ...rejected, prepared: { ...rejected.prepared!, activatedAt: rejected.updatedAt } })).rejects.toThrow('receipt differs')
  await expect(assertStageForkDecision(Object.assign({}, rejected, { startup: { status: 'started', state: f.operation.prepared!.state,
    at: rejected.updatedAt } }))).rejects.toThrow('fork decision is invalid')
}, 60_000)
