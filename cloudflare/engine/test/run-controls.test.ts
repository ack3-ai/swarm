import { memoryR2 } from './support/memory-r2.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { applyAdmissionControl, assertAuditCancellation, assertRunControls } from '../src/run-control-state.js'
import { assertNativeTaskAdmission, reserveNativeLaunch } from '../src/native-launch-authority.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { afterEach, expect, it, vi } from 'vitest'
import { sha256 } from '../src/canonical.js'
import { CloudflareRunStore, stateWriter } from '../src/cloudflare-storage.js'
import { RunMachine } from '../src/machine.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { reconcileRunControls, settleTerminalAdmissionControls } from '../src/run-control-reconcile.js'
import { runControlResponse } from '../src/run-control-api.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../src/runner.js'
import { AgentExecutionPending, TransientRunFailure, PermanentRunFailure } from '../src/run-errors.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { workflowProgress } from '../src/workflow-outcome.js'
import type { AgentProvider, AgentRequest, RunState, RunStateWriteOptions } from '../src/contracts.js'
import type { RunCommandScope } from '../src/run-commands.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { sqliteD1 } from './support/sqlite-d1.js'
import { compileExperimentConfig } from './support/compile-config.js'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }

const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))
async function fixture(credentials: Record<string, unknown> = {}) {
  const runtimeBindings = { ACK3_CODEX_AUTH_JSON: 'synthetic-auth', ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
    PROVIDER_A_API_KEY: 'synthetic-key', PROVIDER_B_API_KEY: 'synthetic-key', ...credentials }
  const db = sqliteD1()
  closes.push(() => db.sqlite.close())
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const { bucket } = memoryR2()
  const store = new CloudflareRunStore(bucket, bucket, db.d1)
  const release = await store.putRelease(audit0PackageBody)
  const id = 'controlled-audit'
  const owner = await store.activateRootExecution(id, undefined, { id })
  let machine = await createControlledMachine(audit0Definition, release.digest, id, undefined, undefined, owner)
  await machine.start()
  let persist = await stateWriter(store, null)
  await persist(machine.view())
  const journal = new RunCommandJournal(db.d1, id), artifacts = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  const reconcile = () => reconcileRunControls({ machine, journal, persist })
  const load = async () => {
    const state = await store.getState(id)
    machine = await RunMachine.fromState((await store.getRelease(state.releaseDigest)).body.definition, state, digest => store.getRelease(digest), store.executionSources())
    persist = await stateWriter(store, state)
  }
  const command = (action: 'pause' | 'continue', expectedRevision: number, scope: RunCommandScope = { kind: 'audit' }) => ({
    id: `${action}-${expectedRevision}`, action, expectedRevision, scope, reason: 'synthetic operator adjustment',
  })
  const api = (method: string, body?: unknown, commandId?: string) => runControlResponse(new Request('https://internal/commands', {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  }), store, db.d1, audit0Definition.id, id, commandId)
  const advance = async (provider: AgentProvider = base,
    write?: (state: RunState, options?: RunStateWriteOptions) => Promise<void>) => {
    await reconcile()
    const result = await advanceExperimentOneWave({ definition: machine.definition, machine, provider,
      artifactStore: artifacts, policy: audit0RunPolicy, reconcileControls: reconcile,
      onWaveAdmission: write ?? ((state, options) => persist(state, options)),
      onCheckpoint: async checkpoint => { await store.putCheckpoint(checkpoint) },
    })
    await persist(machine.view())
    return result
  }
  return { ...db, store, journal, id, owner, base, artifacts, api, command, advance, reconcile, load, release,
    machine: () => machine, persist: (state: RunState, options?: RunStateWriteOptions) => persist(state, options) }
}

it('marks an idle step under a pause for the long poll sleep, but not a pool pause with work in flight', async () => {
  const f = await fixture()
  const pausedIdle = (polled: RunState) => workflowProgress(f.machine().view(), polled.stateGeneration).pausedIdle
  // No pause: an idle step keeps the short sleep.
  expect(pausedIdle(f.machine().view())).toBeUndefined()
  expect(await f.advance()).toBe(true)
  // Audit pause, nothing in flight, the step changed nothing: long sleep.
  const before = f.machine().view()
  expect((await f.api('POST', f.command('pause', 0))).status).toBe(202)
  await f.reconcile(); await f.persist(f.machine().view())
  expect(pausedIdle(before)).toBeUndefined()
  let calls = 0
  const counting = { run: async (request: AgentRequest) => { calls++; return f.base.run(request) } }
  // The first paused step still initializes the discovery scheduler; the next one changes nothing.
  let polled = f.machine().view()
  expect(await f.advance(counting)).toBe(false)
  expect(pausedIdle(polled)).toBeUndefined()
  polled = f.machine().view()
  expect(await f.advance(counting)).toBe(false)
  expect(calls).toBe(0)
  expect(pausedIdle(polled)).toBe(true)
  // Pool pause while the other pool's tasks run: short sleep.
  expect((await f.api('POST', f.command('continue', 1))).status).toBe(202)
  expect((await f.api('POST', f.command('pause', 2, { kind: 'pool', poolId: 'luna' }))).status).toBe(202)
  const pending = { run: async (request: AgentRequest) => {
    if (request.task.modelPool === 'deepseek') throw new AgentExecutionPending('synthetic long task')
    return f.base.run(request)
  } }
  await f.advance(pending)
  const running = f.machine().view()
  expect(running.controls?.pauses).toEqual([{ kind: 'pool', poolId: 'luna' }])
  expect(running.inFlightAgentAttempts?.length).toBeGreaterThan(0)
  expect(pausedIdle(running)).toBeUndefined()
})

it('pauses and continues through the API, then completes autonomously without resetting clocks or usage', async () => {
  const f = await fixture()
  const before = f.machine().snapshot()
  const pause = f.command('pause', 0)
  expect((await f.api('POST', pause)).status).toBe(202)
  expect(await (await f.api('GET', undefined, pause.id)).json()).toMatchObject({ status: 'accepted', revision: 1 })
  await f.reconcile()
  expect((await f.api('POST', pause)).status).toBe(200)
  let calls = 0
  expect(await f.advance({ run: async request => { calls++; return f.base.run(request) } })).toBe(false)
  expect(calls).toBe(0)
  const paused = f.machine().snapshot()
  expect(paused).toMatchObject({ status: 'running', cursor: before.cursor, budget: before.budget,
    rootCreatedAt: before.rootCreatedAt, modelStartedAt: before.modelStartedAt })
  // Status reads are observations, not a second reconciliation engine.
  const count = f.sqlite.prepare('SELECT count(*) AS n FROM audit_run_commands').get()!.n
  await f.api('GET'); await f.api('GET', undefined, pause.id)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_run_commands').get()!.n).toBe(count)
  expect((await f.api('POST', f.command('continue', 0))).status).toBe(409)
  expect((await f.api('POST', f.command('continue', 1, { kind: 'stage', stageId: 'missing' }))).status).toBe(400)
  expect((await f.api('POST', f.command('continue', 1))).status).toBe(202)
  await f.load()
  for (let guard = 0; f.machine().view().cursor.stageIndex < audit0Definition.stages.length; guard++) {
    expect(guard).toBeLessThan(100)
    await f.advance(); await f.load()
  }
  expect(audit0RunPolicy.assessCompletion({ definition: audit0Definition, state: f.machine().snapshot() })).toEqual([])
  await f.machine().complete(); await f.persist(f.machine().view())
  expect(f.machine().view().status).toBe('completed')
  expect(f.machine().view().controls?.pauses).toEqual([])
  expect(f.machine().view().artifacts.some(artifact => artifact.taskId === 'seal-final')).toBe(true)
  expect((await f.api('POST', pause)).status).toBe(200) // Idempotency survives completion.
}, 30_000) // Bounded full audit with persisted-state replay at each wave.

it.each(['wave', 'cohort'])('atomically refuses a %s admission overtaken by a pause and does not leak it through a drain write', async kind => {
  const f = await fixture()
  if (kind === 'cohort') await f.advance() // Preflight establishes the original model clock.
  const before = f.machine().snapshot()
  let injected = false, calls = 0
  await expect(f.advance({ run: async request => { calls++; return f.base.run(request) } }, async (state, options) => {
    if (options?.admission === true && !injected) {
      injected = true
      await f.journal.admit(f.command('pause', 0), f.owner)
    }
    await f.persist(state, options)
  })).rejects.toBeInstanceOf(TransientRunFailure)
  expect(injected).toBe(true); expect(calls).toBe(0)
  expect(f.machine().view().waveAdmission ?? null).toBe(before.waveAdmission ?? null)
  expect(f.machine().view().discoveryScheduler?.admissions ?? []).toEqual([])
  // This is the Workflow catch path: saving paid-work custody must not publish
  // the denied local admission and silently grant it permission to drain.
  await f.persist(f.machine().view())
  await f.load(); await f.reconcile()
  expect(await f.advance({ run: async request => { calls++; return f.base.run(request) } })).toBe(false)
  expect(calls).toBe(0)
  expect(f.machine().view().budget).toEqual(before.budget)
})

it('drains an admitted pool while its pause leaves another pool free to advance', async () => {
  const f = await fixture()
  await f.advance()
  let ready = false
  const requests = new Map<string, AgentRequest>()
  const provider: AgentProvider = { async run(request) {
    const key = `${request.task.id}/${request.attempt}`
    if (!requests.has(key)) requests.set(key, request)
    else expect(request.visibleArtifacts).toEqual(requests.get(key)!.visibleArtifacts)
    if (!ready) throw new AgentExecutionPending(key)
    return f.base.run(request)
  } }
  await f.advance(provider)
  const admitted = f.machine().view().discoveryScheduler!.admissions
  expect(admitted.length).toBeGreaterThan(1)
  const held = admitted[0]!, other = admitted[1]!
  const before = f.machine().snapshot()
  await f.api('POST', f.command('pause', 0, { kind: 'pool', poolId: held.poolId }))
  ready = true
  await f.advance(provider)
  const state = f.machine().snapshot()
  expect(state.status).toBe('running')
  expect(state.cursor.stageIndex).toBe(before.cursor.stageIndex)
  expect(state.discoveryScheduler!.admissions).toEqual([])
  expect(state.waveReceipts.filter(receipt => receipt.poolId === held.poolId)).toHaveLength(1)
  expect(state.waveReceipts.filter(receipt => receipt.poolId === other.poolId).length).toBeGreaterThan(1)
  expect(state.modelStartedAt).toBe(before.modelStartedAt)
  expect(state.rejectedAttempts).toEqual([])
  expect(state.artifacts.filter(artifact => held.taskIds.includes(artifact.taskId))).toHaveLength(held.taskIds.length)
  await f.api('POST', f.command('continue', 1, { kind: 'pool', poolId: held.poolId }))
  await f.advance(provider)
  expect(f.machine().view().cursor.stageIndex).toBeGreaterThan(state.cursor.stageIndex)
})

it.each(['state', 'acknowledgement'])('reconciles a lost %s response without repeating the command effect', async fault => {
  const f = await fixture()
  await f.api('POST', f.command('pause', 0))
  let injected = false
  f.onAfterRun(sql => {
    if (injected) return
    const last = f.sqlite.prepare('SELECT operation_json FROM audit_run_commands ORDER BY revision DESC, version DESC LIMIT 1').get()
    if ((fault === 'state' && sql.includes('INSERT INTO experiment_runs'))
      || (fault === 'acknowledgement' && last !== undefined && JSON.parse(last.operation_json as string).status === 'applied')) {
      injected = true; throw new Error('lost control response')
    }
  })
  if (fault === 'state') await expect(f.reconcile()).rejects.toThrow('lost control response')
  else await expect(f.reconcile()).resolves.toBe(true)
  f.onAfterRun()
  const saved = await f.store.getState(f.id), receipt = saved.controls!.lastReceipt
  await f.load(); await f.reconcile()
  expect(f.machine().view().controls!.lastReceipt).toEqual(receipt)
  expect(f.machine().view().journal.filter(event => event.type === 'run.control-settled')).toHaveLength(1)
  expect(await f.journal.atRevision(1)).toMatchObject({ status: 'applied', receiptDigest: await sha256(receipt), version: 3 })
})

it('allows one state effect when two reconcilers race, then reconciles its exact receipt', async () => {
  const f = await fixture(), state = f.machine().snapshot()
  await f.api('POST', f.command('pause', 0))
  const contenders = await Promise.all([0, 1].map(async () => ({
    machine: await RunMachine.fromState(audit0Definition, state, digest => f.store.getRelease(digest), f.store.executionSources()),
    persist: await stateWriter(f.store, state), journal: f.journal,
  })))
  const outcomes = await Promise.allSettled(contenders.map(reconcileRunControls))
  expect(outcomes.some(result => result.status === 'fulfilled')).toBe(true)
  await f.load(); await f.reconcile()
  expect(f.machine().view().journal.filter(event => event.type === 'run.control-settled')).toHaveLength(1)
  expect((await f.journal.atRevision(1))?.status).toBe('applied')
})


it('rejects a command if failure wins between API validation and admission', async () => {
  const f = await fixture(), getRelease = f.store.getRelease.bind(f.store)
  f.store.getRelease = async digest => {
    const release = await getRelease(digest)
    await f.machine().fail('synthetic framework failure')
    await f.persist(f.machine().view())
    return release
  }
  expect((await f.api('POST', f.command('pause', 0))).status).toBe(409)
  expect(await f.journal.revision()).toBe(0)
})

it.each(['accepted', 'applying'] as const)('consumes an unapplied %s decision as a preserved failed-state rejection', async status => {
  const f = await fixture(), command = f.command('pause', 0)
  await f.api('POST', command)
  if (status === 'applying') await f.journal.advance(command.id, 1, { status: 'applying' })
  await f.machine().fail('synthetic framework failure')
  await f.persist(f.machine().view())
  await f.api('GET', undefined, command.id)
  expect((await f.journal.get(command.id))?.status).toBe(status)
  const failed = f.machine().snapshot()
  await expect(f.store.putState({ ...failed, terminalReason: 'forged' },
    { generation: failed.stateGeneration, digest: await sha256(failed) })).rejects.toThrow('produced')
  await f.reconcile(); await f.load(); await f.reconcile()
  const { controls: _controls, journal: _journal, stateGeneration: _generation, updatedAt: _at, ...preserved } = f.machine().snapshot()
  const { controls: _oldControls, journal: _oldJournal, stateGeneration: _oldGeneration, updatedAt: _oldAt, ...original } = failed
  expect(preserved).toEqual(original)
  expect(await f.journal.get(command.id)).toMatchObject({ status: 'rejected', detail: { code: 'audit-terminal' } })
  expect((await f.journal.get(command.id))?.receiptDigest).toBe(await sha256(f.machine().view().controls!.lastReceipt))
  expect(f.machine().view()).toMatchObject({ status: 'failed', terminalReason: failed.terminalReason, controls: { revision: 1, pauses: [] } })
  expect(f.machine().view().journal.slice(0, failed.journal.length)).toEqual(failed.journal)
  expect(f.machine().view().budget).toEqual(failed.budget)
})

it('reconciles a command accepted before completion can publish, without repeating completed model work', async () => {
  const f = await fixture()
  for (let guard = 0; f.machine().view().cursor.stageIndex < audit0Definition.stages.length; guard++) {
    expect(guard).toBeLessThan(100)
    await f.advance(); await f.load()
  }
  const before = f.machine().snapshot()
  await f.machine().complete()
  await f.api('POST', f.command('pause', 0))
  await expect(f.persist(f.machine().view())).rejects.toBeInstanceOf(TransientRunFailure)
  expect((await f.store.getState(f.id)).status).toBe('running')
  await f.load(); await f.reconcile()
  await f.machine().complete(); await f.persist(f.machine().view())
  expect(f.machine().view().artifacts).toEqual(before.artifacts)
  expect(f.machine().view().budget).toEqual(before.budget)
  expect((await f.journal.atRevision(1))?.status).toBe('applied')
  expect(f.machine().view().status).toBe('completed')
}, 30_000) // Bounded full audit plus the completion/publication race.

it('continues only the exact normalized pause scope and exposes remaining independent holds', async () => {
  const f = await fixture()
  const tasks = audit0Definition.stages[0]!.waves[0]!.tasks.map(task => task.id)
  await f.api('POST', f.command('pause', 0, { kind: 'tasks', taskIds: tasks }))
  await f.reconcile()
  await f.api('POST', f.command('continue', 1))
  await f.reconcile()
  expect(f.machine().view().controls?.pauses).toEqual([{ kind: 'tasks', taskIds: [...tasks].sort() }])
  expect(await f.journal.get('continue-1')).toMatchObject({ status: 'rejected', detail: { code: 'no-matching-pause' } })
  await f.api('POST', f.command('continue', 2, { kind: 'tasks', taskIds: [...tasks].reverse() }))
  await f.reconcile()
  expect(f.machine().view().controls?.pauses).toEqual([])
})

const immutableAdjustments = [
  { action: 'amend', releaseDigest: 'a'.repeat(64), admittedWork: 'drain' },
  { action: 'amend', releaseDigest: 'a'.repeat(64), admittedWork: 'cancel' },
  { action: 'skip', scope: { kind: 'pool', poolId: 'deepseek' } },
  { action: 'restart', scope: { kind: 'audit' }, session: 'fresh' },
  { action: 'restart', scope: { kind: 'audit' }, session: 'resume' },
  { action: 'restart', scope: { kind: 'tasks', taskIds: ['negative-review-replica'] }, session: 'fresh' },
  { action: 'restart', scope: { kind: 'tasks', taskIds: ['negative-review-replica'] }, session: 'resume' },
  { action: 'revalidate', taskId: 'negative-review-replica', outputDigest: 'b'.repeat(64) },
]

it.each(immutableAdjustments)('refuses retired $action without changing live work', async adjustment => {
  const f = await fixture(), before = await f.store.getState(f.id)
  const command = { id: 'immutable-adjustment', expectedRevision: 0, reason: 'operator adjustment', ...adjustment }
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await f.api('POST', command)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'command action is invalid' })
  }
  expect(await f.journal.get(command.id)).toBeNull()
  expect(await f.store.getState(f.id)).toEqual(before)
  expect(await f.journal.revision()).toBe(0)
})

it.each([immutableAdjustments[0]!, immutableAdjustments[3]!])('refuses queued historical $action without mutating it', async adjustment => {
  const f = await fixture(), before = f.machine().snapshot()
  const command = { id: 'old-mutation', expectedRevision: 0, reason: 'queued adjustment', ...adjustment }
  const operation = { auditId: f.id, revision: 1, version: 1, command, commandDigest: await sha256(command),
    status: 'accepted', acceptedAt: before.updatedAt, updatedAt: before.updatedAt }
  f.sqlite.prepare('INSERT INTO audit_run_commands VALUES (?, ?, ?, ?, ?, ?)')
    .run(f.id, 1, command.id, 1, JSON.stringify(operation), await sha256(operation))
  await expect(f.reconcile()).rejects.toThrow('command journal integrity failed')
  expect(f.machine().snapshot()).toEqual(before)
  expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_run_commands').get()).toMatchObject({ n: 1 })
})

it.each([false, true])('cancels outstanding attempts while preserving accepted work and frontier (failed=%s)', async failed => {
  const f = await fixture()
  await f.advance() // Accepted deterministic preparation, including a checkpoint.
  let acceptedOne = false
  await f.advance({ run: async request => {
    if (!acceptedOne) { acceptedOne = true; return f.base.run(request) }
    throw new AgentExecutionPending('synthetic-running')
  } })
  expect((await f.api('POST', f.command('pause', 0))).status).toBe(202)
  await f.reconcile()
  if (failed) { await f.machine().fail('synthetic framework failure'); await f.persist(f.machine().view()); await f.load() }
  const before = f.machine().snapshot()
  expect(before.artifacts.length).toBeGreaterThan(0)
  expect(before.budget.inputTokens).toBeGreaterThan(0)
  expect(before.inFlightAgentAttempts!.length).toBeGreaterThan(0)
  const command = { id: 'cancel-audit', expectedRevision: 1, action: 'cancel', scope: { kind: 'audit' }, reason: 'operator cancellation' }
  const admitted = await f.journal.admit(command, f.owner)
  const source = await f.journal.beginEffect(command.id, admitted.version, before)
  const operation = await f.journal.beginNativeEffect(command.id, source.version, 'c'.repeat(64))
  const proof = { inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
  // This fixture tests the machine transition; native stop evidence is tested by
  // command-custody. It cannot acknowledge the command or enable its public API.
  for (const invalid of [{ ...proof, claimsSettled: false }, { ...proof, physicalZeroVerified: false },
    { ...proof, inventoryDigest: 'e'.repeat(64) }]) {
    await expect(f.machine().cancelAudit(operation, invalid as typeof proof)).rejects.toThrow('settled native evidence')
    expect(f.machine().snapshot()).toEqual(before)
  }
  await f.machine().cancelAudit(operation, proof)
  const cancelled = f.machine().snapshot()
  expect(cancelled).toMatchObject({ status: 'stopped', phase: 'stopped', terminalReason: command.reason, inFlightAgentAttempts: [],
    artifacts: before.artifacts, rejectedAttempts: before.rejectedAttempts, checkpoints: before.checkpoints,
    budget: before.budget, cursor: before.cursor, waveAdmission: before.waveAdmission,
    rootCreatedAt: before.rootCreatedAt, modelStartedAt: before.modelStartedAt, executionAuthority: before.executionAuthority })
  expect(cancelled.discoveryScheduler).toEqual(before.discoveryScheduler)
  expect(cancelled.journal.slice(before.journal.length).map(event => event.type)).toEqual(['run.cancelled', 'run.control-settled'])
  expect(cancelled.journal.at(-2)!.payload).toMatchObject({ abandonedAttempts: before.inFlightAgentAttempts,
    interruptedUsageComplete: false, source: operation.source, ...proof })
  await f.persist(f.machine().view())
  await f.load()
  expect(f.machine().snapshot()).toEqual(cancelled)
  await f.machine().cancelAudit(operation, proof)
  expect(f.machine().snapshot()).toEqual(cancelled)
  expect((await f.journal.get(command.id))!.status).toBe('applying')
  await expect(f.machine().cancelAudit(operation, { ...proof, proofDigest: 'e'.repeat(64) })).rejects.toThrow('proof differs')
  const changedHolds = structuredClone(cancelled)
  changedHolds.controls = { ...changedHolds.controls!, pauses: [],
    lastReceipt: { ...changedHolds.controls!.lastReceipt, pausesDigest: await sha256([]) } }
  const { digest: _digest, ...oldEvent } = changedHolds.journal.at(-1)!
  const newEvent = { ...oldEvent, payload: changedHolds.controls }
  changedHolds.journal = [...changedHolds.journal.slice(0, -1), { ...newEvent, digest: await sha256(newEvent) }]
  await expect(assertAuditCancellation(changedHolds)).rejects.toThrow('changed admission pauses')
  await expect(RunMachine.fromState(f.machine().definition, changedHolds, digest => f.store.getRelease(digest),
    f.store.executionSources())).rejects.toThrow()
  for (const mutate of [
    (state: RunState) => { state.budget.inputTokens++ },
    (state: RunState) => { state.rootCreatedAt = '2000-01-01T00:00:00.000Z' },
    (state: RunState) => { state.status = 'running' },
    (state: RunState) => { state.inFlightAgentAttempts = before.inFlightAgentAttempts! },
  ]) {
    const changed = structuredClone(cancelled); mutate(changed)
    await expect(assertAuditCancellation(changed)).rejects.toThrow()
    await expect(RunMachine.fromState(f.machine().definition, changed, digest => f.store.getRelease(digest),
      f.store.executionSources())).rejects.toThrow()
  }
})


it('preserves late progress and abandons logical attempts admitted after cancellation intent without launching them', async () => {
  const f = await fixture()
  await f.advance()
  let operation: Awaited<ReturnType<RunCommandJournal['beginNativeEffect']>> | undefined
  let source: RunState | undefined
  const command = { id: 'cancel-before-attempt', expectedRevision: 0, action: 'cancel', scope: { kind: 'audit' }, reason: 'operator cancellation' }
  const proof = { inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
  await advanceExperimentOneWave({ definition: f.machine().definition, machine: f.machine(),
    artifactStore: f.artifacts, policy: audit0RunPolicy,
    provider: { run: async () => { throw new AgentExecutionPending('no-native-launch') } },
    onWaveAdmission: async (state, options) => {
      await f.persist(state, options)
      if (operation !== undefined || (state.inFlightAgentAttempts?.length ?? 0) !== 1) return
      source = structuredClone(state)
      const admitted = await f.journal.admit(command, f.owner)
      const anchored = await f.journal.beginEffect(command.id, admitted.version, state)
      operation = await f.journal.beginNativeEffect(command.id, anchored.version, proof.inventoryDigest)
    },
  })
  expect(operation).toBeDefined()
  expect(source!.inFlightAgentAttempts).toHaveLength(1)
  const progressed = f.machine().snapshot()
  expect(progressed.stateGeneration).toBeGreaterThan(source!.stateGeneration)
  expect(progressed.inFlightAgentAttempts!.length).toBeGreaterThan(source!.inFlightAgentAttempts!.length)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  await f.machine().cancelAudit(operation!, proof)
  await f.persist(f.machine().view())
  await f.load()
  const stopped = f.machine().snapshot()
  expect(stopped.artifacts).toEqual(progressed.artifacts)
  expect(stopped.budget).toEqual(progressed.budget)
  expect(stopped.waveAdmission).toEqual(progressed.waveAdmission)
  expect(stopped.journal.at(-2)!.payload).toMatchObject({ abandonedAttempts: progressed.inFlightAgentAttempts })
  expect(stopped.inFlightAgentAttempts).toEqual([])
})


it('rejects a continue that matches no active pause and lists the active pauses (E18, F7)', async () => {
  const f = await fixture()
  const head = 'continue lifts only a pause with exactly the same scope, and no active pause has this scope'
  // No pause at all.
  const idle = f.command('continue', 0)
  expect((await f.api('POST', idle)).status).toBe(202)
  await f.reconcile()
  expect(await f.journal.get(idle.id)).toMatchObject({ status: 'rejected',
    detail: { code: 'no-matching-pause', message: `${head}; no pause is active` } })
  // An audit-scope continue does not lift a pool pause.
  await f.api('POST', f.command('pause', 1, { kind: 'pool', poolId: 'luna' }))
  await f.reconcile()
  const audit = f.command('continue', 2)
  expect((await f.api('POST', audit)).status).toBe(202)
  await f.reconcile()
  const detail = { code: 'no-matching-pause', message: `${head}; active pauses: {"kind":"pool","poolId":"luna"}` }
  expect(await f.journal.get(audit.id)).toMatchObject({ status: 'rejected', detail })
  expect(f.machine().view().controls).toMatchObject({ revision: 3, pauses: [{ kind: 'pool', poolId: 'luna' }],
    lastReceipt: { commandId: audit.id, outcome: { status: 'rejected', detail } } })
  expect(await (await f.api('GET')).json()).toMatchObject({ revision: 3, settledRevision: 3,
    lastOutcome: { status: 'rejected', detail }, pauses: [{ kind: 'pool', poolId: 'luna' }] })
  expect((await f.api('POST', audit)).status).toBe(200)
  // The exact scope lifts it.
  const pool = f.command('continue', 3, { kind: 'pool', poolId: 'luna' })
  expect((await f.api('POST', pool)).status).toBe(202)
  await f.reconcile()
  expect(await f.journal.get(pool.id)).toMatchObject({ status: 'applied' })
  expect(f.machine().view().controls).toMatchObject({ revision: 4, pauses: [] })
})

it('keeps a no-matching-pause message within the receipt limit however many pauses are active', async () => {
  const f = await fixture(), command = f.command('continue', 0, { kind: 'stage', stageId: audit0Definition.stages[1]!.id })
  const operation = await f.journal.admit(command, f.owner)
  const applying = await f.journal.advance(command.id, operation.version, { status: 'applying' })
  const refusal = async (pauses: readonly RunCommandScope[]) => {
    const state = f.machine().snapshot()
    Object.assign(state, { controls: { revision: 0, pauses } })
    const error = await applyAdmissionControl(audit0Definition, state, applying, state.updatedAt).then(() => null, (cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'no-matching-pause' })
    expect((error as Error).message.length).toBeLessThanOrEqual(2000)
    return (error as Error).message
  }
  const many = Array.from({ length: 40 }, (_, index) => ({ kind: 'tasks' as const, taskIds: [`task-${index}-${'x'.repeat(80)}`] }))
  const listed = await refusal(many)
  expect(listed).toContain(`active pauses: ${JSON.stringify(many[0])}, `)
  expect(listed).toMatch(/, and \d+ more \(see pauses in GET on the commands endpoint\)$/)
  const huge = [{ kind: 'tasks' as const, taskIds: Array.from({ length: 256 }, (_, index) => `task-${index}-${'y'.repeat(90)}`) }]
  expect(await refusal(huge)).toMatch(/; 1 pause is active \(see pauses in GET on the commands endpoint\)$/)
})

it('refuses unowned audit controls without reading historical state', async () => {
  const f = await fixture()
  f.sqlite.prepare('DELETE FROM audit_execution_authority WHERE audit_id = ?').run(f.id)
  const read = vi.spyOn(f.store, 'getStateIfPresent')
  expect((await f.api('GET')).status).toBe(409)
  expect((await f.api('POST', f.command('pause', 0))).status).toBe(409)
  expect(read).not.toHaveBeenCalled()
  expect(await f.journal.revision()).toBe(0)
})

it('reports an installed authority awaiting first state as a retryable admission conflict', async () => {
  const f = await fixture()
  f.sqlite.prepare('DELETE FROM experiment_runs WHERE run_id = ?').run(f.id)
  expect((await f.api('GET')).status).toBe(409)
  expect((await f.api('POST', f.command('pause', 0))).status).toBe(409)
  expect(await f.journal.revision()).toBe(0)
})


it.each([
  { kind: 'stage', stageId: 'discovery' },
  { kind: 'pool', poolId: 'deepseek' },
  { kind: 'tasks', taskIds: ['negative-review-replica'] },
] as const)('rejects scoped cancellation ($kind) before journal admission and permits the next decision', async scope => {
  const f = await fixture()
  await f.api('POST', f.command('pause', 0))
  await f.reconcile()
  const before = f.machine().snapshot()
  const command = { id: 'scoped-cancel', expectedRevision: 1, action: 'cancel', scope, reason: 'adjust selected work' }
  expect((await f.api('POST', command)).status).toBe(422)
  expect(await f.journal.get(command.id)).toBeNull()
  await expect(f.journal.admit(command, f.owner, new Date().toISOString())).rejects.toThrow('quiescent fork')
  expect(await f.journal.revision()).toBe(1)
  expect(f.machine().snapshot()).toEqual(before)
  expect((await f.api('POST', f.command('continue', 1))).status).toBe(202)
  await f.reconcile()
  expect(f.machine().view().controls).toMatchObject({ revision: 2, pauses: [] })
})

it('validates saved pause receipts before returning a repeated command effect', async () => {
  const f = await fixture(), command = f.command('pause', 0)
  await f.api('POST', command)
  const operation = await f.journal.advance(command.id, 1, { status: 'applying' })
  const state = f.machine().snapshot(), now = state.updatedAt
  const effect = await applyAdmissionControl(audit0Definition, state, operation, now)
  expect(await applyAdmissionControl(audit0Definition, { ...state, controls: effect }, operation, now)).toEqual(effect)
  for (const controls of [
    { ...effect, pauses: [] },
    { ...effect, lastReceipt: { ...effect.lastReceipt, pausesDigest: 'c'.repeat(64) } },
  ]) {
    await expect(applyAdmissionControl(audit0Definition, { ...state, controls }, operation, now)).rejects.toThrow('receipt')
  }
})


it('does not clear an unknown scope through a legacy persisted hold', async () => {
  const f = await fixture(), scope = { kind: 'pool' as const, poolId: 'removed-pool' }
  const command = f.command('continue', 0, scope)
  const operation = await f.journal.admit(command, f.owner)
  const applying = await f.journal.advance(command.id, operation.version, { status: 'applying' })
  const state = f.machine().snapshot()
  Object.assign(state, { controls: { revision: 0, pauses: [scope] } })
  await expect(applyAdmissionControl(audit0Definition, state, applying, state.updatedAt))
    .rejects.toMatchObject({ code: 'scope-unavailable' })
})

it('rejects the retired failed control-receipt outcome', async () => {
  const f = await fixture(), command = f.command('pause', 0)
  await f.api('POST', command); await f.reconcile()
  const state = f.machine().snapshot()
  Object.assign(state.controls!.lastReceipt, { outcome: { status: 'failed', detail: { code: 'legacy', message: 'legacy' } } })
  await expect(assertRunControls(state)).rejects.toThrow()
})
