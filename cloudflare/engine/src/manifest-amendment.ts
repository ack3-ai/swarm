import type { DiscoverySchedulerState, ExperimentDefinition, RunState } from './contracts.js'
import { canonicalJson, deepClone } from './canonical.js'
import { RunCommandRejected } from './run-commands.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { renderTaskPrompt } from './prompts.js'

/** Only deterministic compatibility refusals settle a command as rejected.
 * Missing/corrupt release bytes and storage failures remain operational errors.
 */
export class ManifestAmendmentRejected extends RunCommandRejected {
  override name = 'ManifestAmendmentRejected'
  constructor(message: string) { super('manifest-incompatible', message) }
}

export function discoveryPoolIds(definition: ExperimentDefinition): readonly string[] {
  return [...new Set(definition.stages.filter(stage => stage.kind === 'discovery').flatMap(stage =>
    stage.waves.flatMap(wave => wave.tasks.filter(task => task.promptKind === 'research').map(configuredResearchTaskPoolId))))].sort()
}

/** Compare the compiled work, including lane rotation and the instructions actually rendered. */
export function discoveryPoolContract(definition: ExperimentDefinition, poolId: string): string {
  const stage = definition.stages.find(stage => stage.kind === 'discovery')
  return canonicalJson({ nativeSearch: definition.nativeSearch, researcherProtocol: definition.prompts.researcherProtocol, waves: stage?.waves.map(wave => ({ id: wave.id,
    tasks: wave.tasks.filter(task => configuredResearchTaskPoolId(task) === poolId).map(task => ({ task,
      // Dynamic peer evidence is frozen at admission; compare the static assignment
      // above and render instructions without inventing historical artifacts.
      prompt: renderTaskPrompt({ definition, task: { ...task, research: { ...task.research!, buildsOn: 'none' } },
        stageKind: 'discovery', visibleArtifacts: [], deadline: 'fixed' }),
    })),
  })) })
}

/** The first key path at which two JSON values differ, keys in code-unit order; null when equal. */
function firstDifference(left: unknown, right: unknown, path: string): string | null {
  if (canonicalJson(left) === canonicalJson(right)) return null
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const found = firstDifference(left[index], right[index], `${path}[${index}]`)
      if (found !== null) return found
    }
  } else if (object(left) && object(right) && !Array.isArray(left) && !Array.isArray(right)) {
    for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
      const found = firstDifference(left[key], right[key], path === '' ? key : `${path}.${key}`)
      if (found !== null) return found
    }
  }
  return path
}

/** One retained-prefix contract for complete stages and an open stage's sealed
 * waves. Only work after that frontier can adopt the replacement manifest.
 * Each refusal names the part that differs (E16). */
export function assertAmendmentFrontier(previous: ExperimentDefinition, next: ExperimentDefinition,
  cursor: RunState['cursor']): void {
  const topology = (definition: ExperimentDefinition) => definition.stages.map(stage => ({ id: stage.id, kind: stage.kind,
    waves: stage.kind === 'discovery' ? undefined : stage.waves.map(wave => wave.id),
  }))
  if (previous.id !== next.id) {
    throw new ManifestAmendmentRejected(`manifest amendment changes the experiment id (${previous.id} → ${next.id})`)
  }
  const target = firstDifference(previous.target, next.target, 'target')
  if (target !== null) {
    throw new ManifestAmendmentRejected(`manifest amendment changes the audit target at ${target}; a fork keeps the original target`)
  }
  const [stagesBefore, stagesAfter] = [topology(previous), topology(next)]
  if (canonicalJson(stagesBefore) !== canonicalJson(stagesAfter)) {
    const names = (stages: typeof stagesBefore) => stages.map(stage =>
      stage.id === stage.kind ? stage.id : `${stage.id} (${stage.kind})`).join(', ')
    const waves = stagesBefore.length === stagesAfter.length && stagesBefore.every((stage, index) =>
      stage.id === stagesAfter[index]!.id && stage.kind === stagesAfter[index]!.kind)
      ? stagesBefore.find((stage, index) => canonicalJson(stage.waves) !== canonicalJson(stagesAfter[index]!.waves)) : undefined
    throw new ManifestAmendmentRejected(waves === undefined
      ? `manifest amendment changes the stage list (${names(stagesBefore)} → ${names(stagesAfter)})`
      : `manifest amendment changes the waves of stage ${waves.id}`)
  }
  const render = (definition: ExperimentDefinition, task: ExperimentDefinition['stages'][number]['waves'][number]['tasks'][number],
    stageKind: ExperimentDefinition['stages'][number]['kind']) =>
    renderTaskPrompt({ definition, task, stageKind, visibleArtifacts: [], deadline: 'fixed' })
  for (const [index, before] of previous.stages.entries()) {
    if (index > cursor.stageIndex) break
    const after = next.stages[index]!, complete = index < cursor.stageIndex
    const reject = (part: string, detail: string) => { throw new ManifestAmendmentRejected(
      `manifest amendment changes a sealed ${part} (${detail}); invalidate its consumers first`) }
    if (before.kind === 'discovery') {
      if (!complete) continue
      const pools = discoveryPoolIds(previous).filter(poolId =>
        discoveryPoolContract(previous, poolId) !== discoveryPoolContract(next, poolId))
      if (pools.length > 0) {
        reject(`stage: ${before.id}, pool${pools.length === 1 ? '' : 's'} ${pools.join(', ')}`,
          'its tasks or rendered instructions differ')
      }
    }
    const stageDifference = complete ? firstDifference(before, after, '') : null
    if (stageDifference !== null) reject(`stage: ${before.id}`, `first difference: ${stageDifference}`)
    if (before.kind === 'discovery') continue
    for (const wave of complete ? before.waves : before.waves.slice(0, cursor.waveIndex)) {
      const replacement = after.waves.find(value => value.id === wave.id)!
      const part = complete ? `stage: ${before.id}` : `wave: ${wave.id} of stage ${before.id}`
      const waveDifference = firstDifference(wave, replacement, '')
      if (waveDifference !== null) reject(part, `first difference: ${waveDifference}`)
      const rendered = wave.tasks.find(task => render(previous, task, before.kind)
        !== render(next, replacement.tasks.find(value => value.id === task.id)!, after.kind))
      if (rendered !== undefined) reject(part, `task ${rendered.id} renders different instructions`)
    }
  }
}

export function amendDiscoveryProgress(previous: ExperimentDefinition, next: ExperimentDefinition,
  scheduler: DiscoverySchedulerState): DiscoverySchedulerState {
  const result = deepClone(scheduler)
  for (const poolId of discoveryPoolIds(next)) {
    let progress = result.pools.find(pool => pool.poolId === poolId)
    if (progress === undefined) {
      progress = { poolId, nextWaveIndex: 0, quietCohorts: 0, quietEpoch: result.materialEpoch, parked: false }
      result.pools = [...result.pools, progress]
    }
    if (discoveryPoolContract(previous, poolId) !== discoveryPoolContract(next, poolId)) {
      progress.quietCohorts = 0; progress.quietEpoch = result.materialEpoch
    }
  }
  // Policy changes can unpark work, but never erase its local frontier or receipts.
  result.pools = result.pools.map(pool => ({ ...pool, parked: next.stopOnSaturation !== false && pool.quietCohorts >= 2 }))
  return result
}
