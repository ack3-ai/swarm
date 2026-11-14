import { expect, it } from 'vitest'
import type { AgentRequest, AgentResult, ResearchLeadCheck } from '../src/contracts.js'
import { validateAgentResultDetailed, validateExecutionResult } from '../src/protocol-validation.js'
import { canonicalJson } from '../src/canonical.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }

const definition = compileExperimentConfig({ ...document, forceSearch: true, nativeSearch: {} }).definition
const stage = definition.stages.find(value => value.kind === 'discovery')!
const wave = stage.waves[0]!
const task = wave.tasks.find(value => value.providerClass === 'core')!
const query = 'generic guard preconditions'
const proof = { schemaVersion: 1 as const, source: 'codex-exa' as const,
  completed: [{ callId: 'search-1', queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64), queries: [query] }],
  failed: 0, incomplete: 0 }

async function fixture() {
  const request: AgentRequest = { experimentId: definition.id, runId: 'validation-source', stage, wave, task,
    prompt: 'synthetic request', promptDigest: 'c'.repeat(64), visibleArtifacts: [], releaseDigest: 'd'.repeat(64),
    attempt: 1, diagnostics: [], repairFiles: {}, freshContext: true, continuationMode: 'new', sessionId: null }
  const raw = await new DeterministicAuditProvider().run(request)
  const leadChecks: ResearchLeadCheck[] = [{ observationId: 'A1', claimConditions: ['The target condition holds.'],
    examinedConditions: ['The target condition holds.'], remainingUntestedConditions: [], evidenceMethod: 'source-inspection',
    conclusion: 'refuted', evidence: 'The guard excludes the stated condition.', researchQueries: [query] }]
  const result: AgentResult = { ...raw,
    files: { ...raw.files, '.swarm/submission.json': JSON.stringify({ ...JSON.parse(raw.files['.swarm/submission.json']!), leadChecks }) },
    protocol: { ...raw.protocol, research: { ...raw.protocol.research!, leadChecks } } }
  return { request, result }
}

it('applies native evidence policy in addition to structured-output validation without changing the result or usage', async () => {
  const { request, result } = await fixture()
  expect((await validateAgentResultDetailed(task, result, [])).issues).toEqual([])
  const original = canonicalJson({ request, result })
  const missing = await validateExecutionResult(definition, request, result)
  expect(missing.issues.some(issue => issue.includes('missing native search evidence'))).toBe(true)
  expect(missing.repairable).toEqual(missing.issues)
  expect(missing.integrity).toEqual([])
  const accepted = await validateExecutionResult(definition, request, { ...result, nativeSearchEvidence: proof })
  expect(accepted.issues).toEqual([])
  expect(accepted.returnedSessionId).toBe(result.sessionId)
  expect(canonicalJson({ request, result })).toBe(original)
})

it('reuses only same-session prior search receipts and follows the original stage policy', async () => {
  const { request, result } = await fixture()
  const prior = [{ sessionId: result.sessionId!, nativeSearchEvidence: proof }]
  expect((await validateExecutionResult(definition, request, result, prior)).issues).toEqual([])
  expect((await validateExecutionResult(definition, request, result,
    [{ ...prior[0]!, sessionId: 'unrelated-session' }])).issues).not.toEqual([])
  expect((await validateExecutionResult({ ...definition, forceSearchStages: ['negative-review'] }, request, result)).issues).toEqual([])
  expect((await validateExecutionResult(definition, request, { ...result, sessionId: 'replacement' }, prior)).issues).not.toEqual([])
})

it.each(['core', 'additive'] as const)('rejects a changed %s output-correction session even with valid search and output', async providerClass => {
  const { request, result } = await fixture()
  const repaired = { ...request, task: { ...task, providerClass }, formatRepairOrdinal: 1,
    continuationMode: 'resume' as const, freshContext: false, sessionId: 'original-session' }
  const returned = { ...result, sessionId: 'different-session', nativeSearchEvidence: proof }
  const checked = await validateExecutionResult(definition, repaired, returned)
  expect(checked.changedRepairSession).toBe(true)
  expect(checked.issues).toContain('output correction returned a different session')
  expect(checked.issues.includes('same-session repair returned a different native session')).toBe(providerClass === 'core')
  const same = await validateExecutionResult(definition, repaired, { ...returned, sessionId: repaired.sessionId })
  expect(same.issues).toEqual([])
  expect(same.changedRepairSession).toBe(false)
})

it('preserves core resume continuity outside format repair and uses actor identity when no session field exists', async () => {
  const { request, result } = await fixture()
  const resumed = { ...request, continuationMode: 'resume' as const, sessionId: result.actorId, freshContext: false }
  const { sessionId: _session, ...withoutSession } = result
  expect((await validateExecutionResult(definition, resumed, { ...withoutSession, nativeSearchEvidence: proof })).issues).toEqual([])
  const changed = await validateExecutionResult(definition, resumed, { ...withoutSession, actorId: 'another-actor', nativeSearchEvidence: proof })
  expect(changed.issues).toContain('same-session repair returned a different native session')
  expect(changed.changedRepairSession).toBe(false)
})

it('does not let native evidence bypass invalid output or provider identity', async () => {
  const { request, result } = await fixture()
  const invalid = await validateExecutionResult(definition, request, { ...result, nativeSearchEvidence: proof,
    model: 'other-model', files: {} })
  expect(invalid.integrity).toContain(`served model other-model differs from ${task.model}`)
  expect(invalid.repairable.some(issue => issue.startsWith('missing required output file'))).toBe(true)
})
