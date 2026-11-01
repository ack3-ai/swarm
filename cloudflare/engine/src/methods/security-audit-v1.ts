import { AUDIT_STAGES } from '../contracts.js'
import { DEFAULT_FORCE_SEARCH_STAGES } from '../native-research.js'
import { promptFileInstructions, validateStagePrompts, validateStages } from './system-prompts.js'
import type {
  AuditStageKind, StagePrompts, ExperimentDefinition, ModelBackend, ModelConnection, ModelPool,
  ProviderClass, ReasoningEffort, ReleasePackageBody, ResearchAssignment, StageDefinition,
  SubagentPolicy, SubagentStage, TaskDefinition, WaveDefinition,
} from '../contracts.js'
import { deepClone } from '../canonical.js'
import { validCodexAccessProgram } from '../../container/reasoning-config.mjs'
import { researchPoolNamespace, scheduleResearchPoolLanes } from '../research-scheduler.js'
import { validateReleasePackage } from '../validation.js'
import { requiresSubmission, SUBMISSION_PATH } from '../submission.js'

interface ScheduledResearchRole { role: string; buildsOn: 'none' | `previous-wave/research-${number}` }
interface ResolvedProfile {
  credentialSource?: string; providerClass: ProviderClass; backend?: ModelBackend; provider?: string; connection?: ModelConnection
  pool?: string; model: string; cyberAccessProgram?: ModelPool['cyberAccessProgram']; reasoning: ReasoningEffort; thinking?: ModelPool['thinking']; subagents?: SubagentPolicy
  optional: boolean; workspaceMode: TaskDefinition['workspaceMode']
}
interface ResolvedResearchPool { id: string; taskIdPrefix: string; workspaceKeyPrefix: string; agents: number; profile: ResolvedProfile }
interface ResearchWavesTemplate {
  count: number; logicalRole: string; outputSchema: string
  outputPattern: 'waves/wave-{wave}/research-{researcher}.md'; scratchPattern: '/workspace/source/test/swarm/lane-{researcher}'
  minSuccessfulTasks: number; minDistinctActors: number
  schedule: { first: readonly ScheduledResearchRole[]; cycle: readonly (readonly ScheduledResearchRole[])[] }
}
interface TemplatedDiscoveryStage { id: string; kind: 'discovery'; objective: string; wavesTemplate: ResearchWavesTemplate }
type ManifestModelPool = ModelPool & { reasoningEffort: ReasoningEffort; subagents: NonNullable<ModelPool['subagents']> }
interface AuditManifestV2 {
  configVersion: 2; kind: 'ack3-audit'; method: 'security-audit-v1'; id: string; objective: string
  stages: readonly AuditStageKind[]; promptFile: string
  stageModelPools: Partial<Record<Exclude<AuditStageKind, 'discovery'>, string | readonly string[]>>
  modelPools: readonly ManifestModelPool[]; maxDiscoveryWaves: number; stopOnSaturation?: boolean
  researchPlan?: { first: readonly Partial<ScheduledResearchRole>[]; cycle: readonly (readonly Partial<ScheduledResearchRole>[])[] }
  forceSearch?: boolean; forceSearchStages?: readonly AuditStageKind[]
  nativeSearch?: false | { searchConnection?: import('../contracts.js').NativeSearchConnection }
  target: Pick<ExperimentDefinition['target'], 'repository' | 'commit' | 'tree'> & {
    environment?: 'disposable-non-production'; runtime?: ExperimentDefinition['target']['runtime']
  }
  environment?: ExperimentDefinition['target']['runtime'] & { image: string }
  limits: Omit<ExperimentDefinition['limits'], 'maxWallTimeMs' | 'phaseMinutes'> & { maxDiscoveryRuntimeMs: number }
}

const roles = [
  {
    "id": "lead",
    "description": "Schedule concurrent waves, route paths and direct peer requests, monitor phase and spend budgets, and avoid target review, threat-model authorship, reproduction, or report drafting.",
    "seats": 1,
    "toolset": "coordination"
  },
  {
    "id": "security-researcher",
    "description": "Search the whole target for security issues and record each observation with its evidence.",
    "seats": 5,
    "toolset": "security-testing"
  },
  {
    "id": "verifier",
    "description": "Independently challenge and attempt potential High/Critical candidates in small checkpointed batches, without accepting findings or assigning final severity.",
    "seats": 1,
    "toolset": "independent-verification"
  }
] as const
const outputs = {
  "preflight": {
    "requiredFiles": [
      "preflight.json"
    ],
    "schema": "ack3.preflight.v2"
  },
  "synthesis": {
    "requiredFiles": [
      "threat-model.md",
      "coverage.md",
      "candidates.md",
      "frontier.md",
      "observation-ledger.md"
    ],
    "schema": "ack3.synthesis.policy-v2"
  },
  "coverage-challenge": {
    "requiredFiles": [
      "coverage-challenge.md"
    ],
    "requiredSections": [
      "## Independent coverage",
      "## Observation ledger",
      "## Candidate supplement"
    ],
    "schema": "ack3.coverage-challenge.policy-v2"
  },
  "coverage-union": {
    "requiredFiles": [
      "coverage-challenge.md"
    ],
    "schema": "ack3.coverage-union.policy-v2"
  },
  "negative-review": {
    "requiredFiles": [
      "negative-disposition-review.md"
    ],
    "schema": "ack3.negative-review.policy-v3"
  },
  "review-union": {
    "requiredFiles": [
      "negative-disposition-review-union.json"
    ],
    "schema": "ack3.negative-review-union.policy-v2"
  },
  "verification": {
    "requiredFiles": [
      "verification.md"
    ],
    "schema": "ack3.verification.policy-v4"
  },
  "reporting": {
    "requiredFiles": [
      "finding-draft.md"
    ],
    "schema": "ack3.finding.policy-v4"
  }
} as const
function object(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
}

function validateSubagentPolicy(value: unknown, name: string): asserts value is SubagentPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  const policy = value as Record<string, unknown>
  if (policy.mode === 'disabled' && Object.keys(policy).length === 1) return
  if (policy.mode === 'native' && Object.keys(policy).length === 2) {
    positiveInteger(policy.maxConcurrent as number, `${name}.maxConcurrent`)
    if ((policy.maxConcurrent as number) <= 8) return
  }
  throw new TypeError(`${name} must be disabled or native with maxConcurrent from 1 to 8`)
}

function researchPath(pattern: string, wave: number, researcher: number): string {
  return pattern.replaceAll('{wave}', String(wave)).replaceAll('{researcher}', String(researcher))
}

function assignment(input: ScheduledResearchRole, wave: number, researcher: number): ResearchAssignment {
  const previous = input.buildsOn.match(/^previous-wave\/research-([1-9]\d*)$/)?.[1]
  if (input.buildsOn !== 'none' && previous === undefined) throw new TypeError(`invalid buildsOn schedule for wave ${wave}`)
  if (wave === 0 && input.buildsOn !== 'none') throw new TypeError('wave zero cannot build on a previous wave')
  return {
    wave,
    researcher,
    role: input.role,
    buildsOn: previous === undefined ? 'none' : `wave-${wave - 1}/research-${previous}`,
    laneScratchPath: `/workspace/source/test/swarm/lane-${researcher}`,
  }
}

// The research plan gives each lane a label and, after wave zero, optionally the
// previous-wave lane whose accepted research it receives as peer evidence.
// Without a plan every lane researches independently in every wave.
function researchSchedule(plan: AuditManifestV2['researchPlan'], researchers: number): ResearchWavesTemplate['schedule'] {
  positiveInteger(researchers, 'research lane count')
  if (plan === undefined) {
    const independent = Array.from({ length: researchers }, (): ScheduledResearchRole => ({ role: 'researcher', buildsOn: 'none' }))
    return { first: independent, cycle: [independent] }
  }
  const lanes = (row: unknown, path: string, firstWave: boolean): ScheduledResearchRole[] => {
    if (!Array.isArray(row) || row.length !== researchers) {
      throw new TypeError(`${path} must have one entry per research lane (${researchers})`)
    }
    return row.map((entry: unknown, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => key !== 'role' && key !== 'buildsOn')) {
        throw new TypeError(`${path}[${index}] must contain only role and buildsOn`)
      }
      const { role, buildsOn = 'none' } = entry as { role?: unknown, buildsOn?: unknown }
      const peer = typeof buildsOn === 'string' ? /^previous-wave\/research-([1-9]\d*)$/.exec(buildsOn)?.[1] : undefined
      if (typeof role !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(role)) throw new TypeError(`${path}[${index}].role is invalid`)
      if (buildsOn !== 'none' && (firstWave || peer === undefined || Number(peer) > researchers)) {
        throw new TypeError(`${path}[${index}].buildsOn must be none or previous-wave/research-N for an existing lane`)
      }
      return { role, buildsOn: buildsOn as ScheduledResearchRole['buildsOn'] }
    })
  }
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some(key => key !== 'first' && key !== 'cycle')) {
    throw new TypeError('researchPlan must contain only first and cycle')
  }
  if (!Array.isArray(plan.cycle) || plan.cycle.length === 0 || plan.cycle.length > 64) {
    throw new TypeError('researchPlan.cycle must list 1 to 64 waves')
  }
  return {
    first: lanes(plan.first, 'researchPlan.first', true),
    cycle: plan.cycle.map((row, index) => lanes(row, `researchPlan.cycle[${index}]`, false)),
  }
}

function retryPolicyFor(providerClass: ProviderClass, promptKind: TaskDefinition['promptKind']): TaskDefinition['retryPolicy'] {
  if (providerClass === 'deterministic') return 'none'
  if (promptKind === 'research') {
    return providerClass === 'core' ? 'redirect-then-fresh-replacement' : 'fresh-repair'
  }
  if (providerClass === 'additive') return 'fresh-repair'
  if (providerClass === 'core' && (
    promptKind === 'synthesis'
    || promptKind === 'coverage-challenge'
    || promptKind === 'negative-review'
    || promptKind === 'verification'
    || promptKind === 'reporting'
  )) {
    return 'same-session-repair'
  }
  return 'none'
}

function researchTask(input: {
  wave: number
  researcher: number
  pool: ResolvedResearchPool
  template: ResearchWavesTemplate
  schedule: ScheduledResearchRole
  objective: string
}): TaskDefinition {
  const { wave, researcher, pool, template } = input
  const { profile } = pool
  if (template.outputPattern !== 'waves/wave-{wave}/research-{researcher}.md'
    || template.scratchPattern !== '/workspace/source/test/swarm/lane-{researcher}') {
    throw new TypeError('unsupported research path template')
  }
  return {
    id: `${pool.taskIdPrefix}-wave-${wave}-research-${researcher}`,
    logicalRole: template.logicalRole,
    objective: input.objective,
    providerClass: profile.providerClass,
    ...(profile.credentialSource === undefined ? {} : { credentialSource: profile.credentialSource }),
    ...(profile.backend === undefined ? {} : { backend: profile.backend }),
    ...(profile.provider === undefined ? {} : { provider: profile.provider }),
    ...(profile.connection === undefined ? {} : { connection: profile.connection }),
    ...(profile.pool === undefined ? {} : { modelPool: profile.pool }),
    model: profile.model,
    ...(profile.cyberAccessProgram === undefined ? {} : { cyberAccessProgram: profile.cyberAccessProgram }),
    reasoning: profile.reasoning,
    ...(profile.thinking === undefined ? {} : { thinking: profile.thinking }),
    ...(profile.subagents === undefined ? {} : { subagents: profile.subagents }),
    promptKind: 'research',
    visibility: wave === 0 ? 'none' : 'accepted-frontier',
    workspaceMode: 'continuation',
    workspaceKey: `${pool.workspaceKeyPrefix}-${researcher}`,
    output: {
      schema: template.outputSchema,
      requiredFiles: [researchPath(template.outputPattern, wave, researcher), SUBMISSION_PATH],
      requiredSections: [],
    },
    research: assignment(input.schedule, wave, researcher),
    optional: profile.optional,
    retryPolicy: retryPolicyFor(profile.providerClass, 'research'),
  }
}

function compileResearchStage(
  stage: TemplatedDiscoveryStage,
  objective: string,
  researchPools: readonly ResolvedResearchPool[],
): StageDefinition {
  const template = stage.wavesTemplate
  positiveInteger(template.count, 'discovery wave count')
  if (researchPools.length === 0) throw new TypeError('discovery requires at least one research pool')
  const laneCount = Math.max(...researchPools.map(pool => pool.agents))
  if (template.schedule.first.length !== laneCount || template.schedule.cycle.length === 0
    || template.schedule.cycle.some(row => row.length !== laneCount)) {
    throw new TypeError('research role schedule does not match the core lane count')
  }
  const waves: WaveDefinition[] = []
  for (let wave = 0; wave < template.count; wave += 1) {
    const schedule = wave === 0
      ? template.schedule.first
      : template.schedule.cycle[(wave - 1) % template.schedule.cycle.length]
    if (schedule === undefined) throw new TypeError(`missing research schedule for wave ${wave}`)
    const tasks: TaskDefinition[] = []
    const allocation = scheduleResearchPoolLanes(
      wave,
      researchPools.map(pool => ({ id: pool.id, seats: pool.agents })),
      laneCount,
    )
    for (const assigned of allocation.assignments) {
      const pool = researchPools.find(candidate => candidate.id === assigned.poolId)
      if (pool === undefined) throw new TypeError(`missing resolved research pool ${assigned.poolId}`)
      for (const researcher of assigned.lanes) {
        tasks.push(researchTask({
          wave,
          researcher,
          pool,
          template,
          schedule: schedule[researcher - 1]!,
          objective,
        }))
      }
    }
    waves.push({ id: `wave-${wave}`, tasks, minSuccessfulTasks: template.minSuccessfulTasks, minDistinctActors: template.minDistinctActors })
  }
  return { id: stage.id, kind: stage.kind, objective: stage.objective, waves }
}

function manifestResearchPools(manifest: AuditManifestV2): readonly ManifestModelPool[] {
  if (manifest.modelPools.length < 1) throw new TypeError('modelPools must contain at least one pool')
  const ids = new Set<string>()
  const namespaces = new Set<string>()
  for (const pool of manifest.modelPools) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(pool.id)) throw new TypeError(`invalid model pool id: ${pool.id}`)
    if (ids.has(pool.id)) throw new TypeError(`duplicate model pool id: ${pool.id}`)
    if (!Number.isSafeInteger(pool.agents) || pool.agents < 0) throw new TypeError(`model pool ${pool.id} agents must be a non-negative integer`)
    if (pool.agents > 64) throw new TypeError(`model pool ${pool.id} exceeds the 64-seat safety ceiling`)
    if (pool.model.trim() === '') {
      throw new TypeError(`model pool ${pool.id} has incomplete execution identity`)
    }
    if (pool.backend === 'codex' || pool.backend === 'claude') {
      if (typeof pool.credentialSource !== 'string' || pool.credentialSource.trim() === '') {
        throw new TypeError(`model pool ${pool.id} has incomplete execution identity`)
      }
      if (pool.provider !== undefined || pool.connection !== undefined) {
        throw new TypeError(`model pool ${pool.id} may not set a provider connection for ${pool.backend}`)
      }
    } else {
      if (pool.backend !== 'dsh-chat-completions') {
        throw new TypeError(`model pool ${pool.id} must use the native DSH Chat Completions backend`)
      }
      if (typeof pool.provider !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(pool.provider)
        || pool.connection === undefined || pool.connection.baseUrl.length > 2_048) {
        throw new TypeError(`model pool ${pool.id} has incomplete provider connection`)
      }
      let endpoint: URL
      try { endpoint = new URL(pool.connection.baseUrl) } catch { throw new TypeError(`model pool ${pool.id} has an invalid baseUrl`) }
      if ((endpoint.protocol !== 'https:'
          && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))
        || endpoint.username !== '' || endpoint.password !== '' || endpoint.search !== '' || endpoint.hash !== '') {
        throw new TypeError(`model pool ${pool.id} has an invalid baseUrl`)
      }
      if (!/^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(pool.connection.apiKeyEnv)) {
        throw new TypeError(`model pool ${pool.id} has an invalid apiKeyEnv`)
      }
    }
    if (pool.backend === 'claude' && !/^CLAUDE_[A-Z0-9_]*OAUTH_TOKEN$/.test(pool.credentialSource ?? '')) {
      throw new TypeError(`model pool ${pool.id} requires a Claude OAuth token binding`)
    }
    if (!validCodexAccessProgram(pool.backend, pool.cyberAccessProgram)) {
      throw new TypeError(`model pool ${pool.id} has invalid cyberAccessProgram`)
    }
    if (!['none', 'low', 'medium', 'high', 'max'].includes(pool.reasoningEffort)) {
      throw new TypeError(`model pool ${pool.id} has invalid reasoningEffort`)
    }
    if (['codex', 'claude'].includes(pool.backend) && pool.thinking !== undefined) {
      throw new TypeError(`model pool ${pool.id} may not set thinking for ${pool.backend}`)
    }
    if (!['codex', 'claude'].includes(pool.backend) && !['enabled', 'disabled'].includes(pool.thinking ?? '')) {
      throw new TypeError(`model pool ${pool.id} must set thinking to enabled or disabled`)
    }
    if (!['codex', 'claude'].includes(pool.backend) && pool.reasoningEffort === 'medium') {
      throw new TypeError(`model pool ${pool.id} uses unsupported DeepSeek reasoningEffort medium`)
    }
    if (!['codex', 'claude'].includes(pool.backend) && ((pool.thinking === 'disabled') !== (pool.reasoningEffort === 'none'))) {
      throw new TypeError(`model pool ${pool.id} must pair disabled thinking with none reasoningEffort`)
    }
    validateSubagentPolicy(pool.subagents?.default, `model pool ${pool.id} subagent default`)
    for (const [stage, policy] of Object.entries(pool.subagents.stages ?? {})) {
      if (!AUDIT_STAGES.includes(stage as AuditStageKind)) {
        throw new TypeError(`model pool ${pool.id} has invalid subagent stage override`)
      }
      if (stage !== 'discovery' && !routes(manifest, stage as AuditStageKind).includes(pool.id)) {
        throw new TypeError(`model pool ${pool.id} has unused subagent stage override ${stage}`)
      }
      validateSubagentPolicy(policy, `model pool ${pool.id} subagent stage ${stage}`)
    }
    const subagentPolicies = [pool.subagents.default, ...Object.values(pool.subagents.stages ?? {})]
    if (pool.backend !== 'codex' && subagentPolicies.some(policy => policy.mode === 'native')) {
      throw new TypeError(`model pool ${pool.id} backend ${pool.backend} does not support bounded native subagents`)
    }
    if (typeof pool.required !== 'boolean') {
      throw new TypeError(`model pool ${pool.id} must set a boolean required flag`)
    }
    const namespace = researchPoolNamespace(pool.id)
    if (namespaces.has(namespace)) throw new TypeError(`model pool ${pool.id} has a duplicate observation namespace`)
    ids.add(pool.id)
    namespaces.add(namespace)
  }
  if (!manifest.modelPools.some(pool => pool.required && pool.agents > 0)) throw new TypeError('discovery requires at least one required model pool')
  return deepClone(manifest.modelPools)
}

function subagentPolicy(pool: ManifestModelPool, stage: SubagentStage): SubagentPolicy {
  return pool.subagents.stages?.[stage] ?? pool.subagents.default
}

function resolvedResearchPools(pools: readonly ManifestModelPool[]): readonly ResolvedResearchPool[] {
  return pools.filter(pool => pool.agents > 0).map(pool => {
    const providerClass: ProviderClass = ['codex', 'claude'].includes(pool.backend) ? 'core' : 'additive'
    return {
      id: pool.id,
      taskIdPrefix: pool.id === 'luna' ? 'core' : pool.id === 'deepseek' ? 'additive' : `pool-${pool.id}`,
      workspaceKeyPrefix: pool.id === 'luna'
        ? 'core-research'
        : pool.id === 'deepseek'
          ? 'additive-research'
          : `pool-${pool.id}-research`,
      agents: pool.agents,
      profile: {
        providerClass,
        backend: pool.backend,
        ...(pool.backend === 'claude' || /^[A-Z][A-Z0-9_]{0,119}_AUTH_JSON$/.test(pool.credentialSource ?? '')
          ? { credentialSource: pool.credentialSource } : {}),
        ...(pool.provider === undefined ? {} : { provider: pool.provider }),
        ...(pool.connection === undefined ? {} : { connection: pool.connection }),
        pool: pool.id,
        reasoning: pool.reasoningEffort,
        ...(pool.thinking === undefined ? {} : { thinking: pool.thinking }),
        subagents: subagentPolicy(pool, 'discovery'),
        optional: !pool.required,
        workspaceMode: 'fresh-pristine',
        model: pool.model,
        ...(pool.cyberAccessProgram === undefined ? {} : { cyberAccessProgram: pool.cyberAccessProgram }),
      },
    }
  })
}


function routes(manifest: AuditManifestV2, stage: AuditStageKind): readonly string[] {
  if (stage === 'discovery') return manifest.modelPools.filter(pool => pool.agents > 0).map(pool => pool.id)
  const route = manifest.stageModelPools[stage]
  return typeof route === 'string' ? [route] : route ?? []
}

export function compileSecurityAuditV1(value: unknown, promptContents: unknown): ReleasePackageBody {
  object(value, 'audit manifest')
  const manifest = value as unknown as AuditManifestV2
  validateStages(manifest.stages)
  const stagePrompts: StagePrompts = validateStagePrompts(promptContents, manifest.stages)
  const instructions = promptFileInstructions(promptContents)
  if (typeof manifest.promptFile !== 'string' || manifest.promptFile.trim() === '') throw new TypeError('promptFile is required')
  if (manifest.stopOnSaturation !== undefined && typeof manifest.stopOnSaturation !== 'boolean') throw new TypeError('stopOnSaturation must be a boolean')
  positiveInteger(manifest.maxDiscoveryWaves, 'maxDiscoveryWaves')
  if (manifest.maxDiscoveryWaves > 64) throw new TypeError('maxDiscoveryWaves must be between 1 and 64')
  if (typeof manifest.objective !== 'string' || manifest.objective.trim() === '') throw new TypeError('objective must not be empty')
  if (manifest.environment === undefined && manifest.target.environment !== 'disposable-non-production') {
    throw new TypeError('target.environment must be disposable-non-production')
  }
  positiveInteger(manifest.limits.maxDiscoveryRuntimeMs, 'limits.maxDiscoveryRuntimeMs')
  const pools = manifestResearchPools(manifest)
  for (const stage of manifest.stages.filter(stage => stage !== 'discovery')) {
    const selected = routes(manifest, stage)
    if (selected.length < 1 || (stage !== 'negative-review' && selected.length !== 1)
      || selected.length > 8 || selected.some(id => !pools.some(pool => pool.id === id))) {
      throw new TypeError(`stageModelPools.${stage} must select ${stage === 'negative-review' ? 'one to eight pools' : 'one pool'}`)
    }
  }
  if (manifest.forceSearch !== undefined && typeof manifest.forceSearch !== 'boolean') throw new TypeError('forceSearch must be a boolean')
  if (manifest.forceSearch === false && manifest.forceSearchStages !== undefined) throw new TypeError('forceSearchStages requires forceSearch')
  if (manifest.nativeSearch === false && manifest.forceSearch !== false) throw new TypeError('nativeSearch cannot be disabled while forceSearch is enabled')
  const searchConnection = manifest.nativeSearch === false ? undefined : manifest.nativeSearch?.searchConnection
    ?? { provider: 'exa' as const, apiKeyEnv: 'EXA_API_KEY' }
  if (searchConnection !== undefined && searchConnection.provider !== 'exa') throw new TypeError('use the official native Exa search connection')
  if (manifest.forceSearchStages !== undefined && !Array.isArray(manifest.forceSearchStages)) throw new TypeError('forceSearchStages must be an array')
  const forceSearchStages = manifest.forceSearchStages ?? DEFAULT_FORCE_SEARCH_STAGES.filter(stage => manifest.stages.includes(stage as AuditStageKind))
  if (forceSearchStages.some(stage => !manifest.stages.includes(stage as AuditStageKind))) throw new TypeError('forceSearchStages must select enabled stages')

  function task(id: string, kind: keyof typeof outputs, stage?: AuditStageKind, poolId?: string): TaskDefinition {
    const pool = poolId === undefined ? undefined : pools.find(pool => pool.id === poolId)!
    const providerClass = pool === undefined ? 'deterministic' : ['codex', 'claude'].includes(pool.backend) ? 'core' : 'additive'
    return {
      id, logicalRole: pool === undefined ? 'lead' : ['negative-review', 'verification'].includes(kind) ? 'verifier' : 'security-researcher',
      objective: stage === undefined ? 'Preserve source and evidence integrity.' : stagePrompts[stage]!,
      providerClass, model: pool?.model ?? 'deterministic', reasoning: pool?.reasoningEffort ?? 'max',
      ...(pool === undefined ? {} : { backend: pool.backend, modelPool: pool.id,
        ...(pool.cyberAccessProgram === undefined ? {} : { cyberAccessProgram: pool.cyberAccessProgram }),
        ...(pool.backend === 'claude' || /^[A-Z][A-Z0-9_]{0,119}_AUTH_JSON$/.test(pool.credentialSource ?? '')
          ? { credentialSource: pool.credentialSource } : {}), subagents: subagentPolicy(pool, stage!),
        ...(pool.provider === undefined ? {} : { provider: pool.provider }),
        ...(pool.connection === undefined ? {} : { connection: pool.connection }),
        ...(pool.thinking === undefined ? {} : { thinking: pool.thinking }) }),
      promptKind: kind, visibility: ['preflight', 'coverage-challenge'].includes(kind) ? 'none' : 'all-accepted',
      workspaceMode: pool === undefined ? 'control' : 'fresh-pristine', workspaceKey: id,
      output: { ...deepClone(outputs[kind]), requiredFiles: [...outputs[kind].requiredFiles,
        ...(requiresSubmission({ providerClass, promptKind: kind }) ? [SUBMISSION_PATH] : [])], requiredSections: [] },
      retryPolicy: retryPolicyFor(providerClass, kind),
    }
  }
  const wave = (id: string, tasks: TaskDefinition[]): WaveDefinition => ({ id, tasks, minSuccessfulTasks: tasks.length, minDistinctActors: tasks.length })
  const stages: StageDefinition[] = [{ id: 'preflight', kind: 'preflight', objective: 'Verify source, tools and baseline without model traffic.',
    waves: [wave('identity-tools-baseline', [task('preflight', 'preflight')])] }]
  const laneCount = Math.max(...pools.map(pool => pool.agents))
  const requiredSeats = pools.filter(pool => pool.required).reduce((sum, pool) => sum + pool.agents, 0)
  for (const stage of manifest.stages) {
    if (stage === 'discovery') {
      stages.push(compileResearchStage({ id: stage, kind: stage, objective: stagePrompts[stage]!, wavesTemplate: {
        count: manifest.maxDiscoveryWaves, logicalRole: 'security-researcher', outputSchema: 'ack3.research-delta.policy-v3',
        outputPattern: 'waves/wave-{wave}/research-{researcher}.md', scratchPattern: '/workspace/source/test/swarm/lane-{researcher}',
        minSuccessfulTasks: requiredSeats, minDistinctActors: requiredSeats, schedule: researchSchedule(manifest.researchPlan, laneCount),
      } }, manifest.objective, resolvedResearchPools(pools)))
      continue
    }
    const poolId = routes(manifest, stage)[0]!
    let waves: WaveDefinition[]
    if (stage === 'synthesis') waves = [wave('synthesis', [task('synthesizer', 'synthesis', stage, poolId)])]
    else if (stage === 'coverage') {
      const challenge = task('challenge-open-adversarial', 'coverage-challenge', stage, poolId)
      challenge.perspective = 'open-adversarial'
      challenge.observationPrefix = 'OPEN'
      waves = [wave('independent-coverage', [challenge]), wave('coverage-union', [task('coverage-union', 'coverage-union')])]
    } else if (stage === 'negative-review') {
      const reviewers = routes(manifest, stage).map((pool, index) => {
        const id = index === 0 ? 'negative-review-primary' : index === 1 ? 'negative-review-replica' : `negative-review-${index + 1}`
        const reviewer = task(id, 'negative-review', stage, pool)
        reviewer.output = { ...reviewer.output, requiredFiles: [`${id}.md`, SUBMISSION_PATH] }
        return reviewer
      })
      waves = [wave('disposition-review', reviewers), wave('dissent-preserving-review-union', [task('negative-review-union', 'review-union')])]
    } else if (stage === 'verification') waves = [wave('all-eligible-references', [task('verifier', 'verification', stage, poolId)])]
    else {
      const seal: TaskDefinition = { id: 'seal-final', logicalRole: 'lead', objective: 'Seal complete observation and dissent custody.',
        providerClass: 'deterministic', model: 'deterministic', reasoning: 'max', promptKind: 'final-seal', visibility: 'all-accepted',
        workspaceMode: 'control', workspaceKey: 'seal-final', retryPolicy: 'none',
        output: { schema: 'ack3.finding-seal.policy-v2', requiredFiles: ['finding.md'], requiredSections: [] } }
      waves = [wave('final-report', [task('reporter', 'reporting', stage, poolId)]), wave('deterministic-final-seal', [seal])]
    }
    stages.push({ id: stage, kind: stage, objective: stagePrompts[stage]!, waves })
  }
  const body: ReleasePackageBody = {
    schemaVersion: 2,
    definition: {
      schemaVersion: 2, id: manifest.id,
      target: { repository: manifest.target.repository, commit: manifest.target.commit, tree: manifest.target.tree,
        sourcePackageVersion: 2, production: false, resettable: true,
        runtime: deepClone(manifest.environment === undefined ? manifest.target.runtime! : {
          environmentBindings: manifest.environment.environmentBindings, preflightCommands: manifest.environment.preflightCommands,
          ...(manifest.environment.workspacePreparation === undefined ? {} : { workspacePreparation: manifest.environment.workspacePreparation }),
        }) },
      limits: { maxWallTimeMs: manifest.limits.maxDiscoveryRuntimeMs, maxModelCalls: manifest.limits.maxModelCalls,
        ...(manifest.limits.maxInputTokens === undefined ? {} : { maxInputTokens: manifest.limits.maxInputTokens }),
        ...(manifest.limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: manifest.limits.maxOutputTokens }), maxCostUsd: manifest.limits.maxCostUsd,
        phaseMinutes: { discovery: manifest.limits.maxDiscoveryRuntimeMs / 60000 } },
      policy: { outcome: manifest.objective, completionRules: ['Complete the configured stages and preserve their evidence.'],
        doneWhen: ['Every required configured task and deterministic evidence check succeeds.'],
        notDoneWhen: ['A required task or evidence record is missing.'],
        evidenceRules: ['Preserve observations, original claim conditions, provenance and dissent.'] },
      roles: deepClone(roles), pools: deepClone(pools), prompts: instructions, stagePrompts,
      ...(searchConnection === undefined ? {} : { nativeSearch: { enabled: true, searchConnection } }),
      ...(manifest.forceSearch === false ? {} : { forceSearchStages: deepClone(forceSearchStages), forceSearch: { enabled: true, promptSet: 'native-exa-v1', ...(searchConnection === undefined ? {} : { searchConnection }) } }),
      discoverySafetyCeiling: manifest.maxDiscoveryWaves, stopOnSaturation: manifest.stopOnSaturation ?? true, stages,
    },
    ...(manifest.environment === undefined ? {} : { environment: { image: manifest.environment.image } }),
  }
  validateReleasePackage(body)
  return body
}
