import { canonicalJson, sha256 } from './canonical.js'
import type { RunState } from './contracts.js'
import { runStateKey, type RunStatePointer } from './run-state-pointer.js'

/** Selection history is recorded by the same SQLite transaction that changes
 * the run head, including activation and startup-failure writes. An R2 upload
 * alone never creates this evidence. Existing heads are deliberately not backfilled. */
export const STATE_SELECTION_SQL = [
  `CREATE TABLE IF NOT EXISTS run_state_selections (
    run_id TEXT NOT NULL, state_generation INTEGER NOT NULL, state_key TEXT NOT NULL,
    authority_json TEXT, previous_state_key TEXT, selected_at TEXT NOT NULL,
    PRIMARY KEY(run_id, state_generation), UNIQUE(state_key)
  )`,
  ...(['INSERT', 'UPDATE OF state_key, state_generation'] as const).map((event, i) => `
    CREATE TRIGGER IF NOT EXISTS record_run_state_selection_${i}
    AFTER ${event} ON experiment_runs
    ${i === 0 ? '' : 'WHEN NEW.state_key <> OLD.state_key OR NEW.state_generation <> OLD.state_generation'}
    BEGIN
      INSERT INTO run_state_selections
        (run_id, state_generation, state_key, authority_json, previous_state_key, selected_at)
      VALUES (NEW.run_id, NEW.state_generation, NEW.state_key,
        (SELECT authority_json FROM audit_execution_authority WHERE execution_id = NEW.run_id),
        ${i === 0 ? 'NULL' : 'OLD.state_key'}, NEW.updated_at);
    END`),
  `CREATE TRIGGER IF NOT EXISTS immutable_run_state_selection_insert
    BEFORE INSERT ON run_state_selections
    WHEN EXISTS (SELECT 1 FROM run_state_selections
      WHERE run_id = NEW.run_id AND state_generation = NEW.state_generation OR state_key = NEW.state_key)
    BEGIN SELECT RAISE(ABORT, 'state selection receipts are immutable'); END`,
  ...(['UPDATE', 'DELETE'] as const).map(event => `
    CREATE TRIGGER IF NOT EXISTS immutable_run_state_selection_${event.toLowerCase()}
    BEFORE ${event} ON run_state_selections
    BEGIN SELECT RAISE(ABORT, 'state selection receipts are immutable'); END`),
] as const

/** A read-only witness, not permission to overwrite the current head. */
export async function assertStateSelected(index: Pick<D1Database, 'prepare'>, state: RunState): Promise<RunStatePointer> {
  const digest = await sha256(state), key = runStateKey(state.runId, state.stateGeneration, digest)
  const receipt = await index.prepare(`SELECT state_key, authority_json FROM run_state_selections
    WHERE run_id = ?1 AND state_generation = ?2`).bind(state.runId, state.stateGeneration)
    .first<{ state_key: string; authority_json: string | null }>()
  if (receipt?.state_key !== key || receipt.authority_json !== (state.executionAuthority === undefined
    ? null : canonicalJson(state.executionAuthority))) throw new Error('snapshot has no matching state selection receipt')
  return { generation: state.stateGeneration, digest }
}
