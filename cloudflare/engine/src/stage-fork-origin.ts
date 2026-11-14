import type { SourceFence } from './source-fence.js'
import { forkBoundary, type ForkBoundary } from './run-commands.js'
import { addBudget, assertBudgetShape } from './execution-budget.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import type { ArtifactRecord, RejectedAttempt, RunState, WaveAdmission, DiscoveryCohortAdmission } from './contracts.js'
import type { ExecutionAuthority } from './execution-authority.js'
import { initialTaskOccurrences } from './task-occurrences.js'
import { compiledTaskContract } from './task-contract.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import type { ReleaseLoader } from './execution-releases.js'
import { validateReleasePackage } from './validation.js'
import { frozenAdmissionArtifacts } from './frozen-inputs.js'
import type { SavedStateReference } from './run-state-pointer.js'
import type { SavedWorkSeed } from './saved-work.js'

/** Immutable provenance only; policies and model assignments remain in releases. */
export type StageForkOrigin = ForkBoundary & {
  source: SavedStateReference
  sourceFence?: SourceFence
  savedWorkDigest: string
}
export type StageForkSeed = SavedWorkSeed

/** Imported outcomes keep their original bytes. Only unfinished obligations
 * acquire execution identities in the new audit; legacy owners are not invented. */
export async function bindStageForkSeed(seed: StageForkSeed, authority: ExecutionAuthority, load: ReleaseLoader): Promise<StageForkSeed> {
  if (seed.boundary.sourceFrontier !== true) return seed
  seed = deepClone(seed); authority = deepClone(authority)
  const configuration = { releaseDigest: seed.release.digest, definitionDigest: await sha256(seed.release.body.definition) }
  const convert = async <T extends WaveAdmission | DiscoveryCohortAdmission>(admission: T): Promise<T> => {
    const digest = admission.configuration?.releaseDigest ?? seed.source.releaseDigest
    const release = deepClone(await load(digest))
    validateReleasePackage(release.body)
    if (release.digest !== digest || await sha256(release.body) !== digest
      || admission.configuration !== undefined && await sha256(release.body.definition) !== admission.configuration.definitionDigest) {
      throw new Error('fork admission release digest differs')
    }
    const old = release.body.definition
    const next = seed.release.body.definition
    const before = old.stages.find(value => value.id === admission.stageId)?.waves.find(value => value.id === admission.waveId)
    const after = next.stages.find(value => value.id === admission.stageId)?.waves.find(value => value.id === admission.waveId)
    const policy = (wave: NonNullable<typeof before>) => { const { tasks: _, ...value } = wave; return value }
    if (before === undefined || after === undefined
      || ('poolId' in admission ? canonicalJson(before.replication) !== canonicalJson(after.replication)
        : canonicalJson(policy(before)) !== canonicalJson(policy(after)))) {
      throw new Error('fork changes admitted wave obligations or independence')
    }
    const tasks = 'poolId' in admission ? after.tasks.filter(task => configuredResearchTaskPoolId(task) === admission.poolId) : after.tasks
    const previous = 'taskIds' in admission ? admission.taskIds : before.tasks.map(task => task.id)
    if (canonicalJson(tasks.map(task => task.id).sort()) !== canonicalJson([...previous].sort())) throw new Error('fork changes admitted task obligations')
    const peers = 'peerPredecessors' in admission ? admission.peerPredecessors : {}
    if (admission.inputArtifacts === undefined) throw new Error('fork lacks its original admitted input snapshot')
    const visible = await frozenAdmissionArtifacts(seed.artifacts, admission)
    for (const task of tasks) {
      const original = before.tasks.find(value => value.id === task.id)!
      if (task.optional !== original.optional || task.promptKind !== original.promptKind
        || task.visibility !== original.visibility || canonicalJson(task.output) !== canonicalJson(original.output)) {
        throw new Error('fork changes admitted output or required role')
      }
      const peer = peers[task.id]
      const configured = <T extends typeof task>(value: T) => peer === undefined || value.research === undefined ? value
        : { ...value, research: { ...value.research, buildsOn: peer } }
      if (seed.artifacts.some(record => record.taskId === task.id)
        && compiledTaskContract(old, admission.stageId, configured(original), visible)
          !== compiledTaskContract(next, admission.stageId, configured(task), visible)) throw new Error('fork changes accepted task contract')
    }
    const unfinished = tasks.filter(task => !seed.artifacts.some(record => record.taskId === task.id))
    return { ...deepClone(admission), configuration,
      taskOccurrences: await initialTaskOccurrences(authority, configuration, unfinished, peers) }
  }
  return { ...seed, waveAdmission: seed.waveAdmission === undefined ? undefined : await convert(seed.waveAdmission),
    ...(seed.discoveryScheduler === undefined ? {} : { discoveryScheduler: { ...seed.discoveryScheduler,
      // The ordinary manifest may explicitly remove an unavailable pool. Its
      // source admission remains in the export; accepted bytes and usage stay
      // imported, while no task from that pool acquires child authority.
      admissions: await Promise.all(seed.discoveryScheduler.admissions.filter(admission =>
        seed.release.body.definition.stages.find(stage => stage.id === admission.stageId)?.waves
          .some(wave => wave.tasks.some(task => configuredResearchTaskPoolId(task) === admission.poolId))).map(convert)) } }) }
}

/** The exemption is exact seed membership, never a stage/model/foreign-ID test. */
export function assertStageForkSelection(seed: Pick<StageForkSeed, 'artifacts' | 'rejectedAttempts' | 'waveReceipts' | 'stageEndReceipts' | 'availabilityBoundaries' | 'stageIndex' | 'waveIndex' | 'release' | 'source'>, state: Pick<RunState,
  'artifacts' | 'rejectedAttempts' | 'waveReceipts' | 'stageEndReceipts' | 'availabilityBoundaries' | 'cursor' | 'rootCreatedAt' | 'modelStartedAt' | 'journal' | 'budget'>): void {
  const samePrefix = <T>(actual: readonly T[], expected: readonly T[]) => canonicalJson(actual.slice(0, expected.length)) === canonicalJson(expected)
  if (!samePrefix(state.artifacts, seed.artifacts) || !samePrefix(state.rejectedAttempts, seed.rejectedAttempts)
    || !samePrefix(state.waveReceipts, seed.waveReceipts)
    || !samePrefix(state.stageEndReceipts, seed.stageEndReceipts)
    || !samePrefix(state.availabilityBoundaries, seed.availabilityBoundaries)
    || state.cursor.stageIndex < seed.stageIndex
    || state.cursor.stageIndex === seed.stageIndex && state.cursor.waveIndex < seed.waveIndex || state.rootCreatedAt !== seed.source.rootCreatedAt
    || state.modelStartedAt !== seed.source.modelStartedAt) throw new Error('fork changed its imported prefix or clocks')
  const retainedStages = new Set(seed.release.body.definition.stages.slice(0, seed.stageIndex).map(stage => stage.id))
  const currentStage = seed.release.body.definition.stages[seed.stageIndex]!
  const retainedWaves = new Set(currentStage.waves.slice(0, seed.waveIndex).map(wave => wave.id))
  const retainedTasks = new Set(seed.artifacts.map(record => record.taskId))
  const retainedCohorts = new Set(seed.waveReceipts.filter(record => record.poolId !== undefined)
    .map(record => canonicalJson([record.stageId, record.waveId, record.poolId])))
  const retained = (record: { stageId?: string; waveId?: string; taskId?: string; poolId?: string }) => retainedStages.has(record.stageId ?? '')
    || retainedTasks.has(record.taskId ?? '')
    || record.poolId !== undefined && retainedCohorts.has(canonicalJson([record.stageId, record.waveId, record.poolId]))
    || record.stageId === currentStage.id && retainedWaves.has(record.waveId ?? '')
  if (state.artifacts.slice(seed.artifacts.length).some(retained)
    || state.waveReceipts.slice(seed.waveReceipts.length).some(retained)
    || state.stageEndReceipts.slice(seed.stageEndReceipts.length).some(record => record.stageIndex < seed.stageIndex)) {
    throw new Error('fork adds outcomes to its retained prefix')
  }
  let budget = seed.source.budget
  assertBudgetShape(budget)
  for (const event of state.journal.slice(1)) {
    if (event.type === 'task.accepted' || event.type === 'task.attempt-rejected') {
      const record = event.type === 'task.accepted' ? (event.payload as { artifact: ArtifactRecord }).artifact : event.payload as RejectedAttempt
      assertBudgetShape(record.usage); budget = addBudget(budget, record.usage)
    }
    const payload = event.payload as { stageId?: string; waveId?: string; taskId?: string; poolId?: string; stageIndex?: number;
      artifact?: { stageId?: string; waveId?: string; taskId?: string } }
    if (retained(payload.artifact ?? payload)
      || (typeof payload.stageIndex === 'number' && payload.stageIndex < seed.stageIndex)) {
      throw new Error('fork journal reopens its retained prefix')
    }
  }
  if (canonicalJson(state.budget) !== canonicalJson(budget)) throw new Error('fork usage differs from inherited and new recorded work')
}

export function stageForkOrigin(prepared: StageForkSeed): StageForkOrigin {
  return { source: prepared.sourceReference, ...prepared.boundary,
    ...(prepared.sourceFence === undefined ? {} : { sourceFence: prepared.sourceFence }),
    savedWorkDigest: prepared.savedWorkDigest }
}

/** The source version validated the export before admission. Startup reads its
 * selected bytes, never reconstructs historical source variants or ancestry. */
export async function resolveStageForkOrigin(state: Pick<RunState, 'forkOrigin' | 'journal'>,
  loadRelease?: ReleaseLoader, loadSource?: ExecutionSourceLoader): Promise<StageForkSeed | undefined> {
  const created = state.journal[0], payload = created?.payload as { forkOrigin?: StageForkOrigin; releaseDigest?: string } | undefined
  if (canonicalJson(payload?.forkOrigin) !== canonicalJson(state.forkOrigin)) throw new Error('fork origin differs from its journal')
  const origin = state.forkOrigin
  if (origin === undefined) return undefined
  if (created?.type !== 'run.created' || loadRelease === undefined || loadSource?.readSavedWork === undefined
    || typeof payload?.releaseDigest !== 'string') throw new Error('fork import requires its saved-work export and release')
  const exported = await loadSource.readSavedWork(origin.savedWorkDigest)
  if (await sha256(exported) !== origin.savedWorkDigest || exported.schemaVersion !== 2
    || canonicalJson(exported.sourceReference) !== canonicalJson(origin.source)
    || canonicalJson(exported.boundary) !== canonicalJson(forkBoundary(origin))
    || canonicalJson(exported.sourceFence) !== canonicalJson(origin.sourceFence)
    || exported.releaseDigest !== payload.releaseDigest) throw new Error('fork saved-work export differs')
  const release = await loadRelease(exported.releaseDigest)
  validateReleasePackage(release.body)
  if (release.digest !== exported.releaseDigest || await sha256(release.body) !== release.digest) throw new Error('fork release differs')
  const authority = (created.payload as Pick<RunState, 'executionAuthority'>).executionAuthority
  if (authority === undefined) throw new Error('fork import lacks its child authority')
  return bindStageForkSeed({ ...exported, release, savedWorkDigest: origin.savedWorkDigest }, authority, loadRelease)
}
