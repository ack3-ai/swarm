import type { AgentResult, WaveDefinition } from './contracts.js'
import { researchObservationPrefix } from './research-scheduler.js'

/** Apply the single canonical discovery-ID transform to native results and custody comparisons. */
export function namespaceResearchResult(task: WaveDefinition['tasks'][number], result: AgentResult): AgentResult {
  const research = result.protocol.research
  const assignment = task.research
  if (result.status !== 'accepted' || research === undefined || assignment === undefined) return result
  const prefix = researchObservationPrefix(task, assignment)
  return {
    ...result,
    protocol: {
      ...result.protocol,
      research: {
        ...research,
        observations: research.observations.map(observation => ({ ...observation, id: `${prefix}${observation.id}` })),
        ...(research.leadChecks === undefined ? {} : {
          leadChecks: research.leadChecks.map(check => ({ ...check, observationId: `${prefix}${check.observationId}` })),
        }),
      },
    },
  }
}
