import document from '../fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { ResearchAssignment } from '../../src/contracts.js'
import { compileExperimentConfig } from './compile-config.js'

export const audit0PackageBody = compileExperimentConfig(document)
export const audit0Definition = audit0PackageBody.definition

export function expectedResearchAssignment(
  wave: number,
  researcher: number,
): Pick<ResearchAssignment, 'role' | 'buildsOn'> {
  const task = audit0Definition.stages
    .find(stage => stage.kind === 'discovery')
    ?.waves[wave]
    ?.tasks.find(candidate => candidate.providerClass === 'core' && candidate.research?.researcher === researcher)
  if (task?.research === undefined) throw new TypeError(`missing research assignment ${wave}/${researcher}`)
  return { role: task.research.role, buildsOn: task.research.buildsOn }
}

/** Synthetic research plan for three or more lanes: lane 1 is the anchor; every other lane builds on its previous wave. */
export function anchorResearchPlan(lanes: number) {
  if (lanes < 3) throw new RangeError('anchorResearchPlan needs at least three lanes')
  return {
    first: Array.from({ length: lanes }, (_, index) => ({ role: index === 0 ? 'anchor' : 'scout' })),
    cycle: [Array.from({ length: lanes }, (_, index) => index === 0
      ? { role: 'anchor' }
      : { role: 'satellite', buildsOn: 'previous-wave/research-1' })],
  }
}
