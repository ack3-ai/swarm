import { compileExperimentConfig } from './support/compile-config.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest, AgentResult } from '../src/contracts.js'
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

describe('independent discovery pool waves', () => {
  it('starts a fast pool next cohort while a slow pool map cohort is still active and freezes the latest frontier', async () => {
    const { body, machine, store, base } = await preparedMachine(manifest([luna, deepseek], 4), 'independent-fast-pool')
    let releaseSlow!: () => void
    const slow = new Promise<void>(resolve => { releaseSlow = resolve })
    let slowActive = false
    let fastAdvancedWhileSlow = false
    let slowMapVisibleToFastWave2 = false
    const activeWorkspaces = new Set<string>()
    const provider: AgentProvider = {
      async run(request) {
        expect(activeWorkspaces.has(request.task.workspaceKey)).toBe(false)
        activeWorkspaces.add(request.task.workspaceKey)
        try {
          const poolId = configuredResearchTaskPoolId(request.task)
          const wave = request.task.research?.wave
          if (poolId === 'deepseek' && wave === 0) {
            slowActive = true
            await slow
            slowActive = false
          }
          if (poolId === 'luna' && wave === 1) {
            fastAdvancedWhileSlow ||= slowActive
            expect(request.visibleArtifacts.filter(artifact => artifact.taskId.startsWith('core-wave-0-'))).toHaveLength(3)
            releaseSlow()
          }
          if (poolId === 'luna' && wave === 2) {
            slowMapVisibleToFastWave2 ||= request.visibleArtifacts.some(artifact => (
              artifact.taskId === 'additive-wave-0-research-1'
            ))
          }
          return base.run(request)
        } finally {
          activeWorkspaces.delete(request.task.workspaceKey)
        }
      },
    }
    await advanceExperimentOneWave({ definition: body.definition, machine, provider, artifactStore: store })
    expect(fastAdvancedWhileSlow).toBe(true)
    expect(slowMapVisibleToFastWave2).toBe(true)
    expect(activeWorkspaces.size).toBe(0)
  })

  it('wakes a parked fast pool when a slow pool publishes material evidence and supplies it to the next cohort', async () => {
    const { body, machine, store, base } = await preparedMachine(manifest([luna, deepseek], 6), 'independent-pool-wakeup')
    let releaseMaterial!: () => void
    const delayedMaterial = new Promise<void>(resolve => { releaseMaterial = resolve })
    let materialPending = false
    let wokeWithMaterial = false
    const provider: AgentProvider = {
      async run(request: AgentRequest) {
        const poolId = configuredResearchTaskPoolId(request.task)
        const wave = request.task.research?.wave
        if (poolId === 'deepseek' && wave === 1) {
          materialPending = true
          await delayedMaterial
          materialPending = false
        }
        if (poolId === 'luna' && wave === 2 && materialPending) releaseMaterial()
        if (poolId === 'luna' && (wave ?? 0) >= 3) {
          wokeWithMaterial ||= request.visibleArtifacts.some(artifact => artifact.taskId === 'additive-wave-1-research-2')
        }
        const result = await base.run(request)
        if (request.task.promptKind !== 'research') return result
        const material = poolId === 'deepseek' && wave === 1
        return withMaterial(result, material, `${poolId}-wave-${wave}-evidence`)
      },
    }
    await advanceExperimentOneWave({ definition: body.definition, machine, provider, artifactStore: store })
    expect(wokeWithMaterial).toBe(true)
    const receipt = machine.snapshot().waveReceipts.find(value => (
      value.poolId === 'luna' && value.waveId === 'wave-3'
    ))
    const slowFinding = machine.snapshot().artifacts.find(value => value.taskId === 'additive-wave-1-research-2')!
    expect(receipt?.inputArtifacts).toContainEqual({ id: slowFinding.id, contentDigest: slowFinding.contentDigest })
  })

  it('keeps identical models on separate endpoint pools with independent counters and receipts', async () => {
    const third = { ...deepseek, id: 'second-endpoint',
      connection: { baseUrl: 'https://second-endpoint.example/v1', apiKeyEnv: 'SECOND_ENDPOINT_API_KEY' } }
    const glm = { ...luna, id: 'glm', model: 'glm-model', credentialSource: 'endpoint-glm', agents: 2 }
    const { body, machine, store, base } = await preparedMachine(
      manifest([luna, deepseek, third, glm], 4), 'independent-endpoints',
    )
    await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
    const state = machine.snapshot()
    expect(state.discoveryScheduler?.pools.map(pool => pool.poolId).toSorted())
      .toEqual(['deepseek', 'glm', 'luna', 'second-endpoint'])
    expect(new Set(state.waveReceipts.filter(receipt => receipt.stageId === 'discovery')
      .map(receipt => receipt.poolId))).toEqual(new Set(['deepseek', 'glm', 'luna', 'second-endpoint']))
    expect(new Set(state.artifacts.filter(artifact => artifact.stageId === 'discovery')
      .map(artifact => artifact.taskId.split('-wave-')[0])))
      .toEqual(new Set(['additive', 'core', 'pool-glm', 'pool-second-endpoint']))
  })

  it('closes admission on an operator stop and drains every already-admitted cohort', async () => {
    const { body, machine, store, base } = await preparedMachine(
      manifest([luna, deepseek], 5), 'independent-stop-drain',
    )
    let stopChecks = 0
    const checkpoint = await advanceExperimentOneWave({
      definition: body.definition,
      machine,
      provider: base,
      artifactStore: store,
      stopRequested: async () => ++stopChecks > 1,
    })
    const state = machine.snapshot()
    expect(checkpoint).toBe(false)
    expect(state.discoveryScheduler?.admissions).toEqual([])
    expect(state.discoveryScheduler?.pools.map(pool => pool.nextWaveIndex)).toEqual([1, 1])
    expect(state.waveReceipts.filter(receipt => receipt.stageId === 'discovery').map(receipt => (
      `${receipt.poolId}/${receipt.waveId}`
    )).toSorted()).toEqual(['deepseek/wave-0', 'luna/wave-0'])
    expect(state.cursor.stageIndex).toBe(1)
  })
})
