import { compileExperimentConfig } from './support/compile-config.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { AgentProvider } from '../src/contracts.js'
import {
  createAudit0RunPolicy, RunMachine, sealReleasePackage,
} from '../src/index.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

describe('generic model-pool acceptance flow', () => {
  it('carries three independently sized pools through synthesis and every deterministic gate', async () => {
    const manifest: any = structuredClone(document)
    manifest.id = 'three-model-pool-acceptance'
    manifest.maxDiscoveryWaves = 4
    manifest.modelPools = [
      {
        id: 'luna', backend: 'codex', model: 'gpt-codex-a',
        reasoningEffort: 'max',
        subagents: { default: { mode: 'disabled' } },
        credentialSource: 'default-codex-account', agents: 4, required: true,
      },
      {
        id: 'deepseek', backend: 'dsh-chat-completions', provider: 'provider-a',
        connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max', thinking: 'enabled',
        subagents: { default: { mode: 'disabled' } },
        agents: 2, required: false,
      },
      {
        id: 'terra', backend: 'codex', model: 'gpt-codex-b',
        reasoningEffort: 'high',
        subagents: { default: { mode: 'disabled' } },
        credentialSource: 'default-codex-account', agents: 1, required: true,
      },
    ]
    const body = compileExperimentConfig(manifest)
    const release = await sealReleasePackage(body)
    const startedAt = '2026-09-22T00:00:00.000Z'
    const machine = await RunMachine.create(body.definition, release.digest, 'generic-pool-acceptance', startedAt)
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      async run(request) {
        const result = await base.run(request)
        return request.task.promptKind === 'research'
          ? { ...result, actorId: `stub-${request.task.id}-${request.attempt}` }
          : result
      },
    }
    const outcome = await runExperiment({
      definition: body.definition,
      machine,
      provider,
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })

    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.stageEndReceipts.find(receipt => receipt.from === 'discovery')?.reason)
      .toBe('safety-ceiling-reached')
    expect(new Set(outcome.state.artifacts.filter(artifact => artifact.stageId === 'discovery')
      .map(artifact => artifact.waveId))).toEqual(new Set(['wave-0', 'wave-1', 'wave-2', 'wave-3']))
    const researchIds = outcome.state.artifacts.flatMap(artifact => (
      artifact.protocol.research?.observations.map(observation => observation.id) ?? []
    ))
    expect(researchIds).toEqual(expect.arrayContaining([
      expect.stringMatching(/^OBS-LUNA-/),
      expect.stringMatching(/^OBS-DEEPSEEK-/),
      expect.stringMatching(/^OBS-TERRA-/),
    ]))
    const synthesis = outcome.state.artifacts.find(artifact => artifact.taskId === 'synthesizer')
    expect(synthesis?.protocol.synthesisDispositions).toHaveLength(researchIds.length)
  })
})
