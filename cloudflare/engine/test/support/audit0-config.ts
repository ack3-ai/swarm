import document from '../fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { ExperimentDefinition, ResearchAssignment } from '../../src/contracts.js'
import { compileExperimentConfig } from './compile-config.js'

// The fixture has 16 discovery waves because every request carries its whole stage; no test
// gets past wave 12. Tests of the 64-wave maximum compile it with `maxDiscoveryWaves: 64`.
export const audit0PackageBody = compileExperimentConfig(document)
export const audit0Definition = audit0PackageBody.definition

export function expectedResearchAssignment(
  wave: number,
  researcher: number,
  definition: ExperimentDefinition = audit0Definition,
): Pick<ResearchAssignment, 'role' | 'buildsOn'> {
  const task = definition.stages
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
