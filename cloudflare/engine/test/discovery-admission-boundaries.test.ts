import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { expect, it, vi } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { advanceExperimentOneWave, runNextWave, RunMachine, sealReleasePackage } from '../src/index.js'
import { sha256 } from '../src/canonical.js'
import { assertIndependentDiscoveryFrontier } from '../src/machine.js'
import { AgentAttemptFailure, AgentExecutionPending, PermanentRunFailure } from '../src/run-errors.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const runtime: any = { schemaVersion: 1, id: 'runtime-original', frameworkCommit: 'a'.repeat(40), workerService: 'swarm-runtime-original', workerVersionId: '11111111-1111-4111-8111-111111111111', workflowName: 'audit-runtime-original', containerImageDigest: `sha256:${'a'.repeat(64)}` }
async function fixture(id: string, cap=10000) {
  const config: any = structuredClone(document)
  config.id = id
  config.maxDiscoveryWaves = 4
  config.modelPools = config.modelPools.map((p: any) => ({ ...p, agents: 1 }))
  config.limits.maxModelCalls = cap
  config.limits.maxCostUsd = 10000
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await createControlledMachine(body.definition, release.digest, id, new Date().toISOString(), runtime)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await runNextWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}
const discoveryEnd = (machine: RunMachine) => machine.snapshot().stageEndReceipts.find(receipt => receipt.stageIndex === 1)?.reason

// D1: maxModelCalls stops new discovery work; a task that already started may still correct its output.
it('lets a started task take its correction turn past the model-call cap, but admits no new cohort', async () => {
  const { body, machine, store, base } = await fixture('review-retry-call-limit', 2)
  const requests: string[] = []
  const provider = { async run(request: any) {
    requests.push(`${request.wave.id}/${request.task.id}:${request.attempt}`)
    if (request.task.providerClass === 'additive' && request.attempt === 1)
      throw new AgentAttemptFailure('synthetic transport error', { includeDiagnosticsInRepair: false,
        usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 } })
    return base.run(request)
  } }
  for (let i=0; i<3 && machine.snapshot().cursor.stageIndex===1; i++) {
    await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  }
  expect(requests).toHaveLength(3)
  expect(requests.filter(request => request.endsWith(':2'))).toHaveLength(1)
  expect(requests.every(request => request.startsWith('wave-0/'))).toBe(true)
  expect(machine.snapshot().budget.modelCalls).toBe(3)
  expect(discoveryEnd(machine)).toBe('measured-budget-inability')
  await expect(restoreSelected(machine)).resolves.toBeDefined()
})
it('does not accept old global discovery recovery then produce an invalid checkpoint', async () => {
  const { body, machine, store, base } = await fixture('review-global-checkpoint-import')
  await runNextWave({ definition: body.definition, machine, artifactStore: store, provider: base })
  const saved = machine.snapshot(), resumed = await restoreSelected(machine)
  const checkpoint = saved.checkpoints.at(-1)!
  expect(checkpoint.body.discoveryScheduler).toBeUndefined()
  expect(checkpoint.body.cursor).toEqual({ stageIndex: 1, waveIndex: 1 })
  const fail = { async run(request: any) {
    if (request.task.providerClass === 'additive')
      throw new AgentAttemptFailure('synthetic exhausted no output', { includeDiagnosticsInRepair: false })
    return base.run(request)
  } }
  await runNextWave({ definition: body.definition, machine, artifactStore: store, provider: fail })
  await expect(runNextWave({ definition: body.definition, machine, artifactStore: store, provider: fail })).rejects.toThrow('synthetic exhausted no output')
  await machine.fail('synthetic source failure')
  const source = machine.snapshot()
  expect(() => assertIndependentDiscoveryFrontier(body.definition, source))
    .toThrow('compatible global-scheduler runtime')
  const calls: string[] = []
  await expect(advanceExperimentOneWave({ definition: body.definition, machine: resumed, artifactStore: store, provider: {
    async run(request: any) { calls.push(request.task.id); return base.run(request) }
  } })).rejects.toThrow('compatible global-scheduler runtime')
  expect(calls).toEqual([])
})

it('runs both correction turns when two pools need repairs at the last call', async () => {
  const { body, machine, store, base } = await fixture('review-two-repairs-last-call', 3)
  const calls: string[] = []
  const provider = { async run(request: any) {
    calls.push(`${request.wave.id}/${request.task.id}:${request.attempt}`)
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic transport failure', {
      includeDiagnosticsInRepair: false, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(calls).toHaveLength(4)
  expect(calls.filter(call => call.endsWith(':2'))).toHaveLength(2)
  expect(calls.every(call => call.startsWith('wave-0/'))).toBe(true)
  expect(machine.snapshot().budget.modelCalls).toBe(4)
  expect(machine.snapshot().artifacts.filter(a => a.stageId === 'discovery')).toHaveLength(2)
  expect(discoveryEnd(machine)).toBe('measured-budget-inability')
  await expect(restoreSelected(machine)).resolves.toBeDefined()
})

it('drains both admitted repairs after restart at the call cap, then admits no new cohort', async () => {
  const { body, machine, store, base } = await fixture('review-pending-repair-reservation', 3)
  let release = false
  const calls = new Set<string>()
  const provider = { async run(request: any) {
    calls.add(`${request.wave.id}/${request.task.id}:${request.attempt}`)
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic transport failure', {
      includeDiagnosticsInRepair: false, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    if (!release) throw new AgentExecutionPending('admitted repair still working')
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(machine.snapshot().inFlightAgentAttempts!.map(attempt => attempt.attempt)).toEqual([2, 2])
  const restored = await restoreSelected(machine)
  release = true
  await advanceExperimentOneWave({ definition: body.definition, machine: restored, artifactStore: store, provider })
  expect(calls.size).toBe(4)
  expect([...calls].every(call => call.startsWith('wave-0/'))).toBe(true)
  expect(restored.snapshot().budget.modelCalls).toBe(4)
  expect(restored.snapshot().inFlightAgentAttempts).toHaveLength(0)
  expect(restored.snapshot().artifacts.filter(a => a.stageId === 'discovery')).toHaveLength(2)
  expect(discoveryEnd(restored)).toBe('measured-budget-inability')
  await expect(restoreSelected(restored)).resolves.toBeDefined()
})

it('fails at once, before any later stage, when discovery ends with no accepted research', async () => {
  const { body, machine, store, base } = await fixture('empty-discovery-deadline')
  const calls: string[] = []
  const provider = { async run(request: any) { calls.push(request.task.id); return base.run(request) } }
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(discoveryDeadline(body.definition, machine.view()) + 60_000)
    const failure = await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
      .then(() => null, (error: unknown) => error)
    expect(failure).toBeInstanceOf(PermanentRunFailure)
    expect(failure).toMatchObject({ category: 'completion-contract-failed' })
    expect((failure as Error).message).toMatch(/wave 0 is missing.*phase-deadline/)
  } finally { vi.useRealTimers() }
  expect(calls).toEqual([])
  expect(machine.view().stageEndReceipts.map(receipt => receipt.stageIndex)).toEqual([0])
})
