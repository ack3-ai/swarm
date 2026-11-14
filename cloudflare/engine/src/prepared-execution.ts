import { canonicalJson, sha256 } from './canonical.js'
import type { RunState } from './contracts.js'
import type { RunOperation } from './run-command-journal.js'

/** Verify the selected fork publication without reopening its lease. */
export async function assertPreparedExecutionPublication(index: D1Database, operation: RunOperation, state: RunState) {
  const selected = operation.prepared
  if (selected === undefined) throw new Error('prepared execution identity is missing')
  if (selected.activatedAt === undefined || state.runId !== selected.authority.executionId
    || state.stateGeneration !== selected.state.generation || await sha256(state) !== selected.state.digest
    || canonicalJson(state.executionAuthority) !== canonicalJson(selected.authority)) throw new Error('prepared publication identity differs')
  await assertExecutionPublication(index, state)
}

/** Every startup requires the selected owner, route and lease, regardless of origin. */
export async function assertExecutionPublication(index: D1Database, state: RunState) {
  const row = await index.prepare(`SELECT 1 FROM audit_execution_authority owner
    JOIN experiment_runs run ON run.run_id = owner.execution_id
    LEFT JOIN run_runtime_routes route ON route.run_id = owner.execution_id
    LEFT JOIN runtime_slot_run_leases lease ON lease.run_id = owner.execution_id
    WHERE owner.audit_id = ?1 AND owner.authority_json = ?2
      AND owner.epoch = (SELECT MAX(epoch) FROM audit_execution_authority WHERE audit_id = ?1)
      AND run.experiment_id = ?3 AND run.state_generation >= ?4
      AND (?5 IS NULL OR (route.experiment_id = ?3 AND route.runtime_release_json = ?5
        AND lease.experiment_id = ?3 AND lease.slot_id = ?6 AND lease.runtime_release_json = ?5))`)
    .bind(state.executionAuthority!.auditId, canonicalJson(state.executionAuthority), state.experimentId,
      state.stateGeneration, state.runtimeRelease === undefined ? null : canonicalJson(state.runtimeRelease),
      state.runtimeRelease?.id ?? null).first()
  if (row === null) throw new Error('execution publication is missing or ownership differs')
}
