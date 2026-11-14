import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { copyState } from './state-copy.js'
import { resolveStageForkOrigin, type StageForkSeed } from './stage-fork-origin.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import type { ArtifactExecution, ExecutionConfiguration, ExperimentDefinition, ReleasePackage, RunState, TaskDefinition, WaveDefinition } from './contracts.js'
import { assertExecutionWorkspace, executionConfiguration } from './artifact-execution.js'
import { validateExperiment } from './validation.js'

export type ReleaseLoader = (digest: string) => Promise<ReleasePackage>

export async function authorizedConfiguration(state: Pick<RunState,
  'releaseDigest' | 'definitionDigest' | 'journal'>): Promise<ExecutionConfiguration> {
  assertCurrentExecutionFormat(state)
  const current = executionConfiguration(state)
  const origins = state.journal.filter(event => event.type === 'run.created')
  const origin = origins[0]?.payload as ExecutionConfiguration | undefined
  if (origins.length !== 1 || origin === undefined
    || canonicalJson(executionConfiguration(origin)) !== canonicalJson(current)) {
    throw new Error('initial configuration differs from the audit origin')
  }
  return current
}

// A private, recursively frozen copy: callers can share it without copying it again.
function frozenCopy<T>(value: T): T {
  const copy = deepClone(value)
  const freeze = (entry: unknown): void => {
    if (entry === null || typeof entry !== 'object' || Object.isFrozen(entry)) return
    Object.freeze(entry)
    for (const child of Object.values(entry)) freeze(child)
  }
  freeze(copy)
  return copy
}

/** Resolve only references admitted by this audit. Each complete release validates independently. */
export class ExecutionReleases {
  private constructor(private readonly configuration: ExecutionConfiguration,
    private readonly current: ExperimentDefinition, private readonly seed?: StageForkSeed) {}

  static async create(definition: ExperimentDefinition,
    state: Pick<RunState, 'releaseDigest' | 'definitionDigest' | 'journal' | 'forkOrigin'>,
    load?: ReleaseLoader, loadSource?: ExecutionSourceLoader): Promise<ExecutionReleases> {
    validateExperiment(definition)
    if (await sha256(definition) !== state.definitionDigest) throw new Error('active definition digest differs')
    const seed = await resolveStageForkOrigin(state, load, loadSource)
    const configuration = await authorizedConfiguration(state)
    return new ExecutionReleases(configuration, frozenCopy(definition), seed)
  }

  get importedSeed(): StageForkSeed | undefined { return this.seed === undefined ? undefined : copyState(this.seed) }

  get importedDiscoveryWaits() { return deepClone(this.seed?.discoveryWaits ?? []) }

  get importedAvailability() { return this.seed === undefined ? undefined : deepClone(this.seed.availability) }

  /** A private copy the caller may change. */
  async definition(reference: ExecutionConfiguration): Promise<ExperimentDefinition> {
    return deepClone(await this.resolveDefinition(reference))
  }

  /** Shared and recursively frozen: for lookups that only read it. A write throws. */
  async definitionView(reference: ExecutionConfiguration): Promise<ExperimentDefinition> {
    return this.resolveDefinition(reference)
  }

  private async resolveDefinition(reference: ExecutionConfiguration): Promise<ExperimentDefinition> {
    if (canonicalJson(executionConfiguration(reference)) !== canonicalJson(this.configuration)) {
      throw new Error('execution references an unauthorized configuration')
    }
    return this.current
  }

  /** Resolve a wave from its original release without copying unrelated stage definitions. */
  async wave(reference: ExecutionConfiguration, stageId: string, waveId: string): Promise<WaveDefinition> {
    const definition = await this.resolveDefinition(reference)
    const wave = definition.stages.find(stage => stage.id === stageId)?.waves.find(wave => wave.id === waveId)
    if (wave === undefined) throw new Error('execution wave is outside its original release')
    return deepClone(wave)
  }

  async task(reference: ExecutionConfiguration & Partial<Pick<ArtifactExecution, 'taskExecutionId' | 'workspaceKey'>>, location: { stageId: string; waveId: string; taskId: string },
    expectedTaskDigest?: string, peerPredecessor?: string): Promise<TaskDefinition> {
    const definition = await this.resolveDefinition(reference)
    const task = definition.stages.find(stage => stage.id === location.stageId)?.waves
      .find(wave => wave.id === location.waveId)?.tasks.find(task => task.id === location.taskId)
    if (task === undefined) throw new Error('execution task is outside its original release')
    const resolved = deepClone(task)
    if (peerPredecessor !== undefined) {
      if (resolved.research === undefined || !/^(none|wave-\d+\/research-[1-9]\d*)$/.test(peerPredecessor)) {
        throw new Error('execution peer predecessor is invalid')
      }
      resolved.research = { ...resolved.research, buildsOn: peerPredecessor }
    }
    if (expectedTaskDigest !== undefined && await sha256(resolved) !== expectedTaskDigest) throw new Error('execution task digest differs')
    await assertExecutionWorkspace(reference, resolved)
    return resolved
  }
}
