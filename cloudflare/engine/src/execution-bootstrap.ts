import { canonicalJson, sha256 } from './canonical.js'
import type { RunState } from './contracts.js'
import { runStateKey } from './run-state-pointer.js'

/** Written only by the Workflow after bootstrap state persistence. Pre-materializing
 * a run or receiving a Workflow ID does not produce this witness. */
export async function recordExecutionBootstrap(index: D1Database, state: RunState): Promise<void> {
  const key = runStateKey(state.runId, state.stateGeneration, await sha256(state))
  await index.prepare(`INSERT INTO execution_bootstrap (run_id, authority_json, state_key)
    SELECT run.run_id, owner.authority_json, run.state_key
    FROM experiment_runs run JOIN audit_execution_authority owner ON owner.execution_id = run.run_id
    WHERE run.run_id = ?1 AND run.state_key = ?2 AND owner.authority_json = ?3
      AND owner.epoch = (SELECT MAX(epoch) FROM audit_execution_authority WHERE audit_id = owner.audit_id)
    ON CONFLICT DO NOTHING`).bind(state.runId, key, canonicalJson(state.executionAuthority)).run()
  if (!await executionBootstrapped(index, state)) throw new Error('bootstrap state is no longer selected')
}

export async function executionBootstrapped(index: D1Database, state: RunState): Promise<boolean> {
  const row = await index.prepare(`SELECT boot.authority_json, receipt.authority_json AS selected_authority
    FROM execution_bootstrap boot LEFT JOIN run_state_selections receipt
      ON receipt.run_id = boot.run_id AND receipt.state_key = boot.state_key
    WHERE boot.run_id = ?1`).bind(state.runId)
    .first<{ authority_json: string; selected_authority: string | null }>()
  if (row === null) return false
  const authority = canonicalJson(state.executionAuthority)
  if (row.authority_json !== authority || row.selected_authority !== authority) {
    throw new Error('bootstrap witness differs from selected execution authority')
  }
  return true
}
