import { memoryR2 } from './support/memory-r2.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { sealReleasePackage } from '../src/release.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { reserveNativeLaunch } from '../src/native-launch-authority.js'
import { runStateKey } from '../src/run-state-pointer.js'
import type { AgentRequest } from '../src/contracts.js'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionAuthorityStore, taskExecutionIdentity, type ExecutionAuthority } from '../src/execution-authority.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { sqliteD1 } from './support/sqlite-d1.js'
import { CloudflareRunStore, stateWriter } from '../src/cloudflare-storage.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../src/runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { AgentExecutionPending, TransientRunFailure } from '../src/run-errors.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'

const emptyRuntimeDigest = await sha256(null)
const launchPointer = { generation: 1, digest: 'd'.repeat(64) }
const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))
const authority = (epoch = 0, executionId = epoch === 0 ? 'stable-audit' : `audit-executor-${epoch}`): ExecutionAuthority => ({
  auditId: 'stable-audit', executionId, epoch, runtimeDigest: emptyRuntimeDigest,
})
function fixture() {
  const db = sqliteD1()
  closes.push(() => db.sqlite.close())
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const store = new ExecutionAuthorityStore(db.d1)
  const running = async (owner: ExecutionAuthority, command = '1'.repeat(64)) => {
    await store.activate(owner, command)
    db.sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, 'synthetic', 'running', ?, 1, '2026-11-01T00:00:00Z')`).run(owner.executionId, runStateKey(owner.executionId, launchPointer.generation, launchPointer.digest))
  }
  return { ...db, store, running }
}

it('requires atomic command activation even after the source is fenced and settled', async () => {
  const { store, sqlite, running } = fixture()
  const first = authority(), next = authority(1)
  await running(first)
  await store.admitLaunch(first, 'task-execution-0', '2'.repeat(64), launchPointer)
  await store.admitLaunch(first, 'task-execution-0', '2'.repeat(64), launchPointer)
  expect(sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(1)
  await expect(store.activate(next, '3'.repeat(64))).rejects.toThrow('ownership')
  await expect(store.retire(first, '4'.repeat(64))).rejects.toThrow('unsettled')
  await store.fence(first, '5'.repeat(64))
  await expect(store.assertActive(first)).rejects.toThrow('no longer active')
  await expect(store.admitLaunch(first, 'task-execution-0', '2'.repeat(64), launchPointer)).rejects.toThrow('authority')
  await expect(store.admitLaunch(first, 'task-execution-1', '6'.repeat(64), launchPointer)).rejects.toThrow('authority')
  await expect(store.retire(first, '4'.repeat(64))).rejects.toThrow('unsettled')
  // The late result is retained even after the old executor lost authority.
  await store.settleLaunch(first, '2'.repeat(64), '7'.repeat(64))
  await store.retire(first, '4'.repeat(64))
  await expect(store.activate(next, '3'.repeat(64))).rejects.toThrow('atomic command activation')
  await expect(store.assertActive(next)).rejects.toThrow('no longer active')
  await store.activate(first, '1'.repeat(64)) // Lost old response: never reopen.
  await expect(store.assertActive(first)).rejects.toThrow('no longer active')
  expect(sqlite.prepare("SELECT count(*) AS n FROM audit_execution_authority WHERE status = 'active'").get()!.n).toBe(0)
})

it('allows only one concurrent activation and binds every idempotent operation to exact content', async () => {
  const { store, running } = fixture()
  const a = authority(), b = authority(0, 'different-executor')
  const results = await Promise.allSettled([store.activate(a, '1'.repeat(64)), store.activate(b, '2'.repeat(64))])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = results[0]!.status === 'fulfilled' ? a : b
  await running(winner, winner === a ? '1'.repeat(64) : '2'.repeat(64))
  await expect(store.activate(winner, '3'.repeat(64))).rejects.toThrow('ownership')
  await store.admitLaunch(winner, 'task-a', '4'.repeat(64), launchPointer)
  await expect(store.admitLaunch(winner, 'task-b', '4'.repeat(64), launchPointer)).rejects.toThrow('authority')
  await store.settleLaunch(winner, '4'.repeat(64), '5'.repeat(64))
  await expect(store.settleLaunch(winner, '4'.repeat(64), '6'.repeat(64))).rejects.toThrow('differs')
  await expect(store.settleLaunch(winner, '7'.repeat(64), '5'.repeat(64))).rejects.toThrow('missing')
  await store.fence(winner, '8'.repeat(64))
  await expect(store.fence(winner, '9'.repeat(64))).rejects.toThrow('another command')
  await store.retire(winner, 'a'.repeat(64))
  await expect(store.retire(winner, 'b'.repeat(64))).rejects.toThrow('different retirement')
})

it('retains a launch reservation if fencing races with its acknowledgement', async () => {
  const { store, sqlite, onAfterRun, running } = fixture()
  const owner = authority()
  await running(owner)
  onAfterRun(sql => {
    if (sql.includes('INSERT INTO audit_execution_launches')) {
      sqlite.prepare("UPDATE audit_execution_authority SET status = 'fenced', fence_command_digest = ?").run('2'.repeat(64))
    }
  })
  await expect(store.admitLaunch(owner, 'task-a', '3'.repeat(64), launchPointer)).rejects.toThrow('authority')
  onAfterRun()
  expect(sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches WHERE receipt_digest IS NULL').get()!.n).toBe(1)
  await expect(store.retire(owner, '4'.repeat(64))).rejects.toThrow('unsettled')
})


async function stateFixture() {
  const db = fixture(), { bucket: r2 } = memoryR2()
  const states = new CloudflareRunStore(r2, r2, db.d1)
  const owner = { ...authority(), runtimeDigest: await sha256(null) }
  await db.store.activate(owner, '1'.repeat(64))
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), owner.executionId, undefined, undefined, owner)
  await machine.start()
  const state = machine.view()
  const branch = async (reason: string, extraTransition = false) => {
    const candidate = await RunMachine.fromState(audit0Definition, state, undefined, states.executionSources())
    if (extraTransition) await candidate.seal()
    await candidate.fail(reason)
    return candidate.view()
  }
  return { ...db, states, state, owner, machine, branch }
}

it('CASes state against its exact predecessor, not just a larger generation', async () => {
  const { states, state, store, owner, branch } = await stateFixture()
  await states.putState(state, null)
  const pointer = { generation: state.stateGeneration, digest: await sha256(state) }
  const left = await branch('left branch')
  const right = await branch('stale right branch', true)
  await states.putState(left, pointer)
  const next = { generation: left.stateGeneration, digest: await sha256(left) }
  await expect(states.putState(right, pointer)).rejects.toThrow('stale run-state')
  expect((await states.getState(state.runId)).terminalReason).toBe('left branch')
  await store.fence(owner, '2'.repeat(64))
  await expect(states.putState(right, next)).rejects.toThrow('exact predecessor history')
  const { executionAuthority: _, ...downgraded } = right
  // @ts-expect-error Deliberately pass an unowned current state.
  await expect(states.putState(downgraded)).rejects.toThrow('state must be produced')
  expect((await states.getState(state.runId)).terminalReason).toBe('left branch')
})

it('reconciles a lost state-write response without publishing another branch', async () => {
  const { states, state, onAfterRun, branch } = await stateFixture()
  await states.putState(state, null)
  const pointer = { generation: state.stateGeneration, digest: await sha256(state) }
  const next = await branch('next state')
  onAfterRun(sql => { if (sql.includes('INSERT INTO experiment_runs')) throw new Error('lost write acknowledgement') })
  await expect(states.putState(next, pointer)).rejects.toThrow('lost write')
  onAfterRun()
  await states.putState(next, pointer)
  expect(await states.getState(next.runId)).toEqual(next)
})

it('does not invent a predecessor or accept state under another runtime authority', async () => {
  const { states, state } = await stateFixture()
  await expect(states.putState(state, { generation: 1, digest: 'f'.repeat(64) })).rejects.toThrow('run state is missing')
  await expect(states.putState(state)).rejects.toThrow('exact predecessor')
  await expect(states.putState({ ...state,
    executionAuthority: { ...state.executionAuthority!, runtimeDigest: 'f'.repeat(64) } }, null)).rejects.toThrow('state must be produced')
})

it.each([false, true])('refuses generation-only history for an installed executor (authority omitted: %s)', async omit => {
  const f = fixture(), b = memoryR2(), owner = authority()
  await f.store.activate(owner, '1'.repeat(64))
  const states = new CloudflareRunStore(b.bucket, b.bucket, f.d1)
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), owner.executionId)
  await machine.start()
  const state = { ...machine.snapshot(), rootRunId: owner.auditId,
    ...(omit ? {} : { executionAuthority: owner }) }
  const content = JSON.stringify(state), digest = await sha256(content)
  const key = `runs/${state.runId}/states/${String(state.stateGeneration).padStart(12, '0')}.json`
  await b.r2.put(key, content, { customMetadata: { objectSha256: digest, generation: String(state.stateGeneration) }, sha256: digest })
  f.sqlite.prepare(`INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?)`).run(state.runId, state.experimentId, key, state.stateGeneration, state.updatedAt)
  await expect(states.getState(state.runId)).rejects.toThrow('pointer digest mismatch')
})

async function nativeFixture(d1: D1Database, owner: ExecutionAuthority) {
  const provider = new SandboxAgentProvider({ INDEX: d1, ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace' } as any) as any
  const claimStart = vi.fn(async () => { throw new Error('injected lost R2 claim response') })
  provider.executionReceipts = { get: async () => null, claimStart }
  provider.runtimeEnvironment = async () => ({})
  provider.assertProviderCredentials = async () => {}
  const sandbox = { mkdir: async () => {}, exists: async () => ({ success: true, exists: false }),
    getProcess: async () => null, startProcess: vi.fn() }
  const dispatchBucket = memoryR2()
  const runs = new CloudflareRunStore(dispatchBucket.bucket, dispatchBucket.bucket, d1)
  const release = await runs.putRelease(audit0PackageBody)
  const machine = await createControlledMachine(audit0Definition, release.digest, owner.executionId,
    undefined, undefined, owner)
  const artifactStore = new MemoryArtifactStore(), requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore,
    provider: new DeterministicAuditProvider() })
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore,
    provider: { async run(request) { requests.push(structuredClone(request)); throw new AgentExecutionPending(request.task.id) } } })
  const request = requests.find(request => request.task.providerClass === 'core')!
  expect(request).toBeDefined()
  // Replace only this test's generation-one index placeholder with the actual
  // producer state; its old selection receipt remains immutable.
  await d1.prepare('DELETE FROM experiment_runs WHERE run_id = ?1').bind(owner.executionId).run()
  // Fenced-authority tests deliberately cannot publish through the running writer.
  const state = machine.snapshot(), content = canonicalJson(state), digest = await sha256(state)
  const key = runStateKey(state.runId, state.stateGeneration, digest)
  await dispatchBucket.r2.put(key, content, { customMetadata: { objectSha256: digest,
    generation: String(state.stateGeneration) }, sha256: digest })
  await d1.prepare(`INSERT INTO experiment_runs
    (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?1, ?2, 'running', ?3, ?4, ?5)`).bind(state.runId, state.experimentId, key,
      state.stateGeneration, state.updatedAt).run()
  provider.runs = { getState: async () => state, getRelease: (digest: string) => runs.getRelease(digest),
    executionSources: () => runs.executionSources(),
    putAgentDispatch: vi.fn((request: AgentRequest, digest: string) => runs.putAgentDispatch(request, digest)) }
  const progress = async (completeTarget = false) => {
    const base = new DeterministicAuditProvider()
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore,
      provider: { async run(current) {
        if (!completeTarget && current.task.id === request.task.id) throw new AgentExecutionPending(current.task.id)
        return base.run(current)
      } } })
    return machine.view()
  }
  return { provider, sandbox, request, claimStart, state, dispatchBucket, runs, progress, machine }
}

it('preserves unsettled native claims when the producer fails', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const n = await nativeFixture(f.d1, owner), nativeDigest = 'c'.repeat(64)
  await reserveNativeLaunch(n.runs, f.store, n.request, nativeDigest)
  const before = await f.store.observeLaunch(owner, n.request.taskExecutionId!, nativeDigest)
  expect(before).toMatchObject({ receiptDigest: null, settledAt: null })
  const persist = await stateWriter(n.runs, n.state)
  await n.machine.fail('synthetic terminal boundary with admitted work')
  await persist(n.machine.view())
  const saved = await n.runs.getState(owner.executionId)
  expect(saved.status).toBe('failed')
  expect(saved.inFlightAgentAttempts).toEqual(n.state.inFlightAgentAttempts)
  expect(await f.store.observeLaunch(owner, n.request.taskExecutionId!, nativeDigest)).toEqual(before)
  await expect(f.store.retire(owner, 'd'.repeat(64))).rejects.toThrow('unsettled')
  await f.store.settleLaunch(owner, nativeDigest, 'e'.repeat(64))
  expect(await f.store.observeLaunch(owner, n.request.taskExecutionId!, nativeDigest))
    .toMatchObject({ receiptDigest: 'e'.repeat(64), settledAt: expect.any(String) })
})

it('checks the installed fence before the native paid-start path, including an omitted authority', async () => {
  const { d1, store } = fixture(), owner = authority()
  await store.activate(owner, '1'.repeat(64)); await store.fence(owner, '2'.repeat(64))
  const { provider, sandbox, request, claimStart } = await nativeFixture(d1, owner)
  await expect(provider.runInSandbox(sandbox, request)).rejects.toThrow('authority')
  const { executionAuthority: _, taskExecutionId: __, ...omitted } = request
  await expect(provider.runInSandbox(sandbox, omitted)).rejects.toThrow('covered allocation authority differs')
  expect(claimStart).not.toHaveBeenCalled()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('keeps an ambiguous native start outstanding and settles its late exact receipt after fencing', async () => {
  const { d1, sqlite, store, running, onAfterRun } = fixture(), owner = authority()
  await running(owner)
  const { provider, sandbox, request } = await nativeFixture(d1, owner)
  await expect(provider.runInSandbox(sandbox, request)).rejects.toThrow('lost R2 claim')
  const claim = sqlite.prepare('SELECT request_digest FROM audit_execution_launches').get()!
  expect(claim.request_digest).toMatch(/^[a-f0-9]{64}$/)
  await store.fence(owner, '2'.repeat(64))
  await expect(store.retire(owner, '3'.repeat(64))).rejects.toThrow('unsettled')
  const receipt = { requestDigest: claim.request_digest, exitCode: 0, actorId: 'saved-session',
    files: {}, inputTokens: 9, outputTokens: 3, costUsd: 0, stderr: '' }
  provider.executionReceipts.get = async (_runId: string, requestDigest: string) => {
    expect(requestDigest).toBe(claim.request_digest)
    return receipt
  }
  onAfterRun(sql => { if (sql.includes('UPDATE audit_execution_launches')) throw new Error('lost settlement acknowledgement') })
  await expect(provider.run(request)).rejects.toBeInstanceOf(TransientRunFailure)
  onAfterRun()
  await expect(provider.run(request)).resolves.toMatchObject({ actorId: 'saved-session', inputTokens: 9, outputTokens: 3 })
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBe(await sha256(receipt))
  await store.retire(owner, '3'.repeat(64))
})

it('does not reserve or launch native work until the exact dispatch is durable', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const n = await nativeFixture(f.d1, owner)
  n.provider.runs.putAgentDispatch.mockRejectedValue(new TransientRunFailure('dispatch unavailable'))
  await expect(n.provider.runInSandbox(n.sandbox, n.request)).rejects.toThrow('dispatch unavailable')
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  expect(n.claimStart).not.toHaveBeenCalled()
  expect(n.sandbox.startProcess).not.toHaveBeenCalled()
})

it('claims the admitted occurrence even when the caller mutates its request during persistence', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const n = await nativeFixture(f.d1, owner), original = structuredClone(n.request)
  n.provider.runs.putAgentDispatch.mockImplementation(async (request: AgentRequest, digest: string) => {
    await n.runs.putAgentDispatch(request, digest)
    n.request.taskExecutionId = 'task-substituted'
    n.request.executionAuthority!.epoch++
  })
  await reserveNativeLaunch(n.provider.runs, f.store, n.request, 'c'.repeat(64))
  expect(f.sqlite.prepare('SELECT task_execution_id FROM audit_execution_launches').get()!.task_execution_id)
    .toBe(original.taskExecutionId)
  expect((await n.runs.getAgentDispatch(original.runId, await sha256(original)))!.request).toEqual(original)
})

it.each(['fence', 'admission'])('rechecks %s changes made while persisting dispatch evidence', async change => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const n = await nativeFixture(f.d1, owner)
  n.provider.runs.putAgentDispatch.mockImplementation(async (request: AgentRequest, digest: string) => {
    await n.runs.putAgentDispatch(request, digest)
    if (change === 'fence') await f.store.fence(owner, 'f'.repeat(64))
    else {
      n.state.stateGeneration++
      n.state.inFlightAgentAttempts = []
      f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = 2')
        .run(runStateKey(n.state.runId, n.state.stateGeneration, await sha256(n.state)))
    }
  })
  await expect(n.provider.runInSandbox(n.sandbox, n.request)).rejects.toThrow()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  expect(n.claimStart).not.toHaveBeenCalled()
  expect(n.sandbox.startProcess).not.toHaveBeenCalled()
  // Evidence survives fencing; its presence grants no permission to launch.
  expect((await n.runs.getAgentDispatch(n.request.runId, await sha256(n.request)))?.request).toEqual(n.request)
})

it('refuses paid admission after terminal state and refuses taking over an existing legacy execution', async () => {
  const { store, sqlite, running } = fixture(), owner = authority()
  await running(owner)
  sqlite.prepare("UPDATE experiment_runs SET status = 'completed' WHERE run_id = ?").run(owner.executionId)
  await expect(store.admitLaunch(owner, 'task-a', '2'.repeat(64), launchPointer)).rejects.toThrow('authority')
  expect(sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  // A pre-existing state cannot be adopted by changing its logical audit id.
  await expect(store.activate({ ...owner, auditId: 'another-audit' }, '3'.repeat(64))).rejects.toThrow('ownership')
})

it.each([false, true])('completes an autonomous audit through guarded persistence (delayed settlement: %s)', async delaySettlement => {
  const { d1, store, onAfterRun } = fixture(), { bucket: r2 } = memoryR2()
  const states = new CloudflareRunStore(r2, r2, d1)
  const runId = 'autonomous-controlled-audit'
  expect(await states.getStateIfPresent(runId)).toBeNull()
  const owner = await states.activateRootExecution(runId, undefined, { runId, mode: 'start' })
  const release = await sealReleasePackage(audit0PackageBody)
  await states.putRelease(release.body)
  let machine = await createControlledMachine(audit0Definition, release.digest, runId, undefined, undefined, owner)
  await machine.start()
  let persist = await stateWriter(states, null)
  await persist(machine.view())
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const requested = new Map<string, string>()
  const nativeReceipts = new Map<string, AgentExecutionReceipt>()
  const otherReceipts = new Map<string, Awaited<ReturnType<DeterministicAuditProvider['run']>>>()
  let lostSettlements = 0, nativeObservations = 0
  let withheld: { taskId: string; requestDigest: string; receiptDigest: string } | undefined
  let blockedDepartures = 0, withheldInvocations = 0
  onAfterRun(sql => {
    if (nativeReceipts.size > 0 && lostSettlements === 0 && sql.includes('UPDATE audit_execution_launches')) {
      lostSettlements++
      throw new Error('injected lost native settlement acknowledgement')
    }
  })
  const provider = { async run(request: Parameters<DeterministicAuditProvider['run']>[0]) {
    expect(request.executionAuthority).toEqual(owner)
    expect(request.taskExecutionId).toBe(await taskExecutionIdentity(owner, request.task.id))
    if (request.task.promptKind === 'research') {
      expect(request.attempt).toBe(1)
      requested.set(request.task.id, request.taskExecutionId!)
      const native = new SandboxAgentProvider({ INDEX: d1, ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace' } as any) as any
      native.assertProviderCredentials = async () => {}
      native.executionReceipts = { get: async (_runId: string, digest: string) => {
        nativeObservations++
        if (!nativeReceipts.has(digest)) {
          await reserveNativeLaunch(states, store, request, digest)
          const result = await base.run(request)
          nativeReceipts.set(digest, { requestDigest: digest, exitCode: 0, stderr: '',
            actorId: result.actorId, files: { ...result.files }, inputTokens: result.inputTokens,
            outputTokens: result.outputTokens, costUsd: result.costUsd })
        }
        return nativeReceipts.get(digest)!
      } }
      return native.run(request)
    }
    const digest = await sha256({ taskId: request.task.id, attempt: request.attempt, promptDigest: request.promptDigest })
    // Closure can lose its pointer CAS after writing artifact bytes. Production
    // providers re-observe the immutable native receipt instead of paying again.
    const recovered = otherReceipts.get(digest)
    if (recovered !== undefined) return recovered
    if (request.task.providerClass === 'deterministic') {
      const state = await states.getState(runId)
      await store.admitLaunch(owner, request.taskExecutionId!, digest, { generation: state.stateGeneration, digest: await sha256(state) })
    } else await reserveNativeLaunch(states, store, request, digest)
    requested.set(request.task.id, request.taskExecutionId!)
    const result = await base.run(request)
    otherReceipts.set(digest, result)
    if (delaySettlement && withheld === undefined && request.task.providerClass !== 'deterministic') {
      withheld = { taskId: request.task.id, requestDigest: digest, receiptDigest: await sha256(result) }
    }
    if (request.task.id === withheld?.taskId) withheldInvocations++
    else await store.settleLaunch(owner, digest, await sha256(result))
    return result
  } }
  for (let guard = 0; machine.snapshot().cursor.stageIndex < audit0Definition.stages.length; guard++) {
    expect(guard).toBeLessThan(100)
    try {
      await advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: artifacts,
        policy: audit0RunPolicy, onWaveAdmission: persist,
        onCheckpoint: async () => { await persist(machine.view()) },
      })
      await persist(machine.view())
    } catch (error) {
      expect(error).toBeInstanceOf(TransientRunFailure)
      expect((error as Error).message).toContain('unsettled native work')
      expect(withheld).toBeDefined()
      blockedDepartures++
      const saved = await states.getState(runId)
      expect(saved.status).toBe('running')
      expect(saved.waveAdmission?.taskOccurrences?.some(value => value.taskId === withheld!.taskId)).toBe(true)
      expect(saved.inFlightAgentAttempts?.some(value => value.taskId === withheld!.taskId)).toBe(true)
      expect(otherReceipts.has(withheld!.requestDigest)).toBe(true)
      await store.settleLaunch(owner, withheld!.requestDigest, withheld!.receiptDigest)
    }
    // A Workflow wake reconstructs from the selected state, not an in-memory predecessor.
    const saved = await states.getState(runId)
    persist = await stateWriter(states, saved)
    machine = await RunMachine.fromState(audit0Definition, saved, digest => states.getRelease(digest), states.executionSources())
  }
  expect(audit0RunPolicy.assessCompletion({ definition: audit0Definition, state: machine.snapshot() })).toEqual([])
  await machine.complete()
  await persist(machine.view())
  const final = await states.getState(runId)
  expect(final.status).toBe('completed')
  expect(lostSettlements).toBe(1)
  expect(blockedDepartures).toBe(delaySettlement ? 1 : 0)
  expect(withheldInvocations).toBe(delaySettlement ? 1 : 0)
  expect(nativeObservations).toBeGreaterThan(nativeReceipts.size)
  expect(final.rejectedAttempts).toEqual([])
  expect(nativeReceipts.size).toBe(final.artifacts.filter(artifact => artifact.protocol.research !== undefined).length)
  onAfterRun()
  expect(final.executionAuthority).toEqual(owner)
  expect(final.artifacts.find(artifact => artifact.taskId === 'seal-final')).toBeDefined()
  for (const checkpoint of final.checkpoints) expect(checkpoint.body.executionAuthority).toEqual(owner)
  for (const artifact of final.artifacts) {
    expect(artifact.execution?.taskExecutionId).toBe(await taskExecutionIdentity(owner, artifact.taskId))
    if (requested.has(artifact.taskId)) expect(artifact.execution?.taskExecutionId).toBe(requested.get(artifact.taskId))
  }
  await expect(store.admitLaunch(owner, 'late-task', 'f'.repeat(64), launchPointer)).rejects.toThrow('authority')
  await store.fence(owner, 'b'.repeat(64))
  await store.retire(owner, 'c'.repeat(64))
}, 30_000) // Full autonomous audit with checkpoint reloads; unit-test timeout is too short under parallel load.


it('binds a production writer to its own predecessor even when the shared store observes newer state', async () => {
  const { states, state, branch } = await stateFixture()
  await states.putState(state, null)
  const stale = await stateWriter(states, await states.getState(state.runId))
  const current = await stateWriter(states, await states.getState(state.runId))
  const currentState = await branch('current computation'), staleState = await branch('stale computation', true)
  await current(currentState)
  // A diagnostic read or another durable step cannot silently rebase stale work.
  await states.getState(state.runId)
  await expect(stale(staleState))
    .rejects.toThrow('stale run-state')
  expect((await states.getState(state.runId)).terminalReason).toBe('current computation')
})


it('does not let concurrent writes through one writer silently rebase each other', async () => {
  const { states, state, branch } = await stateFixture()
  await states.putState(state, null)
  const persist = await stateWriter(states, state)
  const branches = [
    await branch('first'),
    await branch('second', true),
  ]
  const results = await Promise.allSettled(branches.map(branch => persist(branch)))
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const winner = results.findIndex(result => result.status === 'fulfilled')
  expect(await states.getState(state.runId)).toEqual(branches[winner])
})

it('refuses an obsolete state pointer before reserving any native work', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  expect(await f.store.admitLaunch(owner, 'task-a', '2'.repeat(64), { ...launchPointer, digest: 'e'.repeat(64) })).toBe(false)
  expect(await f.store.admitLaunch(owner, 'task-a', '2'.repeat(64), { ...launchPointer, generation: 2 })).toBe(false)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  expect(await f.store.admitLaunch(owner, 'task-a', '2'.repeat(64), launchPointer)).toBe(true)
  await f.store.settleLaunch(owner, '2'.repeat(64), '3'.repeat(64))
  await expect(f.store.admitLaunch(owner, 'task-a', '2'.repeat(64), launchPointer)).rejects.toThrow('authority')
})

it.each(['prompt', 'model', 'session', 'tools', 'missing-digest', 'removed-attempt'] as const)(
  'blocks a native request with %s changed after durable admission', async change => {
    const f = fixture(), owner = authority()
    await f.running(owner)
    const { provider, sandbox, request, claimStart, state } = await nativeFixture(f.d1, owner)
    if (change === 'prompt') { request.prompt += ' changed'; request.promptDigest = await sha256(request.prompt) }
    if (change === 'model') request.task.model = 'different-model'
    if (change === 'session') { request.sessionId = 'different-session'; request.continuationMode = 'resume' }
    if (change === 'tools') request.enableNativeSearch = true
    if (change === 'missing-digest') delete state.inFlightAgentAttempts![0]!.dispatchDigest
    if (change === 'removed-attempt') state.inFlightAgentAttempts = []
    await expect(provider.runInSandbox(sandbox, request)).rejects.toThrow(change === 'model'
      ? 'covered allocation identity differs' : change === 'missing-digest'
        ? 'native launch authority is temporarily unavailable' : 'matching persisted task admission')
    expect(claimStart).not.toHaveBeenCalled(); expect(sandbox.startProcess).not.toHaveBeenCalled()
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  },
)

it.each([false, true])('rechecks peer progress after a pointer race (claim already reserved: %s)', async afterInsert => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, state, progress } = await nativeFixture(f.d1, owner)
  const newer = await progress()
  const key = runStateKey(newer.runId, newer.stateGeneration, await sha256(newer))
  let reads = 0
  provider.runs.getState = async () => {
    reads++
    if (reads === 1 && !afterInsert) f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = ?').run(key, newer.stateGeneration)
    return reads === 1 ? state : newer
  }
  f.onAfterRun(sql => {
    if (afterInsert && sql.includes('INSERT INTO audit_execution_launches')) {
      if (reads === 1) f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = ?').run(key, newer.stateGeneration)
    }
  })
  await reserveNativeLaunch(provider.runs, f.store, request, '2'.repeat(64))
  expect(reads).toBe(2)
  expect(provider.runs.putAgentDispatch).toHaveBeenCalledTimes(1)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(1)
})

it('blocks a delayed callback when its task admission disappears during reservation', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, sandbox, claimStart, state, progress } = await nativeFixture(f.d1, owner)
  const newer = await progress(true)
  const key = runStateKey(newer.runId, newer.stateGeneration, await sha256(newer))
  let reads = 0
  provider.runs.getState = async () => {
    reads++
    if (reads === 1) f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = ?').run(key, newer.stateGeneration)
    return reads === 1 ? state : newer
  }
  await expect(provider.runInSandbox(sandbox, request)).rejects.toThrow('matching persisted task admission')
  expect(reads).toBe(2); expect(claimStart).not.toHaveBeenCalled(); expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it('yields boundedly when unrelated state keeps changing without making another paid request', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, sandbox, claimStart, state, machine } = await nativeFixture(f.d1, owner)
  let reads = 0
  provider.runs.getState = async () => {
    reads++
    const selected = machine.view()
    const command = { id: `pause-${reads}`, expectedRevision: reads - 1, action: 'pause' as const,
      scope: { kind: 'audit' as const }, reason: 'concurrent admission decision' }
    const now = new Date().toISOString()
    await machine.applyAdmissionControl({ auditId: owner.auditId, command, commandDigest: await sha256(command),
      revision: reads, version: 1, status: 'applying', acceptedAt: now, updatedAt: now })
    const newer = machine.view()
    f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = ?')
      .run(runStateKey(newer.runId, newer.stateGeneration, await sha256(newer)), newer.stateGeneration)
    return selected
  }
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(TransientRunFailure)
  expect(reads).toBe(3); expect(claimStart).not.toHaveBeenCalled(); expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it('reconciles a lost reservation acknowledgement before touching the native start claim', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, sandbox, claimStart } = await nativeFixture(f.d1, owner)
  f.onAfterRun(sql => { if (sql.includes('INSERT INTO audit_execution_launches')) throw new Error('lost reservation acknowledgement') })
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(TransientRunFailure)
  expect(claimStart).not.toHaveBeenCalled()
  f.onAfterRun()
  await expect(provider.runInSandbox(sandbox, request)).rejects.toThrow('lost R2 claim')
  expect(claimStart).toHaveBeenCalledTimes(1); expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(1)
})

it('uses an existing repair claim only for observation after task admission disappears', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, sandbox, claimStart, state } = await nativeFixture(f.d1, owner)
  state.inFlightAgentAttempts = []
  request.formatRepairOrdinal = 1
  provider.executionReceipts.getStart = vi.fn(async () => ({ acquired: false, claimedAt: new Date().toISOString() }))
  provider.persistWorkspacePreparationFailure = async () => false
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(provider.executionReceipts.getStart).toHaveBeenCalledOnce()
  expect(claimStart).not.toHaveBeenCalled(); expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it('never creates a native start claim to fill in missing log metadata', async () => {
  const f = fixture(), owner = authority()
  const { provider, request, claimStart } = await nativeFixture(f.d1, owner)
  provider.executionReceipts.getStart = vi.fn(async () => null)
  provider.executionLogs = { putRequest: vi.fn() }
  await provider.ensureAgentLogRequest(request, 'a'.repeat(64))
  expect(provider.executionReceipts.getStart).toHaveBeenCalledOnce()
  expect(claimStart).not.toHaveBeenCalled()
  expect(provider.executionLogs.putRequest).not.toHaveBeenCalled()
})

it('starts an authorized native request once and then only observes that process', async () => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, request, sandbox, state } = await nativeFixture(f.d1, owner)
  let registered = false
  const process = { id: 'synthetic-process', getStatus: async () => { throw new AgentExecutionPending('synthetic-process') } }
  provider.executionReceipts.claimStart = vi.fn(async () => ({ acquired: true, claimedAt: new Date().toISOString() }))
  provider.prepareSandbox = async () => {}
  provider.ensureAgentLogRequest = async () => {}
  const writeFile = vi.fn(async (_path: string, _content: string) => {})
  Object.assign(sandbox, {
    getProcess: async () => registered ? process : null,
    startProcess: vi.fn(async () => { registered = true; return process }),
    writeFile, exec: async () => ({ success: true }), deleteFile: async () => ({ success: true }),
  })
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(sandbox.startProcess).toHaveBeenCalledOnce()
  expect(writeFile.mock.calls.some(call => String(call[0]).includes('/agent-ready-'))).toBe(true)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches WHERE receipt_digest IS NULL').get()!.n).toBe(1)
  // Losing admission or executor authority closes fresh launches, not observation.
  state.inFlightAgentAttempts = []
  await f.store.fence(owner, '2'.repeat(64))
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(sandbox.startProcess).toHaveBeenCalledOnce()
  expect(provider.executionReceipts.claimStart).toHaveBeenCalledOnce()
})


it.each(['origin', 'ordinal'] as const)('refuses a coherently forged occurrence %s before reserving native work', async changed => {
  const f = fixture(), owner = authority()
  await f.running(owner)
  const { provider, sandbox, request, claimStart, state } = await nativeFixture(f.d1, owner)
  const occurrence = state.discoveryScheduler!.admissions.find(value => value.taskIds.includes(request.task.id))!
    .taskOccurrences!.find(value => value.taskId === request.task.id)!
  if (changed === 'origin') occurrence.origin.authority.executionId = 'forged-origin'
  else occurrence.origin.ordinal = 1
  occurrence.taskExecutionId = `task-${(await sha256(occurrence.origin.ordinal === 0
    ? { authority: occurrence.origin.authority, taskId: occurrence.taskId }
    : { version: 1, authority: occurrence.origin.authority, taskId: occurrence.taskId, ordinal: occurrence.origin.ordinal })).slice(0, 48)}`
  request.taskExecutionId = occurrence.taskExecutionId
  request.execution!.taskExecutionId = occurrence.taskExecutionId
  state.inFlightAgentAttempts![0]!.execution = structuredClone(request.execution!)
  state.inFlightAgentAttempts![0]!.dispatchDigest = await sha256(request)
  await expect(f.d1.prepare('UPDATE experiment_runs SET state_key = ?1 WHERE run_id = ?2')
    .bind(runStateKey(state.runId, state.stateGeneration, await sha256(state)), state.runId).run())
    .rejects.toThrow('state selection receipts are immutable')
  await expect(provider.runInSandbox(sandbox, request)).rejects.toBeInstanceOf(TransientRunFailure)
  expect(claimStart).not.toHaveBeenCalled(); expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
})

it.each(['missing', 'substituted', 'duplicate'] as const)(
  'refuses fabricated in-place task selection (%s) before any storage write', async change => {
    const f = fixture(), owner = authority()
    await f.running(owner)
    const { runs, state, request, dispatchBucket } = await nativeFixture(f.d1, owner)
    const admission = state.discoveryScheduler!.admissions.find(value => value.taskIds.includes(request.task.id))!
    if (change === 'missing') Reflect.deleteProperty(admission, 'taskOccurrences')
    else if (change === 'substituted') admission.taskOccurrences![0]!.taskExecutionId = `task-${'f'.repeat(48)}`
    else admission.taskOccurrences = [...admission.taskOccurrences!, admission.taskOccurrences![0]!]
    const write = vi.spyOn(dispatchBucket.r2, 'put')
    await expect(runs.putState(state)).rejects.toThrow('state must be produced')
    expect(write).not.toHaveBeenCalled()
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  })

it("does not block state progress on another audit's unsettled native claims", async () => {
  const f = await stateFixture()
  const pointer = await f.states.putState(f.state, null)
  const other = { ...authority(), auditId: 'other-audit', executionId: 'other-audit' }
  await f.running(other)
  await f.store.admitLaunch(other, 'other-task', '2'.repeat(64), launchPointer)
  const next = await f.branch('synthetic own failure')
  await f.states.putState(next, pointer)
  expect(await f.states.getState(next.runId)).toEqual(next)
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
})

async function cancellationFixture() {
  const f = await stateFixture()
  await f.states.putState(f.state, null)
  const journal = new RunCommandJournal(f.d1, f.owner.auditId)
  const accepted = await journal.admit({ id: 'cancel-native', expectedRevision: 0, action: 'cancel',
    scope: { kind: 'audit' }, reason: 'stop the synthetic audit' }, f.owner)
  const applying = await journal.beginEffect(accepted.command.id, accepted.version, f.state)
  return { ...f, journal, applying, pointer: { generation: f.state.stateGeneration, digest: await sha256(f.state) } }
}

it('closes launch admission at native cancellation intent without fencing state persistence', async () => {
  const f = await cancellationFixture()
  expect(await f.store.admitLaunch(f.owner, 'task-before', '2'.repeat(64), f.pointer)).toBe(true)
  const intent = await f.journal.beginNativeEffect(f.applying.command.id, f.applying.version, '3'.repeat(64))
  await expect(f.store.admitLaunch(f.owner, 'task-after', '4'.repeat(64), f.pointer)).rejects.toThrow('authority')
  await expect(f.store.admitLaunch(f.owner, 'task-before', '2'.repeat(64), f.pointer)).rejects.toThrow('authority')
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(1)
  await f.store.assertActive(f.owner)
  expect(await f.journal.beginNativeEffect(intent.command.id, intent.version, '3'.repeat(64))).toEqual(intent)
  await expect(f.store.admitLaunch(f.owner, 'task-after', '4'.repeat(64), f.pointer)).rejects.toThrow('authority')
  await f.store.settleLaunch(f.owner, '2'.repeat(64), '6'.repeat(64))
  await f.machine.seal()
  await f.states.putState(f.machine.view(), f.pointer)
})

it('keeps the reservation but refuses launch when cancellation wins after INSERT and before readback', async () => {
  const f = await cancellationFixture()
  // Prepare the exact journal row through production CAS, then schedule that
  // same row at the atomic interleaving under test.
  const intent = await f.journal.beginNativeEffect(f.applying.command.id, f.applying.version, '3'.repeat(64))
  const row = f.sqlite.prepare('SELECT * FROM audit_run_commands WHERE version = ?').get(intent.version)!
  f.sqlite.prepare('DELETE FROM audit_run_commands WHERE version = ?').run(intent.version)
  f.onAfterRun(sql => {
    if (sql.includes('INSERT INTO audit_execution_launches')) {
      f.sqlite.prepare('INSERT INTO audit_run_commands (audit_id, revision, command_id, version, operation_json, operation_digest) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.audit_id!, row.revision!, row.command_id!, row.version!, row.operation_json!, row.operation_digest!)
    }
  })
  await expect(f.store.admitLaunch(f.owner, 'task-racing', '2'.repeat(64), f.pointer)).rejects.toThrow('authority')
  f.onAfterRun()
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
  expect((await f.journal.get(intent.command.id))!.nativeEffect).toEqual(intent.nativeEffect)
})

it.each(['other-owner', 'scoped', 'resume'])('honors revocation intent by authority rather than retired command shape (%s)', async variant => {
  const f = await cancellationFixture()
  const intent = await f.journal.beginNativeEffect(f.applying.command.id, f.applying.version, '3'.repeat(64))
  const changed = structuredClone(intent)
  if (variant === 'other-owner') changed.source!.authority.executionId = 'other-executor'
  if (variant === 'scoped') (changed.command as any).scope = { kind: 'tasks', taskIds: ['task-a'] }
  if (variant === 'resume') (changed as { command: unknown }).command = { ...changed.command, action: 'restart', scope: { kind: 'audit' }, session: 'resume' }
  // Only the launch SQL boundary is under test here; journal parsing has its
  // own exact-hash coverage.
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE version = ?')
    .run(canonicalJson(changed), await sha256(changed), intent.version)
  if (variant === 'other-owner') {
    expect(await f.store.admitLaunch(f.owner, 'task-a', '2'.repeat(64), f.pointer)).toBe(true)
  } else {
    // Even an unsupported command shape cannot reopen an existing revocation
    // for this executor. Current command parsing separately rejects the shape.
    await expect(f.store.admitLaunch(f.owner, 'task-a', '2'.repeat(64), f.pointer)).rejects.toThrow('authority')
    expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  }
})

it('refuses overlapping native request digests while allowing a settled retry', async () => {
  const { store, running } = fixture(), owner = authority()
  await running(owner)
  expect(await store.admitLaunch(owner, 'task', '2'.repeat(64), launchPointer)).toBe(true)
  await expect(store.admitLaunch(owner, 'task', '3'.repeat(64), launchPointer)).rejects.toThrow('reservation is missing')
  expect(await store.pendingLaunches(owner)).toHaveLength(1)
  await store.settleLaunch(owner, '2'.repeat(64), '4'.repeat(64))
  expect(await store.admitLaunch(owner, 'task', '3'.repeat(64), launchPointer)).toBe(true)
  expect(await store.pendingLaunches(owner)).toMatchObject([{ requestDigest: '3'.repeat(64) }])
})
