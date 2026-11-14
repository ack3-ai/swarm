import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import type { ArtifactRecord, AvailabilityBoundary, ExecutionConfiguration, ExperimentDefinition, RunState, TaskDefinition } from './contracts.js'
import { zeroBudget } from './execution-budget.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { executionConfiguration } from './artifact-execution.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { providerIdentity, taskBackend } from './provider-identity.js'

function route(task: TaskDefinition): string {
  return canonicalJson({ backend: taskBackend(task), provider: providerIdentity(task), model: task.model,
    connection: task.connection, credentialSource: task.credentialSource, cyberAccessProgram: task.cyberAccessProgram,
    // Only when set, so routes without fallbacks keep their text.
    ...(task.fallbackCredentialSources === undefined ? {} : { fallbackCredentialSources: task.fallbackCredentialSources }) })
}

function poolRoute(definition: ExperimentDefinition, boundary: AvailabilityBoundary): string {
  const tasks = definition.stages.filter(stage => stage.kind === 'discovery').flatMap(stage => stage.waves
    .flatMap(wave => wave.tasks.filter(task => boundary.poolId === undefined
      ? providerIdentity(task) === boundary.provider : configuredResearchTaskPoolId(task) === boundary.poolId)))
  return canonicalJson({ routes: [...new Set(tasks.map(route))].sort(),
    ...(boundary.reason === 'budget' ? { limits: definition.limits } : {}) })
}

/** Derived from verified checkpoint evidence, never an executable configuration
 * history. Null records a broken route and remains inactive through later forks. */
export interface ImportedAvailabilityContext {
  initial: ExecutionConfiguration
  entries: readonly { boundary: AvailabilityBoundary; route: string | null }[]
}

/** Retain the evidence, but only enforce it while its route has remained continuously configured.
 * Continuations carry the source-owned route evidence separately from their manifest.
 */
export async function applicableAvailabilityBoundaries(state: Pick<RunState,
  'availabilityBoundaries' | 'artifacts'>, configuration: ExecutionConfiguration,
  definition: ExperimentDefinition,
  imported?: ImportedAvailabilityContext): Promise<readonly AvailabilityBoundary[]> {
  assertCurrentExecutionFormat(state)
  if (imported === undefined) return state.availabilityBoundaries
  if (await sha256(definition) !== configuration.definitionDigest) throw new Error('availability definition digest differs')
  if (canonicalJson(imported.initial) !== canonicalJson(configuration)) {
    throw new Error('availability target configuration is not authorized')
  }
  const keys = imported.entries.map(value => canonicalJson(value.boundary))
  const recorded = new Set(state.availabilityBoundaries.map(canonicalJson))
  if (new Set(keys).size !== keys.length || keys.some(key => !recorded.has(key))) {
    throw new Error('imported availability evidence is missing or repeated')
  }
  const applicable: AvailabilityBoundary[] = []
  for (const boundary of state.availabilityBoundaries) {
    const source = state.artifacts.find(artifact => artifact.taskId === boundary.sourceTaskId)
    if (source === undefined) throw new Error('availability source artifact is missing')
    if (boundary.configuration !== undefined && source.execution !== undefined
      && canonicalJson(boundary.configuration) !== canonicalJson(executionConfiguration(source.execution))) {
      throw new Error('availability configuration differs from its source execution')
    }
    const inherited = imported.entries.find(value => canonicalJson(value.boundary) === canonicalJson(boundary))
    if (inherited?.route === null) continue
    const origin = boundary.configuration ?? (source.execution === undefined
      ? configuration : executionConfiguration(source.execution))
    if (inherited === undefined && canonicalJson(origin) !== canonicalJson(configuration)) {
      throw new Error('availability source configuration is not authorized')
    }
    if (inherited === undefined || poolRoute(definition, boundary) === inherited.route) applicable.push(boundary)
  }
  return applicable
}

/** Project one exact checkpoint frontier. Its caller has already verified the
 * registered seal and source artifacts; only route continuity is derived here. */
export async function importAvailabilityContext(state: Pick<RunState,
  'availabilityBoundaries' | 'artifacts'>, configuration: ExecutionConfiguration,
  definition: ExperimentDefinition, initial: ExecutionConfiguration,
  imported?: ImportedAvailabilityContext): Promise<ImportedAvailabilityContext> {
  // Source evidence must match its producer; importing cannot restamp it.
  const context = imported ?? { initial: configuration, entries: [] }
  const applicable = new Set((await applicableAvailabilityBoundaries(state, configuration, definition, context)).map(canonicalJson))
  return { initial: deepClone(initial), entries: state.availabilityBoundaries.map(boundary => ({
    boundary: deepClone(boundary), route: applicable.has(canonicalJson(boundary)) ? poolRoute(definition, boundary) : null,
  })) }
}

/** Shared acceptance transition; historical boundaries are never silently restamped. */
export function recordAvailabilityBoundary(boundaries: readonly AvailabilityBoundary[], record: ArtifactRecord,
  task: TaskDefinition, now: string): readonly AvailabilityBoundary[] {
  if (task.providerClass !== 'additive' || record.status !== 'additive-unavailable'
    || (record.unavailableReason !== 'budget' && record.unavailableReason !== 'provider-credit')
    || record.stageId !== 'discovery' || record.execution === undefined) return boundaries
  const configuration = executionConfiguration(record.execution)
  if (boundaries.some(boundary => canonicalJson(boundary.configuration) === canonicalJson(configuration)
    && (boundary.poolId === configuredResearchTaskPoolId(task)
      || (boundary.poolId === undefined && boundary.provider === providerIdentity(task))))) return boundaries
  return [...boundaries, { configuration, provider: providerIdentity(task), poolId: configuredResearchTaskPoolId(task),
    effectiveFromWave: Number(record.waveId.replace(/^wave-/, '')) + 1,
    reason: record.unavailableReason, sourceTaskId: task.id, sealedAt: now }]
}

/** The only native-task result that may precede admission is the scheduler's
 * empty result for a previously disabled optional pool. Reconstruct that
 * decision from earlier accepted evidence, never from the result's label alone. */
export async function isAvailabilityBoundaryAcceptance(record: ArtifactRecord, task: TaskDefinition,
  state: Pick<RunState, 'availabilityBoundaries' | 'artifacts' | 'releaseDigest' | 'definitionDigest'>,
  definition: ExperimentDefinition,
  imported?: ImportedAvailabilityContext): Promise<boolean> {
  if (task.providerClass !== 'additive' || task.optional !== true || record.execution === undefined
    || record.status !== 'additive-unavailable' || record.unavailableReason !== 'discovery-boundary'
    || record.actorId !== `additive-boundary-${record.execution.runId}`
    || record.model !== task.model || record.provider !== providerIdentity(task)
    || canonicalJson(record.usage) !== canonicalJson(zeroBudget())
    || record.files.length !== 0 || record.assertions.length !== 0 || canonicalJson(record.protocol) !== '{}'
    || Object.hasOwn(record, 'acceptance') || record.contentDigest !== await sha256('{}')) return false
  const configuration = executionConfiguration(record.execution)
  if (canonicalJson(configuration) !== canonicalJson(executionConfiguration(state))
    || await sha256(definition) !== state.definitionDigest) return false
  const stage = definition.stages.find(value => value.id === record.stageId)
  if (stage === undefined) return false
  const wave = stage.kind === 'discovery' ? Number(record.waveId.replace(/^wave-/, '')) : Number.MAX_SAFE_INTEGER
  const pool = task.modelPool ?? (task.promptKind === 'research' ? configuredResearchTaskPoolId(task) : undefined)
  return (await applicableAvailabilityBoundaries(state, configuration, definition, imported)).some(boundary =>
    wave >= boundary.effectiveFromWave && (pool === undefined ? boundary.provider === providerIdentity(task)
      : boundary.poolId === pool || boundary.poolId === undefined && boundary.provider === providerIdentity(task)))
}
