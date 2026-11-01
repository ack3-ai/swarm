import { modelHeaderCredentialNames, validCodexAccessProgram } from '../container/reasoning-config.mjs'
import { INSTRUCTION_KEYS, validateStagePrompts, validateStages } from './methods/system-prompts.js'
import {
  STAGE_KINDS,
  type ExperimentDefinition,
  type ReleasePackageBody,
  type RunCursor,
  type SubagentStage,
  type TaskDefinition,
} from './contracts.js'
import { canonicalJson } from './canonical.js'
import { requiresSubmission, SUBMISSION_PATH } from './submission.js'
import { taskBackend } from './provider-identity.js'
import { requestedEnvironmentImageDigest } from './environment-image.js'

const idPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/
const shaPattern = /^[0-9a-f]{40,64}$/
const outputPathPattern = /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message)
}

function requireRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`)
}

function rejectUnknownKeys(value: unknown, allowed: readonly string[], path: string): void {
  requireRecord(value, path)
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).toSorted()
  requireValue(unknown.length === 0, `${path} has unknown keys: ${unknown.join(', ')}`)
}

function validateSubagentPolicy(value: unknown, path: string): void {
  requireRecord(value, path)
  if (value.mode === 'disabled') {
    rejectUnknownKeys(value, ['mode'], path)
    return
  }
  requireValue(value.mode === 'native', `${path} has invalid mode`)
  rejectUnknownKeys(value, ['mode', 'maxConcurrent'], path)
  requireValue(Number.isSafeInteger(value.maxConcurrent)
    && (value.maxConcurrent as number) >= 1 && (value.maxConcurrent as number) <= 8,
  `${path}.maxConcurrent must be from 1 to 8`)
}

function validateSearchConnection(search: unknown, path: string): void {
  const connection = search as Record<string, unknown>
  if (connection?.provider === 'exa') {
    rejectUnknownKeys(search, ['provider', 'apiKeyEnv'], path)
    requireValue(typeof connection.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]*_API_KEY$/.test(connection.apiKeyEnv),
      'search apiKeyEnv must name an API key environment variable')
    return
  }
  rejectUnknownKeys(search, ['baseUrl', 'apiKeyEnv', 'model'], path)
  requireValue(typeof connection.baseUrl === 'string', 'search baseUrl must be a string')
  const endpoint = new URL(connection.baseUrl)
  requireValue(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:'
    && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)),
  'search baseUrl must use HTTPS or local HTTP')
  requireValue(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'search baseUrl must not contain credentials, query, or fragment')
  requireValue(typeof connection.apiKeyEnv === 'string' && /^[A-Z][A-Z0-9_]*_API_KEY$/.test(connection.apiKeyEnv),
    'search apiKeyEnv must name an API key environment variable')
  requireValue(typeof connection.model === 'string' && connection.model.trim().length > 0,
    'search model must be non-empty')
}

function validateDefinitionShape(definition: ExperimentDefinition): void {
  rejectUnknownKeys(definition, [
    'schemaVersion', 'id', 'target', 'limits', 'policy', 'prompts', 'stagePrompts', 'roles', 'pools',
    'discoverySafetyCeiling', 'stopOnSaturation', 'stages', 'forceSearch', 'forceSearchStages', 'nativeSearch',
  ], 'experiment')
  rejectUnknownKeys(definition.target, [
    'repository', 'commit', 'tree', 'sourcePackageVersion', 'production', 'resettable', 'runtime',
  ], 'experiment.target')
  rejectUnknownKeys(definition.target.runtime, [
    'environmentBindings', 'preflightCommands', 'workspacePreparation',
  ], 'experiment.target.runtime')
  rejectUnknownKeys(definition.limits, [
    'maxWallTimeMs', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd', 'phaseMinutes',
  ], 'experiment.limits')
  rejectUnknownKeys(definition.limits.phaseMinutes, ['discovery'], 'experiment.limits.phaseMinutes')
  rejectUnknownKeys(definition.policy, [
    'authorization', 'outcome', 'doneWhen', 'notDoneWhen', 'evidenceRules', 'completionRules',
  ], 'experiment.policy')
  rejectUnknownKeys(definition.prompts, INSTRUCTION_KEYS, 'experiment.prompts')
  if (definition.forceSearchStages !== undefined) {
    requireValue(definition.forceSearch?.enabled === true, 'forceSearchStages requires forceSearch')
    requireValue(Array.isArray(definition.forceSearchStages)
      && definition.forceSearchStages.every(stage => STAGE_KINDS.includes(stage))
      && new Set(definition.forceSearchStages).size === definition.forceSearchStages.length,
    'forceSearchStages must contain unique stage names')
  }
  if (definition.forceSearch !== undefined) {
    rejectUnknownKeys(definition.forceSearch, ['enabled', 'promptSet', 'searchConnection'], 'experiment.forceSearch')
    requireValue(typeof definition.forceSearch.enabled === 'boolean', 'experiment.forceSearch.enabled must be boolean')
    requireValue(definition.forceSearch.promptSet === 'native-exa-v1',
      'experiment.forceSearch.promptSet must be native-exa-v1')
    if (definition.forceSearch.searchConnection !== undefined) {
      validateSearchConnection(definition.forceSearch.searchConnection, 'experiment.forceSearch.searchConnection')
    }
  }
  if (definition.nativeSearch !== undefined) {
    rejectUnknownKeys(definition.nativeSearch, ['enabled', 'searchConnection'], 'experiment.nativeSearch')
    requireValue(typeof definition.nativeSearch.enabled === 'boolean', 'experiment.nativeSearch.enabled must be boolean')
    requireValue(definition.nativeSearch.enabled || definition.nativeSearch.searchConnection === undefined,
      'disabled nativeSearch cannot have a searchConnection')
    if (definition.nativeSearch.searchConnection !== undefined) {
      validateSearchConnection(definition.nativeSearch.searchConnection, 'experiment.nativeSearch.searchConnection')
    }
    requireValue(definition.nativeSearch.enabled || definition.forceSearch?.enabled !== true,
      'nativeSearch cannot be disabled while forceSearch is enabled')
    requireValue(!definition.nativeSearch.enabled || !definition.pools.some(pool => pool.backend !== 'codex')
      || definition.nativeSearch.searchConnection !== undefined,
    'nativeSearch requires a DSH searchConnection for additive model pools')
    if (definition.nativeSearch.enabled && definition.forceSearch?.enabled === true
      && definition.forceSearch.searchConnection !== undefined) {
      requireValue(canonicalJson(definition.nativeSearch.searchConnection)
        === canonicalJson(definition.forceSearch.searchConnection),
      'nativeSearch and forceSearch search connections must match')
    }
  }
  for (const [index, role] of definition.roles.entries()) {
    rejectUnknownKeys(role, ['id', 'description', 'seats', 'toolset'], `experiment.roles[${index}]`)
  }
  for (const [index, pool] of definition.pools.entries()) {
    rejectUnknownKeys(pool, [
      'id', 'backend', 'provider', 'connection', 'model', 'cyberAccessProgram', 'reasoningEffort', 'thinking', 'subagents', 'credentialSource', 'agents', 'required',
    ], `experiment.pools[${index}]`)
    if (pool.connection !== undefined) {
      rejectUnknownKeys(pool.connection, ['baseUrl', 'apiKeyEnv', 'headersEnv', 'usageWindowWait', 'contextWindow', 'maxTokens', 'costRates'], `experiment.pools[${index}].connection`)
      if (pool.connection.costRates !== undefined) {
        rejectUnknownKeys(pool.connection.costRates,
          ['uncachedInputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion'],
          `experiment.pools[${index}].connection.costRates`)
      }
    }
    if (pool.subagents !== undefined) {
      rejectUnknownKeys(pool.subagents, ['default', 'stages'], `experiment.pools[${index}].subagents`)
      if (pool.subagents.stages !== undefined) {
        rejectUnknownKeys(pool.subagents.stages, [
          'discovery', 'synthesis', 'coverage', 'negative-review', 'verification', 'reporting',
        ], `experiment.pools[${index}].subagents.stages`)
      }
    }
  }
  for (const [stageIndex, stage] of definition.stages.entries()) {
    const stagePath = `experiment.stages[${stageIndex}]`
    rejectUnknownKeys(stage, ['id', 'kind', 'objective', 'waves'], stagePath)
    for (const [waveIndex, wave] of stage.waves.entries()) {
      const wavePath = `${stagePath}.waves[${waveIndex}]`
      rejectUnknownKeys(wave, [
        'id', 'tasks', 'minSuccessfulTasks', 'minDistinctActors', 'replication',
      ], wavePath)
      if (wave.replication !== undefined) {
        rejectUnknownKeys(wave.replication, [
          'id', 'taskIds', 'minSuccessfulAgents', 'minDistinctProviders', 'minDistinctModels',
          'mergePolicy', 'allowAttestedAdditiveUnavailability',
        ], `${wavePath}.replication`)
      }
      for (const [taskIndex, task] of wave.tasks.entries()) {
        const taskPath = `${wavePath}.tasks[${taskIndex}]`
        rejectUnknownKeys(task, [
          'id', 'logicalRole', 'objective', 'providerClass', 'modelPool', 'model', 'cyberAccessProgram', 'reasoning', 'thinking', 'subagents', 'promptKind',
          'backend', 'provider', 'connection', 'credentialSource',
          'visibility', 'workspaceMode', 'workspaceKey', 'output', 'research', 'perspective',
          'observationPrefix', 'requiredTable', 'optional', 'retryPolicy',
        ], taskPath)
        rejectUnknownKeys(task.output, ['schema', 'requiredFiles', 'requiredSections'], `${taskPath}.output`)
        if (task.research !== undefined) {
          rejectUnknownKeys(task.research, [
            'wave', 'researcher', 'role', 'buildsOn', 'laneScratchPath',
          ], `${taskPath}.research`)
        }
      }
    }
  }
}

function taskSubagentStage(task: TaskDefinition): SubagentStage | null {
  if (task.promptKind === 'research') return 'discovery'
  if (task.promptKind === 'synthesis') return 'synthesis'
  if (task.promptKind === 'coverage-challenge') return 'coverage'
  if (task.promptKind === 'negative-review') {
    return 'negative-review'
  }
  if (task.promptKind === 'verification') return 'verification'
  if (task.promptKind === 'reporting') return 'reporting'
  return null
}

export function validateExperiment(definition: ExperimentDefinition): void {
  validateDefinitionShape(definition)
  requireValue(definition.schemaVersion === 2, 'experiment schemaVersion must be 2')
  requireValue(idPattern.test(definition.id), 'experiment id is invalid')
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(definition.target.repository), 'target repository is invalid')
  requireValue(shaPattern.test(definition.target.commit), 'target commit must be a pinned Git object')
  requireValue(shaPattern.test(definition.target.tree), 'target tree must be a pinned Git object')
  requireValue(definition.target.sourcePackageVersion === 2, 'target source package version must be 2')
  requireValue(definition.target.production === false, 'production targets are forbidden')
  requireValue(definition.target.resettable === true, 'target must be resettable')
  requireValue(definition.target.runtime.environmentBindings !== null
    && typeof definition.target.runtime.environmentBindings === 'object'
    && !Array.isArray(definition.target.runtime.environmentBindings),
  'target runtime environmentBindings must be an object')
  for (const [name, binding] of Object.entries(definition.target.runtime.environmentBindings)) {
    requireValue(/^[A-Z][A-Z0-9_]{0,127}$/.test(name), `invalid target runtime environment variable: ${name}`)
    requireValue(/^TARGET_[A-Z0-9_]{1,120}$/.test(binding), `invalid target runtime Cloudflare secret binding: ${binding}`)
  }
  requireValue(Array.isArray(definition.target.runtime.preflightCommands)
    && definition.target.runtime.preflightCommands.length > 0,
  'target runtime preflightCommands must be a non-empty array')
  for (const command of definition.target.runtime.preflightCommands) {
    requireValue(typeof command === 'string' && command.trim().length > 0 && command.length <= 4_096,
      'target runtime preflight command is invalid')
  }
  const preparation = definition.target.runtime.workspacePreparation
  if (preparation !== undefined) {
    rejectUnknownKeys(preparation, ['schemaVersion', 'workingDirectory', 'commands', 'integrityFiles'],
      'experiment.target.runtime.workspacePreparation')
    requireValue(preparation.schemaVersion === 1, 'workspace preparation schemaVersion must be 1')
    requireValue(preparation.workingDirectory === '.'
      || /^(?!\/)(?!.*(?:^|\/)\.\.?\/)\w[\w./-]{0,199}$/.test(preparation.workingDirectory),
    'workspace preparation workingDirectory is invalid')
    requireValue(Array.isArray(preparation.commands) && preparation.commands.length >= 1
      && preparation.commands.length <= 4, 'workspace preparation must have 1 to 4 commands')
    for (const command of preparation.commands) {
      requireValue(typeof command === 'string' && command.trim().length > 0 && command.length <= 4_096,
        'workspace preparation command is invalid')
    }
    requireValue(Array.isArray(preparation.integrityFiles) && preparation.integrityFiles.length >= 1
      && preparation.integrityFiles.length <= 8, 'workspace preparation integrityFiles must have 1 to 8 entries')
    for (const file of preparation.integrityFiles) {
      rejectUnknownKeys(file, ['path', 'sha256'], 'workspace preparation integrity file')
      requireValue(typeof file.path === 'string' && /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]{1,240}$/.test(file.path),
        'workspace preparation integrity path is invalid')
      requireValue(typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256),
        'workspace preparation integrity hash is invalid')
    }
    requireValue(new Set(preparation.integrityFiles.map(file => file.path)).size === preparation.integrityFiles.length,
      'workspace preparation integrity paths must be unique')
  }
  requireValue(definition.stages.length > 0, 'at least one stage is required')
  requireValue(INSTRUCTION_KEYS.every(key => typeof definition.prompts[key] === 'string' && definition.prompts[key].trim() !== ''),
    'every agent instruction must be non-empty text')
  const configuredStages = definition.stages.filter(stage => stage.kind !== 'preflight').map(stage => stage.kind) as import('./contracts.js').AuditStageKind[]
  validateStages(configuredStages)
  validateStagePrompts(definition.stagePrompts, configuredStages)
  const releaseRoles = [
    {
      id: 'lead',
      description: 'Schedule concurrent waves, route paths and direct peer requests, monitor phase and spend budgets, and avoid target review, threat-model authorship, reproduction, or report drafting.',
      seats: 1,
      toolset: 'coordination',
    },
    {
      id: 'security-researcher',
      description: 'Search the whole target for security issues and record each observation with its evidence.',
      seats: 5,
      toolset: 'security-testing',
    },
    {
      id: 'verifier',
      description: 'Independently challenge and attempt potential High/Critical candidates in small checkpointed batches, without accepting findings or assigning final severity.',
      seats: 1,
      toolset: 'independent-verification',
    },
  ] as const
  requireValue(canonicalJson(definition.roles) === canonicalJson(releaseRoles),
    'agent roles must match the security-audit-v1 method exactly')
  const roleIds = new Set(definition.roles.map(role => role.id))
  requireValue(definition.stopOnSaturation === undefined || typeof definition.stopOnSaturation === 'boolean', 'stopOnSaturation must be a boolean')
  requireValue(definition.discoverySafetyCeiling >= 1 && definition.discoverySafetyCeiling <= 64,
    'discovery wave limit must be between 1 and 64')
  requireValue(definition.pools.length >= 1, 'audit topology requires at least one model pool')
  const poolIds = new Set<string>()
  for (const pool of definition.pools) {
    requireValue(idPattern.test(pool.id), `invalid model pool id: ${pool.id}`)
    requireValue(!poolIds.has(pool.id), `duplicate model pool id: ${pool.id}`)
    requireValue(pool.backend === 'codex' || pool.backend === 'claude' || pool.backend === 'dsh-chat-completions',
      `model pool ${pool.id} has an unsupported backend`)
    requireValue(typeof pool.model === 'string' && pool.model.trim().length > 0, `model pool ${pool.id} has no model`)
    requireValue(validCodexAccessProgram(pool.backend, pool.cyberAccessProgram),
    `model pool ${pool.id} has invalid cyberAccessProgram`)
    requireValue(['none', 'low', 'medium', 'high', 'max'].includes(pool.reasoningEffort ?? ''),
      `model pool ${pool.id} has invalid reasoningEffort`)
    requireValue(['codex', 'claude'].includes(pool.backend) || pool.reasoningEffort !== 'medium',
      `model pool ${pool.id} uses unsupported DeepSeek reasoningEffort medium`)
    requireValue((['codex', 'claude'].includes(pool.backend)
      ? pool.thinking === undefined
      : ['enabled', 'disabled'].includes(pool.thinking ?? '')),
    `model pool ${pool.id} has invalid thinking mode`)
    requireValue(['codex', 'claude'].includes(pool.backend)
      || ((pool.thinking === 'disabled') === (pool.reasoningEffort === 'none')),
    `model pool ${pool.id} has unsupported thinking and reasoningEffort combination`)
    if (pool.subagents !== undefined) {
      validateSubagentPolicy(pool.subagents.default, `model pool ${pool.id} subagent default`)
      for (const [stage, policy] of Object.entries(pool.subagents.stages ?? {})) {
        validateSubagentPolicy(policy, `model pool ${pool.id} subagent stage ${stage}`)
      }
    }
    if (pool.backend === 'claude') {
      requireValue(/^CLAUDE_[A-Z0-9_]*OAUTH_TOKEN$/.test(pool.credentialSource ?? '')
        && pool.provider === undefined && pool.connection === undefined, `model pool ${pool.id} has invalid Claude subscription identity`)
      requireValue(pool.subagents?.default.mode !== 'native'
        && !Object.values(pool.subagents?.stages ?? {}).some(policy => policy.mode === 'native'),
      `model pool ${pool.id} does not support bounded native subagents`)
    }
    if (pool.backend === 'dsh-chat-completions') {
      requireValue(typeof pool.provider === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(pool.provider),
        `model pool ${pool.id} has no provider identity`)
      requireValue(pool.connection !== undefined, `model pool ${pool.id} has no provider connection`)
      let endpoint: URL | undefined
      try { endpoint = new URL(pool.connection?.baseUrl ?? '') } catch {}
      requireValue((pool.connection?.baseUrl.length ?? Number.POSITIVE_INFINITY) <= 2_048 && endpoint !== undefined
        && (endpoint.protocol === 'https:'
          || (endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))
        && endpoint.username === '' && endpoint.password === '' && endpoint.search === '' && endpoint.hash === '',
      `model pool ${pool.id} has invalid provider baseUrl`)
      requireValue(typeof pool.connection?.apiKeyEnv === 'string'
        && /^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(pool.connection.apiKeyEnv),
        `model pool ${pool.id} has invalid apiKeyEnv`)
      modelHeaderCredentialNames(pool.connection)
      requireValue(pool.connection.usageWindowWait === undefined || typeof pool.connection.usageWindowWait === 'boolean',
        `model pool ${pool.id} has invalid usageWindowWait`)
      for (const key of ['contextWindow', 'maxTokens'] as const) {
        const value = pool.connection[key]
        requireValue(value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= 2_000_000),
          `model pool ${pool.id} has invalid ${key}`)
      }
      requireValue((pool.connection.maxTokens ?? 256000) <= (pool.connection.contextWindow ?? 1000000),
        `model pool ${pool.id} maxTokens exceeds contextWindow`)
      if (pool.connection.costRates !== undefined) {
        requireValue(Object.values(pool.connection.costRates).length === 3
          && Object.values(pool.connection.costRates).every(rate => (
            typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 && rate <= 1_000
          )), `model pool ${pool.id} has invalid cost rates`)
      }
    } else {
      requireValue(typeof pool.credentialSource === 'string' && pool.credentialSource.trim().length > 0,
        `model pool ${pool.id} has no credential source`)
    }
    requireValue(Number.isSafeInteger(pool.agents) && pool.agents >= 0 && pool.agents <= 64,
      `model pool ${pool.id} has an invalid agent count`)
    requireValue(typeof pool.required === 'boolean' && (!['codex', 'claude'].includes(pool.backend) || pool.required),
      `model pool ${pool.id} must set a boolean required flag and keep subscription pools required`)
    poolIds.add(pool.id)
  }
  const stageIds = new Set<string>()
  const taskIds = new Set<string>()
  const discoveryStages = definition.stages.filter(stage => stage.kind === 'discovery')
  requireValue(discoveryStages.length === 1, 'exactly one discovery stage is required')
  requireValue(discoveryStages[0]?.waves.length === definition.discoverySafetyCeiling,
    'discoverySafetyCeiling must match the concrete safety topology')
  for (const stage of definition.stages) {
    requireValue(idPattern.test(stage.id), `invalid stage id: ${stage.id}`)
    requireValue(!stageIds.has(stage.id), `duplicate stage id: ${stage.id}`)
    requireValue(STAGE_KINDS.includes(stage.kind), `unsupported stage kind: ${stage.kind}`)
    requireValue(stage.waves.length > 0, `stage ${stage.id} has no waves`)
    stageIds.add(stage.id)

    const waveIds = new Set<string>()
    for (const wave of stage.waves) {
      requireValue(idPattern.test(wave.id), `invalid wave id: ${wave.id}`)
      requireValue(!waveIds.has(wave.id), `duplicate wave id in ${stage.id}: ${wave.id}`)
      requireValue(wave.tasks.length > 0, `wave ${stage.id}/${wave.id} has no tasks`)
      requireValue(wave.minSuccessfulTasks > 0 && wave.minSuccessfulTasks <= wave.tasks.length,
        `wave ${stage.id}/${wave.id} has an invalid success threshold`)
      requireValue(wave.minDistinctActors > 0 && wave.minDistinctActors <= wave.tasks.length,
        `wave ${stage.id}/${wave.id} has an invalid actor threshold`)
      if (wave.replication !== undefined) {
        requireValue(wave.replication.taskIds.length >= wave.replication.minSuccessfulAgents,
          `wave ${stage.id}/${wave.id} has an invalid replication threshold`)
        requireValue(wave.replication.mergePolicy === 'union-preserve-dissent',
          `wave ${stage.id}/${wave.id} may not collapse replicated dissent`)
      }
      waveIds.add(wave.id)

      for (const task of wave.tasks) {
        requireValue(idPattern.test(task.id), `invalid task id: ${task.id}`)
        requireValue(!taskIds.has(task.id), `duplicate task id: ${task.id}`)
        requireValue(task.output.requiredFiles.length > 0, `task ${task.id} has an empty output contract`)
        if (definition.forceSearch?.enabled === true && task.promptKind === 'research') {
          requireValue(task.output.schema === 'ack3.research-delta.policy-v3',
            `forceSearch requires v3 research output for task ${task.id}`)
        }
        requireValue(['none', 'low', 'medium', 'high', 'max'].includes(task.reasoning),
          `task ${task.id} has invalid reasoning effort`)
        requireValue(task.modelPool === undefined || poolIds.has(task.modelPool),
          `task ${task.id} names an unknown model pool`)
        if (task.subagents !== undefined) validateSubagentPolicy(task.subagents, `task ${task.id} subagents`)
        requireValue(roleIds.has(task.logicalRole as 'lead' | 'security-researcher' | 'verifier'),
          `task ${task.id} uses a role outside the method role contract`)
        requireValue(task.providerClass !== 'deterministic' || task.logicalRole === 'lead',
          `deterministic task ${task.id} must execute the lead control role`)
        requireValue(task.providerClass === 'deterministic' || task.logicalRole !== 'lead',
          `model task ${task.id} may not execute the lead control role`)
        for (const path of task.output.requiredFiles) {
          requireValue(outputPathPattern.test(path) && !path.includes('..') && !path.includes('//'),
            `task ${task.id} has an unsafe output path: ${path}`)
        }
        requireValue(task.output.requiredFiles.filter(path => path === SUBMISSION_PATH).length
          === (requiresSubmission(task) ? 1 : 0), `task ${task.id} has an invalid structured submission contract`)
        if (task.promptKind === 'coverage-challenge') {
          requireValue(task.perspective !== undefined && task.observationPrefix !== undefined,
            `coverage task ${task.id} lacks an isolated perspective contract`)
          requireValue(task.requiredTable === undefined || task.requiredTable.trim().length > 0,
            `coverage task ${task.id} has an empty required table contract`)
        }
        const permittedRetry = task.retryPolicy === 'none'
          || (task.retryPolicy === 'redirect-then-fresh-replacement' && task.providerClass === 'core' && task.promptKind === 'research')
          || (task.retryPolicy === 'fresh-repair' && task.providerClass === 'additive')
          || (task.retryPolicy === 'same-session-repair' && task.providerClass === 'core'
            && (task.promptKind === 'synthesis' || task.promptKind === 'coverage-challenge'
              || task.promptKind === 'negative-review' || task.promptKind === 'verification'
              || task.promptKind === 'reporting'))
        requireValue(permittedRetry, `task ${task.id} has an invalid retry policy`)
        const backend = taskBackend(task)
        requireValue(validCodexAccessProgram(backend, task.cyberAccessProgram),
        `task ${task.id} has invalid cyberAccessProgram`)
        requireValue((task.providerClass === 'core' && ['codex', 'claude'].includes(backend))
          || (task.providerClass === 'additive' && !['codex', 'claude', 'deterministic'].includes(backend))
          || (task.providerClass === 'deterministic' && backend === 'deterministic'),
        `task ${task.id} has an inconsistent execution backend`)
        const matchingPool = definition.pools.find(pool => {
          if (pool.id !== task.modelPool) return false
          if ((backend === 'claude' || task.credentialSource !== undefined)
            && task.credentialSource !== pool.credentialSource) return false
          if (pool.model !== task.model || pool.backend !== backend) return false
          if (pool.cyberAccessProgram !== task.cyberAccessProgram) return false
          if (pool.provider !== task.provider || canonicalJson(pool.connection) !== canonicalJson(task.connection)) return false
          if (pool.reasoningEffort !== task.reasoning || pool.thinking !== task.thinking) return false
          if (pool.subagents === undefined) return false
          const route = taskSubagentStage(task)
          return route !== null && canonicalJson(task.subagents)
            === canonicalJson(pool.subagents.stages?.[route] ?? pool.subagents.default)
        })
        requireValue(task.providerClass === 'deterministic' || matchingPool !== undefined,
          `model task ${task.id} does not preserve a configured model pool execution profile`)
        requireValue(stage.kind !== 'discovery' || task.providerClass === 'deterministic'
          || (task.optional !== true) === matchingPool?.required,
        `discovery task ${task.id} must preserve its pool availability requirement`)
        taskIds.add(task.id)
      }
    }
  }

  const limits = definition.limits
  requireValue(limits.maxWallTimeMs > 0, 'maxWallTimeMs must be positive')
  requireValue(limits.maxModelCalls > 0, 'maxModelCalls must be positive')
  requireValue(limits.maxInputTokens === undefined || limits.maxInputTokens > 0, 'maxInputTokens must be positive when set')
  requireValue(limits.maxOutputTokens === undefined || limits.maxOutputTokens > 0, 'maxOutputTokens must be positive when set')
  requireValue(limits.maxCostUsd >= 0, 'maxCostUsd cannot be negative')
  requireValue(Object.values(limits.phaseMinutes).every(value => Number.isFinite(value) && value > 0),
    'phase minute ceilings must be positive')
}

/** New admissions use native Exa; historical sealed definitions remain readable. */
export function validateNewSearchAdmission(definition: ExperimentDefinition): void {
  const forceSearch = definition.forceSearch
  const nativeSearch = definition.nativeSearch
  requireValue(forceSearch?.enabled !== true || nativeSearch?.enabled === true,
    'native Exa search is required when forceSearch is enabled')
  for (const connection of [forceSearch?.searchConnection, nativeSearch?.searchConnection]) {
    requireValue(connection === undefined || connection.provider === 'exa',
      'chat-completions search is retired for new audits')
  }
  requireValue(nativeSearch?.enabled !== true || nativeSearch.searchConnection?.provider === 'exa',
    'enabled native search requires an Exa connection for new audits')
}

export function validateReleasePackage(body: ReleasePackageBody): void {
  rejectUnknownKeys(body, ['schemaVersion', 'definition', 'environment'], 'release package')
  if (body.environment !== undefined) {
    rejectUnknownKeys(body.environment, ['image'], 'release package environment')
    requestedEnvironmentImageDigest(body.environment.image)
  }
  requireValue(body.schemaVersion === 2, 'release package schemaVersion must be 2')
  validateExperiment(body.definition)
}

export function normalizeCursor(definition: ExperimentDefinition, cursor: RunCursor): RunCursor {
  let { stageIndex, waveIndex } = cursor
  while (stageIndex < definition.stages.length) {
    const stage = definition.stages[stageIndex]
    if (stage === undefined) break
    if (waveIndex < stage.waves.length) return { stageIndex, waveIndex }
    stageIndex += 1
    waveIndex = 0
  }
  return { stageIndex: definition.stages.length, waveIndex: 0 }
}
