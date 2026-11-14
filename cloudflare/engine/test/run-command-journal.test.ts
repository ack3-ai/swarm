import { createControlledMachine } from './support/controlled-machine.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parseRunCommand, type RunCommand } from '../src/run-commands.js'
import { RunCommandJournal, type RunOperation } from '../src/run-command-journal.js'
import { sqliteD1 } from './support/sqlite-d1.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { RunMachine } from '../src/machine.js'
import { audit0Definition } from './support/audit0-config.js'
import { runStateKey } from '../src/run-state-pointer.js'
import { sha256 } from '../src/canonical.js'

async function storedVersion(d1: D1Database, journal: RunCommandJournal, id: string, version: number): Promise<RunOperation> {
  const row = await d1.prepare('SELECT operation_json, operation_digest FROM audit_run_commands WHERE audit_id=?1 AND command_id=?2 AND version=?3')
    .bind(journal.auditId, id, version).first<{ operation_json: string; operation_digest: string }>()
  const operation = JSON.parse(row!.operation_json) as RunOperation
  expect(await sha256(operation)).toBe(row!.operation_digest)
  return operation
}

const close: Array<() => void> = []
afterEach(() => close.splice(0).forEach(fn => fn()))
async function fixture() {
  const db = sqliteD1()
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  close.push(() => db.sqlite.close())
  const authority = { auditId: 'audit-1', executionId: 'audit-1', epoch: 0, runtimeDigest: await sha256(null) }
  const ownership = new ExecutionAuthorityStore(db.d1)
  await ownership.activate(authority, 'a'.repeat(64))
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), authority.executionId,
    undefined, undefined, authority)
  await machine.start()
  const state = machine.snapshot(), digest = await sha256(state)
  db.sqlite.prepare(`INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?)`).run(state.runId, state.experimentId,
      runStateKey(state.runId, state.stateGeneration, digest), state.stateGeneration, state.updatedAt)
  const publish = async () => {
    if (machine.view().status === 'stopped') await machine.fail('synthetic terminal cleanup failure')
    else await machine.seal()
    const next = machine.view()
    db.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = ?, updated_at = ?, status = ?')
      .run(runStateKey(next.runId, next.stateGeneration, await sha256(next)), next.stateGeneration, next.updatedAt, next.status)
    return next
  }
  let loseNextResponse = false
  db.onAfterRun(() => {
    if (loseNextResponse) { loseNextResponse = false; throw new Error('response lost after commit') }
  })
  return { ...db, state, machine, publish, authority, ownership,
    source: { authority, state: { generation: state.stateGeneration, digest } },
    loseResponse: () => { loseNextResponse = true }, journal: new RunCommandJournal(db.d1, 'audit-1') }
}

const pause = (id = 'retry-verifier', expectedRevision = 0): RunCommand => ({
  id, expectedRevision, reason: 'Hold verifier admission',
  action: 'pause', scope: { kind: 'tasks', taskIds: ['verifier'] },
})

async function sourceFixture(command: RunCommand = { id: 'cancel-audit', expectedRevision: 0, reason: 'stop audit', action: 'cancel', scope: { kind: 'audit' } }) {
  const f = await fixture()
  return { ...f, admitted: await f.journal.admit(command, f.authority) }
}

describe('command effect source', () => {
  it('anchors the selected source once and preserves it through later command versions', async () => {
    const f = await sourceFixture()
    // Queued commands do not prevent reconciliation of the next processed revision.
    await f.journal.admit(pause('later', 1), f.authority)
    const applying = await f.journal.beginEffect(f.admitted.command.id, 1, f.state)
    expect(applying).toMatchObject({ status: 'applying', version: 2, source: f.source })
    await f.publish()
    await f.ownership.fence(f.authority, 'b'.repeat(64))
    expect(await f.journal.beginEffect(f.admitted.command.id, 1, f.state)).toEqual(applying)
    expect((await storedVersion(f.d1, f.journal, f.admitted.command.id, 2))!.source).toEqual(f.source)
    await expect(f.journal.beginEffect(f.admitted.command.id, applying.version,
      { ...f.state, terminalReason: 'different bytes at the same generation' })).rejects.toThrow('already bound')
  })

  it('reconciles a lost source-binding acknowledgement without refreshing the original source', async () => {
    const f = await sourceFixture()
    f.loseResponse()
    await expect(f.journal.beginEffect(f.admitted.command.id, 1, f.state)).resolves.toMatchObject({ version: 2, source: f.source })
    const resumed = new RunCommandJournal(f.d1, 'audit-1')
    expect(await resumed.beginEffect(f.admitted.command.id, 1, f.state)).toMatchObject({ version: 2, source: f.source })
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_run_commands').get()!.n).toBe(2)
  })

  it('binds original state identity when a caller reuses the state object during asynchronous I/O', async () => {
    const f = await sourceFixture()
    const binding = f.journal.beginEffect(f.admitted.command.id, 1, f.state)
    f.state.stateGeneration++
    f.state.rootRunId = 'changed-after-binding-started'
    f.state.executionAuthority!.epoch++
    expect((await binding).source).toEqual(f.source)
  })

  it.each(['orphan', 'fenced', 'terminal', 'operation-version', 'revision', 'runtime', 'run', 'audit'])
    ('refuses a %s source without binding or changing command outcome', async change => {
      const f = await sourceFixture(), state = structuredClone(f.state)
      if (change === 'orphan') state.terminalReason = 'unselected R2 state'
      if (change === 'fenced') await f.ownership.fence(f.authority, 'b'.repeat(64))
      if (change === 'terminal') f.sqlite.prepare("UPDATE experiment_runs SET status = 'completed'").run()
      if (change === 'operation-version') await f.journal.advance(f.admitted.command.id, 1, { status: 'applying' })
      if (change === 'revision') await f.journal.admit(pause('future', 1), f.authority)
      if (change === 'runtime') state.executionAuthority!.runtimeDigest = 'd'.repeat(64)
      if (change === 'run') state.runId = 'another-executor'
      if (change === 'audit') state.rootRunId = 'another-audit'
      const id = change === 'revision' ? 'future' : f.admitted.command.id
      const before = await f.journal.get(id)
      await expect(f.journal.beginEffect(id, 1, state)).rejects.toThrow()
      expect(await f.journal.get(id)).toEqual(before)
    })

  it('rejects a competing source binding rather than replacing its snapshot', async () => {
    const f = await sourceFixture()
    const original = await f.journal.beginEffect(f.admitted.command.id, 1, f.state)
    const next = await f.publish()
    await expect(f.journal.beginEffect(f.admitted.command.id, 1, next)).rejects.toThrow('already bound')
    expect(await f.journal.get(f.admitted.command.id)).toEqual(original)
  })

  it('rebases a progressed selected source only before native intent', async () => {
    const f = await sourceFixture(), id = f.admitted.command.id
    const first = await f.journal.beginEffect(id, 1, f.state)
    const next = await f.publish(), digest = await sha256(next)
    await expect(f.journal.beginNativeEffect(id, first.version, 'd'.repeat(64))).rejects.toThrow('source or execution changed')
    f.loseResponse()
    await expect(f.journal.beginEffect(id, first.version, next)).resolves.toMatchObject({ status: 'applying', source: { state: { generation: next.stateGeneration } } })
    const rebased = await f.journal.beginEffect(id, first.version, next)
    expect(rebased.source).toEqual({ authority: f.authority, state: { generation: next.stateGeneration, digest } })
    expect((await storedVersion(f.d1, f.journal, id, first.version))!.source).toEqual(first.source)
    // A stale collector cannot bind the previous source's native intent.
    await expect(f.journal.beginNativeEffect(id, first.version, 'd'.repeat(64))).rejects.toThrow('command changed')
    const intent = await f.journal.beginNativeEffect(id, rebased.version, 'f'.repeat(64))
    const later = await f.publish()
    await expect(f.journal.beginEffect(id, intent.version, later)).rejects.toThrow('already bound')
    // An already committed native effect remains recoverable after later state changes.
    expect(await f.journal.beginNativeEffect(id, rebased.version, 'f'.repeat(64))).toEqual(intent)
  })

  it.each(['orphan', 'same-generation', 'older-generation', 'authority', 'revision'])
    ('rejects a %s rebase and preserves the previously selected source', async change => {
      const f = await sourceFixture(), id = f.admitted.command.id
      const original = await f.journal.beginEffect(id, 1, f.state)
      const next = structuredClone(f.state)
      next.stateGeneration++
      if (change === 'same-generation') {
        next.stateGeneration = f.state.stateGeneration
        next.terminalReason = 'different bytes at the same generation'
      }
      if (change === 'older-generation') next.stateGeneration = f.state.stateGeneration - 1
      if (change === 'authority') next.executionAuthority!.epoch++
      if (change === 'revision') next.controls = { ...next.controls!, revision: 1 }
      if (change === 'same-generation') expect(() => f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?')
        .run(runStateKey(next.runId, next.stateGeneration, 'f'.repeat(64)))).toThrow('immutable')

      await expect(f.journal.beginEffect(id, original.version, next)).rejects.toThrow()
      expect(await f.journal.get(id)).toEqual(original)
    })

  it.each(['selected-state', 'fenced', 'terminal'])
    ('atomically refuses native intent if %s changes after reading the applying operation', async change => {
      const f = await sourceFixture(), id = f.admitted.command.id
      const source = await f.journal.beginEffect(id, 1, f.state)
      const read = f.journal.get.bind(f.journal)
      let intercept = true
      f.journal.get = async commandId => {
        const result = await read(commandId)
        if (intercept) {
          intercept = false
          if (change === 'selected-state') await f.publish()
          if (change === 'terminal') f.sqlite.prepare("UPDATE experiment_runs SET status = 'completed'").run()
          if (change === 'fenced') await f.ownership.fence(f.authority, 'b'.repeat(64))
        }
        return result
      }
      await expect(f.journal.beginNativeEffect(id, source.version, 'c'.repeat(64))).rejects.toThrow('source or execution changed')
      expect(await f.journal.get(id)).toEqual(source)
    })

  it('keeps native effect intent irrevocable through lost acknowledgement and partial custody', async () => {
    const f = await sourceFixture(), id = f.admitted.command.id
    const source = await f.journal.beginEffect(id, 1, f.state)
    f.loseResponse()
    await expect(f.journal.beginNativeEffect(id, source.version, 'c'.repeat(64))).resolves.toMatchObject({ nativeEffect: { kind: 'revoke-admission', inventoryDigest: 'c'.repeat(64) } })
    const intent = await f.journal.beginNativeEffect(id, source.version, 'c'.repeat(64))
    expect(intent.nativeEffect).toEqual({ kind: 'revoke-admission', inventoryDigest: 'c'.repeat(64) })
    await expect(f.journal.beginNativeEffect(id, intent.version, 'd'.repeat(64))).rejects.toThrow('already bound')
    for (const status of ['failed', 'rejected', 'applied'] as const) {
      await expect(f.journal.advance(id, intent.version, { status, receiptDigest: 'f'.repeat(64) })).rejects.toThrow('must reconcile')
    }
    expect(await f.journal.beginNativeEffect(id, source.version, 'c'.repeat(64))).toEqual(intent)
  })

  it('refuses native intent when a competing outcome won before intent admission', async () => {
    const f = await sourceFixture(), id = f.admitted.command.id
    const source = await f.journal.beginEffect(id, 1, f.state)
    const rejected = await f.journal.advance(id, source.version, { status: 'rejected' })
    await expect(f.journal.beginNativeEffect(id, source.version, 'c'.repeat(64))).rejects.toThrow('requires its applying source')
    expect(await f.journal.get(id)).toEqual(rejected)
  })
})

describe('durable run commands', () => {
  it('reconciles a lost admission response without consuming another revision', async () => {
    const { d1, journal, loseResponse, authority } = await fixture()
    loseResponse()
    await expect(journal.admit(pause(), authority)).rejects.toThrow('response lost')
    const retried = await new RunCommandJournal(d1, 'audit-1').admit(pause(), authority)
    expect(retried).toMatchObject({ revision: 1, version: 1, status: 'accepted' })
    expect(await journal.revision()).toBe(1)
    expect(await journal.atRevision(1)).toEqual(retried)
    expect(await journal.atRevision(2)).toBeNull()
  })

  it('admits one winner when independent decisions race at the same revision', async () => {
    const { d1, journal, loseResponse, authority } = await fixture()
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => journal.admit(pause(`retry-${i}`), authority)))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(19)
    expect(await journal.revision()).toBe(1)
    const first = await journal.atRevision(1)
    expect(first).not.toBeNull()
    expect(await journal.admit(first!.command, authority)).toEqual(first)
    await journal.admit(pause('second-decision', 1), authority)
    expect(await journal.revision()).toBe(2)
  })

  it('does not partially admit a command when the atomic insert fails', async () => {
    const { journal, sqlite, authority } = await fixture()
    sqlite.exec("CREATE TRIGGER fail_command BEFORE INSERT ON audit_run_commands BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END")
    await expect(journal.admit(pause(), authority)).rejects.toThrow('injected storage failure')
    expect(await journal.revision()).toBe(0)
    expect(await journal.get('retry-verifier')).toBeNull()
    sqlite.exec('DROP TRIGGER fail_command')
    expect((await journal.admit(pause(), authority)).revision).toBe(1)
  })

  it('refuses to reuse a command id with a different body, even at the current revision', async () => {
    const { journal, authority } = await fixture()
    await journal.admit(pause(), authority)
    await expect(journal.admit({ ...pause(), expectedRevision: 1 }, authority)).rejects.toMatchObject({ code: 'idempotency-conflict' })
    await expect(journal.admit({ ...pause(), action: 'continue' }, authority)).rejects.toMatchObject({ code: 'idempotency-conflict' })
    await expect(journal.admit(pause('another', 0), authority)).rejects.toMatchObject({ code: 'revision-conflict' })
  })

  it('keeps admission separate from applied effects and preserves every transition receipt', async () => {
    const { d1, journal, loseResponse, authority } = await fixture()
    const admitted = await journal.admit(pause(), authority)
    await expect(journal.advance(admitted.command.id, 1, { status: 'applied', receiptDigest: 'a'.repeat(64) }))
      .rejects.toMatchObject({ code: 'operation-conflict' })
    const applying = await journal.advance(admitted.command.id, 1, { status: 'applying' })
    await expect(journal.advance(admitted.command.id, applying.version, { status: 'applied' })).rejects.toThrow('update')
    loseResponse()
    const appliedUpdate = { status: 'applied' as const, receiptDigest: 'a'.repeat(64) }
    await expect(journal.advance(admitted.command.id, applying.version, appliedUpdate)).resolves.toMatchObject({ status: 'applied', version: 3 })
    const done = await journal.advance(admitted.command.id, applying.version, appliedUpdate)
    expect(done).toMatchObject({ status: 'applied', version: 3 })
    expect(await storedVersion(d1, journal, admitted.command.id, 1)).toEqual(admitted)
    expect(await storedVersion(d1, journal, admitted.command.id, 2)).toEqual(applying)
    expect(await storedVersion(d1, journal, admitted.command.id, 3)).toEqual(done)
    await expect(journal.advance(admitted.command.id, done.version, { status: 'applying' })).rejects.toThrow('transition')
  })

  it('propagates a write failure when durable readback does not prove the transition', async () => {
    const f = await fixture(), admitted = await f.journal.admit(pause(), f.authority)
    const failure = new Error('transition was rolled back')
    f.onAfterRun(() => {
      f.sqlite.prepare('DELETE FROM audit_run_commands WHERE version > 1').run()
      throw failure
    })
    await expect(f.journal.advance(admitted.command.id, 1, { status: 'applying' })).rejects.toBe(failure)
    expect(await f.journal.get(admitted.command.id)).toEqual(admitted)
  })

  it('fences concurrent reconciliation updates and does not share returned mutable objects', async () => {
    const { journal, authority } = await fixture()
    const input = pause()
    const admitted = await journal.admit(input, authority)
    input.reason = 'mutated request'; admitted.command.reason = 'mutated response'
    expect((await journal.get(input.id))!.command.reason).not.toContain('mutated')
    const results = await Promise.allSettled([
      journal.advance(input.id, 1, { status: 'applying' }),
      journal.advance(input.id, 1, { status: 'rejected', detail: { code: 'invalid-target', message: 'No such task' } }),
    ])
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(value => value.status === 'rejected')).toHaveLength(1)
  })

  it('isolates command ids and revisions between audits', async () => {
    const f = await fixture(), a = f.journal, b = new RunCommandJournal(f.d1, 'audit-b')
    const authority = { ...f.authority, auditId: 'audit-b', executionId: 'audit-b' }
    await f.ownership.activate(authority, 'a'.repeat(64))
    const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'audit-b', undefined, undefined, authority)
    await machine.start()
    const state = machine.view()
    f.sqlite.prepare(`INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(state.runId, state.experimentId, state.status,
        runStateKey(state.runId, state.stateGeneration, await sha256(state)), state.stateGeneration, state.updatedAt)
    await a.admit(pause(), f.authority)
    expect(await b.revision()).toBe(0)
    expect(await b.get('retry-verifier')).toBeNull()
    await b.admit(pause(), authority)
    expect((await b.atRevision(1))!.auditId).toBe('audit-b')
  })
})

describe('one configuration format', () => {
  it.each(['amend', 'restart', 'skip', 'revalidate'])('refuses retired in-place %s commands', action => {
    expect(() => parseRunCommand({ ...pause(), action })).toThrow('command action is invalid')
  })
  it.each(['model', 'models', 'modelPools', 'prompts', 'limits', 'force', 'fallbacks'])('rejects inline %s configuration', field => {
    expect(() => parseRunCommand({ ...pause(), [field]: {} })).toThrow('fields')
  })
  it.each([
    { scope: { kind: 'tasks', taskIds: [] } },
    { scope: { kind: 'tasks', taskIds: ['verifier', 'verifier'] } },
    { scope: { kind: 'pool', poolId: '../pool' } },
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER },
    { reason: ' ' }, { id: '../overwrite' }, { session: 'automatic' },
  ])('rejects invalid command input %j', change => {
    expect(() => parseRunCommand({ ...pause(), ...change })).toThrow()
  })
})


async function cancellationFixture() {
  const command: RunCommand = { id: 'cancel-audit', expectedRevision: 0, action: 'cancel', scope: { kind: 'audit' }, reason: 'synthetic cancel' }
  const f = await sourceFixture(command)
  const machine = f.machine
  const anchored = await f.journal.beginEffect(command.id, f.admitted.version, f.state)
  const intent = await f.journal.beginNativeEffect(command.id, anchored.version, 'c'.repeat(64))
  await machine.cancelAudit(intent, { inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64), physicalZeroVerified: true, claimsSettled: true })
  const stopped = machine.snapshot()
  f.sqlite.prepare("UPDATE experiment_runs SET status = 'stopped', state_key = ?, state_generation = ?")
    .run(runStateKey(stopped.runId, stopped.stateGeneration, await sha256(stopped)), stopped.stateGeneration)
  return { ...f, stopped, intent, command }
}

describe('cancellation acknowledgement', () => {
  it('keeps the selected cancellation snapshot independent of caller mutations during ACK', async () => {
    const f = await cancellationFixture()
    const receiptDigest = await sha256(f.stopped.controls!.lastReceipt)
    const pending = f.journal.completeCancellation(f.command.id, f.intent.version, f.stopped)
    f.stopped.cursor.stageIndex = 999
    f.stopped.controls!.lastReceipt.commandDigest = 'f'.repeat(64)
    f.stopped.journal = []
    expect(await pending).toMatchObject({ status: 'applied', receiptDigest })
    expect((await f.journal.get(f.command.id))!.receiptDigest).toBe(receiptDigest)
  })

  it('reconciles an ambiguous ACK after fencing without clearing native intent', async () => {
    const f = await cancellationFixture()
    f.loseResponse()
    await expect(f.journal.completeCancellation(f.command.id, f.intent.version, f.stopped)).resolves.toMatchObject({ status: 'applied', nativeEffect: f.intent.nativeEffect })
    await f.ownership.fence(f.authority, 'e'.repeat(64))
    const applied = await f.journal.completeCancellation(f.command.id, f.intent.version, f.stopped)
    expect(applied).toMatchObject({ status: 'applied', nativeEffect: f.intent.nativeEffect,
      source: f.intent.source, receiptDigest: await sha256(f.stopped.controls!.lastReceipt) })
    expect(await f.journal.get(f.command.id)).toEqual(applied)
    await expect(f.journal.advance(f.command.id, applied.version, { status: 'failed' })).rejects.toThrow('must reconcile')
  })

  it.each(['selected-state', 'running', 'fenced', 'claim', 'version'])
    ('refuses cancellation ACK when %s changed and leaves the command applying', async change => {
      const f = await cancellationFixture()
      if (change === 'selected-state') await f.publish()
      if (change === 'running') f.sqlite.prepare("UPDATE experiment_runs SET status = 'running'").run()
      if (change === 'fenced') await f.ownership.fence(f.authority, 'e'.repeat(64))
      if (change === 'claim') f.sqlite.prepare(`INSERT INTO audit_execution_launches
        (audit_id, epoch, task_execution_id, request_digest, admitted_at) VALUES (?, 0, 'pending', ?, ?)`)
        .run(f.authority.auditId, 'a'.repeat(64), new Date().toISOString())
      await expect(f.journal.completeCancellation(f.command.id, change === 'version' ? f.intent.version - 1 : f.intent.version, f.stopped)).rejects.toThrow('changed before')
      expect((await f.journal.get(f.command.id))!.status).toBe('applying')
    })
})


it('rejects retired native failure receipts even with a valid recomputed digest', async () => {
  const f = await fixture()
  const admitted = await f.journal.admit({ id: 'hold', expectedRevision: 0, reason: 'test',
    action: 'pause', scope: { kind: 'audit' } }, f.authority)
  const changed = { ...admitted, nativeFailure: {} }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ?')
    .run(JSON.stringify(changed), await sha256(changed), admitted.command.id)
  await expect(f.journal.get(admitted.command.id)).rejects.toThrow('command journal integrity failed')
})


it.each(['retain-workspace', 'revoke-selection'])('rejects historical %s intent with a recomputed journal digest', async kind => {
  const f = await sourceFixture()
  const operation = await f.journal.beginEffect(f.admitted.command.id, f.admitted.version, f.state)
  const changed = { ...operation, nativeEffect: { kind, inventoryDigest: 'c'.repeat(64),
    ...(kind === 'revoke-selection' ? { selection: { taskExecutionIds: ['old-task'] } } : {}) } }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ? AND version = ?')
    .run(JSON.stringify(changed), await sha256(changed), operation.command.id, operation.version)
  await expect(f.journal.get(operation.command.id)).rejects.toThrow('command journal integrity failed')
})

it('leaves historical executor reservations to their source version', async () => {
  const command: RunCommand = { id: 'old-executor', expectedRevision: 0, reason: 'historical fixture',
    action: 'cancel', scope: { kind: 'audit' } }
  const f = await sourceFixture(command)
  const operation = { ...f.admitted, status: 'applying' as const, source: f.source }
  const runtime = { schemaVersion: 1 as const, id: 'old-runtime', frameworkCommit: 'a'.repeat(40),
    workerService: 'old-runtime', workflowName: 'old-runtime', containerImageDigest: `sha256:${'b'.repeat(64)}`,
    workerVersionId: '11111111-1111-4111-8111-111111111111' }
  const historical = { ...operation, target: { experimentId: 'old-experiment', runtimeRelease: runtime,
    authority: { auditId: f.authority.auditId, epoch: f.authority.epoch + 1,
      executionId: `exec-${(await sha256({ source: f.authority, commandDigest: operation.commandDigest })).slice(0, 48)}`,
      runtimeDigest: await sha256(runtime) } } }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json=?, operation_digest=? WHERE command_id=? AND version=?')
    .run(JSON.stringify(historical), await sha256(historical), command.id, operation.version)
  await expect(f.journal.get(command.id)).rejects.toMatchObject({ cause: { message: 'unsupported command journal fields' } })
})


it.each(['startup', 'successor', 'nativeFailure', 'target', 'unknownFutureField'])(
  'rejects unsupported %s fields at the journal boundary even with a valid digest', async field => {
    const f = await fixture(), admitted = await f.journal.admit(pause(), f.authority)
    const changed = { ...admitted, [field]: {} }
    f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ?')
      .run(JSON.stringify(changed), await sha256(changed))
    await expect(f.journal.get(admitted.command.id)).rejects.toMatchObject({
      cause: { message: 'unsupported command journal fields' },
    })
    await expect(f.journal.atRevision(admitted.revision)).rejects.toThrow('command journal integrity failed')
  },
)

it.each(['waiting', 'superseded'])('rejects retired %s command states even with a valid digest', async status => {
  const f = await fixture(), admitted = await f.journal.admit(pause(), f.authority)
  await expect(f.journal.advance(admitted.command.id, admitted.version, { status } as never)).rejects.toThrow()
  expect(await f.journal.get(admitted.command.id)).toEqual(admitted)
  const changed = { ...admitted, status }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ?')
    .run(JSON.stringify(changed), await sha256(changed))
  await expect(f.journal.get(admitted.command.id)).rejects.toThrow('command journal integrity failed')
  await expect(f.journal.atRevision(admitted.revision)).rejects.toThrow('command journal integrity failed')
})

it('rejects retired mutable custody pointers in the current journal', async () => {
  const f = await sourceFixture()
  const applying = await f.journal.beginEffect(f.admitted.command.id, 1, f.state)
  const changed = { ...applying, custodyDigest: 'c'.repeat(64) }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ? AND version = ?')
    .run(JSON.stringify(changed), await sha256(changed), applying.command.id, applying.version)
  await expect(f.journal.get(applying.command.id)).rejects.toThrow('journal integrity failed')
})

it.each(['missing', 'other-audit', 'unselected'] as const)('rejects %s admission ownership before recording a command', async kind => {
  const f = await fixture()
  const authority = kind === 'missing' ? undefined : kind === 'other-audit'
    ? { ...f.authority, auditId: 'other-audit' } : { ...f.authority, runtimeDigest: 'f'.repeat(64) }
  await expect(f.journal.admit(pause(), authority!)).rejects.toThrow()
  expect(await f.journal.revision()).toBe(0)
})

it('refuses ownerless historical commands instead of rebinding them to the current executor', async () => {
  const f = await fixture(), admitted = await f.journal.admit(pause(), f.authority)
  const { admittedAuthority: _owner, ...historical } = admitted
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ?')
    .run(JSON.stringify(historical), await sha256(historical), admitted.command.id)
  await expect(f.journal.get(admitted.command.id)).rejects.toThrow('journal integrity failed')
})

it('leaves already-admitted partial cancellation to its historical app version', async () => {
  const f = await fixture(), admitted = await f.journal.admit(pause(), f.authority)
  const command = { ...admitted.command, action: 'cancel', scope: { kind: 'pool', poolId: 'old-pool' } }
  const historical = { ...admitted, command, commandDigest: await sha256(command) }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ?')
    .run(JSON.stringify(historical), await sha256(historical), command.id)
  await expect(f.journal.get(command.id)).rejects.toThrow('journal integrity failed')
})
