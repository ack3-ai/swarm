import type { ExperimentDefinition, PromptCatalog } from '../../src/contracts.js'

/** A sealed agent instruction with its {{NAME}} placeholders filled, for asserting placement. */
export function instruction(definition: Pick<ExperimentDefinition, 'prompts'>, key: keyof PromptCatalog,
  values: Readonly<Record<string, string>> = {}): string {
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{{${name}}}`).join(value),
    definition.prompts[key])
}

/** The sealed search question for one native search tool. */
export function searchQuestion(definition: Pick<ExperimentDefinition, 'prompts'>, tool: string): string {
  return instruction(definition, 'searchQuestion', { TOOL: tool })
}

export const submissionFile = '/workspace/results/.swarm/submission.json'
