import { canonicalJson, sha256 } from '../../src/canonical.js'
import type { RunState } from '../../src/contracts.js'
import type { ExecutionSourceLoader } from '../../src/execution-lineage.js'
import { RunMachine } from '../../src/machine.js'
import { ROUTING_SCHEMA_SQL } from '../../src/routing-schema.js'
import { runStateKey } from '../../src/run-state-pointer.js'
import { assertStateSelected } from '../../src/state-selection.js'
import { restoreSqlite, sqliteContent, sqliteD1, type SqliteContent } from './sqlite-d1.js'

export interface SelectedSnapshotsContent { database: SqliteContent; bytes: Map<string, string> }

/** Test storage uses the production selection triggers, and accepts only actual
 * machine output. Rehashing a forged snapshot cannot mint a selection receipt.
 * `from`: start as an exact copy of another instance's `content()`. */
export function selectedSnapshots(from?: SelectedSnapshotsContent) {
  const db = sqliteD1(from === undefined ? undefined : restoreSqlite(from.database)), bytes = new Map<string, string>(from?.bytes)
  if (from === undefined) for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const load: ExecutionSourceLoader = async (id, pointer) => {
    const value = bytes.get(runStateKey(id, pointer.generation, pointer.digest))
    if (value === undefined) throw new Error('snapshot is missing')
    return JSON.parse(value) as RunState
  }
  load.assertSelected = async state => { await assertStateSelected(db.d1, state) }
  const select = async (machine: RunMachine | RunState) => {
    const state = machine instanceof RunMachine ? machine.view() : machine; RunMachine.assertProducedState(state)
    const authority = state.executionAuthority
    if (authority !== undefined) db.sqlite.prepare(`INSERT OR IGNORE INTO audit_execution_authority
      VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, NULL)`)
      .run(authority.auditId, authority.epoch, authority.executionId, canonicalJson(authority), 'a'.repeat(64), state.updatedAt)
    const key = runStateKey(state.runId, state.stateGeneration, await sha256(state))
    bytes.set(key, canonicalJson(state))
    db.sqlite.prepare(`INSERT INTO experiment_runs VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
      ON CONFLICT(run_id) DO UPDATE SET state_key = excluded.state_key,
      state_generation = excluded.state_generation, status = excluded.status, updated_at = excluded.updated_at`)
      .run(state.runId, state.experimentId, state.status, key, state.stateGeneration, state.updatedAt)
    return JSON.parse(canonicalJson(state)) as RunState
  }
  return { load, select, close: () => db.sqlite.close(),
    content: (): SelectedSnapshotsContent => ({ database: sqliteContent(db.sqlite), bytes: new Map(bytes) }) }
}

/** Round-trip an actual producer view; an edited candidate cannot acquire its
 * own receipt merely because its journal was rehashed. */
export async function restoreSelected(machine: RunMachine, candidate: RunState = machine.view()): Promise<RunMachine> {
  const selected = selectedSnapshots()
  try {
    await selected.select(machine)
    return await RunMachine.fromState(machine.definition, candidate, undefined, selected.load)
  } finally { selected.close() }
}
