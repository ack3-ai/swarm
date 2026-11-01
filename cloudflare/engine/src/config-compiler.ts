import type { ReleasePackageBody } from './contracts.js'
import { compileSecurityAuditV1 } from './methods/security-audit-v1.js'

const manifestKeys = [
  'configVersion',
  'id',
  'kind',
  'limits',
  'maxDiscoveryWaves',
  'stopOnSaturation',
  'researchPlan',
  'modelPools',
  'stageModelPools',
  'method',
  'stages',
  'promptFile',
  'forceSearch',
  'forceSearchStages',
  'nativeSearch',
  'objective',
  'target',
  'environment',
] as const

function object(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('audit manifest must be an object')
  }
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key)).toSorted()
  if (unknown.length > 0) throw new TypeError(`${path} has unknown keys: ${unknown.join(', ')}`)
}

export function compileExperimentConfig(value: unknown, promptContents: unknown): ReleasePackageBody {
  object(value)
  rejectUnknownKeys(value, manifestKeys, 'audit manifest')
  if (value.kind !== 'ack3-audit' || value.configVersion !== 2) {
    throw new TypeError('audit manifest must use ack3-audit v2')
  }
  if (value.method !== 'security-audit-v1') throw new TypeError('unsupported audit method')
  object(value.target)
  rejectUnknownKeys(value.target, ['repository', 'commit', 'tree', 'environment', 'runtime'], 'audit manifest target')
  if (value.environment !== undefined) {
    object(value.environment)
    rejectUnknownKeys(value.environment, [
      'image', 'environmentBindings', 'preflightCommands', 'workspacePreparation',
    ], 'audit manifest environment')
    if (value.target.environment !== undefined || value.target.runtime !== undefined) {
      throw new TypeError('audit manifest environment must not be combined with legacy target environment/runtime')
    }
  } else {
    object(value.target.runtime)
  }
  const runtime = value.environment ?? value.target.runtime
  object(runtime)
  rejectUnknownKeys(runtime, [
    'environmentBindings', 'preflightCommands', 'workspacePreparation',
    ...(value.environment === undefined ? [] : ['image']),
  ], value.environment === undefined ? 'audit manifest target.runtime' : 'audit manifest environment')
  object(value.limits)
  rejectUnknownKeys(value.limits, [
    'maxDiscoveryRuntimeMs', 'maxModelCalls', 'maxInputTokens', 'maxOutputTokens', 'maxCostUsd',
  ], 'audit manifest limits')
  if (value.nativeSearch !== undefined && value.nativeSearch !== false) {
    object(value.nativeSearch)
    rejectUnknownKeys(value.nativeSearch, ['searchConnection'], 'audit manifest nativeSearch')
    if (value.nativeSearch.searchConnection !== undefined) {
      object(value.nativeSearch.searchConnection)
      rejectUnknownKeys(value.nativeSearch.searchConnection, ['provider', 'baseUrl', 'apiKeyEnv', 'model'],
        'audit manifest nativeSearch.searchConnection')
    }
  }
  if (!Array.isArray(value.modelPools)) throw new TypeError('audit manifest modelPools must be an array')
  for (const [index, pool] of value.modelPools.entries()) {
    object(pool)
    rejectUnknownKeys(pool, [
      'id', 'backend', 'provider', 'connection', 'model', 'cyberAccessProgram', 'reasoningEffort', 'thinking', 'subagents', 'credentialSource', 'agents', 'required',
    ], `audit manifest modelPools[${index}]`)
    if (pool.connection !== undefined) {
      object(pool.connection)
      rejectUnknownKeys(pool.connection, ['baseUrl', 'apiKeyEnv', 'headersEnv', 'usageWindowWait', 'contextWindow', 'maxTokens', 'costRates'], `audit manifest modelPools[${index}].connection`)
      if (pool.connection.costRates !== undefined) {
        object(pool.connection.costRates)
        rejectUnknownKeys(pool.connection.costRates,
          ['uncachedInputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion'],
          `audit manifest modelPools[${index}].connection.costRates`)
      }
    }
    if (pool.subagents === undefined) {
      throw new TypeError(`audit manifest modelPools[${index}] must define subagents`)
    }
    object(pool.subagents)
    rejectUnknownKeys(pool.subagents, ['default', 'stages'], `audit manifest modelPools[${index}].subagents`)
    if (pool.subagents.stages !== undefined) {
      object(pool.subagents.stages)
      rejectUnknownKeys(pool.subagents.stages, [
        'discovery', 'synthesis', 'coverage', 'negative-review', 'verification', 'reporting',
      ], `audit manifest modelPools[${index}].subagents.stages`)
    }
  }
  const stageModelPools = value.stageModelPools ?? {}
  object(stageModelPools)
  rejectUnknownKeys(stageModelPools, [
    'synthesis', 'coverage', 'negative-review', 'verification', 'reporting',
  ], 'audit manifest stageModelPools')
  return compileSecurityAuditV1({ ...value, stageModelPools }, promptContents)
}
