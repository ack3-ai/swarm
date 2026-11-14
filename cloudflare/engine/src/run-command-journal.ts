import type { SavedWork } from './saved-work.js'
import { copyState } from './state-copy.js'
import { sourceFenceWitness } from './source-fence.js'
import type { SavedStateReference } from './run-state-pointer.js'
import { assertPreparedExecutionPublication } from './prepared-execution.js'
import { loadAdmittedStageFork, loadPreparedStageFork, assertStageForkDecision, stageForkPublicationDigest, stageForkRejectionDigest, stageForkRejectionDetail,
  type StageForkDecision, type StageForkRejection } from './stage-fork-command.js'
import type { ReleaseLoader } from './execution-releases.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import { PermanentRunFailure } from './run-errors.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import type { RunState, RuntimeRelease } from './contracts.js'
import { assertAuditCancellation, type AuditCancellationEffect } from './run-control-state.js'
import { runStateKey, type RunStatePointer } from './run-state-pointer.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { canonicalJsonDigest } from './canonical-bytes.js'
import { assertControlId, assertSavedStateReference, parseRunCommand, RunCommandConflict, type RunCommand } from './run-commands.js'

type NativeControlIntent = { kind: 'revoke-admission'; inventoryDigest: string }

export type RunOperationStatus = 'accepted' | 'applying' | 'applied' | 'rejected' | 'failed'
export interface RunCommandSource {
  authority: ExecutionAuthority
  state: RunStatePointer
}
export interface RunOperation {
  auditId: string
  revision: number
  version: number
  command: RunCommand
  commandDigest: string
  admittedAuthority?: ExecutionAuthority
  /** New logical audit from completed evidence; never an executor replacement. */
  fork?: StageForkDecision
  status: RunOperationStatus
  /** Exact selected state at the start of native effect reconciliation. This
   * proves historical selection, not revocation or physical termination. */
  source?: RunCommandSource
  /** Selected fork; activation is distinct from Workflow dispatch. */
  prepared?: RunCommandSource & { activatedAt?: string }
  /** Irrevocable native-effect intent. Ordinary status transitions cannot
   * abandon it while an actor RPC may still be applying this exact inventory. */
  nativeEffect?: NativeControlIntent
  /** Digest of the durable transition/effect receipt, not an assertion supplied by the caller. */
  receiptDigest?: string
  detail?: { code: string; message: string }
  acceptedAt: string
  updatedAt: string
}

const transitions: Record<RunOperationStatus, readonly RunOperationStatus[]> = {
  accepted: ['applying', 'rejected'],
  applying: ['applied', 'rejected', 'failed'],
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

function assertSource(source: RunCommandSource, auditId: string): void {
  assertExecutionAuthority(source.authority)
  if (source.authority.auditId !== auditId || !Number.isSafeInteger(source.state.generation)
    || source.state.generation < 1 || !/^[a-f0-9]{64}$/.test(source.state.digest)) {
    throw new TypeError('command source identity is invalid')
  }
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

  /** Resolve transition writes, including a lost ACK, from the selected durable decision. */
  private async reconcileWrite(id: string, write: () => Promise<unknown>,
    accepts: (operation: RunOperation) => boolean, conflict: string): Promise<RunOperation> {
    let failure: unknown
    try { await write() } catch (error) { failure = error }
    const selected = await this.get(id)
    if (selected !== null && accepts(selected)) return selected
    throw failure ?? new RunCommandConflict('operation-conflict', conflict)
  }

  private async decode(row: OperationRow | null): Promise<RunOperation | null> {
    if (row === null) return null
    try {
      const operation = JSON.parse(row.operation_json) as RunOperation
      if (operation.auditId !== this.auditId || row.audit_id !== operation.auditId || row.revision !== operation.revision
        || row.command_id !== operation.command.id || row.version !== operation.version || await sha256(operation) !== row.operation_digest
        || await sha256(parseRunCommand(operation.command)) !== operation.commandDigest
        || !Object.hasOwn(transitions, operation.status)) throw new Error('command journal integrity failed')
      ordinal(operation.revision); ordinal(operation.version)
      if (operation.command.action === 'fork' || operation.fork !== undefined) await assertStageForkDecision(operation)
      if (operation.command.action !== 'fork') {
        assertExecutionAuthority(operation.admittedAuthority!)
        if (operation.admittedAuthority!.auditId !== this.auditId) throw new Error('command admission owner differs')
      }
      if (operation.source !== undefined) assertSource(operation.source, this.auditId)
      if (Object.keys(operation).some(key => ![
        'auditId', 'revision', 'version', 'command', 'commandDigest', 'admittedAuthority', 'fork', 'status',
        'source', 'prepared', 'nativeEffect', 'receiptDigest', 'detail', 'acceptedAt', 'updatedAt',
      ].includes(key))) throw new Error('unsupported command journal fields')
      if (operation.prepared !== undefined && operation.fork === undefined) throw new Error('prepared execution requires a fork')

      if (operation.nativeEffect !== undefined) {
        const intent = operation.nativeEffect
        const revoked = intent.kind === 'revoke-admission' && operation.command.action === 'cancel'
        const settledRevocation = revoked && operation.status === 'applied'
          && /^[a-f0-9]{64}$/.test(operation.receiptDigest ?? '')
        if (operation.source === undefined || !revoked
          || !(operation.status === 'applying' || settledRevocation)
          || !/^[a-f0-9]{64}$/.test(intent.inventoryDigest)
          || Object.keys(intent).sort().join(',') !== 'inventoryDigest,kind') throw new Error('command native effect intent is invalid')
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

  /** An empty read alone cannot resolve an INSERT whose acknowledgement was
   * lost. This single read proves its original admission predicates are now
   * impossible while also proving the exact command has not appeared. */
  async admissionImpossible(id: string, expectedRevision: number, authority: ExecutionAuthority): Promise<boolean> {
    assertControlId(id, 'command id'); assertExecutionAuthority(authority)
    if (authority.auditId !== this.auditId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError('invalid unresolved command admission')
    }
    return await this.index.prepare(`SELECT 1 WHERE
      NOT EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?2)
      AND ((SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?1) > ?3
        OR NOT EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?4 AND owner.status = 'active' AND run.status IN ('running', 'failed')))`
    ).bind(this.auditId, id, expectedRevision, canonicalJson(authority)).first() !== null
  }

  /** Check unresolved registration without importing source bytes. Only these
   * monotonic D1 conflicts prove admission impossible; missing rows, changed
   * pointers/status or unknown source epochs conservatively keep the marker. */
  async forkAdmissionImpossible(id: string, expectedRevision: number, source: SavedStateReference, childId: string): Promise<boolean> {
    assertControlId(id, 'command id'); assertControlId(childId, 'child id')
    assertSavedStateReference(source)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError('invalid unresolved fork admission')
    return await this.index.prepare(`SELECT 1 WHERE
      NOT EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?2)
      AND ((SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?1) > ?3
        OR EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?4 AND state_generation > ?5)
        OR EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = ?6 OR audit_id = ?6))`)
      .bind(this.auditId, id, expectedRevision, source.runId, source.state.generation, childId).first() !== null
  }

  async admit(value: unknown, runningAuthority: ExecutionAuthority, now = new Date().toISOString()): Promise<RunOperation> {
    const command = parseRunCommand(value)
    if (command.action === 'fork') throw new TypeError('fork admission requires verified saved-stage evidence')
    timestamp(now); assertExecutionAuthority(runningAuthority)
    runningAuthority = deepClone(runningAuthority)
    if (runningAuthority.auditId !== this.auditId) throw new TypeError('command admission owner differs')
    const commandDigest = await sha256(command)
    const operation: RunOperation = { auditId: this.auditId, revision: command.expectedRevision + 1, version: 1,
      command, commandDigest, status: 'accepted', acceptedAt: now, updatedAt: now,
      admittedAuthority: runningAuthority }
    // Revision selection and idempotency are one SQL statement. A lost response
    // is reconciled from the immutable row, even after later decisions arrive.
    await this.index.prepare(`INSERT INTO audit_run_commands
      (audit_id, revision, command_id, version, operation_json, operation_digest)
      SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE
        NOT EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3)
        AND (SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?1) = ?6
        AND EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?7 AND owner.status = 'active'
            AND (run.status = 'running' OR (?8 = 1 AND run.status = 'failed')))
      ON CONFLICT DO NOTHING`).bind(this.auditId, operation.revision, command.id,
      canonicalJson(operation), await sha256(operation), command.expectedRevision,
      canonicalJson(runningAuthority), command.action === 'cancel' ? 1 : 0).run()
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

  /** Bind verified immutable child bytes to the exact completed source selected
   * in D1. No route, lease, authority, source mutation or model call is issued. */
  async admitStageFork(value: unknown, exported: SavedWork, prepared: RunState,
    loadRelease: ReleaseLoader, loadState: ExecutionSourceLoader,
    now = new Date().toISOString()): Promise<RunOperation> {
    const command = parseRunCommand(value)
    const source = copyState(exported.source), pointer = exported.sourceReference.state
    prepared = copyState(prepared); timestamp(now)
    if (command.action !== 'fork') throw new TypeError('fork command is required')
    const commandDigest = await sha256(command), existing = await this.get(command.id)
    if (existing !== null) {
      if (existing.commandDigest !== commandDigest) throw new RunCommandConflict('idempotency-conflict', 'command id is already bound to a different request')
      await loadAdmittedStageFork(existing, loadState)
      return existing
    }
    if (!['completed', 'failed', 'stopped'].includes(source.status) || command.source.runId !== source.runId
      || command.source.state.generation !== pointer.generation || command.source.state.digest !== pointer.digest
      || (source.executionAuthority === undefined ? source.runId : source.rootRunId) !== this.auditId) {
      throw new RunCommandConflict('operation-conflict', 'fork source differs from the requested settled audit')
    }
    const operation: RunOperation = { auditId: this.auditId, revision: command.expectedRevision + 1, version: 1,
      command, commandDigest, status: 'accepted', acceptedAt: now, updatedAt: now,
      fork: { experimentId: prepared.experimentId }, prepared: { authority: prepared.executionAuthority!,
        state: { generation: prepared.stateGeneration, digest: await sha256(prepared) } } }
    // The immutable archive, rather than caller memory, must reconstruct the
    // exact new root. The storage entry point additionally checks artifact bytes.
    await loadPreparedStageFork(operation, loadRelease, loadState)
    const authority = source.executionAuthority, disposition = sourceFenceWitness(prepared.forkOrigin?.sourceFence, 15)
    await this.index.prepare(`INSERT INTO audit_run_commands
      (audit_id, revision, command_id, version, operation_json, operation_digest)
      SELECT ?1, ?2, ?3, 1, ?4, ?5 WHERE
        NOT EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3)
        AND (SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?1) = ?6
        AND EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?7 AND experiment_id = ?8
          AND status = ?14 AND state_key = ?9 AND state_generation = ?10)
        AND ${disposition.sql}
        AND ((?11 IS NULL
            AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = ?7 OR audit_id IN (?1, ?12)))
          OR (?11 IS NOT NULL AND EXISTS (SELECT 1 FROM audit_execution_authority owner
            WHERE owner.audit_id = ?1 AND owner.execution_id = ?7 AND owner.authority_json = ?11
              AND owner.epoch = (SELECT MAX(epoch) FROM audit_execution_authority WHERE audit_id = ?1))))
        AND NOT EXISTS (SELECT 1 FROM audit_execution_launches
          WHERE audit_id IN (?1, ?12, ?7) AND receipt_digest IS NULL)
        AND NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?13)
        AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = ?13 OR audit_id = ?13)
        AND NOT EXISTS (SELECT 1 FROM run_runtime_routes WHERE run_id = ?13)
        AND NOT EXISTS (SELECT 1 FROM runtime_slot_run_leases WHERE run_id = ?13)
      ON CONFLICT DO NOTHING`).bind(this.auditId, operation.revision, command.id, canonicalJson(operation),
      await sha256(operation), command.expectedRevision, source.runId, source.experimentId,
      runStateKey(source.runId, pointer.generation, pointer.digest), pointer.generation,
      authority === undefined ? null : canonicalJson(authority), source.rootRunId, prepared.runId, source.status,
      ...disposition.values).run()
    const selected = await this.get(command.id)
    if (selected === null) {
      if (await this.revision() !== command.expectedRevision) throw new RunCommandConflict('revision-conflict', 'audit control revision changed before fork admission')
      throw new RunCommandConflict('operation-conflict', 'fork source or child identity changed before admission')
    }
    if (selected.commandDigest !== commandDigest) throw new RunCommandConflict('idempotency-conflict', 'command id is already bound to a different request')
    // Our exact envelope already reconstructed the immutable archive before
    // CAS. A concurrent winner may have a different preparation timestamp or
    // later decision; only that different envelope needs another reconstruction.
    if (canonicalJson(selected) !== canonicalJson(operation)) await loadPreparedStageFork(selected, loadRelease, loadState)
    return selected
  }

  /** A failed publication decision owns no child or lease. The exact operation
   * CAS races activation; a published or rejected winner is adopted unchanged. */
  async rejectStageFork(id: string, expectedVersion: number, rejection: StageForkRejection,
    now = new Date().toISOString()): Promise<RunOperation> {
    assertControlId(id, 'command id'); ordinal(expectedVersion); timestamp(now)
    rejection = deepClone(rejection)
    const current = await this.get(id)
    if (current?.fork === undefined || current.command.action !== 'fork') throw new Error('prepared fork command is missing')
    if (current.prepared!.activatedAt !== undefined || current.fork.rejection !== undefined) return current
    if (current.version !== expectedVersion || current.status !== 'accepted') throw new RunCommandConflict('operation-conflict', 'fork publication decision changed')
    const operation: RunOperation = { ...current, status: 'rejected', version: current.version + 1, updatedAt: now,
      fork: { ...current.fork, rejection }, detail: stageForkRejectionDetail(rejection),
      receiptDigest: await stageForkRejectionDigest(current, rejection) }
    await assertStageForkDecision(operation)
    const child = current.prepared!.authority.executionId, pointer = current.prepared!.state
    // Same-command ownership or selected prepared bytes without an activation
    // witness is an integrity fault. Route/lease-only orphans are also ambiguous.
    // A positive unrelated owner can establish a collision, never a cleanup right.
    return this.reconcileWrite(id, async () => (await this.transition(operation, current.version, `
        AND EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3 AND version = ?7 AND operation_digest = ?8)
        AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE (audit_id = ?9 OR execution_id = ?9) AND command_digest = ?10)
        AND NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?9 AND state_key = ?11)
        AND ((NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?9)
            AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE audit_id = ?9 OR execution_id = ?9)
            AND NOT EXISTS (SELECT 1 FROM run_runtime_routes WHERE run_id = ?9)
            AND NOT EXISTS (SELECT 1 FROM runtime_slot_run_leases WHERE run_id = ?9))
          OR EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = ?9 AND command_digest != ?10))
        AND (?12 IS NULL OR EXISTS (SELECT 1 FROM audit_execution_authority
          WHERE execution_id = ?9 AND authority_json = ?12 AND command_digest = ?13))`, [
      await sha256(current), child, current.commandDigest, runStateKey(child, pointer.generation, pointer.digest),
      rejection.kind === 'child-conflict' ? canonicalJson(rejection.authority) : null,
      rejection.kind === 'child-conflict' ? rejection.commandDigest : null])).run(),
      selected => selected.prepared?.activatedAt !== undefined || selected.fork?.rejection !== undefined,
      'fork rejection lacks an unclaimed or independently owned destination')
  }

  /** Anchor native reconciliation to the state actually selected by D1. An R2
   * object at a plausible generation is not sufficient: orphan writes exist.
   * This is not a fence; already admitted callbacks may still be running. */
  async beginEffect(id: string, expectedVersion: number, state: RunState,
    now = new Date().toISOString()): Promise<RunOperation> {
    assertControlId(id, 'command id'); ordinal(expectedVersion); timestamp(now)
    // Capture small identity fields and stream the state digest before yielding.
    // A long audit need not duplicate its entire artifact/journal history merely
    // to bind one command, nor may a later caller mutation change this source.
    const snapshot = { executionAuthority: deepClone(state.executionAuthority), status: state.status,
      rootRunId: state.rootRunId, runId: state.runId, runtimeRelease: deepClone(state.runtimeRelease),
      stateGeneration: state.stateGeneration, controlRevision: state.controls?.revision ?? 0 }
    const stateDigest = canonicalJsonDigest(state)
    const current = await this.get(id)
    if (current === null) throw new Error('command operation is missing')
    if (current.fork !== undefined) throw new RunCommandConflict('operation-conflict', 'fork requires its publication transition')
    if (current.command.action !== 'cancel') throw new Error('native effect belongs to its historical app version')
    if (snapshot.executionAuthority === undefined
      || !['running', 'failed'].includes(snapshot.status)
      || snapshot.rootRunId !== this.auditId || snapshot.executionAuthority.executionId !== snapshot.runId
      || snapshot.executionAuthority.runtimeDigest !== await sha256(snapshot.runtimeRelease ?? null)) {
      throw new RunCommandConflict('operation-conflict', 'command source has no matching execution authority')
    }
    const source: RunCommandSource = { authority: snapshot.executionAuthority,
      state: { generation: snapshot.stateGeneration, digest: stateDigest } }
    assertSource(source, this.auditId)
    if (current.source !== undefined) {
      if (canonicalJson(current.source) === canonicalJson(source)) return current
      // Native effects have not started: admitted callbacks may have advanced
      // the selected state while evidence was collected. Rebuild the inventory
      // from that newer state, preserving the old source in immutable history.
      if (current.version !== expectedVersion || current.status !== 'applying' || current.nativeEffect !== undefined
        || canonicalJson(current.source.authority) !== canonicalJson(source.authority)
        || source.state.generation <= current.source.state.generation) {
        throw new RunCommandConflict('operation-conflict', 'command source is already bound to another state')
      }
    }
    if (current.version !== expectedVersion || !['accepted', 'applying'].includes(current.status)
      || current.command.expectedRevision !== snapshot.controlRevision) {
      throw new RunCommandConflict('operation-conflict', 'command cannot begin at this state or operation version')
    }
    const { receiptDigest: _receipt, detail: _detail, ...base } = current
    const operation: RunOperation = { ...base, source, status: 'applying', version: current.version + 1, updatedAt: now }
    return this.reconcileWrite(id, async () => (await this.transition(operation, expectedVersion, `
        AND EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?8 AND owner.status = 'active'
            AND run.status = ?11 AND run.state_key = ?9 AND run.state_generation = ?10)`, [
      canonicalJson(source.authority),
      runStateKey(snapshot.runId, source.state.generation, source.state.digest), source.state.generation, snapshot.status])).run(),
      selected => canonicalJson(selected.source) === canonicalJson(source),
      'command source or execution changed before effect admission')
  }

  async activatePreparedExecution(id: string, loadState: ExecutionSourceLoader,
    observedRuntime?: RuntimeRelease, now = new Date().toISOString()): Promise<RunOperation> {
    assertControlId(id, 'command id'); timestamp(now)
    const current = await this.get(id)
    if (current === null) throw new Error('execution command is missing')
    if (current.fork?.rejection !== undefined) return current
    const selected = current.prepared
    if (selected === undefined) throw new Error('prepared execution identity is missing')
    if (current.fork === undefined) throw new Error('execution activation requires an immutable fork')
    const state = await loadAdmittedStageFork(current, loadState)
    const runtime = state.runtimeRelease!, runtimeJson = canonicalJson(runtime)
    if (observedRuntime !== undefined && canonicalJson(observedRuntime) !== runtimeJson) throw new Error('execution runtime identity differs')
    if (observedRuntime === undefined) throw new Error('fork activation requires an observed runtime')
    if (selected.activatedAt !== undefined) return this.verifyPreparedExecutionActivation(id, loadState)
    const disposition = sourceFenceWitness(state.forkOrigin?.sourceFence, 14)
    const guard = `${disposition.sql}
      AND NOT EXISTS (SELECT 1 FROM run_runtime_routes WHERE run_id = ?9)
      AND NOT EXISTS (SELECT 1 FROM runtime_slot_run_leases WHERE run_id = ?9)`
    const guardValues = disposition.values
    const operation: RunOperation = { ...current, status: 'applied', version: current.version + 1, updatedAt: now,
      prepared: { ...selected, activatedAt: now } }
    operation.receiptDigest = await stageForkPublicationDigest(operation)
    await assertStageForkDecision(operation)
    const digest = await sha256(operation)
    const witness = `EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?2 AND version = ?3 AND operation_digest = ?4)`
    const values = [this.auditId, id, operation.version, digest]
    const statements = [
      await this.transition(operation, current.version, `
          AND EXISTS (SELECT 1 FROM audit_run_commands WHERE audit_id = ?1 AND command_id = ?3 AND version = ?7 AND operation_digest = ?8)
          AND NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?9)
          AND NOT EXISTS (SELECT 1 FROM audit_execution_authority WHERE execution_id = ?9 OR (audit_id = ?10 AND epoch >= ?11))
          AND (COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0) = 0
            OR EXISTS (SELECT 1 FROM runtime_slots WHERE slot_id = ?12 AND runtime_release_json = ?13
              AND NOT EXISTS (SELECT 1 FROM runtime_slot_control WHERE singleton = 1 AND rotating_slot_id = ?12)))
          AND ${guard}`, [
      await sha256(current), state.runId, selected.authority.auditId, selected.authority.epoch,
        runtime.id, runtimeJson, ...guardValues]),
      this.index.prepare(`INSERT INTO audit_execution_authority
        (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at)
        SELECT ?5, ?6, ?7, ?8, ?9, 'active', ?10 WHERE ${witness}`)
        .bind(...values, selected.authority.auditId, selected.authority.epoch, state.runId, canonicalJson(selected.authority), current.commandDigest, now),
      this.index.prepare(`INSERT INTO experiment_runs
        (run_id, experiment_id, status, state_key, state_generation, checkpoint_digest, updated_at, terminal_reason)
        SELECT ?5, ?6, 'running', ?7, ?8, ?9, ?10, NULL WHERE ${witness}`)
        .bind(...values, state.runId, state.experimentId, runStateKey(state.runId, state.stateGeneration, selected.state.digest),
          state.stateGeneration, state.checkpoints.at(-1)?.digest ?? null, state.updatedAt),
    ]
    statements.push(
      this.index.prepare(`INSERT INTO run_runtime_routes (run_id, experiment_id, runtime_release_json, reserved_at)
        SELECT ?5, ?6, ?7, ?8 WHERE ${witness}`)
        .bind(...values, state.runId, state.experimentId, runtimeJson, now),
      this.index.prepare(`INSERT INTO runtime_slot_run_leases (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled)
        SELECT ?5, ?6, ?7, ?8, ?9, COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0) WHERE ${witness}`)
        .bind(...values, state.runId, state.experimentId, runtime.id, runtimeJson, now))
    const activated = (value: RunOperation | null) => value !== null && value.commandDigest === current.commandDigest
      && value.prepared?.activatedAt !== undefined
      && canonicalJson({ authority: value.prepared.authority, state: value.prepared.state })
        === canonicalJson({ authority: selected.authority, state: selected.state })
    const published = await this.reconcileWrite(id, () => this.index.batch(statements),
      value => value.fork?.rejection !== undefined || activated(value),
      'execution activation lost its operation or destination')
    if (published.fork?.rejection !== undefined) return published
    return this.verifyPreparedExecutionActivation(id, loadState)
  }

  /** Historical verification never rewinds progress or reopens a released lease. */
  async verifyPreparedExecutionActivation(id: string, loadState: ExecutionSourceLoader): Promise<RunOperation> {
    const operation = await this.get(id)
    if (operation?.prepared?.activatedAt === undefined) throw new Error('execution activation publication is missing')
    await assertPreparedExecutionPublication(this.index, operation, await loadAdmittedStageFork(operation, loadState))
    return operation
  }

  /** Internal reconciliation only. Admission is never reported as an applied effect. */
  async beginNativeEffect(id: string, expectedVersion: number, inventoryDigest: string,
    now = new Date().toISOString()): Promise<RunOperation> {
    assertControlId(id, 'command id'); ordinal(expectedVersion); timestamp(now)
    if (!/^[a-f0-9]{64}$/.test(inventoryDigest)) throw new TypeError('native inventory digest is invalid')
    const current = await this.get(id)
    if (current?.source === undefined || current.status !== 'applying'
      || current.command.action !== 'cancel') {
      throw new RunCommandConflict('operation-conflict', 'native effect requires its applying source')
    }
    const source = current.source
    const nativeEffect: NativeControlIntent = { kind: 'revoke-admission', inventoryDigest }
    if (current.nativeEffect !== undefined) {
      if (canonicalJson(current.nativeEffect) !== canonicalJson(nativeEffect)) {
        throw new RunCommandConflict('operation-conflict', 'native effect inventory is already bound')
      }
      return current
    }
    if (current.version !== expectedVersion) throw new RunCommandConflict('operation-conflict', 'command changed before native effect intent')
    const operation: RunOperation = { ...current, nativeEffect, version: current.version + 1, updatedAt: now }
    return this.reconcileWrite(id, async () => (await this.transition(operation, expectedVersion, `
        AND EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?8 AND owner.status = 'active'
            AND (run.status = 'running' OR (?11 = 1 AND run.status = 'failed'))
            AND run.state_key = ?9 AND run.state_generation = ?10)
`, [
      canonicalJson(source.authority),
      runStateKey(source.authority.executionId, source.state.generation, source.state.digest),
      source.state.generation, 1])).run(),
      selected => canonicalJson(selected.nativeEffect) === canonicalJson(nativeEffect)
        && canonicalJson(selected.source) === canonicalJson(current.source),
      'command source or execution changed before native effect intent')
  }

  /** Called only after verifying the archived cancellation inventory/stop proof.
   * Commit the ACK against the selected terminal state, not a caller's flag. */
  async completeCancellation(id: string, expectedVersion: number, state: RunState,
    now = new Date().toISOString()): Promise<RunOperation> {
    assertControlId(id, 'command id'); ordinal(expectedVersion); timestamp(now)
    state = copyState(state)
    await assertAuditCancellation(state)
    const event = state.journal.at(-2), receipt = state.controls?.lastReceipt
    if (event?.type !== 'run.cancelled' || receipt === undefined || receipt.commandId !== id
      || state.rootRunId !== this.auditId) throw new RunCommandConflict('operation-conflict', 'cancellation terminal receipt is missing')
    const effect = event.payload as AuditCancellationEffect
    const current = await this.get(id), receiptDigest = await sha256(receipt)
    if (current === null || canonicalJson(current.command) !== canonicalJson(effect.command)
      || current.commandDigest !== receipt.commandDigest || current.revision !== receipt.revision
      || canonicalJson(current.source) !== canonicalJson(effect.source)
      || current.nativeEffect?.kind !== 'revoke-admission' || current.nativeEffect.inventoryDigest !== effect.inventoryDigest) {
      throw new RunCommandConflict('operation-conflict', 'cancellation terminal receipt differs from its command')
    }
    if (current.status === 'applied' && current.receiptDigest === receiptDigest) return current
    if (current.status !== 'applying' || current.version !== expectedVersion) {
      throw new RunCommandConflict('operation-conflict', 'command changed before cancellation acknowledgement')
    }
    const operation: RunOperation = { ...current, status: 'applied', receiptDigest,
      version: current.version + 1, updatedAt: now }
    return this.reconcileWrite(id, async () => (await this.transition(operation, expectedVersion, `
        AND EXISTS (SELECT 1 FROM audit_execution_authority owner
          JOIN experiment_runs run ON run.run_id = owner.execution_id
          WHERE owner.audit_id = ?1 AND owner.authority_json = ?8 AND owner.status = 'active'
            AND run.status = 'stopped' AND run.state_key = ?9 AND run.state_generation = ?10)
        AND NOT EXISTS (SELECT 1 FROM audit_execution_launches
          WHERE audit_id = ?1 AND epoch = ?11 AND receipt_digest IS NULL)`, [
      canonicalJson(effect.source.authority),
      runStateKey(state.runId, state.stateGeneration, await sha256(state)), state.stateGeneration,
      effect.source.authority.epoch])).run(),
      selected => selected.status === 'applied' && selected.receiptDigest === receiptDigest,
      'cancellation state, authority or claims changed before acknowledgement')
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
    if (current.fork !== undefined) throw new RunCommandConflict('operation-conflict', 'fork requires its publication transition')
    if (matches(current, next)) return current
    if (current.nativeEffect !== undefined) {
      throw new RunCommandConflict('operation-conflict', 'native effect must reconcile before changing command outcome')
    }
    if (current.version !== expectedVersion || !transitions[current.status].includes(next.status)) {
      throw new RunCommandConflict('operation-conflict', 'operation changed or transition is invalid')
    }
    const { receiptDigest: _receipt, detail: _detail, ...base } = current
    const operation: RunOperation = { ...base, ...next, version: current.version + 1, updatedAt: now }
    return this.reconcileWrite(id, async () => (await this.transition(operation, expectedVersion)).run(),
      selected => matches(selected, next),
      'operation changed or transition is invalid')
  }
}
