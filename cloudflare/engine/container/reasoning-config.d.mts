import type { ModelConnection, ReasoningEffort, SubagentPolicy, ThinkingMode } from '../src/contracts.js'

interface ReasoningInput {
  reasoningEffort: ReasoningEffort
  thinking?: ThinkingMode
}

export function validateCoreReasoning(input: ReasoningInput): { reasoningEffort: ReasoningEffort }
export function dshReasoningConfig(input: ReasoningInput): {
  thinking: ThinkingMode
  reasoningEffort: 'off' | 'low' | 'high' | 'max'
}
export function renderDshReasoningPatch(input: ReasoningInput & {
  provider?: string
  model: string
  connection?: ModelConnection
  subagents?: SubagentPolicy
  searchAttribution?: { agent: string, stage: string, wave: string, task: string }
}): string
