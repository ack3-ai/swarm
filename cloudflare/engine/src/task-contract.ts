import { canonicalJson } from './canonical.js'
import type { ArtifactRecord, ExperimentDefinition, TaskDefinition } from './contracts.js'
import { renderTaskPrompt } from './prompts.js'

export function compiledTaskContract(definition: ExperimentDefinition, stageId: string, task: TaskDefinition, visibleArtifacts: readonly ArtifactRecord[] = []): string {
  const stage = definition.stages.find(value => value.id === stageId)
  if (stage === undefined) throw new Error('task stage is missing')
  const input = { definition, task, stageKind: stage.kind, visibleArtifacts, deadline: 'fixed' }
  return canonicalJson({ task, nativeSearch: definition.nativeSearch,
    ...(task.promptKind === 'research' ? { researcherProtocol: definition.prompts.researcherProtocol } : {}),
    prompts: [renderTaskPrompt(input), renderTaskPrompt({ ...input, diagnostics: ['contract-check'] }),
      ...[['contract-check'], ['researchQueries missing'],
        ['researchQueries missing', 'no successful native search queries recorded in this session']].map(diagnostics =>
        renderTaskPrompt({ ...input, diagnostics, formatRepairOnly: true }))] })
}
