import { afterEach, expect, it } from 'vitest'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const closes: (() => void)[] = []
afterEach(() => closes.splice(0).forEach(close => close()))
function fixture() {
  const db = sqliteD1()
  closes.push(() => db.sqlite.close())
  ROUTING_SCHEMA_SQL.forEach(sql => db.sqlite.exec(sql))
  return { ...db, journal: new RunCommandJournal(db.d1, 'audit') }
}
const pause = (id = 'pause', expectedRevision = 0) => ({
  id, expectedRevision, action: 'pause', scope: { kind: 'audit' }, reason: 'synthetic hold',
})

it('selects one decision per revision and preserves command idempotency', async () => {
  const { journal } = fixture()
  const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => journal.admit(pause(`pause-${i}`))))
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = (await journal.atRevision(1))!
  expect(await journal.admit(winner.command)).toEqual(winner)
  await expect(journal.admit({ ...winner.command, reason: 'changed' })).rejects.toMatchObject({ code: 'idempotency-conflict' })
  expect(await journal.revision()).toBe(1)
})

it('recovers a committed admission whose acknowledgement was lost', async () => {
  const { journal, onAfterRun } = fixture()
  let fail = true
  onAfterRun(() => { if (fail) { fail = false; throw new Error('lost ACK') } })
  await expect(journal.admit(pause())).rejects.toThrow('lost ACK')
  const recovered = await journal.admit(pause())
  expect(recovered).toMatchObject({ revision: 1, version: 1, status: 'accepted' })
  expect(await journal.revision()).toBe(1)
})

it('keeps transition CAS idempotent after a lost acknowledgement and refuses competing outcomes', async () => {
  const { journal, onAfterRun } = fixture()
  await journal.admit(pause())
  let fail = true
  onAfterRun(() => { if (fail) { fail = false; throw new Error('lost ACK') } })
  await expect(journal.advance('pause', 1, { status: 'applying' })).rejects.toThrow('lost ACK')
  const applying = await journal.advance('pause', 1, { status: 'applying' })
  expect(applying.version).toBe(2)
  const outcomes = await Promise.allSettled([
    journal.advance('pause', 2, { status: 'applied', receiptDigest: 'a'.repeat(64) }),
    journal.advance('pause', 2, { status: 'rejected', detail: { code: 'changed', message: 'synthetic' } }),
  ])
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const settled = (await journal.get('pause'))!
  expect(settled.version).toBe(3)
  await expect(journal.advance('pause', 3, { status: 'applying' })).rejects.toMatchObject({ code: 'operation-conflict' })
})

it('requires active selected execution authority at admission', async () => {
  const { journal, d1, sqlite } = fixture()
  const owner = { auditId: 'audit', executionId: 'audit', epoch: 0, runtimeDigest: 'a'.repeat(64) }
  const authority = new ExecutionAuthorityStore(d1)
  await authority.activate(owner, 'b'.repeat(64))
  sqlite.prepare("INSERT INTO experiment_runs (run_id,experiment_id,status,state_key,state_generation,updated_at) VALUES ('audit','synthetic','running','synthetic',1,'2026-01-01')").run()
  await journal.admit(pause(), undefined, owner)
  await authority.fence(owner, 'c'.repeat(64))
  await expect(journal.admit(pause('second', 1), undefined, owner)).rejects.toMatchObject({ code: 'operation-conflict' })
  expect(await journal.revision()).toBe(1)
})

it.each(['cancel', 'fork'])('does not admit %s without its later evidence transition', async action => {
  const { journal } = fixture()
  await expect(journal.admit({ ...pause(), action })).rejects.toThrow()
  expect(await journal.revision()).toBe(0)
})

it.each(['unknown', 'nativeEffect', 'prepared'])('rejects unsupported %s fields even with a recomputed digest', async field => {
  const { journal, sqlite } = fixture()
  const operation = await journal.admit(pause())
  const changed = { ...operation, [field]: {} }
  sqlite.prepare('UPDATE audit_run_commands SET operation_json=?,operation_digest=?').run(canonicalJson(changed), await sha256(changed))
  await expect(journal.get('pause')).rejects.toThrow('command journal integrity failed')
  await expect(journal.atRevision(1)).rejects.toThrow('command journal integrity failed')
})

it('rejects a changed row digest and refuses applied without a receipt', async () => {
  const { journal, sqlite } = fixture()
  await journal.admit(pause())
  await expect(journal.advance('pause', 1, { status: 'applied' })).rejects.toThrow('operation update is invalid')
  sqlite.prepare("UPDATE audit_run_commands SET operation_digest=?").run('0'.repeat(64))
  await expect(journal.get('pause')).rejects.toThrow('command journal integrity failed')
})
