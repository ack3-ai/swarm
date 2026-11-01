import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import publicSample from '../../../docs/examples/audit.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/canonical.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { anchorResearchPlan } from './support/audit0-config.js'
import { instruction, searchQuestion } from './support/instructions.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import type { RuntimeRelease } from '../src/contracts.js'
import { DEFAULT_FORCE_SEARCH_STAGES, mandatorySearchRequirement } from '../src/native-research.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { captureDiscoveryRequests, mirroredResearchPrompt, researchReasoningText } from './support/research-prompts.js'
import { researchEvidencePaths, researchPredecessor } from '../src/accepted-mounts.js'

describe('experiment config compiler', () => {
  it('carries an explicit Codex access program to the scheduled task', () => {
    const program: any = structuredClone(document)
    program.modelPools[0].model = 'codex-program-model'
    program.modelPools[0].cyberAccessProgram = 'example_program'
    const definition = compileExperimentConfig(program).definition
    expect(definition.pools[0]!.cyberAccessProgram).toBe('example_program')
    expect(definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks
      .find(task => task.modelPool === program.modelPools[0].id)?.cyberAccessProgram).toBe('example_program')

    for (const name of ['', 'Example', '-flag', 'a b', 'x'.repeat(65)]) {
      program.modelPools[0].cyberAccessProgram = name
      expect(() => compileExperimentConfig(program)).toThrow('invalid cyberAccessProgram')
    }
    program.modelPools[0].cyberAccessProgram = 'example_program'
    program.modelPools[1].cyberAccessProgram = 'example_program'
    expect(() => compileExperimentConfig(program)).toThrow('invalid cyberAccessProgram')
  })

  it('accepts an opt-in usage-window wait only as a boolean on a DSH connection', () => {
    const windowed: any = structuredClone(document)
    windowed.modelPools[1].connection.usageWindowWait = true
    expect(compileExperimentConfig(windowed).definition.pools[1]!.connection?.usageWindowWait).toBe(true)
    windowed.modelPools[1].connection.usageWindowWait = 'yes'
    expect(() => compileExperimentConfig(windowed)).toThrow('invalid usageWindowWait')
  })

  it('defaults both harnesses to official Exa and rejects retired routing', () => {
    const manifest = { ...document, forceSearch: true, nativeSearch: {} }
    expect(compileExperimentConfig(manifest).definition.nativeSearch?.searchConnection)
      .toEqual({ provider: 'exa', apiKeyEnv: 'EXA_API_KEY' })
    expect(() => compileExperimentConfig({ ...manifest,
      modelPools: document.modelPools.map(pool => ({ ...pool, searchAgent: 'luna' })) }))
      .toThrow('modelPools[0] has unknown keys: searchAgent')
  })
  it('offers voluntary native search to ordinary tasks in both harnesses', async () => {
    const searchConnection = { provider: 'exa' as const, apiKeyEnv: 'EXA_API_KEY' }
    const enabled = compileExperimentConfig({ ...document, forceSearch: false,
      nativeSearch: { searchConnection } })
    const requests = await captureDiscoveryRequests(enabled.definition)
    expect(requests.some(request => request.task.providerClass === 'core')).toBe(true)
    expect(requests.some(request => request.task.providerClass === 'additive')).toBe(true)
    for (const request of requests) {
      if (request.task.providerClass === 'core') {
        expect(request.enableNativeSearch).toBe(true)
        expect(request.nativeSearchConnection).toEqual(searchConnection)
      } else {
        expect(request.nativeSearchConnection).toEqual(searchConnection)
        expect(request.enableNativeSearch).toBeUndefined()
      }
      expect(request.optionalOutputFiles).toBeUndefined()
      expect(request.prompt).not.toContain('public-search-request.json')
      expect(request.prompt).not.toContain('stop this turn')
      expect(request.prompt).toContain(instruction(enabled.definition, 'searchOptional',
        { TOOL: request.task.providerClass === 'additive' ? 'mcp__exa__web_search_exa' : 'web_search_exa' }))
    }
    const offline = await captureDiscoveryRequests(compileExperimentConfig(document).definition)
    expect(offline.every(request => request.enableNativeSearch === undefined
      && request.nativeSearchConnection === undefined)).toBe(true)
  })

  it('seals official Exa for mandatory research in both harnesses', async () => {
    const searchConnection = { provider: 'exa' as const, apiKeyEnv: 'EXA_API_KEY' }
    const manifest = { ...document, forceSearch: true,
      nativeSearch: { searchConnection } }
    const compiled = compileExperimentConfig(manifest)
    expect(compiled.definition.nativeSearch?.searchConnection).toEqual(searchConnection)
    const requests = await captureDiscoveryRequests(compiled.definition)
    const deepseek = requests.filter(request => request.task.providerClass === 'additive')
    expect(deepseek.length).toBeGreaterThan(0)
    expect(deepseek.every(request => JSON.stringify(request.nativeSearchConnection)
      === JSON.stringify(searchConnection))).toBe(true)
    expect(requests.filter(request => request.task.providerClass === 'core')
      .every(request => request.enableNativeSearch === true)).toBe(true)
    expect(requests.every(request => request.optionalOutputFiles === undefined)).toBe(true)
    for (const request of requests) {
      const tool = request.task.providerClass === 'additive' ? 'mcp__exa__web_search_exa' : 'web_search_exa'
      expect(request.prompt.split(searchQuestion(compiled.definition, tool))).toHaveLength(2)
      expect(request.prompt).not.toMatch(/proxy|initializer/i)
      expect(request.prompt).not.toContain('Native public search may supply')
    }
    const tasks = compiled.definition.stages.flatMap(stage => stage.waves.flatMap((wave, index) =>
      wave.tasks.filter(task => task.promptKind !== 'research' || index === 0)))
    for (const task of tasks) {
      const input = { definition: compiled.definition, task, visibleArtifacts: [], deadline: '2026-10-09T00:00:00.000Z' }
      const prompt = renderTaskPrompt(input)
      const repair = renderTaskPrompt({ ...input, formatRepairOnly: true, diagnostics: ['retain exact evidence'] })
      const tool = task.providerClass === 'additive' ? 'mcp__exa__web_search_exa' : 'web_search_exa'
      const question = searchQuestion(compiled.definition, tool)
      if (mandatorySearchRequirement(compiled.definition, task) === undefined) {
        expect(prompt).not.toContain(question)
      } else {
        expect(prompt).toContain(question)
      }
      expect(repair).not.toContain(question)
    }
    const disabled = compileExperimentConfig({ ...manifest, forceSearch: false }).definition
    const ordinaryTask = disabled.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
      .find(task => task.providerClass !== 'deterministic')!
    expect(renderTaskPrompt({ definition: disabled, task: ordinaryTask, visibleArtifacts: [],
      deadline: '2026-10-09T00:00:00.000Z' })).not.toContain(searchQuestion(disabled, 'web_search_exa'))
    expect(() => compileExperimentConfig({ ...manifest,
      nativeSearch: { searchConnection: { ...searchConnection, apiKeyEnv: 'not-a-key-reference' } } }))
      .toThrow('API key environment variable')
    expect(() => compileExperimentConfig({ ...manifest,
      nativeSearch: { searchConnection: { ...searchConnection, model: 'unnecessary' } } }))
      .toThrow('unknown keys')
  })

  it('seals selected stage names and rejects invalid stage configuration', () => {
    const manifest = { ...document, forceSearch: true, nativeSearch: {} }
    const compiled = compileExperimentConfig({ ...manifest, forceSearchStages: ['discovery'] })
    expect(compiled.definition.forceSearchStages).toEqual(['discovery'])
    const tasks = compiled.definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
    for (const task of tasks) {
      expect(mandatorySearchRequirement(compiled.definition, task))
        .toBe(task.promptKind === 'research' ? 'leads' : undefined)
    }
    expect(compileExperimentConfig({ ...manifest, forceSearchStages: [] }).definition.forceSearchStages).toEqual([])
    for (const forceSearchStages of [['research'], ['discovery', 'discovery'], 'discovery', null]) {
      expect(() => compileExperimentConfig({ ...manifest, forceSearchStages })).toThrow()
    }
    expect(() => compileExperimentConfig({ ...manifest, forceSearch: false, forceSearchStages: ['discovery'] }))
      .toThrow('forceSearchStages requires forceSearch')
    for (const sample of [publicSample]) {
      const definition = compileExperimentConfig(sample).definition
      expect(definition.forceSearchStages).toEqual(DEFAULT_FORCE_SEARCH_STAGES)
      expect(definition.nativeSearch?.searchConnection).toEqual({ provider: 'exa', apiKeyEnv: 'EXA_API_KEY' })
    }
  })

  it('defaults new manifests to direct native research while permitting an explicit opt-out', () => {
    const searchConnection = { provider: 'exa' as const, apiKeyEnv: 'EXA_API_KEY' }
    const newManifest = { ...document, forceSearch: undefined,
      nativeSearch: { searchConnection } }
    const enabled = compileExperimentConfig(newManifest)
    expect(enabled.definition.forceSearch).toEqual({
      enabled: true,
      promptSet: 'native-exa-v1',
      searchConnection,
    })
    expect(enabled.definition.forceSearchStages).toEqual(DEFAULT_FORCE_SEARCH_STAGES)
    expect(enabled.definition.nativeSearch).toEqual({ enabled: true, searchConnection })
    expect(enabled.definition.stages.find(stage => stage.kind === 'discovery')?.waves[0]?.tasks[0]?.output.schema)
      .toBe('ack3.research-delta.policy-v3')
    const disabled = compileExperimentConfig({ ...newManifest, forceSearch: false })
    expect(disabled.definition.forceSearch).toBeUndefined()
    expect(disabled.definition.nativeSearch).toEqual({ enabled: true, searchConnection })
    expect(disabled.definition.stages.find(stage => stage.kind === 'discovery')?.waves[0]?.tasks[0]?.output.schema)
      .toBe('ack3.research-delta.policy-v3')
    expect(() => compileExperimentConfig({ ...newManifest, outputContractVersion: 2 })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest, forceSearch: 'false' })).toThrow('forceSearch must be a boolean')
    expect(() => compileExperimentConfig({ ...newManifest, forceSearchPromptSet: 'missing' })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest, forceSearch: false,
      forceSearchPromptSet: 'unknown-set' })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest, forceSearchSearchConnection: searchConnection })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest,
      nativeSearch: { searchConnection: { ...searchConnection, model: 'other' } },
      forceSearchSearchConnection: searchConnection })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest, nativeSearch: false })).toThrow('cannot be disabled')
    expect(() => compileExperimentConfig({ ...newManifest, nativeSearch: undefined }))
      .not.toThrow()
    expect(() => compileExperimentConfig({ ...newManifest, forceSearch: false,
      forceSearchSearchConnection: searchConnection })).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...newManifest,
      nativeSearch: { searchConnection: { ...searchConnection, baseUrl: 'http://example.org/v1' } } }))
      .toThrow('unknown keys')
  })

  it('binds a public environment image and tools without changing legacy manifests', () => {
    const legacy = compileExperimentConfig(document)
    expect(legacy.environment).toBeUndefined()
    const configured = structuredClone(document) as any
    const runtime = configured.target.runtime
    delete configured.target.environment
    delete configured.target.runtime
    const digest = 'a'.repeat(64)
    configured.environment = {
      image: `registry.cloudflare.com/${'b'.repeat(32)}/swarm-sandbox@sha256:${digest}`,
      ...runtime,
    }
    const compiled = compileExperimentConfig(configured)
    expect(compiled.definition).toEqual(legacy.definition)
    expect(compiled.environment).toEqual({ image: configured.environment.image })
    const selected = {
      schemaVersion: 1, id: 'runtime-fixture', frameworkCommit: 'c'.repeat(40),
      workerService: 'runtime-fixture', workerVersionId: '11111111-1111-4111-8111-111111111111',
      workflowName: 'runtime-fixture', containerImageDigest: `sha256:${digest}`,
    } satisfies RuntimeRelease
    expect(() => assertReleaseEnvironmentMatchesRuntime(compiled, selected)).not.toThrow()
    expect(() => assertReleaseEnvironmentMatchesRuntime(compiled, {
      ...selected, containerImageDigest: `sha256:${'d'.repeat(64)}`,
    })).toThrow('audit environment image does not match the selected runtime')
    expect(() => assertReleaseEnvironmentMatchesRuntime(compiled, undefined))
      .toThrow('audit environment image does not match the selected runtime')
    expect(() => assertReleaseEnvironmentMatchesRuntime(legacy, selected)).not.toThrow()
    configured.target.runtime = runtime
    expect(() => compileExperimentConfig(configured)).toThrow('must not be combined')
    delete configured.target.runtime
    configured.environment.image = `swarm-sandbox@sha256:${digest}`
    expect(() => compileExperimentConfig(configured)).toThrow('environment.image must be an approved immutable OCI image')
  })

  it('keeps the documented audit manifest compiler-valid', () => {
    expect(compileExperimentConfig(publicSample).environment?.image).toBe(publicSample.environment.image)
  })

  it('routes every task of the example DSH pool through its native DSH connection', () => {
    const compiled = compileExperimentConfig(publicSample)
    const tasks = compiled.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .filter(task => task.modelPool === 'dsh')
    expect(tasks.some(task => task.promptKind === 'research')).toBe(true)
    expect(tasks.some(task => task.promptKind === 'negative-review')).toBe(true)
    for (const task of tasks) {
      expect(task).toMatchObject({
        backend: 'dsh-chat-completions', provider: 'your-provider', model: 'your-provider/model-id',
        connection: { baseUrl: 'https://llm.example.com/v1', apiKeyEnv: 'PROVIDER_API_KEY' },
        reasoning: 'high', thinking: 'enabled',
      })
      expect(task.optional).not.toBe(true)
    }
  })

  it.each([3_600_000, 18_000_000])('uses the per-audit %ims discovery clock', maxDiscoveryRuntimeMs => {
    const configured = structuredClone(document) as any
    configured.limits.maxDiscoveryRuntimeMs = maxDiscoveryRuntimeMs
    const body = compileExperimentConfig(configured)
    expect(body.definition.limits.phaseMinutes.discovery).toBe(maxDiscoveryRuntimeMs / 60_000)
  })

  it('expands the compact audit manifest into the exact executable topology', () => {
    const body = compileExperimentConfig(document)
    const discovery = body.definition.stages.find(stage => stage.kind === 'discovery')!
    expect(discovery.waves).toHaveLength(64)
    expect(body.definition.discoverySafetyCeiling).toBe(64)
    expect(discovery.waves.every(wave => wave.tasks.length === 6)).toBe(true)
    expect(discovery.waves.flatMap(wave => wave.tasks)
      .some(task => task.id === 'challenge-open-adversarial-replica')).toBe(false)
    expect(body.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)).toHaveLength(394)
    expect(document.method).toBe('security-audit-v1')
    expect(document).toHaveProperty('stages')
    expect(document).not.toHaveProperty('prompts')
  })

  it('propagates pool execution settings into discovery and fixed-stage tasks', () => {
    const body = compileExperimentConfig(document)
    const tasks = body.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
    const lunaTasks = tasks.filter(task => task.model === 'gpt-codex-a')
    const deepseekTasks = tasks.filter(task => task.model === 'deepseek-v4-flash')
    expect(lunaTasks.length).toBeGreaterThan(0)
    expect(deepseekTasks.length).toBeGreaterThan(0)
    expect(lunaTasks.every(task => task.reasoning === 'max' && task.thinking === undefined)).toBe(true)
    expect(deepseekTasks.every(task => task.reasoning === 'max' && task.thinking === 'enabled')).toBe(true)
    expect(deepseekTasks.every(task => task.provider === 'provider-a'
      && task.connection?.baseUrl === 'https://llm-a.example.com/v1'
      && task.connection.apiKeyEnv === 'PROVIDER_A_API_KEY')).toBe(true)
    expect(tasks.filter(task => task.providerClass !== 'deterministic')
      .every(task => task.subagents?.mode === 'disabled')).toBe(true)
  })

  it('requires each selected review independently of optional discovery', () => {
    const definition = compileExperimentConfig(document).definition
    const review = definition.stages.find(stage => stage.kind === 'negative-review')!.waves[0]!
    expect(review.tasks.every(task => task.optional !== true)).toBe(true)
    expect(review.minSuccessfulTasks).toBe(2)
    expect(definition.stages[1]!.waves[0]!.tasks.some(task => task.optional)).toBe(true)
  })

  it('resolves provider-neutral subagent defaults and stage overrides into immutable tasks', () => {
    const configured = structuredClone(document) as any
    configured.modelPools.find((pool: any) => pool.id === 'luna').subagents = {
      default: { mode: 'disabled' },
      stages: { synthesis: { mode: 'native', maxConcurrent: 2 }, verification: { mode: 'native', maxConcurrent: 2 } },
    }
    configured.modelPools.find((pool: any) => pool.id === 'deepseek').subagents = {
      default: { mode: 'disabled' },
    }
    const tasks = compileExperimentConfig(configured).definition.stages
      .flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
    expect(tasks.filter(task => task.model === 'gpt-codex-a' && task.promptKind === 'research')
      .every(task => task.subagents?.mode === 'disabled')).toBe(true)
    expect(tasks.find(task => task.id === 'synthesizer')?.subagents).toEqual({ mode: 'native', maxConcurrent: 2 })
    expect(tasks.find(task => task.id === 'verifier')?.subagents).toEqual({ mode: 'native', maxConcurrent: 2 })
    expect(tasks.find(task => task.id === 'reporter')?.subagents).toEqual({ mode: 'disabled' })
    expect(tasks.filter(task => task.model === 'deepseek-v4-flash' && task.promptKind === 'research')
      .every(task => task.subagents?.mode === 'disabled')).toBe(true)
    expect(tasks.find(task => task.id === 'negative-review-replica')?.subagents)
      .toEqual({ mode: 'disabled' })
    expect(tasks.filter(task => task.providerClass !== 'deterministic')
      .every(task => typeof task.modelPool === 'string')).toBe(true)
  })

  it('keeps subagent policy out of research and review instructions', () => {
    const body = compileExperimentConfig(document)
    const tasks = body.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .filter(task => task.promptKind === 'coverage-challenge' || task.promptKind === 'negative-review')
    for (const task of tasks) {
      const prompt = renderTaskPrompt({
        definition: body.definition,
        task,
        visibleArtifacts: [],
        deadline: '2026-09-24T00:00:00.000Z',
      })
      expect(prompt).not.toContain('recruit subagents')
      expect(prompt).not.toContain('coordinate other workers')
    }
  })

  it('requires explicit reasoning controls in every new audit manifest', () => {
    const missing = structuredClone(document) as any
    delete missing.modelPools[0].reasoningEffort
    expect(() => compileExperimentConfig(missing)).toThrow('invalid reasoningEffort')
    const unsupported = structuredClone(document) as any
    unsupported.modelPools[1].thinking = 'disabled'
    expect(() => compileExperimentConfig(unsupported))
      .toThrow('must pair disabled thinking with none reasoningEffort')
    const medium = structuredClone(document) as any
    medium.modelPools[1].reasoningEffort = 'medium'
    expect(() => compileExperimentConfig(medium))
      .toThrow('unsupported DeepSeek reasoningEffort medium')
  })

  it('restricts native provider connections before sealing or dispatch', () => {
    const controlCredential = structuredClone(document) as any
    controlCredential.modelPools[1].connection.apiKeyEnv = 'CONTROL_API_TOKEN'
    expect(() => compileExperimentConfig(controlCredential)).toThrow('invalid apiKeyEnv')
    const credentialInUrl = structuredClone(document) as any
    credentialInUrl.modelPools[1].connection.baseUrl = 'https://secret@example.invalid/v1'
    expect(() => compileExperimentConfig(credentialInUrl)).toThrow('invalid baseUrl')
    const query = structuredClone(document) as any
    query.modelPools[1].connection.baseUrl = 'https://example.invalid/v1?token=secret'
    expect(() => compileExperimentConfig(query)).toThrow('invalid baseUrl')
    const remotePlaintext = structuredClone(document) as any
    remotePlaintext.modelPools[1].connection.baseUrl = 'http://example.invalid/v1'
    expect(() => compileExperimentConfig(remotePlaintext)).toThrow('invalid baseUrl')
  })

  it('seals optional rates only on their originating native connection', () => {
    const configured = structuredClone(document) as any
    configured.modelPools[1].connection.costRates = {
      uncachedInputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 5,
    }
    const definition = compileExperimentConfig(configured).definition
    const native = definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .filter(task => task.modelPool === configured.modelPools[1].id)
    expect(native.length).toBeGreaterThan(0)
    expect(native.every(task => task.connection?.costRates?.outputUsdPerMillion === 5)).toBe(true)
    expect(definition.pools[0]?.connection).toBeUndefined()
    expect(compileExperimentConfig(document).definition.pools[1]?.connection?.costRates).toBeUndefined()

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY, '2']) {
      const malformed = structuredClone(configured)
      malformed.modelPools[1].connection.costRates.cachedInputUsdPerMillion = invalid
      expect(() => compileExperimentConfig(malformed)).toThrow('invalid cost rates')
    }
  })

  it('requires an explicit, bounded subagent policy in every new audit manifest', () => {
    const missing = structuredClone(document) as any
    delete missing.modelPools[0].subagents
    expect(() => compileExperimentConfig(missing)).toThrow('must define subagents')
    const invalid = structuredClone(document) as any
    invalid.modelPools[0].subagents.default = { mode: 'automatic' }
    expect(() => compileExperimentConfig(invalid)).toThrow('must be disabled or native')
    const unknown = structuredClone(document) as any
    unknown.modelPools[0].subagents.stages = {}
    unknown.modelPools[0].subagents.stages.discoveryReplica = { mode: 'native', maxConcurrent: 2 }
    expect(() => compileExperimentConfig(unknown)).toThrow('unknown keys: discoveryReplica')
    const unused = structuredClone(document) as any
    unused.modelPools[1].subagents.stages = { reporting: { mode: 'native', maxConcurrent: 2 } }
    expect(() => compileExperimentConfig(unused)).toThrow('unused subagent stage override reporting')
    const unsupported = structuredClone(document) as any
    unsupported.modelPools[1].subagents.default = { mode: 'native', maxConcurrent: 2 }
    expect(() => compileExperimentConfig(unsupported)).toThrow('does not support bounded native subagents')
  })

  it('runs independent research lanes when no research plan is configured', () => {
    const discovery = compileExperimentConfig(document).definition.stages.find(stage => stage.kind === 'discovery')!
    const assignments = discovery.waves.flatMap(wave => wave.tasks).map(task => task.research)
    expect(assignments.length).toBeGreaterThan(0)
    expect(assignments.every(research => research?.role === 'researcher' && research.buildsOn === 'none')).toBe(true)
  })

  it('rejects research plans that do not fit the lanes or reference missing peers', () => {
    const plan = anchorResearchPlan(3)
    const invalid = [
      { ...plan, first: plan.first.slice(1) },
      { ...plan, cycle: [] },
      { ...plan, cycle: [plan.cycle[0]!.slice(1)] },
      { ...plan, first: [{ role: 'anchor', buildsOn: 'previous-wave/research-1' }, ...plan.first.slice(1)] },
      { ...plan, cycle: [[{ role: 'satellite', buildsOn: 'previous-wave/research-4' }, ...plan.cycle[0]!.slice(1)]] },
      { ...plan, cycle: [[{ role: 'Satellite' }, ...plan.cycle[0]!.slice(1)]] },
      { ...plan, cycle: [[{ role: 'satellite', weight: 2 }, ...plan.cycle[0]!.slice(1)]] },
      { ...plan, strategy: 'hidden' },
    ]
    for (const researchPlan of invalid) {
      expect(() => compileExperimentConfig({ ...document, researchPlan }), JSON.stringify(researchPlan)).toThrow('researchPlan')
    }
  })

  it('compiles a configured four-lane research plan with a two-lane mirror', async () => {
    const audit1 = {
      ...structuredClone(document),
      researchPlan: anchorResearchPlan(4),
      id: 'four-lane',
      maxDiscoveryWaves: 10,
      modelPools: document.modelPools.map(pool => ({
        ...pool,
        agents: pool.id === 'luna' ? 4 : 2,
      })),
    }
    const body = compileExperimentConfig(audit1)
    const discovery = body.definition.stages.find(stage => stage.kind === 'discovery')!
    expect(body.definition.pools.find(pool => pool.id === 'luna')?.agents).toBe(4)
    expect(body.definition.pools.find(pool => pool.id === 'deepseek')?.agents).toBe(2)
    expect(discovery.waves).toHaveLength(10)
    expect(discovery.waves.every(wave => wave.tasks.length === 6)).toBe(true)
    expect(discovery.waves[1]?.tasks.filter(task => task.providerClass === 'core').map(task => task.research))
      .toEqual([
        expect.objectContaining({ researcher: 1, role: 'anchor', buildsOn: 'none' }),
        expect.objectContaining({ researcher: 2, role: 'satellite', buildsOn: 'wave-0/research-1' }),
        expect.objectContaining({ researcher: 3, role: 'satellite', buildsOn: 'wave-0/research-1' }),
        expect.objectContaining({ researcher: 4, role: 'satellite', buildsOn: 'wave-0/research-1' }),
      ])
    expect(discovery.waves[2]?.tasks.filter(task => task.providerClass === 'core').map(task => task.research))
      .toEqual([
        expect.objectContaining({ researcher: 1, role: 'anchor', buildsOn: 'none' }),
        expect.objectContaining({ researcher: 2, role: 'satellite', buildsOn: 'wave-1/research-1' }),
        expect.objectContaining({ researcher: 3, role: 'satellite', buildsOn: 'wave-1/research-1' }),
        expect.objectContaining({ researcher: 4, role: 'satellite', buildsOn: 'wave-1/research-1' }),
      ])
    const mirrorResearchers = discovery.waves.slice(0, 3).map(wave => wave.tasks
      .filter(task => task.providerClass === 'additive' && task.promptKind === 'research')
      .map(task => task.research?.researcher))
    expect(mirrorResearchers).toEqual([[1, 2], [3, 4], [1, 2]])
    const requests = await captureDiscoveryRequests(body.definition)
    for (const request of requests.filter(request => request.task.providerClass === 'additive')) {
      const replica = request.task
      const wave = request.wave
      const core = wave.tasks.find(task => task.providerClass === 'core'
        && task.research?.researcher === replica.research?.researcher)!
      const corePrompt = mirroredResearchPrompt(body.definition, core, request, requests)
      expect(researchReasoningText(request.prompt)).toBe(researchReasoningText(corePrompt))
      expect(replica.research?.role).toBe(core.research?.role)
      if (replica.research?.buildsOn !== 'none') {
        const peer = researchPredecessor(body.definition, replica, request.visibleArtifacts)!
        expect(request.prompt).toContain(`Peer evidence: ${researchEvidencePaths(peer).documents[0]}`)
        expect(await sha256(request.prompt)).not.toBe(await sha256(corePrompt))
      }
    }
    expect(requests.some(request => request.task.research !== undefined
      && request.task.research.buildsOn !== 'none' && request.task.research.buildsOn !== discovery.waves.find(wave => wave.id === request.wave.id)!
        .tasks.find(task => task.id === request.task.id)!.research?.buildsOn)).toBe(true)
  })

  it.each([
    {
      name: 'equal pools',
      agents: [4, 4],
      expected: [
        { luna: [1, 2, 3, 4], deepseek: [1, 2, 3, 4] },
        { luna: [1, 2, 3, 4], deepseek: [1, 2, 3, 4] },
      ],
    },
    {
      name: 'more DeepSeek seats than Codex seats',
      agents: [2, 4],
      expected: [
        { luna: [1, 2], deepseek: [1, 2, 3, 4] },
        { luna: [3, 4], deepseek: [1, 2, 3, 4] },
      ],
    },
  ])('compiles $name through the generic model-pool scheduler', ({ agents, expected }) => {
    const generic: any = structuredClone(document)
    generic.id = 'generic-model-pools'
    generic.maxDiscoveryWaves = 4
    generic.modelPools = [
      {
        id: 'luna', backend: 'codex', model: 'gpt-codex-a',
        reasoningEffort: 'max',
        subagents: { default: { mode: 'disabled' } },
        credentialSource: 'default-codex-account', agents: agents[0], required: true,
      },
      {
        id: 'deepseek', backend: 'dsh-chat-completions', provider: 'provider-a',
        connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max', thinking: 'enabled',
        subagents: { default: { mode: 'disabled' } },
        agents: agents[1], required: false,
      },
    ]
    const discovery = compileExperimentConfig(generic).definition.stages.find(stage => stage.kind === 'discovery')!
    const actual = discovery.waves.slice(0, 2).map(wave => Object.fromEntries(['luna', 'deepseek'].map(poolId => {
      const prefix = poolId === 'luna' ? 'core-' : 'additive-'
      return [poolId, wave.tasks.filter(task => task.promptKind === 'research' && task.id.startsWith(prefix))
        .map(task => task.research!.researcher)]
    })))
    expect(actual).toEqual(expected)
  })

  it('adds a third model pool without changing research prompts or parser contracts', async () => {
    const generic: any = structuredClone(document)
    generic.id = 'generic-three-model-pools'
    generic.researchPlan = anchorResearchPlan(4)
    generic.maxDiscoveryWaves = 4
    generic.modelPools = [
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
    const body = compileExperimentConfig(generic)
    const discovery = body.definition.stages.find(stage => stage.kind === 'discovery')!
    const terraLanes = discovery.waves.map(wave => wave.tasks
      .filter(task => task.promptKind === 'research' && task.model === 'gpt-codex-b')
      .map(task => task.research!.researcher))
    expect(terraLanes).toEqual([[1], [2], [3], [4]])
    const requests = await captureDiscoveryRequests(body.definition)
    for (const request of requests.filter(request => request.task.model === 'gpt-codex-b')) {
      const terra = request.task
      const wave = request.wave
      const luna = wave.tasks.find(task => task.promptKind === 'research'
        && task.model === 'gpt-codex-a' && task.research?.researcher === terra.research?.researcher)!
      const lunaPrompt = mirroredResearchPrompt(body.definition, luna, request, requests)
      expect(researchReasoningText(request.prompt)).toBe(researchReasoningText(lunaPrompt))
      expect(terra.research?.role).toBe(luna.research?.role)
      if (terra.research?.buildsOn !== 'none') {
        const peer = researchPredecessor(body.definition, terra, request.visibleArtifacts)!
        expect(request.prompt).toContain(`Peer observations: ${researchEvidencePaths(peer).observations}`)
        expect(await sha256(request.prompt)).not.toBe(await sha256(lunaPrompt))
      }
    }
  })

  it('routes fixed stages through named pools rather than reserved model ids', () => {
    const routed: any = structuredClone(document)
    routed.modelPools.push({
      id: 'terra', backend: 'codex', model: 'gpt-codex-b',
      reasoningEffort: 'high',
      subagents: { default: { mode: 'disabled' } },
      credentialSource: 'default-codex-account', agents: 1, required: true,
    })
    routed.stageModelPools.synthesis = 'terra'
    routed.stageModelPools.verification = 'terra'
    const body = compileExperimentConfig(routed)
    expect(body.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .find(task => task.id === 'synthesizer')?.model).toBe('gpt-codex-b')
    expect(body.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .find(task => task.id === 'verifier')?.model).toBe('gpt-codex-b')
  })

  it('allows either native harness for a selected review stage', () => {
    const configured = structuredClone(document) as any
    configured.stageModelPools.verification = 'deepseek'
    const verifier = compileExperimentConfig(configured).definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks).find(task => task.id === 'verifier')!
    expect(verifier.backend).toBe('dsh-chat-completions')
    expect(verifier.optional).not.toBe(true)
  })

  it('rejects the removed implicit coverage replica route', () => {
    const malformed: any = structuredClone(document)
    malformed.stageModelPools.coverageChallengeReplica = 'deepseek'
    expect(() => compileExperimentConfig(malformed))
      .toThrow('audit manifest stageModelPools has unknown keys: coverageChallengeReplica')
  })

  it('rejects an unknown audit method instead of treating data as executable topology', () => {
    const malformed = structuredClone(document) as any
    malformed.method = 'inline-task-graph'
    expect(() => compileExperimentConfig(malformed)).toThrow('unsupported audit method')
  })

  it('rejects an invalid discovery ceiling before expanding the method', () => {
    const malformed = structuredClone(document) as any
    malformed.maxDiscoveryWaves = 0
    expect(() => compileExperimentConfig(malformed)).toThrow('maxDiscoveryWaves must be a positive integer')
  })

  it('rejects an invalid discovery runtime before expanding the method', () => {
    const malformed = structuredClone(document) as any
    malformed.limits.maxDiscoveryRuntimeMs = 0
    expect(() => compileExperimentConfig(malformed))
      .toThrow('limits.maxDiscoveryRuntimeMs must be a positive integer')
  })

  it('does not accept the removed expanded-config shape', () => {
    const malformed = { ...structuredClone(document), kind: 'ack3-experiment-config' }
    expect(() => compileExperimentConfig(malformed)).toThrow('audit manifest must use ack3-audit v2')
  })

  it('rejects unknown manifest fields instead of silently discarding them', () => {
    const malformed = structuredClone(document) as any
    malformed.stages = [{ id: 'unsealed-runtime-override' }]
    expect(() => compileExperimentConfig(malformed)).toThrow('stages must contain unique audit stages')
  })
})
