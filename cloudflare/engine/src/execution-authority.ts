import { runStateKey, type RunStatePointer } from './run-state-pointer.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertControlId, RunCommandConflict } from './run-commands.js'

/** Logical audit and replaceable executor identities are deliberately separate. */
export interface ExecutionAuthority {
  auditId: string
  executionId: string
  epoch: number
  runtimeDigest: string
}

export function assertExecutionAuthority(value: ExecutionAuthority): void {
  assertControlId(value.auditId, 'audit id')
  assertControlId(value.executionId, 'execution id')
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 0 || value.epoch >= Number.MAX_SAFE_INTEGER
    || !/^[a-f0-9]{64}$/.test(value.runtimeDigest)) throw new TypeError('execution authority is invalid')
}

/** A task has one identity per audit; rerunning it requires a new fork. */
export async function taskExecutionIdentity(authority: ExecutionAuthority, taskId: string): Promise<string> {
  assertExecutionAuthority(authority); assertControlId(taskId, 'task id')
  return `task-${(await sha256({ authority, taskId })).slice(0, 48)}`
}

function digest(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError('receipt digest is invalid')
}

interface AuthorityRow {
  authority_json: string
  command_digest: string
  status: 'active' | 'fenced' | 'retired'
  fence_command_digest: string | null
  retirement_digest: string | null
}

/** Whole-executor stop intent closes new claims before physical cancellation. */
function nativeControlIntent(authorityParameter: string): string {
  return `EXISTS (SELECT 1 FROM audit_run_commands effect
    WHERE effect.audit_id = json_extract(${authorityParameter}, '$.auditId')
      AND effect.version = (SELECT MAX(latest.version) FROM audit_run_commands latest
        WHERE latest.audit_id = effect.audit_id AND latest.command_id = effect.command_id)
      AND json_extract(effect.operation_json, '$.status') = 'applying'
      AND json_extract(effect.operation_json, '$.source.authority') = ${authorityParameter}
      AND json_extract(effect.operation_json, '$.nativeEffect.kind') = 'revoke-admission')`
}

/** Activated ownership is not permission to run models before exact Workflow startup. */
function unstartedExecution(authorityParameter: string, pendingOnly = false): string {
  return `EXISTS (SELECT 1 FROM audit_run_commands effect
    WHERE effect.version = (SELECT MAX(latest.version) FROM audit_run_commands latest
        WHERE latest.audit_id = effect.audit_id AND latest.command_id = effect.command_id)
      AND json_extract(effect.operation_json, '$.prepared.authority') = ${authorityParameter}
      AND json_extract(effect.operation_json, '$.prepared.activatedAt') IS NOT NULL
      AND COALESCE(json_extract(effect.operation_json, '$.startup.status'), '') != 'started'
      ${pendingOnly ? "AND json_extract(effect.operation_json, '$.status') = 'applying' AND json_extract(effect.operation_json, '$.startup') IS NULL" : ''})`
}

export class ExecutionAuthorityStore {
  constructor(private readonly index: D1Database) {}

  async awaitingStartup(authority: ExecutionAuthority): Promise<boolean> {
    assertExecutionAuthority(authority)
    return await this.index.prepare(`SELECT 1 WHERE ${unstartedExecution('?1', true)}`).bind(canonicalJson(authority)).first() !== null
  }

  async assertNoLaunches(authority: ExecutionAuthority): Promise<void> {
    assertExecutionAuthority(authority)
    if (await this.index.prepare('SELECT 1 FROM audit_execution_launches WHERE audit_id = ?1 AND epoch = ?2 LIMIT 1')
      .bind(authority.auditId, authority.epoch).first() !== null) throw new Error('execution has launch evidence before startup acknowledgement')
  }

  async current(auditId: string): Promise<ExecutionAuthority | null> {
    assertControlId(auditId, 'audit id')
    const row = await this.index.prepare(`SELECT authority_json FROM audit_execution_authority
      WHERE audit_id = ?1 ORDER BY epoch DESC LIMIT 1`).bind(auditId).first<{ authority_json: string }>()
    if (row === null) return null
    const authority = JSON.parse(row.authority_json) as ExecutionAuthority
    assertExecutionAuthority(authority)
    if (authority.auditId !== auditId) throw new Error('audit execution authority identity differs')
    return authority
  }

  private async read(authority: ExecutionAuthority): Promise<AuthorityRow | null> {
    assertExecutionAuthority(authority)
    const row = await this.index.prepare(`SELECT authority_json, command_digest, status,
      fence_command_digest, retirement_digest FROM audit_execution_authority
      WHERE audit_id = ?1 AND epoch = ?2`).bind(authority.auditId, authority.epoch).first<AuthorityRow>()
    if (row !== null && row.authority_json !== canonicalJson(authority)) {
      throw new RunCommandConflict('operation-conflict', 'execution authority belongs to another executor')
    }
    return row
  }

  /** Root-only bootstrap. Successors publish ownership and state atomically through their command. */
  async activate(authority: ExecutionAuthority, commandDigest: string): Promise<void> {
    assertExecutionAuthority(authority); digest(commandDigest)
    if (authority.epoch !== 0 || authority.executionId !== authority.auditId) {
      throw new RunCommandConflict('operation-conflict', 'successor ownership requires atomic command activation')
    }
    await this.index.prepare(`INSERT INTO audit_execution_authority
      (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, 'active', ?6
      WHERE NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?3)
        AND ?2 = 0 AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE audit_id = ?1)
      ON CONFLICT DO NOTHING`).bind(authority.auditId, authority.epoch, authority.executionId,
      canonicalJson(authority), commandDigest, new Date().toISOString()).run()
    const row = await this.read(authority)
    if (row === null || row.command_digest !== commandDigest) {
      throw new RunCommandConflict('operation-conflict', 'execution activation conflicts with audit ownership')
    }
    // A lost activation response can be reconciled after a later fence. Never
    // reopen that execution; the caller must separately check active authority.
  }

  async assertActive(authority: ExecutionAuthority): Promise<void> {
    if ((await this.read(authority))?.status !== 'active') {
      throw new RunCommandConflict('operation-conflict', 'execution authority is no longer active')
    }
  }

  /** Historical work can be omitted from a successor's physical inventory only
   * when the exact replacement command already retired its original owner. */
  async assertRetired(authority: ExecutionAuthority, commandDigest: string, proofDigest: string): Promise<void> {
    digest(commandDigest); digest(proofDigest)
    const row = await this.read(authority)
    if (row?.status !== 'retired' || row.fence_command_digest !== commandDigest
      || row.retirement_digest !== proofDigest || (await this.pendingLaunches(authority)).length !== 0) {
      throw new RunCommandConflict('operation-conflict', 'historical execution retirement differs or has unsettled work')
    }
  }

  /** Historical reservation observation, not proof that a process started or
   * stopped. A source-active callback may still be before this reservation. */
  async observeLaunch(authority: ExecutionAuthority, taskExecutionId: string, requestDigest: string) {
    assertControlId(taskExecutionId, 'task execution id'); digest(requestDigest)
    if (await this.read(authority) === null) throw new RunCommandConflict('operation-conflict', 'execution authority is missing')
    const row = await this.index.prepare(`SELECT task_execution_id, admitted_at, receipt_digest, settled_at
      FROM audit_execution_launches WHERE audit_id = ?1 AND epoch = ?2 AND request_digest = ?3`)
      .bind(authority.auditId, authority.epoch, requestDigest)
      .first<{ task_execution_id: string; admitted_at: string; receipt_digest: string | null; settled_at: string | null }>()
    if (row === null) return null
    if (row.task_execution_id !== taskExecutionId || !Number.isFinite(Date.parse(row.admitted_at))
      || (row.receipt_digest === null ? row.settled_at !== null
        : !/^[a-f0-9]{64}$/.test(row.receipt_digest) || !Number.isFinite(Date.parse(row.settled_at ?? '')))) {
      throw new RunCommandConflict('operation-conflict', 'native launch observation differs from its admitted occurrence')
    }
    return { taskExecutionId, requestDigest, admittedAt: row.admitted_at, receiptDigest: row.receipt_digest, settledAt: row.settled_at }
  }

  /** Reserve against a validated persisted task admission. A false result means
   * the state pointer moved: re-read and revalidate, never silently rebase. */
  async admitLaunch(authority: ExecutionAuthority, taskExecutionId: string, requestDigest: string,
    expected: RunStatePointer): Promise<boolean> {
    assertExecutionAuthority(authority); assertControlId(taskExecutionId, 'task execution id'); digest(requestDigest)
    if (expected === undefined || !Number.isSafeInteger(expected.generation) || expected.generation < 1) {
      throw new TypeError('native launch requires its persisted admission pointer')
    }
    digest(expected.digest)
    const key = runStateKey(authority.executionId, expected.generation, expected.digest)
    await this.index.prepare(`INSERT INTO audit_execution_launches
      (audit_id, epoch, task_execution_id, request_digest, admitted_at)
      SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM audit_execution_authority
        WHERE audit_id = ?1 AND epoch = ?2 AND authority_json = ?6 AND status = 'active'
          AND EXISTS (SELECT 1 FROM experiment_runs
            WHERE run_id = audit_execution_authority.execution_id AND status = 'running'
              AND state_key = ?7 AND state_generation = ?8))
        AND NOT ${nativeControlIntent('?6')} AND NOT ${unstartedExecution('?6')}
        AND NOT EXISTS (SELECT 1 FROM audit_execution_launches pending
          WHERE pending.audit_id = ?1 AND pending.epoch = ?2 AND pending.task_execution_id = ?3
            AND pending.request_digest != ?4 AND pending.receipt_digest IS NULL)
      ON CONFLICT DO NOTHING`).bind(authority.auditId, authority.epoch, taskExecutionId, requestDigest,
      new Date().toISOString(), canonicalJson(authority), key, expected.generation).run()
    const row = await this.index.prepare(`SELECT claim.task_execution_id, claim.receipt_digest,
        owner.status, current.status AS run_status, current.state_key, current.state_generation,
        (${nativeControlIntent('?4')} OR ${unstartedExecution('?4')}) AS cancellation_pending
      FROM audit_execution_authority owner JOIN experiment_runs current ON current.run_id = owner.execution_id
      LEFT JOIN audit_execution_launches claim ON owner.audit_id = claim.audit_id
        AND owner.epoch = claim.epoch AND claim.request_digest = ?3
      WHERE owner.audit_id = ?1 AND owner.epoch = ?2 AND owner.authority_json = ?4`)
      .bind(authority.auditId, authority.epoch, requestDigest, canonicalJson(authority))
      .first<{ task_execution_id: string | null; receipt_digest: string | null; status: string;
        run_status: string; state_key: string; state_generation: number; cancellation_pending: number }>()
    if (row === null || row.status !== 'active' || row.run_status !== 'running'
      || (row.task_execution_id !== null && row.task_execution_id !== taskExecutionId)
      || row.receipt_digest !== null) {
      throw new RunCommandConflict('operation-conflict', 'native launch has no active execution authority')
    }
    if (row.cancellation_pending !== 0) throw new RunCommandConflict('operation-conflict', 'native launch has no active execution authority')
    if (row.state_key !== key || row.state_generation !== expected.generation) return false
    if (row.task_execution_id !== taskExecutionId) throw new RunCommandConflict('operation-conflict', 'native launch reservation is missing or conflicts with unsettled task work')
    return true
  }

  /** Read a bounded page after the caller's native cancellation cutoff. No
   * selection from a stale source snapshot can substitute for these claims. */
  async pendingLaunches(authority: ExecutionAuthority) {
    if (await this.read(authority) === null) throw new RunCommandConflict('operation-conflict', 'execution authority is missing')
    const result = await this.index.prepare(`SELECT task_execution_id, request_digest, admitted_at
      FROM audit_execution_launches WHERE audit_id = ?1 AND epoch = ?2 AND receipt_digest IS NULL
      ORDER BY request_digest LIMIT 64`).bind(authority.auditId, authority.epoch)
      .all<{ task_execution_id: string; request_digest: string; admitted_at: string }>()
    return result.results.map(row => {
      assertControlId(row.task_execution_id, 'task execution id'); digest(row.request_digest)
      if (!Number.isFinite(Date.parse(row.admitted_at))) throw new Error('native claim admission time is invalid')
      return { taskExecutionId: row.task_execution_id, requestDigest: row.request_digest, admittedAt: row.admitted_at }
    })
  }

  /** A missing full dispatch is safe to abandon only after the launch cutoff
   * after excluding only independently verified, settled historical requests. */
  async hasTaskLaunch(authority: ExecutionAuthority, taskExecutionId: string, verifiedHistorical: readonly string[] = []): Promise<boolean> {
    assertExecutionAuthority(authority); assertControlId(taskExecutionId, 'task execution id')
    if (await this.read(authority) === null) throw new RunCommandConflict('operation-conflict', 'execution authority is missing')
    for (const value of verifiedHistorical) digest(value)
    return await this.index.prepare(`SELECT 1 FROM audit_execution_launches
      WHERE audit_id = ?1 AND epoch = ?2 AND task_execution_id = ?3
        AND (receipt_digest IS NULL OR request_digest NOT IN (SELECT value FROM json_each(?4))) LIMIT 1`)
      .bind(authority.auditId, authority.epoch, taskExecutionId, canonicalJson(verifiedHistorical)).first() !== null
  }

  /** Only a verified terminal native receipt or physical cancellation proof may settle a claim. */
  async settleLaunch(authority: ExecutionAuthority, requestDigest: string, receiptDigest: string): Promise<void> {
    assertExecutionAuthority(authority); digest(requestDigest); digest(receiptDigest)
    await this.index.prepare(`UPDATE audit_execution_launches
      SET receipt_digest = ?4, settled_at = ?5
      WHERE audit_id = ?1 AND epoch = ?2 AND request_digest = ?3 AND receipt_digest IS NULL
        AND EXISTS (SELECT 1 FROM audit_execution_authority
          WHERE audit_id = ?1 AND epoch = ?2 AND authority_json = ?6)`).bind(authority.auditId,
      authority.epoch, requestDigest, receiptDigest, new Date().toISOString(), canonicalJson(authority)).run()
    const row = await this.index.prepare(`SELECT receipt_digest FROM audit_execution_launches
      WHERE audit_id = ?1 AND epoch = ?2 AND request_digest = ?3`).bind(authority.auditId,
      authority.epoch, requestDigest).first<{ receipt_digest: string | null }>()
    if (row?.receipt_digest !== receiptDigest || await this.read(authority) === null) {
      throw new RunCommandConflict('operation-conflict', 'native launch settlement is missing or differs')
    }
  }

  /** Logical fencing stops new writes/claims; it does NOT assert physical shutdown. */
  async fence(authority: ExecutionAuthority, commandDigest: string): Promise<void> {
    assertExecutionAuthority(authority); digest(commandDigest)
    await this.index.prepare(`UPDATE audit_execution_authority
      SET status = 'fenced', fence_command_digest = ?4, fenced_at = ?5
      WHERE audit_id = ?1 AND epoch = ?2 AND authority_json = ?3 AND status = 'active'`)
      .bind(authority.auditId, authority.epoch, canonicalJson(authority), commandDigest, new Date().toISOString()).run()
    const row = await this.read(authority)
    if (row === null || row.status === 'active' || row.fence_command_digest !== commandDigest) {
      throw new RunCommandConflict('operation-conflict', 'execution fence is missing or belongs to another command')
    }
  }

  /** The control executor calls this only after independently verifying physical custody. */
  async retire(authority: ExecutionAuthority, verifiedPhysicalProofDigest: string): Promise<void> {
    assertExecutionAuthority(authority); digest(verifiedPhysicalProofDigest)
    await this.index.prepare(`UPDATE audit_execution_authority
      SET status = 'retired', retirement_digest = ?4, retired_at = ?5
      WHERE audit_id = ?1 AND epoch = ?2 AND authority_json = ?3 AND status = 'fenced'
        AND NOT EXISTS (SELECT 1 FROM audit_execution_launches
          WHERE audit_id = ?1 AND epoch = ?2 AND receipt_digest IS NULL)`)
      .bind(authority.auditId, authority.epoch, canonicalJson(authority), verifiedPhysicalProofDigest,
        new Date().toISOString()).run()
    const row = await this.read(authority)
    if (row?.status !== 'retired' || row.retirement_digest !== verifiedPhysicalProofDigest) {
      throw new RunCommandConflict('operation-conflict', 'execution still has unsettled work or a different retirement proof')
    }
  }
}
