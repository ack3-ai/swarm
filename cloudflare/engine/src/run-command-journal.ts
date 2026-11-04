import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import { PermanentRunFailure } from './run-errors.js'
import { assertControlId, parseRunCommand, RunCommandConflict, type RunCommand } from './run-commands.js'

/** Pause/continue persistence only; native cancellation and fork need their own evidence transitions. */
export type RunOperationStatus = 'accepted' | 'waiting' | 'applying' | 'applied' | 'rejected' | 'failed'
export interface RunOperation {
  auditId: string
  revision: number
  version: number
  command: RunCommand
  commandDigest: string
  admittedAuthority?: ExecutionAuthority
  status: RunOperationStatus
  receiptDigest?: string
  detail?: { code: string; message: string }
  acceptedAt: string
  updatedAt: string
}
const transitions: Record<RunOperationStatus, readonly RunOperationStatus[]> = {
  accepted: ['waiting', 'applying', 'rejected'],
  waiting: ['waiting', 'applying', 'rejected'],
  applying: ['waiting', 'applied', 'rejected', 'failed'],
  applied: [], rejected: [], failed: [],
}
export type OperationUpdate = Pick<RunOperation, 'status' | 'receiptDigest' | 'detail'>
interface OperationRow { audit_id: string; revision: number; command_id: string; version: number; operation_json: string; operation_digest: string }

function timestamp(now: string): void {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError('operation timestamp is invalid')
}
function ordinal(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('operation ordinal is invalid')
}
function matches(current: RunOperation, update: OperationUpdate): boolean {
  const { status, receiptDigest, detail } = current
  return canonicalJson({ status, receiptDigest, detail }) === canonicalJson(update)
}

/** Immutable decisions in the existing shared run index; no scheduler or configuration copy. */
export class RunCommandJournal {
  constructor(private readonly index: D1Database, readonly auditId: string) {
    assertControlId(auditId, 'audit id')
  }

  /** One immutable journal-version CAS. Callers supply their native/state guards
   * and retain their own readback reconciliation and multi-statement batches.
   * Parameters 1–7 bind the envelope and predecessor; guards start at 8. */
  private async transition(operation: RunOperation, expectedVersion: number, guard = '', values: unknown[] = []) {
    return this.index.prepare(`INSERT INTO audit_run_commands
      (audit_id, revision, command_id, version, operation_json, operation_digest)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6
      WHERE (SELECT MAX(version) FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3) = ?7
      ${guard}
      ON CONFLICT DO NOTHING`).bind(this.auditId, operation.revision, operation.command.id, operation.version,
      canonicalJson(operation), await sha256(operation), expectedVersion, ...values)
  }

  private async decode(row: OperationRow | null): Promise<RunOperation | null> {
    if (row === null) return null
    try {
      const operation = JSON.parse(row.operation_json) as RunOperation
      if (operation.auditId !== this.auditId || row.audit_id !== operation.auditId || row.revision !== operation.revision
        || row.command_id !== operation.command.id || row.version !== operation.version || await sha256(operation) !== row.operation_digest
        || await sha256(parseRunCommand(operation.command)) !== operation.commandDigest
        || !['pause', 'continue'].includes(operation.command.action)
        || !Object.hasOwn(transitions, operation.status)
        || Object.keys(operation).some(key => !['auditId', 'revision', 'version', 'command', 'commandDigest',
          'admittedAuthority', 'status', 'receiptDigest', 'detail', 'acceptedAt', 'updatedAt'].includes(key))) {
        throw new Error('command journal integrity failed')
      }
      ordinal(operation.revision); ordinal(operation.version)
      if (operation.admittedAuthority !== undefined) {
        assertExecutionAuthority(operation.admittedAuthority)
        if (operation.admittedAuthority.auditId !== this.auditId) throw new Error('command admission owner differs')
      }
      return operation
    } catch (cause) { throw new PermanentRunFailure('command journal integrity failed', 'integrity-failed', { cause }) }
  }

  async revision(): Promise<number> {
    return (await this.index.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM audit_run_commands WHERE audit_id = ?1')
      .bind(this.auditId).first<{ revision: number }>())!.revision
  }

  async get(id: string): Promise<RunOperation | null> {
    assertControlId(id, 'command id')
    return this.decode(await this.index.prepare(`SELECT audit_id, revision, command_id, version, operation_json, operation_digest FROM audit_run_commands
      WHERE audit_id = ?1 AND command_id = ?2 ORDER BY version DESC LIMIT 1`).bind(this.auditId, id).first<OperationRow>())
  }

  /** Sequential reconciliation resumes by revision without scanning history. */
  async atRevision(revision: number): Promise<RunOperation | null> {
    ordinal(revision)
    return this.decode(await this.index.prepare(`SELECT audit_id, revision, command_id, version, operation_json, operation_digest FROM audit_run_commands
      WHERE audit_id = ?1 AND revision = ?2 ORDER BY version DESC LIMIT 1`).bind(this.auditId, revision).first<OperationRow>())
  }

  async admit(value: unknown, now = new Date().toISOString(), runningAuthority?: ExecutionAuthority): Promise<RunOperation> {
    const command = parseRunCommand(value)
    if (command.action !== 'pause' && command.action !== 'continue') throw new TypeError('only admission controls are installed')
    timestamp(now)
    const commandDigest = await sha256(command)
    const operation: RunOperation = { auditId: this.auditId, revision: command.expectedRevision + 1, version: 1,
      command, commandDigest, status: 'accepted', acceptedAt: now, updatedAt: now,
      ...(runningAuthority === undefined ? {} : { admittedAuthority: runningAuthority }) }
    // Revision selection and idempotency are one SQL statement. A lost response
    // is reconciled from the immutable row, even after later decisions arrive.
    await this.index.prepare(`INSERT INTO audit_run_commands
      (audit_id, revision, command_id, version, operation_json, operation_digest)
      SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE
        NOT EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3)
        AND (SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?1) = ?6
        AND (?7 IS NULL OR EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?7 AND owner.status = 'active'
            AND run.status = 'running'))
      ON CONFLICT DO NOTHING`).bind(this.auditId, operation.revision, command.id,
      canonicalJson(operation), await sha256(operation), command.expectedRevision,
      runningAuthority === undefined ? null : canonicalJson(runningAuthority)).run()
    const existing = await this.get(command.id)
    if (existing === null) {
      const revision = await this.revision()
      if (revision !== command.expectedRevision) throw new RunCommandConflict('revision-conflict', `audit control revision changed: ${revision}`)
      throw new RunCommandConflict('operation-conflict', 'audit execution changed before command admission')
    }
    if (existing.commandDigest !== commandDigest) {
      throw new RunCommandConflict('idempotency-conflict', 'command id is already bound to a different request')
    }
    return existing
  }

  /** Internal reconciliation only. Admission is never reported as an applied effect. */
  async advance(id: string, expectedVersion: number, update: OperationUpdate,
    now = new Date().toISOString()): Promise<RunOperation> {
    timestamp(now); ordinal(expectedVersion)
    if (Object.keys(update).some(key => !['status', 'receiptDigest', 'detail'].includes(key))
      || !Object.hasOwn(transitions, update.status)
      || (update.receiptDigest !== undefined && !/^[a-f0-9]{64}$/.test(update.receiptDigest))
      || (update.status === 'applied' && update.receiptDigest === undefined)
      || (update.detail !== undefined && (typeof update.detail.code !== 'string'
        || !/^[a-z][a-z0-9-]{0,99}$/.test(update.detail.code)
        || typeof update.detail.message !== 'string' || update.detail.message.length > 2000))) {
      throw new TypeError('operation update is invalid')
    }
    const next = deepClone(update), current = await this.get(id)
    if (current === null) throw new Error('command operation is missing')
    if (matches(current, next)) return current
    if (current.version !== expectedVersion || !transitions[current.status].includes(next.status)) {
      throw new RunCommandConflict('operation-conflict', 'operation changed or transition is invalid')
    }
    const { receiptDigest: _receipt, detail: _detail, ...base } = current
    const operation: RunOperation = { ...base, ...next, version: current.version + 1, updatedAt: now }
    await (await this.transition(operation, expectedVersion)).run()
    const selected = await this.get(id)
    if (selected === null || !matches(selected, next)) {
      throw new RunCommandConflict('operation-conflict', 'operation changed or transition is invalid')
    }
    return selected
  }
}
