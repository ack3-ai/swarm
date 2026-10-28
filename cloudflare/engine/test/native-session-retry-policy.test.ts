import { expect, it } from 'vitest'
import type { AgentRequest, NativeTerminalCustodyEvidence, NativeTransportEvidence } from '../src/contracts.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure, AgentExecutionPending, TransientRunFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave, disposeTerminalWorkspaces } from '../src/runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { MemoryArtifactStore } from './support/memory-runner.js'

const sessionId = 'session-11111111-1111-4111-8111-111111111111'
const usage = { modelCalls: 1 as const, inputTokens: 25, outputTokens: 4, costUsd: 0 }
function setup() {
  const config = structuredClone(document)
  config.maxDiscoveryWaves = 4
  config.modelPools = config.modelPools.map(pool => ({ ...pool, agents: pool.id === 'luna' ? 3 : 1 }))
  return compileExperimentConfig(config).definition
}
function evidence(request: AgentRequest, workState: NativeTransportEvidence['workState']): NativeTransportEvidence {
  return { code: 'TRANSPORT', sourceRunId: request.runId, requestDigest: 'c'.repeat(64), sessionId,
    snapshotDigest: 'd'.repeat(64), workState }
}

it.each(['present', 'unknown', 'none'] as const)('keeps execution, persisted admission, checkpoint, and resume consistent for %s custody', async workState => {
  const definition = setup(), machine = await RunMachine.create(definition, 'a'.repeat(64), `custody-${workState}`)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const nativeCalls: AgentRequest[] = []
  let sideEffects = 0, nativeAdmissionVerified = false
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0) return base.run(request)
    nativeCalls.push(request)
    if (request.attempt === 1) {
      sideEffects = workState === 'present' ? 1 : 0
      throw new AgentAttemptFailure('synthetic exhausted native transport', { usage, includeDiagnosticsInRepair: false,
        nativeTransport: evidence(request, workState) })
    }
    expect(request.attempt).toBe(2)
    expect(request.nativeTransport).toEqual(evidence(request, workState))
    expect(request.diagnostics).toEqual([])
    expect(request.continuationMode).toBe(workState === 'none' ? 'new' : 'resume')
    expect(request.freshContext).toBe(workState === 'none')
    expect(request.sessionId).toBe(workState === 'none' ? null : sessionId)
    // The native resume fixture separately proves the actual tool/reasoning replay.
    const result = await base.run(request)
    return { ...result, actorId: sessionId, sessionId }
  } }
  for (let tick = 0; tick < 12 && machine.snapshot().cursor.stageIndex === 1; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store,
      onWaveAdmission: async state => {
        if (state.inFlightAgentAttempts?.some(a => a.attempt === 2)) {
          await RunMachine.fromState(definition, state)
          nativeAdmissionVerified = true
        }
      },
    })
  }
  const state = machine.snapshot()
  expect(state.cursor.stageIndex).toBe(2)
  expect(nativeCalls.map(r => r.attempt)).toEqual([1, 2])
  expect(nativeAdmissionVerified).toBe(true)
  expect(state.rejectedAttempts).toHaveLength(1)
  expect(state.rejectedAttempts[0]).toMatchObject({ sessionId, nativeTransport: { workState }, usage })
  expect(sideEffects).toBe(workState === 'present' ? 1 : 0)
  expect(state.budget.modelCalls).toBe(state.artifacts.reduce((n, a) => n + a.usage.modelCalls, 0) + 1)
  const checkpoint = state.checkpoints.at(-1)!
  await expect(RunMachine.resume(definition, checkpoint, `custody-${workState}-resumed`)).resolves.toBeDefined()
  expect(nativeCalls).toHaveLength(2) // Neither state validation nor checkpoint loading invokes a model.
  const changed = structuredClone(state)
  changed.rejectedAttempts[0]!.nativeTransport!.snapshotDigest = 'invalid'
  await expect(RunMachine.fromState(definition, changed)).rejects.toThrow('digest mismatch')
})

it('leaves ordinary native output repairs on their original fresh-context policy', async () => {
  const definition = setup(), machine = await RunMachine.create(definition, 'a'.repeat(64), 'ordinary-native-repair')
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const calls: AgentRequest[] = []
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0) return base.run(request)
    calls.push(request)
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic invalid output', { usage })
    expect(request.continuationMode).toBe('new'); expect(request.freshContext).toBe(true)
    expect(request.nativeTransport).toBeUndefined()
    return base.run(request)
  } }
  for (let tick = 0; tick < 12 && machine.snapshot().cursor.stageIndex === 1; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
  }
  expect(calls.map(r => r.attempt)).toEqual([1, 2])
  await expect(RunMachine.resume(definition, machine.snapshot().checkpoints.at(-1)!, 'ordinary-repair-resume')).resolves.toBeDefined()
})

it('does not charge or consume an allowance while the closed execution custody upload retries', async () => {
  const definition = setup(), machine = await RunMachine.create(definition, 'a'.repeat(64), 'native-custody-upload-retry')
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const calls: number[] = []
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0) return base.run(request)
    calls.push(request.attempt)
    if (calls.length === 1) throw new TransientRunFailure('synthetic private archive upload failure')
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic closed receipt', { usage,
      includeDiagnosticsInRepair: false, nativeTransport: evidence(request, 'present') })
    expect(request.continuationMode).toBe('resume')
    const result = await base.run(request)
    return { ...result, actorId: sessionId, sessionId }
  } }
  for (let tick = 0; tick < 12 && machine.snapshot().cursor.stageIndex === 1; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
  }
  expect(calls).toEqual([1, 1, 2])
  expect(machine.snapshot().rejectedAttempts).toHaveLength(1)
  expect(machine.snapshot().rejectedAttempts[0]?.usage).toEqual(usage)
  expect(machine.snapshot().budget.modelCalls).toBe(machine.snapshot().artifacts.reduce((n, a) => n + a.usage.modelCalls, 0) + 1)
  await expect(RunMachine.resume(definition, machine.snapshot().checkpoints.at(-1)!, 'custody-upload-resume')).resolves.toBeDefined()
})

it('does not reopen exhausted native repair allowances on supervisor retries', async () => {
  const definition = setup(), machine = await RunMachine.create(definition, 'a'.repeat(64), 'native-repair-exhausted')
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const calls: number[] = []
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0) return base.run(request)
    calls.push(request.attempt)
    throw new AgentAttemptFailure('synthetic exhausted transport', { usage, includeDiagnosticsInRepair: false,
      nativeTransport: evidence(request, 'present') })
  } }
  const failures: unknown[] = []
  for (let tick = 0; tick < 12 && machine.snapshot().cursor.stageIndex === 1; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store }).catch(error => failures.push(error))
  }
  expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'agent-repair-exhausted', retryable: false })]))
  expect(machine.snapshot().rejectedAttempts.filter(r => r.nativeTransport !== undefined)).toHaveLength(2)
  await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store }).catch(() => {})
  expect(calls).toEqual([1, 2])
})

it.each(['present', 'unknown', 'none'] as const)('stops after terminal AUTH and preserves only potentially worked native lanes (%s)', async workState => {
  const definition = setup(), machine = await RunMachine.create(definition, 'a'.repeat(64), `terminal-auth-${workState}`)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const calls: number[] = [], disposed: string[] = []
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0) return base.run(request)
    calls.push(request.attempt)
    const custody: NativeTerminalCustodyEvidence = { code: 'AUTH', sourceRunId: request.runId,
      requestDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64), sessionId,
      archiveStatus: workState === 'unknown' ? 'unavailable' : 'available', workState }
    throw new AgentAttemptFailure('synthetic provider AUTH403', { usage, includeDiagnosticsInRepair: false,
      nativeTerminalCustody: custody })
  }, async disposeWorkspace(input: { workspaceKey: string }) { disposed.push(input.workspaceKey); return { status: 'destroyed' as const, timeoutMs: 5_000 } } }
  const failures: unknown[] = []
  for (let tick = 0; tick < 12 && machine.snapshot().status === 'running'; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store }).catch(error => failures.push(error))
  }
  expect(calls).toEqual([1])
  expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({ category: 'provider-rejected', retryable: false })]))
  await machine.fail('synthetic terminal AUTH')
  const state = machine.snapshot()
  expect(state.status).toBe('failed')
  expect(state.rejectedAttempts.filter(r => r.nativeTerminalCustody !== undefined)).toHaveLength(1)
  expect(state.rejectedAttempts.find(r => r.nativeTerminalCustody)?.usage).toEqual(usage)
  await RunMachine.fromState(definition, state)
  const tampered = structuredClone(state)
  tampered.rejectedAttempts[0]!.nativeTerminalCustody!.snapshotDigest = 'invalid'
  await expect(RunMachine.fromState(definition, tampered)).rejects.toThrow('digest mismatch')
  const nativeKey = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
    .find(task => task.providerClass === 'additive' && task.research?.wave === 0)!.workspaceKey
  await disposeTerminalWorkspaces(provider, definition, state)
  expect(disposed.includes(nativeKey)).toBe(workState === 'none')
})

it('does not re-admit terminal AUTH while a required review peer drains across checkpoints', async () => {
  const definition = compileExperimentConfig({ ...structuredClone(document), maxDiscoveryWaves: 4,
     }).definition
  let machine = await RunMachine.create(definition, 'a'.repeat(64), 'terminal-auth-pending-peer')
  const artifactStore = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const replicaAttempts: number[] = []
  let primaryPolls = 0, pendingWithFailure = false, failure: unknown
  const provider = { async run(request: AgentRequest) {
    if (request.task.id === 'negative-review-primary' && primaryPolls++ < 2) {
      throw new AgentExecutionPending('synthetic-primary-peer', 'unfinished')
    }
    if (request.task.id !== 'negative-review-replica') return base.run(request)
    replicaAttempts.push(request.attempt)
    throw new AgentAttemptFailure('synthetic terminal AUTH 403', { usage, includeDiagnosticsInRepair: false,
      nativeTerminalCustody: { code: 'AUTH', sourceRunId: request.runId, requestDigest: 'c'.repeat(64),
        snapshotDigest: 'd'.repeat(64), sessionId, archiveStatus: 'available', workState: 'present' } })
  } }
  for (let tick = 0; tick < 50; tick++) {
    try { await advanceExperimentOneWave({ definition, machine, provider, artifactStore }) } catch (error) {
      if (error instanceof AgentExecutionPending) {
        if (machine.snapshot().journal.some(event => event.type === 'task.failed'
          && (event.payload as { taskId?: string }).taskId === 'negative-review-replica')) {
          pendingWithFailure = true
          machine = await RunMachine.fromState(definition, machine.snapshot())
        }
        continue
      }
      failure = error
      break
    }
  }
  expect(pendingWithFailure).toBe(true)
  expect(primaryPolls).toBeGreaterThanOrEqual(3)
  expect(replicaAttempts).toEqual([1])
  expect(failure).toMatchObject({ category: 'provider-rejected', retryable: false })
  expect(machine.snapshot().journal.filter(event => event.type === 'task.failed'
    && (event.payload as { taskId?: string }).taskId === 'negative-review-replica')).toHaveLength(1)
})
