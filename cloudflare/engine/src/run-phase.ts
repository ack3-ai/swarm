import type { ExperimentDefinition, RunPhase } from './contracts.js'

export function phaseForStage(stage: ExperimentDefinition['stages'][number] | undefined): RunPhase {
  if (stage === undefined) return 'complete'
  if (stage.kind === 'preflight') return 'preparation'
  if (stage.kind === 'synthesis') return 'synthesis'
  if (stage.kind === 'coverage') return 'coverage'
  return stage.kind
}
