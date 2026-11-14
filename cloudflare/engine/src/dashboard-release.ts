import { sha256 } from './canonical.js'
import type { ExperimentDefinition, RunState } from './contracts.js'

type RunBinding = Pick<RunState, 'releaseDigest' | 'definitionDigest' | 'experimentId'>
  & Partial<Pick<RunState, 'artifacts' | 'rejectedAttempts' | 'inFlightAgentAttempts' | 'journal'>>
export type DashboardDefinition = Pick<ExperimentDefinition, 'stages'> & {
  historical?: ExperimentDefinition
  releases?: ReadonlyMap<string, ExperimentDefinition>
  configuration?: Record<string, unknown>
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Read immutable history without reapplying today's execution admission rules. */
export async function readDashboardDefinition(packages: Pick<R2Bucket, 'get'>, run: RunBinding, includeHistorical = false): Promise<DashboardDefinition> {
  if (![run.releaseDigest, run.definitionDigest].every(value => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error('invalid monitoring release binding')
  }
  const load = async (releaseDigest: string, definitionDigest: string) => {
    const object = await packages.get(`releases/sha256/${releaseDigest}.json`)
    if (object === null) throw new Error('monitoring release not found')
    const content = await object.text()
    const objectDigest = await sha256(content)
    if (object.customMetadata?.bodySha256 !== releaseDigest
      || object.customMetadata?.objectSha256 !== objectDigest
      || object.checksums.toJSON().sha256 !== objectDigest) {
      throw new Error('monitoring release object integrity mismatch')
    }
    const envelope: unknown = JSON.parse(content)
    if (!record(envelope) || envelope.digest !== releaseDigest || !record(envelope.body)
      || await sha256(envelope.body) !== releaseDigest) {
      throw new Error('monitoring release body integrity mismatch')
    }
    const definition = envelope.body.definition
    if (!record(definition) || definition.id !== run.experimentId
      || await sha256(definition) !== definitionDigest) {
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
    return { definition: { ...definition, stages: definition.stages as ExperimentDefinition['stages'] } as ExperimentDefinition,
      environment: envelope.body.environment }
  }
  const { definition: historical, environment } = await load(run.releaseDigest, run.definitionDigest)
  const references = new Map<string, string>()
  const add = (value: unknown) => {
    if (!record(value) || typeof value.releaseDigest !== 'string' || typeof value.definitionDigest !== 'string') return
    const prior = references.get(value.releaseDigest)
    if (prior !== undefined && prior !== value.definitionDigest) throw new Error('monitoring release has conflicting definition digests')
    references.set(value.releaseDigest, value.definitionDigest)
  }
  add(run)
  for (const item of [...(run.artifacts ?? []), ...(run.rejectedAttempts ?? []), ...(run.inFlightAgentAttempts ?? [])]) add(item.execution)
  for (const event of run.journal ?? []) if (event.type === 'agent.attempt-admitted' && record(event.payload)) add(event.payload.execution)
  const releases = new Map<string, ExperimentDefinition>([[run.releaseDigest, historical]])
  for (const [digest, definitionDigest] of references) {
    if (digest === run.releaseDigest) continue
    const earlier = (await load(digest, definitionDigest)).definition
    if (await sha256(earlier.target) !== await sha256(historical.target)) throw new Error('historical monitoring target differs')
    releases.set(digest, earlier)
  }
  // Historical prompt inputs are read-only; a reconstruction is shown only when its digest matches a recorded request.
  return { stages: historical.stages, releases, ...(includeHistorical ? { historical } : {}), configuration: {
    target: historical.target, limits: historical.limits,
    maxDiscoveryWaves: historical.discoverySafetyCeiling,
    stopOnSaturation: historical.stopOnSaturation ?? true,
    stagePrompts: historical.stagePrompts ?? null,
    scope: historical.policy.scope ?? null,
    ...(historical.prompts.pocReview === undefined ? {} : { keepPocs: true }),
    ...(historical.prompts.submitCheck === undefined ? {} : { submitCheck: true }),
    forceSearch: record(historical.forceSearch) && historical.forceSearch.enabled === true,
    forceSearchStages: historical.forceSearchStages ?? null,
    environment: environment ?? null,
    pools: historical.pools,
    revisions: [...references].map(([releaseDigest, definitionDigest]) => ({ releaseDigest, definitionDigest,
      active: releaseDigest === run.releaseDigest })),
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
