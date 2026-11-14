import { createControlledMachine } from './support/controlled-machine.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { assertStateSelected, STATE_SELECTION_SQL } from '../src/state-selection.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { runStateKey } from '../src/run-state-pointer.js'
import type { RunState } from '../src/contracts.js'
import { RunMachine } from '../src/machine.js'
import { compileExperimentConfig } from '../src/config-compiler.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
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


it('does not grant publication authority to a copied or edited machine snapshot', async () => {
  const definition = compileExperimentConfig(document, prompts).definition
  const machine = await createControlledMachine(definition, 'a'.repeat(64), 'producer-test')
  const original = machine.view()
  expect(() => RunMachine.assertProducedState(original)).not.toThrow()
  expect(Object.isFrozen(original)).toBe(true)
  expect(Object.isFrozen(original.journal)).toBe(true)
  for (const untrusted of [machine.snapshot(), { ...original, status: 'completed' as const }]) {
    expect(() => RunMachine.assertProducedState(untrusted)).toThrow('produced by')
  }
  await machine.start()
  expect(() => RunMachine.assertProducedState(machine.view())).not.toThrow()
})

it('loads exact selected machine bytes and rejects an orphan or substituted snapshot', async () => {
  const db = sqliteD1(); databases.push(db)
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const definition = compileExperimentConfig(document, prompts).definition
  const machine = await createControlledMachine(definition, 'a'.repeat(64), 'selected-machine')
  await machine.start()
  const state = machine.view()
  db.sqlite.prepare(`INSERT INTO audit_execution_authority VALUES (?, 0, ?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL)`)
    .run(state.runId, state.runId, canonicalJson(state.executionAuthority), 'b'.repeat(64), state.createdAt)
  const load = Object.assign(async () => { throw new Error('unexpected ancestor read') }, {
    assertSelected: async (candidate: RunState) => { await assertStateSelected(db.d1, candidate) },
  })
  await expect(RunMachine.fromState(definition, state, undefined, load)).rejects.toThrow('no matching')
  await db.d1.prepare(`INSERT INTO experiment_runs VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, NULL)`)
    .bind(state.runId, state.experimentId, state.status, runStateKey(state.runId, state.stateGeneration, await sha256(state)),
      state.stateGeneration, state.updatedAt).run()
  const restored = await RunMachine.fromState(definition, machine.snapshot(), undefined, load)
  expect(restored.snapshot()).toEqual(machine.snapshot())
  expect(() => RunMachine.assertProducedState(restored.view())).not.toThrow()
  await expect(RunMachine.fromState(definition, { ...state, status: 'completed' }, undefined, load)).rejects.toThrow('no matching')
  await expect(RunMachine.fromState(definition, state)).rejects.toThrow('owning app version')
})

it('rejects premature stage/cursor transitions before they can become selected checkpoints', async () => {
  const definition = compileExperimentConfig(document, prompts).definition
  const machine = await createControlledMachine(definition, 'a'.repeat(64), 'premature-progress')
  await machine.start()
  const before = machine.snapshot()
  await expect(machine.advance({ stageIndex: 1, waveIndex: 0 })).rejects.toThrow('completed wave')
  await expect(machine.endStage('preflight-passed', { finalWave: 'invented', artifacts: [] })).rejects.toThrow('completed waves')
  await expect(machine.endStage('stage-complete', {}, 1)).rejects.toThrow('settled cursor')
  expect(machine.snapshot()).toEqual(before)
  expect(Object.isFrozen(machine.definition)).toBe(true)
  expect(Object.isFrozen(machine.definition.stages)).toBe(true)
})

it('verifies a seal followed by terminal state in one selection without an intermediate persisted generation', async () => {
  const { createExecutorSourceFixture } = await import('./support/successor-fixture.js')
  const { advanceExperimentOneWave, audit0RunPolicy } = await import('../src/runner.js')
  const { DeterministicAuditProvider } = await import('./support/deterministic-audit-provider.js')
  const { MemoryArtifactStore } = await import('./support/memory-runner.js')
  const closes: Array<() => void> = []
  try {
    const f = await createExecutorSourceFixture(close => closes.push(close), false, undefined, 0)
    await advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine,
      provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy })
    const checkpoint = f.machine.view().checkpoints.at(-1)!
    await f.machine.fail('test terminal selection')
    await f.store.putState(f.machine.view(), { generation: f.source.stateGeneration, digest: await sha256(f.source) })
    expect(f.sqlite.prepare('SELECT count(*) n FROM run_state_selections WHERE state_generation = ?')
      .get(checkpoint.body.stateGeneration + 1)).toEqual({ n: 0 })
    const restored = await RunMachine.fromState(f.machine.definition, await f.store.getState(f.source.runId),
      digest => f.store.getRelease(digest), f.store.executionSources())
    await restored.verifyCheckpoint(checkpoint)
    const altered = structuredClone(checkpoint); altered.body.budget.modelCalls++
    altered.digest = await sha256(altered.body)
    await expect(restored.verifyCheckpoint(altered)).rejects.toThrow('not registered')
  } finally { closes.forEach(close => close()) }
})

it('requires explicit ownership for new and restored current executions', async () => {
  const definition = compileExperimentConfig(document, prompts).definition
  await expect(RunMachine.create(definition, 'a'.repeat(64), 'unowned-root'))
    .rejects.toThrow('current execution requires explicit authority')
  const machine = await createControlledMachine(definition, 'a'.repeat(64), 'owned-root')
  const { executionAuthority: _authority, ...unowned } = machine.snapshot()
  const assertSelected = vi.fn(async () => {})
  const load = Object.assign(async () => { throw new Error('unexpected ancestor read') }, { assertSelected })
  // @ts-expect-error Deliberately pass an unowned current state.
  await expect(RunMachine.fromState(definition, unowned, undefined, load)).rejects.toThrow('owning app version')
  expect(assertSelected).not.toHaveBeenCalled()
})
