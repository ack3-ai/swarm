import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import { compileExperimentConfig } from '../src/config-compiler.js'
import { AUDIT_STAGES, type AuditStageKind, type AgentRequest } from '../src/contracts.js'
import { createAudit0RunPolicy } from '../src/runner.js'
import { RunMachine } from '../src/machine.js'
import { sealReleasePackage } from '../src/release.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { loadAuditConfig } from '../tools/load-audit-config.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

function config(stages: readonly AuditStageKind[], backend: 'codex' | 'dsh-chat-completions' = 'codex', waves = 1) {
  const pool = { ...document.modelPools.find(pool => pool.backend === backend)!, agents: 1, required: true,
    subagents: { default: { mode: 'disabled' } } }
  return { ...document, stages, maxDiscoveryWaves: waves, stopOnSaturation: false, modelPools: [pool],
    stageModelPools: Object.fromEntries(stages.filter(stage => stage !== 'discovery').map(stage => [stage, pool.id])) }
}
async function execute(selected: Omit<ReturnType<typeof config>, 'stageModelPools'> & { stageModelPools: Record<string, string | string[]> }) {
  const body = compileExperimentConfig(selected, prompts)
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, 'configurable-stages')
  const calls: AgentRequest[] = []
  const provider = new DeterministicAuditProvider()
  const outcome = await runExperiment({ definition: body.definition, machine, artifactStore: new MemoryArtifactStore(),
    provider: { run: async request => { calls.push(request); return provider.run(request) }, disposeWorkspace: async () => {} },
    policy: createAudit0RunPolicy() })
  return { outcome, calls, body }
}

describe('configurable audit flow', () => {
  it('runs Claude through all configured stages with its sealed subscription identity', async () => {
    const selected = config([...AUDIT_STAGES])
    const { outcome, calls } = await execute({ ...selected, modelPools: [{ id: selected.modelPools[0]!.id,
      backend: 'claude', model: 'claude-sonnet-5', credentialSource: 'CLAUDE_TEAM_OAUTH_TOKEN',
      reasoningEffort: 'high', agents: 1, required: true, subagents: { default: { mode: 'disabled' } } }] })
    expect(outcome.state.status).toBe('completed')
    const modelCalls = calls.filter(call => call.task.providerClass !== 'deterministic')
    expect(modelCalls.every(call => call.task.backend === 'claude'
      && call.task.credentialSource === 'CLAUDE_TEAM_OAUTH_TOKEN')).toBe(true)
    expect(outcome.state.recoveryEpoch).toBe(0)
  })
  it('keeps a named Codex account on every configured stage', async () => {
    const selected = config([...AUDIT_STAGES])
    selected.modelPools[0]!.credentialSource = 'CODEX_TEAM_AUTH_JSON'
    const { outcome, calls } = await execute(selected)
    expect(outcome.state.status).toBe('completed')
    expect(calls.filter(call => call.task.providerClass === 'core')
      .every(call => call.task.credentialSource === 'CODEX_TEAM_AUTH_JSON')).toBe(true)
  })
  it('validates DSH model token limits without changing the harness', () => {
    const selected = config(['discovery'], 'dsh-chat-completions')
    const pool = selected.modelPools[0]!
    for (const [model, maxTokens] of [['glm-5.3', 131072], ['kimi-k3', 262144]] as const) {
      const body = compileExperimentConfig({ ...selected, modelPools: [{ ...pool, model,
        connection: { ...pool.connection, contextWindow: 1048576, maxTokens } }] }, prompts)
      expect(body.definition.pools[0]!.connection?.maxTokens).toBe(maxTokens)
    }
    expect(() => compileExperimentConfig({ ...selected, modelPools: [{ ...pool,
      connection: { ...pool.connection, contextWindow: 100, maxTokens: 101 } }] }, prompts)).toThrow('maxTokens')
  })

  it('completes ten research/review tasks plus synthesis and reporting with shared discovery and independent reviewers', async () => {
    const selected = config([...AUDIT_STAGES], 'codex', 3)
    const flash = { ...document.modelPools.find(pool => pool.backend === 'dsh-chat-completions')!, agents: 1,
      required: true, model: 'deepseek-v4-flash', subagents: { default: { mode: 'disabled' } } }
    const { outcome, calls, body } = await execute({ ...selected, forceSearch: false,
      nativeSearch: false, modelPools: [...selected.modelPools, flash],
      stageModelPools: { ...selected.stageModelPools, 'negative-review': [selected.modelPools[0]!.id, flash.id] } })
    expect(outcome.state.status).toBe('completed')
    const modelCalls = calls.filter(call => call.task.providerClass !== 'deterministic')
    expect(modelCalls).toHaveLength(12)
    expect(modelCalls.filter(call => !['synthesis', 'reporting'].includes(call.task.promptKind))).toHaveLength(10)
    expect(modelCalls.filter(call => call.task.backend === 'codex')).toHaveLength(8)
    expect(modelCalls.filter(call => call.task.backend === 'dsh-chat-completions')).toHaveLength(4)
    expect(modelCalls.filter(call => call.task.promptKind === 'research')).toHaveLength(6)
    const coverage = modelCalls.filter(call => call.task.promptKind === 'coverage-challenge')
    expect(coverage).toHaveLength(1)
    expect(coverage[0]!.task.backend).toBe('codex')
    for (const call of modelCalls.filter(call => (call.task.research?.wave ?? 0) > 0)) {
      expect(call.visibleArtifacts.some(artifact => artifact.protocol.research !== undefined)).toBe(true)
    }
    const reviews = modelCalls.filter(call => call.task.promptKind === 'negative-review')
    expect(reviews).toHaveLength(2)
    expect(reviews[0]!.visibleArtifacts.map(artifact => artifact.contentDigest).sort())
      .toEqual(reviews[1]!.visibleArtifacts.map(artifact => artifact.contentDigest).sort())
    expect(reviews[0]!.task.workspaceKey).not.toBe(reviews[1]!.task.workspaceKey)
    expect(body.definition.forceSearch).toBeUndefined()
    expect(body.definition.nativeSearch).toBeUndefined()
    expect(outcome.state.recoveryEpoch).toBe(0)
    expect(outcome.state.artifacts.find(artifact => artifact.taskId === 'seal-final')?.protocol.finalCustody?.observations.length)
      .toBeGreaterThan(0)
  })
  it.each(['codex', 'dsh-chat-completions'] as const)('runs exactly ten discovery tasks with %s and no hidden review', async backend => {
    const { outcome, calls } = await execute(config(['discovery'], backend, 10))
    expect(outcome.state.status).toBe('completed')
    expect(calls.filter(call => call.task.providerClass !== 'deterministic')).toHaveLength(10)
    expect(new Set(calls.map(call => call.task.promptKind))).toEqual(new Set(['preflight', 'research']))
    expect(outcome.state.artifacts.some(artifact => artifact.taskId === 'reporter')).toBe(false)
    expect(outcome.state.recoveryEpoch).toBe(0)
  })
  const valid: AuditStageKind[][] = [
    ['discovery'], ['discovery', 'coverage'], ['discovery', 'synthesis'],
    ['discovery', 'synthesis', 'coverage'],
    ['discovery', 'synthesis', 'coverage', 'negative-review'],
    ['discovery', 'synthesis', 'coverage', 'verification'],
    ['discovery', 'synthesis', 'coverage', 'negative-review', 'verification'],
    ['discovery', 'synthesis', 'negative-review', 'verification'],
    ['discovery', 'synthesis', 'negative-review'], ['discovery', 'synthesis', 'verification'],
    ['discovery', 'synthesis', 'verification', 'reporting'],
    ['discovery', 'synthesis', 'coverage', 'verification', 'reporting'],
    ['discovery', 'synthesis', 'negative-review', 'verification', 'reporting'], [...AUDIT_STAGES],
  ]
  it.each((['codex', 'dsh-chat-completions'] as const).flatMap(backend => valid.map(stages => [backend, stages.join(' → '), stages] as const)))('completes %s: %s with full evidence custody', async (backend, _, stages) => {
    const { outcome, body } = await execute(config(stages, backend))
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.stageEndReceipts).toHaveLength(stages.length + 1)
    expect(body.definition.stages.map(stage => stage.kind)).toEqual(['preflight', ...stages])
    const final = outcome.state.artifacts.find(artifact => artifact.taskId === 'seal-final')
    if (stages.includes('reporting')) {
      expect(final?.protocol.finalCustody?.observations.length).toBeGreaterThan(0)
      expect(final?.protocol.finalCustody?.negativeReviewUnionArtifactDigest === null).toBe(!stages.includes('negative-review'))
      expect(final?.protocol.finalCustody?.observations.filter(row => row.retainedReferences.length > 0).every(row => row.reportSections!.length > 0)).toBe(true)
    } else expect(final).toBeUndefined()
  })
  it.each([
    [], ['verification'], ['discovery', 'discovery'], ['discovery', 'reporting'],
    ['discovery', 'negative-review'], ['discovery', 'verification'],
    ['discovery', 'verification', 'synthesis'], ['discovery', 'synthesis', 'reporting'], ['discovery', 'invented'],
  ])('rejects invalid selection %j', (...stages) => {
    expect(() => compileExperimentConfig(config(stages as AuditStageKind[]), prompts)).toThrow()
  })
  it('supports one reviewer or repeated independent reviewers without requiring a second provider', async () => {
    const selected = config(['discovery', 'synthesis', 'negative-review'])
    const pool = selected.modelPools[0]!.id
    const { body, outcome } = await execute({ ...selected, stageModelPools: { synthesis: pool, 'negative-review': [pool, pool, pool] } })
    expect(outcome.state.status).toBe('completed')
    const review = body.definition.stages.at(-1)!
    expect(review.waves[0]!.tasks).toHaveLength(3)
    expect(new Set(review.waves[0]!.tasks.map(task => task.workspaceKey)).size).toBe(3)
    expect(review.waves[0]!.minSuccessfulTasks).toBe(3)
  })
  it('uses a later-stage-only pool without scheduling discovery calls for it', async () => {
    const selected = config([...AUDIT_STAGES])
    const reviewer = { ...document.modelPools.find(pool => pool.backend === 'dsh-chat-completions')!, agents: 0,
      subagents: { default: { mode: 'disabled' } } }
    const { outcome, calls } = await execute({ ...selected, modelPools: [...selected.modelPools, reviewer],
      stageModelPools: { ...selected.stageModelPools, verification: reviewer.id } })
    expect(outcome.state.status).toBe('completed')
    expect(calls.filter(call => call.task.modelPool === reviewer.id).map(call => call.task.promptKind)).toEqual(['verification'])
    expect(() => compileExperimentConfig({ ...selected, modelPools: [reviewer] }, prompts)).toThrow('required model pool')
  })
  it('resolves promptFile relative to the config and rejects missing files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-prompts-'))
    try {
      const file = join(dir, 'audit.json')
      await writeFile(file, JSON.stringify({ ...config(['discovery']), promptFile: 'research.json' }))
      await expect(loadAuditConfig(file)).rejects.toThrow()
      await writeFile(join(dir, 'research.json'), JSON.stringify({ discovery: 'Focus on access control.' }))
      expect((await loadAuditConfig(file)).definition.stagePrompts).toEqual({ discovery: 'Focus on access control.' })
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

it('seals optional header references into every task and rejects inline secrets', () => {
  const selected = config(['discovery'], 'dsh-chat-completions')
  const headersEnv = { 'X-Api-Key': 'EXTRA_PROVIDER_API_KEY' }
  const pool = { ...selected.modelPools[0]!, provider: 'local', model: 'local-model', connection: {
    baseUrl: 'https://local-model.example.com/v1', apiKeyEnv: 'LOCAL_MODEL_API_KEY', headersEnv } }
  const body = compileExperimentConfig({ ...selected, modelPools: [pool] }, prompts)
  expect(body.definition.pools[0]!.connection?.headersEnv).toEqual(headersEnv)
  expect(body.definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
    .filter(task => task.providerClass === 'additive').every(task => JSON.stringify(task.connection?.headersEnv) === JSON.stringify(headersEnv))).toBe(true)
  expect(() => compileExperimentConfig({ ...selected, modelPools: [{ ...pool,
    connection: { ...pool.connection, headersEnv: { ...headersEnv, 'X-Secret': 'inline-secret' } } }] }, prompts)).toThrow('header credential')
})
