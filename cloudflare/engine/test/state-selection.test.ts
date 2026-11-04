import { afterEach, expect, it } from 'vitest'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { assertStateSelected, STATE_SELECTION_SQL } from '../src/state-selection.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { runStateKey } from '../src/run-state-pointer.js'
import type { RunState } from '../src/contracts.js'
import { sqliteD1 } from './support/sqlite-d1.js'

const databases: ReturnType<typeof sqliteD1>[] = []
afterEach(() => databases.splice(0).forEach(db => db.sqlite.close()))
async function fixture() {
  const db = sqliteD1(); databases.push(db)
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const authority = { auditId: 'audit', executionId: 'execution', epoch: 0, runtimeDigest: 'a'.repeat(64) }
  db.sqlite.prepare(`INSERT INTO audit_execution_authority VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL)`)
    .run('audit', 0, 'execution', canonicalJson(authority), 'b'.repeat(64), '2030-01-01T00:00:00Z')
  // The receipt layer binds opaque bytes; full state validation belongs to its producer.
  const state = (generation: number, value = generation) => ({ runId: 'execution', stateGeneration: generation,
    executionAuthority: authority, value }) as unknown as RunState
  const key = async (s: RunState) => runStateKey(s.runId, s.stateGeneration, await sha256(s))
  const insert = async (s: RunState) => db.d1.prepare(`INSERT INTO experiment_runs VALUES
    (?1, 'experiment', 'running', ?2, ?3, NULL, '2030-01-01T00:00:00Z', NULL)`)
    .bind(s.runId, await key(s), s.stateGeneration)
  const update = async (before: RunState, after: RunState) => db.d1.prepare(`UPDATE experiment_runs
    SET state_key = ?1, state_generation = ?2 WHERE run_id = ?3 AND state_key = ?4 AND state_generation = ?5`)
    .bind(await key(after), after.stateGeneration, after.runId, await key(before), before.stateGeneration)
  return { ...db, state, key, insert, update }
}

it('records only the winning selection and preserves historical selection after head advancement', async () => {
  const f = await fixture(), a = f.state(1), b = f.state(2), loser = f.state(2, 99), c = f.state(3)
  await expect(assertStateSelected(f.d1, a)).rejects.toThrow('no matching')
  await (await f.insert(a)).run()
  await (await f.update(a, b)).run()
  await (await f.update(a, loser)).run()
  await (await f.update(b, c)).run()
  for (const s of [a, b, c]) expect(await assertStateSelected(f.d1, s)).toEqual({ generation: s.stateGeneration, digest: await sha256(s) })
  await expect(assertStateSelected(f.d1, loser)).rejects.toThrow('no matching')
  expect(f.sqlite.prepare('SELECT previous_state_key FROM run_state_selections WHERE state_generation = 3').get())
    .toEqual({ previous_state_key: await f.key(b) })
  expect(f.sqlite.prepare('SELECT COUNT(*) n FROM run_state_selections').get()).toEqual({ n: 3 })
})

it('rolls the receipt back with a failed batch and records a lost-ACK retry only once', async () => {
  const f = await fixture(), a = f.state(1), b = f.state(2)
  await (await f.insert(a)).run()
  await expect(f.d1.batch([await f.update(a, b), f.d1.prepare('INSERT INTO nonexistent VALUES (1)')])).rejects.toThrow()
  await expect(assertStateSelected(f.d1, b)).rejects.toThrow('no matching')
  await (await f.update(a, b)).run()
  await (await f.update(a, b)).run()
  expect(f.sqlite.prepare('SELECT COUNT(*) n FROM run_state_selections').get()).toEqual({ n: 2 })
  expect(await assertStateSelected(f.d1, b)).toMatchObject({ generation: 2 })
})

it('rejects substituted bytes or authority and cannot rewrite receipts through replacement SQL', async () => {
  const f = await fixture(), a = f.state(1)
  await (await f.insert(a)).run()
  await expect(assertStateSelected(f.d1, { ...a, executionAuthority: { ...a.executionAuthority!, epoch: 1 } })).rejects.toThrow('no matching')
  await expect(assertStateSelected(f.d1, f.state(1, 10))).rejects.toThrow('no matching')
  for (const sql of [
    `UPDATE run_state_selections SET authority_json = NULL`,
    `DELETE FROM run_state_selections`,
    `INSERT OR REPLACE INTO run_state_selections SELECT * FROM run_state_selections`,
  ]) expect(() => f.sqlite.exec(sql)).toThrow('immutable')
  expect(await assertStateSelected(f.d1, a)).toMatchObject({ generation: 1 })
})

it('does not manufacture historical selection receipts when the schema is installed', async () => {
  const f = await fixture(), a = f.state(1)
  for (const name of ['record_run_state_selection_0', 'record_run_state_selection_1']) f.sqlite.exec(`DROP TRIGGER ${name}`)
  await (await f.insert(a)).run()
  for (const sql of STATE_SELECTION_SQL) f.sqlite.exec(sql)
  await expect(assertStateSelected(f.d1, a)).rejects.toThrow('no matching')
  f.sqlite.exec(`UPDATE experiment_runs SET status = 'failed'`)
  await expect(assertStateSelected(f.d1, a)).rejects.toThrow('no matching')
})


