import { compileExperimentConfig } from './support/compile-config.js'
import { expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { advanceExperimentOneWave, runNextWave, RunMachine, sealReleasePackage } from '../src/index.js'
import { sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { assertIndependentDiscoveryFrontier } from '../src/machine.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../src/run-errors.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const runtime: any = { schemaVersion: 1, id: 'runtime-original', frameworkCommit: 'a'.repeat(40), workerService: 'swarm-runtime-original', workerVersionId: '11111111-1111-4111-8111-111111111111', workflowName: 'audit-runtime-original', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const targetRuntime = { ...runtime, id: 'runtime-new', frameworkCommit: 'b'.repeat(40), workerService: 'swarm-runtime-new', workerVersionId: '22222222-2222-4222-8222-222222222222', workflowName: 'audit-runtime-new' }
async function fixture(id: string, cap=10000) {
  const config: any = structuredClone(document)
  config.id = id
  config.maxDiscoveryWaves = 4
  config.modelPools = config.modelPools.map((p: any) => ({ ...p, agents: 1 }))
  config.limits.maxModelCalls = cap
  config.limits.maxCostUsd = 10000
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, id, new Date().toISOString(), runtime)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await runNextWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}
it('never dispatches a repair beyond a configured model-call cap', async () => {
  const { body, machine, store, base } = await fixture('review-retry-call-limit', 2)
  const requests: string[] = []
  const provider = { async run(request: any) {
    requests.push(`${request.task.id}:${request.attempt}`)
    if (request.task.providerClass === 'additive' && request.attempt === 1)
      throw new AgentAttemptFailure('synthetic transport error', { includeDiagnosticsInRepair: false,
        usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 } })
    return base.run(request)
  } }
  for (let i=0; i<3 && machine.snapshot().cursor.stageIndex===1; i++) {
    try { await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider }) }
    catch { break }
  }
  expect.soft(requests, 'maximum two new provider calls across original attempts and repair').toHaveLength(2)
  expect.soft(machine.snapshot().budget.modelCalls).toBeLessThanOrEqual(2)
  const checkpoint = machine.snapshot().checkpoints.at(-1)!
  await expect(RunMachine.resume(body.definition, checkpoint, 'review-retry-cap-child')).resolves.toBeDefined()
})
it('does not accept old global discovery recovery then produce an invalid checkpoint', async () => {
  const { body, machine, store, base } = await fixture('review-global-checkpoint-import')
  await runNextWave({ definition: body.definition, machine, artifactStore: store, provider: base })
  const checkpoint = machine.snapshot().checkpoints.at(-1)!
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
  // Portable preparation in the front door still permits routing to an old
  // compatible runtime; the new destination rejects before Workflow creation.
  await expect(prepareFailedWaveRecovery({ definition: body.definition, checkpoint, source,
    sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
    targetRuntimeRelease: targetRuntime, artifacts: { async read(record: any) { return JSON.parse(store.contents.get(record.uri)!) } } }))
    .resolves.toBeDefined()
  expect(() => assertIndependentDiscoveryFrontier(body.definition, source))
    .toThrow('compatible global-scheduler runtime')
  const resumed = await RunMachine.resume(body.definition, checkpoint, 'review-global-import-child')
  const calls: string[] = []
  await expect(advanceExperimentOneWave({ definition: body.definition, machine: resumed, artifactStore: store, provider: {
    async run(request: any) { calls.push(request.task.id); return base.run(request) }
  } })).rejects.toThrow('compatible global-scheduler runtime')
  expect(calls).toEqual([])
})

it('reserves the last call once when two pools need repairs', async () => {
  const { body, machine, store, base } = await fixture('review-two-repairs-last-call', 3)
  const calls: string[] = []
  const provider = { async run(request: any) {
    calls.push(`${request.task.id}:${request.attempt}`)
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic transport failure', {
      includeDiagnosticsInRepair: false, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  await expect(advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider }))
    .rejects.toThrow('model-call budget admission denied')
  expect(calls).toHaveLength(3)
  expect(calls.filter(call => call.endsWith(':2'))).toHaveLength(1)
  expect(machine.snapshot().budget.modelCalls).toBe(3)
  await expect(RunMachine.fromState(body.definition, machine.snapshot())).resolves.toBeDefined()
})

it('drains an existing repair after restart when another repair has no call capacity', async () => {
  const { body, machine, store, base } = await fixture('review-pending-repair-reservation', 3)
  let release = false
  const calls = new Set<string>()
  const provider = { async run(request: any) {
    calls.add(`${request.task.id}:${request.attempt}`)
    if (request.attempt === 1) throw new AgentAttemptFailure('synthetic transport failure', {
      includeDiagnosticsInRepair: false, usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    })
    if (!release) throw new AgentExecutionPending('admitted repair still working')
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(machine.snapshot().inFlightAgentAttempts).toHaveLength(1)
  expect(machine.snapshot().inFlightAgentAttempts![0]!.attempt).toBe(2)
  const restored = await RunMachine.fromState(body.definition, machine.snapshot())
  release = true
  await expect(advanceExperimentOneWave({ definition: body.definition, machine: restored, artifactStore: store, provider }))
    .rejects.toThrow('model-call budget admission denied')
  expect(calls.size).toBe(3)
  expect(restored.snapshot().budget.modelCalls).toBe(3)
  expect(restored.snapshot().inFlightAgentAttempts).toHaveLength(0)
  expect(restored.snapshot().artifacts.filter(a => a.stageId === 'discovery')).toHaveLength(1)
  await expect(RunMachine.fromState(body.definition, restored.snapshot())).resolves.toBeDefined()
})
