import { describe, expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { validateDismissalResearch } from '../src/native-research.js'
import type { AgentResult } from '../src/contracts.js'
import { instruction, searchQuestion, submissionFile } from './support/instructions.js'

const definition = compileExperimentConfig({ ...manifest, forceSearch: true, nativeSearch: {} }).definition
const task = definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks[0]!
const question = searchQuestion(definition, 'web_search_exa')
const handoff = instruction(definition, 'handoffIntro', { SUBMISSION_FILE: submissionFile })
const input = { definition, task, visibleArtifacts: [], deadline: '2030-01-01T00:00:00Z' }
const missing = validateDismissalResearch({ sessionId: 'same-session',
  protocol: { research: { leadChecks: [{ observationId: 'A1', conclusion: 'unresolved' }] } },
} as unknown as AgentResult, [], 'leads')[0]!

describe('complete rendered search correction prompts', () => {
  it('gives original research one native question and a target-code uptake instruction', () => {
    const prompt = renderTaskPrompt(input)
    expect(prompt.split(question)).toHaveLength(2)
    expect(prompt).toContain(handoff)
  })

  it('shows researchQueries as a non-empty list, because an empty one is rejected', () => {
    const prompt = renderTaskPrompt(input)
    expect(prompt).toContain('"researchQueries":["..."]')
    expect(prompt).not.toContain('"researchQueries":[]')
  })

  it.each([
    [missing],
    ['leadChecks[0].researchQueries must contain at least one string'],
    ['observations[0].id must be a local identifier', missing],
  ].map(diagnostics => ({ diagnostics })))('permits targeted same-session investigation for search diagnostics mixed with schema errors: %j', ({ diagnostics }) => {
    const prompt = renderTaskPrompt({ ...input, formatRepairOnly: true, diagnostics })
    expect(prompt).toContain(instruction(definition, 'correctionSearchUpdate'))
    expect(prompt.split(question)).toHaveLength(2)
    for (const diagnostic of diagnostics) expect(prompt).toContain(diagnostic)
    expect(prompt).not.toContain(instruction(definition, 'correctionFormat'))
    expect(prompt).not.toContain(instruction(definition, 'searchQueries'))
    expect(prompt).not.toContain(handoff)
    expect(prompt).not.toContain(instruction(definition, 'leadReconciliation'))
  })

  it('keeps an ordinary schema repair output-only without another mandatory search', () => {
    const prompt = renderTaskPrompt({ ...input, formatRepairOnly: true,
      diagnostics: ['observations[0].id must be a local identifier'] })
    expect(prompt).toContain(instruction(definition, 'correctionFormat'))
    expect(prompt).not.toContain(instruction(definition, 'searchTriggerLeads'))
    expect(prompt).not.toContain(question)
    expect(prompt).not.toContain(instruction(definition, 'searchQueries'))
  })
})

it.each(['codex-exa', 'dsh-json'] as const)('offers exact successful same-session citations once in %s repair and accepts their reuse', source => {
  const query = 'generic callback invalidation semantics'
  const receipt = (queries: string[]) => ({ schemaVersion: 1 as const, source, completed: [{ callId: 'search-1', queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64), queries }], failed: 0, incomplete: 0 })
  const checks = ['A1', 'A2'].map(observationId => ({ observationId, conclusion: 'refuted', researchQueries: ['invented wording'] }))
  const result = { sessionId: 'same-session', protocol: { research: { leadChecks: checks } } } as unknown as AgentResult
  const prior = [{ sessionId: 'same-session', nativeSearchEvidence: receipt([query]) },
    { sessionId: 'other-session', nativeSearchEvidence: receipt(['unrelated private query']) }]
  const diagnostics = validateDismissalResearch(result, prior, 'leads')
  const selected = source === 'dsh-json' ? { ...task, providerClass: 'additive' as const } : task
  const prompt = renderTaskPrompt({ ...input, task: selected, formatRepairOnly: true, diagnostics })
  expect(prompt.split(query)).toHaveLength(2)
  expect(prompt).not.toContain('unrelated private query')
  const tool = source === 'dsh-json' ? 'mcp__exa__web_search_exa' : 'web_search_exa'
  expect(prompt).toContain(instruction(definition, 'correctionCitations', { SEARCH_QUESTION: searchQuestion(definition, tool) }))
  const corrected = { ...result, protocol: { research: { ...result.protocol.research!,
    leadChecks: checks.map(check => ({ ...check, researchQueries: [query] })) } } } as unknown as AgentResult
  expect(validateDismissalResearch(corrected, prior, 'leads')).toEqual([])
  const initial = renderTaskPrompt({ ...input, task: selected })
  expect(initial.split(searchQuestion(definition, tool))).toHaveLength(2)
})


it('keeps the verification evidence-method instruction exclusive to verifier initial and repair prompts', () => {
  const selected = compileExperimentConfig({ ...manifest, forceSearch: true, nativeSearch: {} }).definition
  const criterion = instruction(selected, 'verificationEvidenceMethod')
  for (const stage of selected.stages) for (const wave of stage.waves) for (const original of wave.tasks) {
    if (original.providerClass === 'deterministic' || (original.research !== undefined && original.research.buildsOn !== 'none')) continue
    for (const providerClass of ['core', 'additive'] as const) for (const formatRepairOnly of [false, true]) {
      const prompt = renderTaskPrompt({ ...input, definition: selected, task: { ...original, providerClass },
        formatRepairOnly, diagnostics: ['complete must be true'] })
      expect(prompt.split(criterion).length - 1).toBe(original.promptKind === 'verification' ? 1 : 0)
    }
  }
})

it.each(['core', 'additive'] as const)('distinguishes missing search from citation repair for %s', providerClass => {
  const output = { sessionId: 'same-session', protocol: { research: { leadChecks: [
    { observationId: 'A1', conclusion: 'refuted', researchQueries: ['unexecuted callback query'] },
  ] } } } as unknown as AgentResult
  const selected = { ...task, providerClass }
  const tool = providerClass === 'additive' ? 'mcp__exa__web_search_exa' : 'web_search_exa'
  const fragment = searchQuestion(definition, tool)
  const noSearch = renderTaskPrompt({ ...input, task: selected, formatRepairOnly: true,
    diagnostics: validateDismissalResearch(output, [], 'leads') })
  expect(noSearch).toContain(instruction(definition, 'correctionSearchMissing', { SEARCH_QUESTION: fragment }))
  expect(noSearch).not.toContain(instruction(definition, 'correctionCitations', { SEARCH_QUESTION: fragment }))
  expect(renderTaskPrompt({ ...input, task: selected })).toContain(fragment)
  for (const researchQueries of [[], ['unexecuted callback query']]) {
    const result = { ...output, protocol: { research: { leadChecks: [
      { observationId: 'A1', conclusion: 'refuted', researchQueries },
    ] } }, nativeSearchEvidence: { schemaVersion: 1, source: providerClass === 'additive' ? 'dsh-json' : 'codex-exa',
      completed: [{ callId: 'search-1', queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64), queries: ['actual query'] }],
      failed: 0, incomplete: 0 } } as unknown as AgentResult
    const diagnostics = validateDismissalResearch(result, [], 'leads')
    const repair = renderTaskPrompt({ ...input, task: selected, formatRepairOnly: true, diagnostics })
    expect(repair).toContain(instruction(definition, 'correctionCitations', { SEARCH_QUESTION: fragment }))
    expect(repair).not.toContain(instruction(definition, 'correctionSearchMissing', { SEARCH_QUESTION: fragment }))
    expect(repair).not.toContain(handoff)
  }
})
