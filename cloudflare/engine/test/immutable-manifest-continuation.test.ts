import { createControlledMachine } from './support/controlled-machine.js'
import { selectedSnapshots } from './support/selected-snapshots.js'
import { onTestFinished } from 'vitest'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
import { expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { prepareStageForkSource } from '../src/stage-fork-source.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { PermanentRunFailure } from '../src/run-errors.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { syntheticSourceFence } from './support/source-fence.js'
import { forkWithSavedWork } from './support/saved-work.js'
import { runtime, target } from './support/successor-fixture.js'

it.each([false, true].flatMap(keepPoolPeer => [false, true].map(lowerCap => ({ keepPoolPeer, lowerCap }))))(
  'continues with an unavailable pool removed (accepted peers=$keepPoolPeer, lower cap=$lowerCap)', async ({ keepPoolPeer, lowerCap }) => {
  const config = structuredClone(manifest)
  config.maxDiscoveryWaves = 3
  config.modelPools.find(pool => pool.id === 'deepseek')!.required = true
  const previous = await sealReleasePackage(compileExperimentConfig(config))
  const changed = structuredClone(config)
  changed.modelPools = changed.modelPools.filter(pool => pool.id !== 'deepseek')
  changed.modelPools.push({ ...changed.modelPools[0]!, id: 'replacement-reviewer', model: 'replacement-model', agents: 0 })
  changed.stageModelPools['negative-review'] = ['luna', 'replacement-reviewer']
  if (lowerCap) changed.limits.maxModelCalls = 1
  const next = await sealReleasePackage(compileExperimentConfig(changed))
  const load = async (digest: string) => {
    if (digest === previous.digest) return previous
    if (digest === next.digest) return next
    throw new Error('unknown release')
  }
  let machine = await createControlledMachine(previous.body.definition, previous.digest, 'pool-outage', undefined, runtime,
    { auditId: 'pool-outage', executionId: 'pool-outage', epoch: 0, runtimeDigest: await sha256(runtime) })
  const artifacts = new MemoryArtifactStore(), provider = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts, provider })
  await expect(advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts,
    provider: { async run(request) {
      if (configuredResearchTaskPoolId(request.task) === 'deepseek'
        && (!keepPoolPeer || request.task.id === 'additive-wave-0-research-1')) throw new PermanentRunFailure('subscription unavailable', 'invalid-configuration')
      return provider.run(request)
    } } })).rejects.toThrow('subscription unavailable')
  await machine.fail('subscription unavailable')
  const source = machine.snapshot(), sourceDigest = await sha256(source)
  expect(source.artifacts.some(record => record.stageId === 'discovery')).toBe(true)
  expect(source.artifacts.some(record => record.taskId.startsWith('additive-wave-0'))).toBe(keepPoolPeer)
  const selected = selectedSnapshots(); onTestFinished(selected.close)
  await selected.select(machine)
  const stateAt = selected.load
  const prepared = await prepareStageForkSource({ sourceFrontier: true, releaseDigest: next.digest,
    source: { runId: source.runId, state: { generation: source.stateGeneration, digest: sourceDigest } },
    sourceFence: syntheticSourceFence(source), read: { stateAt, release: load,
      checkpoint: async digest => source.checkpoints.find(value => value.digest === digest)! },
    readArtifact: async record => artifacts.contents.get(record.uri)!, readInputs: digest => artifacts.readExecutionInputs(digest) })
  machine = await forkWithSavedWork(prepared, 'pool-replacement', target, load, stateAt)
  expect(machine.view().budget).toEqual(source.budget)
  const calls: Array<{ taskId: string; pool: string | undefined; model: string }> = []
  for (let ticks = 0; machine.view().cursor.stageIndex < machine.definition.stages.length; ticks++) {
    expect(ticks).toBeLessThan(20)
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts,
      provider: { async run(request) {
        calls.push({ taskId: request.task.id, pool: request.task.modelPool ?? (request.task.promptKind === 'research' ? configuredResearchTaskPoolId(request.task) : undefined), model: request.task.model })
        return provider.run(request)
      } } })
    await selected.select(machine)
    machine = await RunMachine.fromState(machine.definition, machine.snapshot(), load, stateAt)
  }
  await machine.complete()
  expect(calls.some(call => call.pool === 'deepseek')).toBe(false)
  if (lowerCap) {
    expect(calls.some(call => call.taskId.includes('-research-'))).toBe(false)
    expect(machine.view().budget.modelCalls).toBeGreaterThan(next.body.definition.limits.maxModelCalls)
  }
  expect(calls.find(call => call.taskId === 'negative-review-replica')?.model).toBe('replacement-model')
  expect(calls.some(call => source.artifacts.some(record => record.taskId === call.taskId))).toBe(false)
  expect(machine.view().artifacts.slice(0, source.artifacts.length)).toEqual(source.artifacts)
  expect(machine.view().modelStartedAt).toBe(source.modelStartedAt)
  expect(machine.view().rootCreatedAt).toBe(source.rootCreatedAt)
  expect(await sha256(source)).toBe(sourceDigest)
})
