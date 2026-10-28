import { compileExperimentConfig } from './support/compile-config.js'
import { AgentAttemptFailure, AgentExecutionPending, PermanentRunFailure } from '../src/run-errors.js'
import { sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { AgentRequest } from '../src/contracts.js'
import {
  advanceExperimentOneWave, RunMachine, sealReleasePackage,
} from '../src/index.js'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
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

const luna = {
  id: 'luna', backend: 'codex', model: 'shared-model', reasoningEffort: 'max',
  subagents: { default: { mode: 'disabled' } }, credentialSource: 'endpoint-luna', agents: 3, required: true,
}
const deepseek = {
  id: 'deepseek', backend: 'dsh-chat-completions', provider: 'provider-a',
  connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
  model: 'shared-model', reasoningEffort: 'max', thinking: 'enabled',
  subagents: { default: { mode: 'disabled' } }, agents: 1, required: false,
}

async function preparedMachine(config: any, runId: string) {
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, runId)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}

describe('independent review: sharing and failure boundaries', () => {
  it('retains each originating artifact exactly once when two pools produce identical valid bytes', async () => {
    const { body, machine, store, base } = await preparedMachine(manifest([luna, deepseek], 5), 'review-identical-content')
    const cuts: Array<{ task: string; ids: string[] }> = []
    let mapArrivals = 0
    let releaseMap!: () => void
    const mapBarrier = new Promise<void>(resolve => { releaseMap = resolve })
    await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
      async run(request) {
        if ((request.task.research?.wave ?? 0) === 0 && ++mapArrivals === 4) releaseMap()
        if ((request.task.research?.wave ?? 0) === 0) await mapBarrier
        if ((request.task.research?.wave ?? 0) > 0) cuts.push({ task: request.task.id, ids: request.visibleArtifacts.map(artifact => artifact.id) })
        return base.run(request)
      },
    } })
    const a = machine.snapshot().artifacts.find(artifact => artifact.taskId === 'core-wave-0-research-1')!
    const b = machine.snapshot().artifacts.find(artifact => artifact.taskId === 'additive-wave-0-research-1')!
    expect(a.contentDigest).toBe(b.contentDigest)
    expect(a.id).not.toBe(b.id)
    expect(cuts.length).toBeGreaterThan(0)
    for (const cut of cuts) {
      expect(cut.ids, cut.task + ': each saved provenance record must occur once').toEqual([...new Set(cut.ids)])
      expect(cut.ids, cut.task + ': both origin identities must survive the shared frontier').toEqual(expect.arrayContaining([a.id, b.id]))
    }
  })

  it('defers terminal failure while another already-admitted pool still has healthy pending work', async () => {
    const { body, machine, store, base } = await preparedMachine(manifest([{ ...luna, agents: 1 }, deepseek], 5), 'review-failure-drain')
    let pendingDispatched = false
    let failure: unknown
    try {
      await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
        async run(request) {
          if (configuredResearchTaskPoolId(request.task) === 'deepseek') {
            pendingDispatched = true
            throw new AgentExecutionPending('healthy-foreign-process')
          }
          throw new PermanentRunFailure('fixture terminal required task error', 'invalid-configuration')
        },
      } })
    } catch (error) { failure = error }
    expect(pendingDispatched).toBe(true)
    expect(failure === undefined || failure instanceof AgentExecutionPending,
      `pending work must defer terminal Workflow cleanup; received ${String(failure)}`).toBe(true)
  })
})


it('recovers independently sealed fast cohorts through the public recovery path without replaying them', async () => {
  const config = manifest([{ ...luna, agents: 1 }, deepseek], 5)
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const runtime = {
    schemaVersion: 1 as const, id: 'runtime-review-source', frameworkCommit: 'a'.repeat(40),
    workerService: 'swarm-runtime-review-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
    workflowName: 'audit-runtime-review-source', containerImageDigest: `sha256:${'a'.repeat(64)}`,
  }
  const machine = await RunMachine.create(body.definition, release.digest, 'review-recovery-parent', new Date().toISOString(), runtime)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  let failure: unknown
  for (let tick = 0; tick < 5 && failure === undefined; tick++) {
    try {
      await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
        async run(request) {
          if (configuredResearchTaskPoolId(request.task) === 'deepseek') {
            throw new AgentAttemptFailure('fixture lost process without output', { includeDiagnosticsInRepair: false })
          }
          return base.run(request)
        },
      } })
    } catch (error) { failure = error }
  }
  expect(failure).toBeInstanceOf(Error)
  await machine.fail('fixture failed discovery')
  const source = machine.snapshot()
  const fastArtifacts = source.artifacts.filter(artifact => artifact.stageId === 'discovery')
  expect(fastArtifacts.length).toBeGreaterThan(1)
  const checkpoint = source.checkpoints.at(-1)!
  const targetRuntime = { ...runtime, id: 'runtime-review-target', frameworkCommit: 'b'.repeat(40),
    workerService: 'swarm-runtime-review-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
    workflowName: 'audit-runtime-review-target' }
  const prepared = await prepareFailedWaveRecovery({
    definition: body.definition, checkpoint, source, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: targetRuntime,
    artifacts: { async read(record) {
      const raw = store.contents.get(record.uri)!
      expect(await sha256(raw)).toBe(record.contentDigest)
      return JSON.parse(raw)
    } },
  })
  const child = await RunMachine.recoverFailedWave(body.definition, checkpoint, source, 'review-recovery-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
  const restored = await RunMachine.fromState(body.definition, child.snapshot())
  const calls: string[] = []
  await advanceExperimentOneWave({ definition: body.definition, machine: restored, artifactStore: store, provider: {
    async run(request) { calls.push(request.task.id); return base.run(request) },
  } })
  for (const record of fastArtifacts) {
    expect(calls).not.toContain(record.taskId)
    expect(restored.snapshot().artifacts.find(item => item.id === record.id)).toEqual(record)
  }
  expect(restored.snapshot().cursor.stageIndex).toBe(2)
})


it('terminalizes when all admitted pools failed rather than treating failures as healthy drain work', async () => {
  const { body, machine, store } = await preparedMachine(manifest([{ ...luna, agents: 1 }, deepseek]), 'review-all-pools-failed')
  await expect(advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
    async run() { throw new PermanentRunFailure('fixture all admitted pools failed', 'invalid-configuration') },
  } })).rejects.toThrow('fixture all admitted pools failed')
})


it('replays a pending failure drain without re-dispatching the permanently failed pool', async () => {
  const { body, machine, store, base } = await preparedMachine(manifest([{ ...luna, agents: 1 }, deepseek]), 'review-drain-replay')
  let failedCalls = 0
  const provider = { async run(request: AgentRequest) {
    if (configuredResearchTaskPoolId(request.task) === 'luna') {
      failedCalls++
      throw new PermanentRunFailure('fixture permanent failure', 'invalid-configuration')
    }
    throw new AgentExecutionPending('fixture healthy pending peer')
  } }
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider })
  expect(failedCalls).toBe(1)
  const restored = await RunMachine.fromState(body.definition, machine.snapshot())
  await advanceExperimentOneWave({ definition: body.definition, machine: restored, artifactStore: store, provider })
  expect(failedCalls, 'a new polling slice must observe the saved failure rather than dispatching it again').toBe(1)
})


it('resumes a portable checkpoint at drained independent discovery without replaying accepted tasks', async () => {
  const { body, machine, store, base } = await preparedMachine(manifest([luna, deepseek]), 'review-stop-checkpoint')
  let checks = 0
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: base,
    stopRequested: async () => ++checks > 1 })
  const accepted = machine.snapshot().artifacts.filter(artifact => artifact.stageId === 'discovery')
  expect(accepted).toHaveLength(4)
  const checkpoint = await machine.seal()
  const child = await RunMachine.resume(body.definition, checkpoint, 'review-stopped-child', new Set())
  const calls: string[] = []
  await advanceExperimentOneWave({ definition: body.definition, machine: child, artifactStore: store, provider: {
    async run(request) { calls.push(request.task.id); return base.run(request) },
  } })
  for (const artifact of accepted) {
    expect(calls).not.toContain(artifact.taskId)
    expect(child.snapshot().artifacts.find(value => value.id === artifact.id)).toEqual(artifact)
  }
})
