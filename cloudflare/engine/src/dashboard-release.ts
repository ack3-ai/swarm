import { sha256 } from './canonical.js'
import type { ExperimentDefinition, RunState } from './contracts.js'

type RunBinding = Pick<RunState, 'releaseDigest' | 'definitionDigest' | 'experimentId'>
export type DashboardDefinition = Pick<ExperimentDefinition, 'stages'> & { historical?: ExperimentDefinition; configuration?: Record<string, unknown> }

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read immutable history without reapplying today's execution admission rules. */
export async function readDashboardDefinition(packages: Pick<R2Bucket, 'get'>, run: RunBinding, includeHistorical = false): Promise<DashboardDefinition> {
  if (![run.releaseDigest, run.definitionDigest].every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('invalid monitoring release binding')
  }
  const object = await packages.get(`releases/sha256/${run.releaseDigest}.json`)
  if (object === null) throw new Error('monitoring release not found')
  const content = await object.text()
  const objectDigest = await sha256(content)
  if (object.customMetadata?.bodySha256 !== run.releaseDigest
    || object.customMetadata?.objectSha256 !== objectDigest
    || object.checksums.toJSON().sha256 !== objectDigest) {
    throw new Error('monitoring release object integrity mismatch')
  }
  const envelope: unknown = JSON.parse(content)
  if (!record(envelope) || envelope.digest !== run.releaseDigest || !record(envelope.body)
    || await sha256(envelope.body) !== run.releaseDigest) {
    throw new Error('monitoring release body integrity mismatch')
  }
  const definition = envelope.body.definition
  if (!record(definition) || definition.id !== run.experimentId
    || await sha256(definition) !== run.definitionDigest) {
    throw new Error('monitoring release does not belong to this run')
  }
  // Only inspect the structural fields consumed by the projection. Prompts, gates
  // and submission contracts are historical data, not authority to execute them.
  if (!Array.isArray(definition.stages) || !definition.stages.every(stage => record(stage)
    && ['id', 'kind', 'objective'].every(key => typeof stage[key] === 'string')
    && Array.isArray(stage.waves) && stage.waves.every(wave => record(wave) && typeof wave.id === 'string'
      && Array.isArray(wave.tasks) && wave.tasks.every(task => record(task)
        && ['id', 'workspaceKey', 'logicalRole', 'model', 'providerClass', 'promptKind']
          .every(key => typeof task[key] === 'string')
        && (task.research === undefined || (record(task.research) && typeof task.research.role === 'string')))))) {
    throw new Error('unsupported monitoring stage structure')
  }
  // Historical prompt inputs are read-only; a reconstruction is shown only when its digest matches a recorded request.
  const historical = { ...definition, stages: definition.stages as ExperimentDefinition['stages'] } as ExperimentDefinition
  return { stages: historical.stages, ...(includeHistorical ? { historical } : {}), configuration: {
    target: definition.target, limits: definition.limits,
    maxDiscoveryWaves: definition.discoverySafetyCeiling,
    stopOnSaturation: definition.stopOnSaturation ?? true,
    stagePrompts: definition.stagePrompts ?? null,
    forceSearch: record(definition.forceSearch) && definition.forceSearch.enabled === true,
    forceSearchStages: definition.forceSearchStages ?? null,
    environment: envelope.body.environment ?? null,
    pools: definition.pools,
    stages: historical.stages.map(stage => ({ id: stage.id, kind: stage.kind,
      waves: stage.waves.map(wave => ({ id: wave.id,
        minSuccessfulTasks: wave.minSuccessfulTasks, minDistinctActors: wave.minDistinctActors,
        replication: wave.replication,
        tasks: wave.tasks.map(task => ({ id: task.id, pool: task.modelPool ?? null,
          model: task.model, role: task.promptKind, required: !task.optional,
          reasoning: task.reasoning, thinking: task.thinking,
          visibility: task.visibility, workspaceMode: task.workspaceMode, workspaceKey: task.workspaceKey,
          retryPolicy: task.retryPolicy,
        })),
      })),
    })),
  } }
}
