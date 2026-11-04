import { afterEach, expect, it } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { ExecutionAuthorityStore, type ExecutionAuthority } from '../src/execution-authority.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { runStateKey } from '../src/run-state-pointer.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const owner: ExecutionAuthority = { auditId: 'audit', executionId: 'audit', epoch: 0, runtimeDigest: 'a'.repeat(64) }
const pointer = { generation: 1, digest: 'b'.repeat(64) }
const command = 'c'.repeat(64), request = 'd'.repeat(64), proof = 'e'.repeat(64)
const closes: (() => void)[] = []
afterEach(() => closes.splice(0).forEach(close => close()))
async function fixture() {
  const db = sqliteD1()
  closes.push(() => db.sqlite.close())
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const store = new ExecutionAuthorityStore(db.d1)
  await store.activate(owner, command)
  db.sqlite.prepare(`INSERT INTO experiment_runs
    (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?, 'synthetic', 'running', ?, 1, '2026-01-01T00:00:00Z')`)
    .run(owner.executionId, runStateKey(owner.executionId, pointer.generation, pointer.digest))
  const operation = (value: unknown, version = 1) => db.sqlite.prepare(`INSERT INTO audit_run_commands
    (audit_id, revision, command_id, version, operation_json, operation_digest) VALUES (?, 1, 'control', ?, ?, ?)`)
    .run(owner.auditId, version, canonicalJson(value), command)
  return { ...db, store, operation }
}

it('reconciles the original activation without reopening fenced or retired ownership', async () => {
  const { store } = await fixture()
  await store.fence(owner, command)
  await store.retire(owner, proof)
  await store.activate(owner, command)
  await expect(store.assertActive(owner)).rejects.toThrow('no longer active')
  await store.assertRetired(owner, command, proof)
  await expect(store.activate(owner, proof)).rejects.toThrow('conflicts')
  await expect(store.activate({ ...owner, epoch: 1, executionId: 'replacement' }, command)).rejects.toThrow('atomic')
})

it('admits an exact request once and refuses changed task identity or settled claims', async () => {
  const { store, sqlite } = await fixture()
  expect(await store.admitLaunch(owner, 'task', request, pointer)).toBe(true)
  expect(await store.admitLaunch(owner, 'task', request, pointer)).toBe(true)
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_execution_launches').get()!.n).toBe(1)
  await expect(store.admitLaunch(owner, 'other', request, pointer)).rejects.toThrow('authority')
  expect(await store.observeLaunch(owner, 'task', request)).toMatchObject({ receiptDigest: null })
  await store.settleLaunch(owner, request, proof)
  await store.settleLaunch(owner, request, proof)
  await expect(store.settleLaunch(owner, request, command)).rejects.toThrow('differs')
  await expect(store.admitLaunch(owner, 'task', request, pointer)).rejects.toThrow('authority')
})

it('does not admit against a stale state pointer', async () => {
  const { store, sqlite } = await fixture()
  expect(await store.admitLaunch(owner, 'task', request, { ...pointer, generation: 2 })).toBe(false)
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it('detects a state move after reservation and keeps the claim for cancellation', async () => {
  const { store, sqlite, onAfterRun } = await fixture()
  onAfterRun(sql => {
    if (sql.includes('INSERT INTO audit_execution_launches')) {
      sqlite.prepare('UPDATE experiment_runs SET state_generation = 2, state_key = ?').run(runStateKey('audit', 2, proof))
    }
  })
  expect(await store.admitLaunch(owner, 'task', request, pointer)).toBe(false)
  expect(await store.pendingLaunches(owner)).toHaveLength(1)
})

it('fences new claims and refuses retirement until every admitted claim settles', async () => {
  const { store } = await fixture()
  await store.admitLaunch(owner, 'task', request, pointer)
  await store.fence(owner, command)
  await expect(store.admitLaunch(owner, 'later', proof, pointer)).rejects.toThrow('authority')
  await expect(store.retire(owner, proof)).rejects.toThrow('unsettled')
  await store.settleLaunch(owner, request, proof)
  await store.retire(owner, proof)
  await store.assertRetired(owner, command, proof)
  await expect(store.assertRetired(owner, proof, proof)).rejects.toThrow('differs')
})

it.each(['cancellation', 'startup'] as const)('blocks model admission while %s is unsettled', async kind => {
  const { store, operation, sqlite } = await fixture()
  operation(kind === 'cancellation'
    ? { status: 'applying', source: { authority: owner }, nativeEffect: { kind: 'revoke-admission' } }
    : { status: 'applying', prepared: { authority: owner, activatedAt: '2026-01-01T00:00:00Z' } })
  await expect(store.admitLaunch(owner, 'task', request, pointer)).rejects.toThrow('authority')
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  if (kind === 'startup') {
    expect(await store.awaitingStartup(owner)).toBe(true)
    operation({ status: 'applied', prepared: { authority: owner, activatedAt: '2026-01-01T00:00:00Z' }, startup: { status: 'started' } }, 2)
    expect(await store.awaitingStartup(owner)).toBe(false)
    expect(await store.admitLaunch(owner, 'task', request, pointer)).toBe(true)
  }
})

it('settles an ambiguous write by reading the same immutable launch claim', async () => {
  const { store, onAfterRun } = await fixture()
  onAfterRun(sql => { if (sql.includes('INSERT INTO audit_execution_launches')) throw new Error('lost reply') })
  await expect(store.admitLaunch(owner, 'task', request, pointer)).rejects.toThrow('lost reply')
  onAfterRun()
  expect(await store.observeLaunch(owner, 'task', request)).toMatchObject({ taskExecutionId: 'task', receiptDigest: null })
  expect(await store.admitLaunch(owner, 'task', request, pointer)).toBe(true)
  expect(await store.pendingLaunches(owner)).toHaveLength(1)
})
