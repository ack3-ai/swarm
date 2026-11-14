import { describe, expect, it, vi } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { canonicalJson } from '../src/canonical.js'
import type { AgentRequest, AgentResult, ExperimentDefinition, TaskDefinition } from '../src/contracts.js'
import { assertBudgetShape, zeroBudget } from '../src/execution-budget.js'
import { classifyAgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { executionRequestBody } from '../src/native-request.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { providerIdentity } from '../src/provider-identity.js'
import { sealReleasePackage } from '../src/release.js'
import { assertReleaseProviderCredentials } from '../src/release-provider-credentials.js'
import { createAudit0RunPolicy } from '../src/runner.js'
import { agentProcessEnvironment, SandboxAgentProvider } from '../src/sandbox-provider.js'
import { validateExperiment } from '../src/validation.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const primary = 'CLAUDE_TEAM_OAUTH_TOKEN'
const fallbacks = ['CLAUDE_B_OAUTH_TOKEN', 'CLAUDE_C_OAUTH_TOKEN']
const tokens: Record<string, string> = { [primary]: 'sk-ant-oat-test-a', CLAUDE_B_OAUTH_TOKEN: 'sk-ant-oat-test-b',
  CLAUDE_C_OAUTH_TOKEN: 'sk-ant-oat-test-c' }
const claudePool = { id: 'luna', backend: 'claude', model: 'claude-sonnet-5', credentialSource: primary,
  reasoningEffort: 'high', agents: 3, required: true, subagents: { default: { mode: 'disabled' }, stages: {} } }
const config = (pool: Record<string, unknown> = {}) => ({ ...document,
  modelPools: [{ ...claudePool, ...pool }, document.modelPools[1]] })
const rotating = () => compileExperimentConfig(config({ fallbackCredentialSources: fallbacks })).definition
const tasks = (definition: ExperimentDefinition) =>
  definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks.map(task => ({ task, stage, wave }))))
const request = (definition: ExperimentDefinition, id: string): AgentRequest => {
  const { task, stage, wave } = tasks(definition).find(entry => entry.task.id === id)!
  return { experimentId: definition.id, runId: 'rotation-run', stage, wave, task, prompt: 'fixture',
    promptDigest: 'd'.repeat(64), visibleArtifacts: [], releaseDigest: 'e'.repeat(64), attempt: 1, diagnostics: [],
    repairFiles: {}, freshContext: false, continuationMode: 'new', sessionId: null } as AgentRequest
}
const switched = (sessionId: string, from = primary, to = fallbacks[0]!) => ({ provider: 'claude' as const, sessionId,
  from, to, at: '2026-01-01T00:00:00.000Z', resetsAt: '2026-01-01T05:00:00.000Z' })

describe('Claude account rotation config', () => {
  it('seals fallback accounts on the Claude pool and its tasks only when set', async () => {
    const definition = rotating()
    expect(() => validateExperiment(definition)).not.toThrow()
    expect(definition.pools[0]!.fallbackCredentialSources).toEqual(fallbacks)
    expect(definition.pools[1]!).not.toHaveProperty('fallbackCredentialSources')
    for (const { task } of tasks(definition)) {
      if (task.modelPool === 'luna') expect(task.fallbackCredentialSources).toEqual(fallbacks)
      else expect(task).not.toHaveProperty('fallbackCredentialSources')
    }
    const plain = compileExperimentConfig(config()).definition
    expect(canonicalJson(plain)).not.toContain('fallbackCredentialSources')
    expect(executionRequestBody(request(plain, 'core-wave-0-research-1'), 'workspace')).not.toHaveProperty('claudeAccounts')
    expect(executionRequestBody(request(definition, 'core-wave-0-research-1'), 'workspace').claudeAccounts)
      .toEqual([primary, ...fallbacks])
    expect(executionRequestBody(request(definition, 'additive-wave-0-research-1'), 'workspace')).not.toHaveProperty('claudeAccounts')
    const digest = async (value: unknown) => (await sealReleasePackage(compileExperimentConfig(value))).digest
    expect(await digest(config())).not.toBe(await digest(config({ fallbackCredentialSources: fallbacks })))
  })

  it('leaves a release without fallback accounts unchanged', async () => {
    // The sealed body is the same object whether the key never existed or was left undefined.
    const plain = compileExperimentConfig(config())
    expect(compileExperimentConfig(config({ fallbackCredentialSources: undefined }))).toEqual(plain)
    expect((await sealReleasePackage(compileExperimentConfig(config({ fallbackCredentialSources: undefined })))).digest)
      .toBe((await sealReleasePackage(plain)).digest)
    expect(canonicalJson(compileExperimentConfig(document))).not.toMatch(/fallbackCredentialSources|claudeAccounts/)
  })

  it('accepts one to seven distinct fallbacks and rejects every other list', () => {
    const seven = Array.from({ length: 7 }, (_, index) => `CLAUDE_${index}_OAUTH_TOKEN`)
    expect(compileExperimentConfig(config({ fallbackCredentialSources: seven })).definition.pools[0]!.fallbackCredentialSources)
      .toEqual(seven)
    expect(compileExperimentConfig(config({ credentialSource: 'CLAUDE_CODE_OAUTH_TOKEN', fallbackCredentialSources: fallbacks }))
      .definition.pools[0]!.fallbackCredentialSources).toEqual(fallbacks)
    for (const value of [[], [...seven, 'CLAUDE_7_OAUTH_TOKEN'], 'CLAUDE_B_OAUTH_TOKEN', [primary], [fallbacks[0], fallbacks[0]],
      ['CODEX_B_AUTH_JSON'], ['CLAUDE_CODE_OAUTH_TOKEN'], ['claude_b_oauth_token'], [7], null]) {
      expect(() => compileExperimentConfig(config({ fallbackCredentialSources: value })), JSON.stringify(value))
        .toThrow('model pool luna has invalid fallbackCredentialSources')
    }
    for (const pool of document.modelPools) {
      expect(() => compileExperimentConfig({ ...document, modelPools: document.modelPools.map(other =>
        other === pool ? { ...other, fallbackCredentialSources: fallbacks } : other) }))
        .toThrow(`model pool ${pool.id}: fallbackCredentialSources is only supported on Claude pools`)
    }
  })

  it('the front door rejects invalid lists and tasks that differ from their pool', () => {
    const check = (change: (definition: ExperimentDefinition) => void) => {
      const definition = rotating()
      change(definition)
      return () => validateExperiment(definition)
    }
    const pool = (definition: ExperimentDefinition) => definition.pools[0]! as { fallbackCredentialSources?: readonly string[] }
    const task = (definition: ExperimentDefinition) => tasks(definition).find(entry => entry.task.modelPool === 'luna')!.task as TaskDefinition
    expect(check(() => {})).not.toThrow()
    expect(check(definition => { pool(definition).fallbackCredentialSources = [primary] }))
      .toThrow('model pool luna has invalid fallbackCredentialSources')
    expect(check(definition => { (definition.pools[1] as typeof definition.pools[0]).fallbackCredentialSources = fallbacks }))
      .toThrow('model pool deepseek: fallbackCredentialSources is only supported on Claude pools')
    expect(check(definition => { task(definition).fallbackCredentialSources = [fallbacks[1]!, fallbacks[0]!] }))
      .toThrow('does not preserve a configured model pool execution profile')
    expect(check(definition => { delete (task(definition) as { fallbackCredentialSources?: unknown }).fallbackCredentialSources }))
      .toThrow('does not preserve a configured model pool execution profile')
  })
})

describe('Claude account credentials', () => {
  const task = { id: 'claude', providerClass: 'core', backend: 'claude', credentialSource: primary,
    fallbackCredentialSources: fallbacks } as unknown as TaskDefinition
  const definition = { stages: [{ waves: [{ tasks: [task] }] }] } as unknown as ExperimentDefinition
  const bound = (overrides: Record<string, unknown> = {}) => ({ ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '',
    ...Object.fromEntries(Object.entries(tokens).map(([name, value]) => [name, { get: async () => value }])), ...overrides })

  it('checks every account at release start and names the missing binding', async () => {
    await expect(assertReleaseProviderCredentials(definition, bound())).resolves.toBeUndefined()
    await expect(assertReleaseProviderCredentials(definition, bound({ CLAUDE_C_OAUTH_TOKEN: undefined })))
      .rejects.toThrow('Claude subscription token CLAUDE_C_OAUTH_TOKEN is missing or invalid')
    await expect(assertReleaseProviderCredentials(definition, bound({ CLAUDE_B_OAUTH_TOKEN: 'api-key' })))
      .rejects.toThrow('Claude subscription token CLAUDE_B_OAUTH_TOKEN is missing or invalid')
    const invalid = { stages: [{ waves: [{ tasks: [{ ...task, fallbackCredentialSources: [primary] }] }] }] } as unknown as ExperimentDefinition
    await expect(assertReleaseProviderCredentials(invalid, bound())).rejects.toThrow('Claude subscription binding is invalid')
  })

  it('checks, redacts and passes every fallback token under its own binding', async () => {
    const provider = new SandboxAgentProvider(bound() as any) as any
    await expect(provider.assertProviderCredentials({ task })).resolves.toBeUndefined()
    expect(provider.redactKnownCredentials(`a ${tokens.CLAUDE_C_OAUTH_TOKEN} b`)).toBe('a <redacted:CLAUDE_C_OAUTH_TOKEN> b')
    await expect(new (SandboxAgentProvider as any)(bound({ CLAUDE_B_OAUTH_TOKEN: undefined })).assertProviderCredentials({ task }))
      .rejects.toThrow('Claude subscription token CLAUDE_B_OAUTH_TOKEN is missing or invalid')
    const env = agentProcessEnvironment({ task } as any, tokens as any, {})
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(tokens[primary])
    expect(env.CLAUDE_B_OAUTH_TOKEN).toBe(tokens.CLAUDE_B_OAUTH_TOKEN)
    expect(env.CLAUDE_C_OAUTH_TOKEN).toBe(tokens.CLAUDE_C_OAUTH_TOKEN)
    expect(env[primary]).toBeUndefined()
    expect(() => agentProcessEnvironment({ task } as any, { ...tokens, CLAUDE_C_OAUTH_TOKEN: '' } as any, {}))
      .toThrow('agent credential CLAUDE_C_OAUTH_TOKEN is missing')
    const single = agentProcessEnvironment({ task: { ...task, fallbackCredentialSources: undefined } } as any, tokens as any, {})
    expect(Object.keys(single).filter(name => name.startsWith('CLAUDE_'))).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
  })
})

describe('Claude account switch records', () => {
  const definition = rotating()
  const task = tasks(definition).find(entry => entry.task.id === 'core-wave-0-research-1')!.task
  const result = (extra: Partial<AgentResult> = {}, target: TaskDefinition = task): AgentResult => ({ status: 'accepted',
    actorId: 'rotation-session', model: target.model, provider: providerIdentity(target), files: {}, assertions: [],
    protocol: {}, inputTokens: 0, outputTokens: 0, costUsd: 0, ...extra })
  const integrity = async (value: AgentResult, target: TaskDefinition = task) =>
    (await validateAgentResultDetailed(target, value, [])).integrity
  const missing = 'the runner returned no account switch record; use a container image with Claude account rotation'
  const invalid = 'provider account switch evidence is invalid'

  it('requires the switch list exactly with rotation and checks it against the task accounts', async () => {
    expect(await integrity(result())).toContain(missing)
    expect(await integrity(result({ subscriptionSwitches: [] }))).not.toContain(invalid)
    expect(await integrity(result({ subscriptionSwitches: [] }))).not.toContain(missing)
    expect(await integrity(result({ subscriptionSwitches: [switched('rotation-session'),
      switched('rotation-session', fallbacks[0], fallbacks[1])] }))).not.toContain(invalid)
    for (const bad of [switched('other-session'), switched('rotation-session', primary, 'CLAUDE_OTHER_OAUTH_TOKEN'),
      switched('rotation-session', primary, primary), { ...switched('rotation-session'), at: 'never' }]) {
      expect(await integrity(result({ subscriptionSwitches: [bad] })), JSON.stringify(bad)).toContain(invalid)
    }
    const plain = tasks(compileExperimentConfig(config()).definition).find(entry => entry.task.id === task.id)!.task
    expect(await integrity(result({}, plain), plain)).not.toContain(missing)
    expect(await integrity(result({}, plain), plain)).not.toContain(invalid)
    expect(await integrity(result({ subscriptionSwitches: [] }, plain), plain)).toContain(invalid)
  })

  it('receipts and checkpoint usage accept valid switch lists and nothing else', () => {
    const receipt = { requestDigest: 'a'.repeat(64), exitCode: 0, actorId: 'rotation-session', files: {},
      inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '' }
    const status = (value: unknown) => classifyAgentExecutionReceipt(JSON.stringify(value), 'a'.repeat(64)).status
    expect(status(receipt)).toBe('exact')
    expect(status({ ...receipt, subscriptionSwitches: [switched('rotation-session')] })).toBe('exact')
    expect(status({ ...receipt, subscriptionSwitches: [{ ...switched('rotation-session'), token: tokens[primary] }] })).toBe('invalid')
    expect(() => assertBudgetShape({ ...zeroBudget(), subscriptionSwitches: [switched('rotation-session')] })).not.toThrow()
    expect(() => assertBudgetShape({ ...zeroBudget(), subscriptionSwitches: [switched('rotation-session', primary, primary)] }))
      .toThrow('checkpoint subscription switches are invalid')
  })

  it('a rotating Claude pool runs every stage and keeps its switches; an image without rotation fails closed', async () => {
    const body = compileExperimentConfig({ ...document,
      modelPools: [{ ...claudePool, agents: 1, fallbackCredentialSources: fallbacks }], maxDiscoveryWaves: 1,
      stopOnSaturation: false, stageModelPools: { synthesis: 'luna', coverage: 'luna', 'negative-review': ['luna'],
        verification: 'luna', reporting: 'luna' } })
    const release = await sealReleasePackage(body)
    const execute = async (runId: string, records: (agent: AgentRequest, actorId: string) => Partial<AgentResult>) => {
      const machine = await createControlledMachine(body.definition, release.digest, runId)
      const base = new DeterministicAuditProvider()
      return runExperiment({ definition: body.definition, machine, artifactStore: new MemoryArtifactStore(),
        provider: { run: async (agent: AgentRequest) => {
          const value = await base.run(agent)
          return agent.task.backend === 'claude' ? { ...value, ...records(agent, value.actorId) } : value
        }, disposeWorkspace: async () => {} },
        policy: createAudit0RunPolicy() })
    }
    const outcome = await execute('claude-rotation', (agent, actorId) =>
      ({ subscriptionSwitches: agent.task.promptKind === 'synthesis' ? [switched(actorId)] : [] }))
    expect(outcome.state.status).toBe('completed')
    const synthesis = outcome.state.artifacts.find(artifact => artifact.taskId === 'synthesizer')!
    expect(synthesis.usage.subscriptionSwitches).toEqual([switched(synthesis.actorId)])
    expect(outcome.state.artifacts.filter(artifact => (artifact.usage.subscriptionSwitches?.length ?? 0) > 0)).toHaveLength(1)
    // An older image ignores claudeAccounts and returns no list: the first Claude task fails integrity.
    await expect(execute('claude-rotation-old-image', () => ({}))).rejects.toMatchObject({ category: 'integrity-failed' })
  })
})
