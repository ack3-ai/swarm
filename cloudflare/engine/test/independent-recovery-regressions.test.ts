import { compileExperimentConfig } from './support/compile-config.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../src/run-errors.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { sha256 } from '../src/canonical.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { expect, it } from 'vitest'
import type { AgentRequest, AgentResult } from '../src/contracts.js'
import {
  advanceExperimentOneWave, RunMachine, sealReleasePackage,
} from '../src/index.js'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

function manifest(pools: any[], maxDiscoveryWaves = 5): any {
  const value: any = structuredClone(document)
  value.id = `independent-discovery-${pools.map(pool => pool.id).join('-')}`
  value.maxDiscoveryWaves = maxDiscoveryWaves
  value.modelPools = pools
  value.limits.maxModelCalls = 10_000
  value.limits.maxInputTokens = 100_000_000
  value.limits.maxOutputTokens = 100_000_000
  value.limits.maxCostUsd = 10_000
  return value
}

const luna = document.modelPools.find(pool => pool.id === 'luna')!
const deepseek = { ...document.modelPools.find(pool => pool.id === 'deepseek')!, agents: 1 }

async function preparedMachine(config: any, runId: string) {
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, runId)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}

function withMaterial(result: AgentResult, materialHighCriticalDelta: boolean, label: string): AgentResult {
  if (result.protocol.research === undefined) return result
  const observations = result.protocol.research.observations.map(observation => ({
    ...observation,
    statement: label,
    evidence: [label],
  }))
  const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
  submission.materialHighCriticalDelta = materialHighCriticalDelta
  submission.observations = submission.observations.map((observation: any) => ({
    ...observation,
    statement: label,
    evidence: [label],
  }))
  return {
    ...result,
    files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
    protocol: { research: { ...result.protocol.research, materialHighCriticalDelta, observations } },
  }
}


it.each(['provider-credit', 'platform-interruption'] as const)('resumes after optional %s interrupts a quiet streak', async reason => {
  const { body, machine, store, base } = await preparedMachine(manifest([{ ...luna, agents: 1 }, deepseek], 4), 'review-unavailable-after-quiet')
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
    async run(request) {
      const result = await base.run(request)
      if (request.task.promptKind !== 'research') return result
      if (configuredResearchTaskPoolId(request.task) === 'deepseek' && request.task.research?.wave === 2) {
        return { ...result, status: 'additive-unavailable', files: {}, assertions: [], protocol: {},
          unavailableReason: reason, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      }
      return withMaterial(result, false, 'no material delta')
    }
  } })
  expect(machine.snapshot().cursor.stageIndex).toBe(2)
  const checkpoint = machine.snapshot().checkpoints.at(-1)!
  await expect(RunMachine.resume(body.definition, checkpoint, 'review-unavailable-resume')).resolves.toBeDefined()
})

const runtime = {
  schemaVersion: 1 as const, id: 'runtime-review-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-review-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-review-source', containerImageDigest: `sha256:${'a'.repeat(64)}`,
}
const targetRuntime = { ...runtime, id: 'runtime-review-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-review-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'audit-runtime-review-target' }
async function recoveryFixture(id: string) {
  const body = compileExperimentConfig(manifest([{ ...luna, agents: 1 }, deepseek], 5))
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, id, new Date().toISOString(), runtime)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}
async function preparedRecovery(body: any, machine: RunMachine, store: MemoryArtifactStore) {
  const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
  const prepared = await prepareFailedWaveRecovery({ definition: body.definition, checkpoint, source,
    sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
    targetRuntimeRelease: targetRuntime, artifacts: { async read(record) {
      return JSON.parse(store.contents.get(record.uri)!)
    } } })
  return { prepared, source, checkpoint }
}
it('review: failed peer recovery preserves another peer accepted after a diagnostic repair', async () => {
  const { body, machine, store, base } = await recoveryFixture('review-repaired-peer')
  let failure: unknown
  for (let tick = 0; tick < 5 && failure === undefined; tick++) {
    try {
      await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
        async run(request) {
          if (configuredResearchTaskPoolId(request.task) === 'deepseek')
            throw new AgentAttemptFailure('fixture no output', { includeDiagnosticsInRepair: false })
          if (request.task.research?.wave === 0 && request.attempt === 1)
            throw new AgentAttemptFailure('fixture repair diagnosis', { includeDiagnosticsInRepair: true })
          return base.run(request)
        }
      } })
    } catch(error) { failure = error }
  }
  expect(failure).toBeInstanceOf(Error)
  await machine.fail('fixture failed discovery')
  expect(machine.snapshot().artifacts.some(a => a.taskId === 'core-wave-0-research-1')).toBe(true)
  await expect(preparedRecovery(body, machine, store)).resolves.toBeDefined()
})
it('review: recovery after a drained checkpoint retains earlier rejection accounting', async () => {
  const { body, machine, store, base } = await recoveryFixture('review-prior-rejections')
  const mapping = { async run(request: AgentRequest) {
    if (configuredResearchTaskPoolId(request.task) === 'luna' && request.task.research?.wave === 0 && request.attempt === 1)
      throw new AgentAttemptFailure('fixture restart without diagnostics', { includeDiagnosticsInRepair: false,
        usage: { modelCalls: 1, inputTokens: 123, outputTokens: 45, costUsd: 0.01 } })
    return base.run(request)
  } }
  const stop = async () => machine.snapshot().waveReceipts.some(r => r.stageId === 'discovery')
  for (let tick = 0; tick < 4; tick++) {
    await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store,
      provider: mapping, stopRequested: stop })
    if (machine.snapshot().discoveryScheduler?.admissions.length === 0) break
  }
  const priorCheckpoint = await machine.seal()
  expect(priorCheckpoint.body.rejectedAttempts).toHaveLength(1)
  let failure: unknown
  for (let tick = 0; tick < 5 && failure === undefined; tick++) {
    try {
      await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
        async run(request) {
          if (configuredResearchTaskPoolId(request.task) === 'deepseek')
            throw new AgentAttemptFailure('fixture no output', { includeDiagnosticsInRepair: false })
          return base.run(request)
        }
      } })
    } catch (error) { failure = error }
  }
  expect(failure).toBeInstanceOf(Error)
  await machine.fail('fixture failed after checkpoint')
  const { prepared, source, checkpoint } = await preparedRecovery(body, machine, store)
  const child = await RunMachine.recoverFailedWave(body.definition, checkpoint, source, 'review-prior-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
  expect.soft(child.snapshot().rejectedAttempts, 'all old usage evidence must survive').toHaveLength(source.rejectedAttempts.length)
  await advanceExperimentOneWave({ definition: body.definition, machine: child, artifactStore: store, provider: base })
  const restoredCheckpoint = child.snapshot().checkpoints.at(-1)!
  await expect(RunMachine.resume(body.definition, restoredCheckpoint, 'review-next-resume')).resolves.toBeDefined()
})

it.each([
  ['costUsd', 'maxCostUsd', 2, 3],
  ['inputTokens', 'maxInputTokens', 1_000, 2_000],
  ['outputTokens', 'maxOutputTokens', 1_000, 2_000],
] as const)('resumes legal late %s usage but rejects admission after that limit', async (metric, limit, cap, overrun) => {
  const config = manifest([{ ...luna, agents: 1 }, deepseek], 5)
  config.limits[limit] = cap
  const { body, machine, store, base } = await preparedMachine(config, 'review-asynchronous-budget')
  let releaseSlow = false
  const provider = { async run(request: AgentRequest) {
    const slow = configuredResearchTaskPoolId(request.task) === 'deepseek'
    if (slow && !releaseSlow) throw new AgentExecutionPending('slow-admitted-work')
    const result = await base.run(request)
    return { ...withMaterial(result, false, 'quiet fixture'), [metric]: slow ? overrun : metric === 'costUsd' ? 0.1 : 100 }
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(machine.snapshot().discoveryScheduler?.pools.find(p => p.poolId === 'luna')?.nextWaveIndex).toBe(3)
  releaseSlow = true
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(machine.snapshot().cursor.stageIndex).toBe(2)
  const checkpoint = machine.snapshot().checkpoints.at(-1)!
  await expect(RunMachine.resume(body.definition, checkpoint, 'review-budget-child')).resolves.toBeDefined()
  const invalid = structuredClone(checkpoint)
  invalid.body.waveReceipts.find(receipt => receipt.poolId === 'deepseek')!.budgetAtAdmission![metric] = cap
  invalid.digest = await sha256(invalid.body)
  await expect(RunMachine.resume(body.definition, invalid, 'review-budget-invalid')).rejects.toThrow('admitted after a measured budget limit')
})
