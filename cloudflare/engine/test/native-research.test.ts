import { describe, expect, it } from 'vitest'
import { validateDismissalResearch } from '../src/native-research.js'
import type { AgentResult, ProtocolMetadata } from '../src/contracts.js'
import type { NativeSearchEvidence } from '../src/agent-execution-receipt.js'

const query = 'generic authorization guard preconditions'
const evidence: NativeSearchEvidence = { schemaVersion: 1, source: 'codex-exa',
  completed: [{ callId: 'call-1', queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64), queries: [query] }],
  failed: 0, incomplete: 0 }
const protocols = [
  { research: { leadChecks: [{ observationId: 'A1', conclusion: 'refuted' }] } },
  { synthesisDispositions: [{ id: 'A1', disposition: 'refuted' }] },
  { challengeObservations: [{ id: 'A1', disposition: 'refuted' }] },
  { reviewDecisions: [{ observationId: 'A1', finalDisposition: 'refuted', action: 'uphold' }] },
  { reviewDecisions: [{ observationId: 'A1', finalDisposition: 'candidate', action: 'narrow' }] },
  { verificationOutcomes: [{ reference: 'A1', exploitability: 'refuted' }] },
]
function result(protocol: unknown, proof?: NativeSearchEvidence): AgentResult {
  return { sessionId: 'original-session', protocol: protocol as ProtocolMetadata,
    ...(proof === undefined ? {} : { nativeSearchEvidence: proof }) } as AgentResult
}
function queried(protocol: unknown, queries = [query]): unknown {
  return JSON.parse(JSON.stringify(protocol), (key, value) =>
    Array.isArray(value) ? value.map(item => ({ ...item, researchQueries: queries })) : value)
}

describe('per-observation native research', () => {
  it.each(protocols)('requires a successful, cited query at each dismissal boundary: %j', protocol => {
    expect(validateDismissalResearch(result(protocol, evidence))).toHaveLength(2)
    expect(validateDismissalResearch(result(queried(protocol)))).toHaveLength(1)
    expect(validateDismissalResearch(result(queried(protocol), evidence))).toEqual([])
    expect(validateDismissalResearch(result(queried(protocol, ['unexecuted query']), evidence))).toHaveLength(2)
    expect(validateDismissalResearch(result(queried(protocol), { ...evidence, completed: [], failed: 1 }))).toHaveLength(1)
    expect(validateDismissalResearch(result(queried(protocol), { ...evidence, source: 'dsh-json' }))).toEqual([])
  })
  it('checks every dismissal even when another observation has completed research', () => {
    const protocol = { synthesisDispositions: [
      { id: 'A1', disposition: 'refuted', researchQueries: [query] },
      { id: 'A2', disposition: 'refuted' },
    ] }
    const issues = validateDismissalResearch(result(protocol, evidence))
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain('A2:')
  })
  it('distinguishes missing research or citation from unexecuted cited strings', () => {
    const missing = validateDismissalResearch(result(protocols[0], evidence))
    expect(missing[0]).toContain('missing native search citation in researchQueries')
    expect(missing[0]).not.toContain('no successful native search queries')
    const mismatched = ['unexecuted query "one"', 'unexecuted query two']
    const issues = validateDismissalResearch(result(queried(protocols[0], [query, ...mismatched]), evidence))
    expect(issues).toHaveLength(2)
    expect(issues[0]).toContain('native search citation mismatch')
    expect(issues[0]).toContain(JSON.stringify(mismatched))
    expect(issues[0]).not.toContain(JSON.stringify([query]))
    expect(issues[1]).toContain(JSON.stringify([query]))
  })
  it('reuses prior successful research only in the original session during output repair', () => {
    const output = result(queried(protocols[0]))
    expect(validateDismissalResearch(output, [{ sessionId: 'original-session', nativeSearchEvidence: evidence }])).toEqual([])
    expect(validateDismissalResearch(output, [{ sessionId: 'another-session', nativeSearchEvidence: evidence }])).toHaveLength(1)
  })
  it('does not turn an unresolved or retained observation into a mandatory search', () => {
    expect(validateDismissalResearch(result({ synthesisDispositions: [{ id: 'A1', disposition: 'unresolved' }],
      verificationOutcomes: [{ reference: 'A1', exploitability: 'unresolved' }] }))).toEqual([])
  })
  it('rejects malformed native evidence instead of treating an output claim as a receipt', () => {
    expect(validateDismissalResearch(result(queried(protocols[0]), { ...evidence,
      completed: [{ ...evidence.completed[0]!, resultDigest: 'fake' }] }))).toHaveLength(1)
  })
})

describe('stage-scoped search', () => {
  it.each(['research', 'challenge'])('requires native evidence for unresolved %s leads', kind => {
    const protocol = kind === 'research'
      ? { research: { leadChecks: [{ observationId: 'A1', conclusion: 'unresolved' }] } }
      : { challengeObservations: [{ id: 'A1', disposition: 'unresolved' }] }
    expect(validateDismissalResearch(result(protocol), [], 'leads')).toHaveLength(1)
    expect(validateDismissalResearch(result(queried(protocol), evidence), [], 'leads')).toEqual([])
    const failure = { ...evidence, completed: [], failed: 1 }
    expect(validateDismissalResearch(result(protocol, failure), [], 'leads')).toEqual([])
    expect(validateDismissalResearch(result(queried(protocol), failure), [], 'leads')).toHaveLength(1)
    expect(validateDismissalResearch(result(protocol, { ...failure, failed: 0, incomplete: 1 }), [], 'leads')).toHaveLength(1)
    expect(validateDismissalResearch(result(protocol), [{ sessionId: 'another-session', nativeSearchEvidence: failure }], 'leads')).toHaveLength(1)
    expect(validateDismissalResearch(result(protocol), [{ sessionId: 'original-session', nativeSearchEvidence: failure }], 'leads')).toEqual([])
  })

  it('does not let failed search justify a refutation or narrowing', () => {
    const failure = { ...evidence, completed: [], failed: 1 }
    expect(validateDismissalResearch(result(protocols[0], failure), [], 'leads')).toHaveLength(1)
    expect(validateDismissalResearch(result(protocols[4], failure), [], 'narrowing')).toHaveLength(1)
  })

  it('does not search again for unchanged reviews, but checks new narrowing', () => {
    expect(validateDismissalResearch(result(protocols[3]), [], 'narrowing')).toEqual([])
    expect(validateDismissalResearch(result(protocols[4]), [], 'narrowing')).toHaveLength(1)
    expect(validateDismissalResearch(result(queried(protocols[4]), evidence), [], 'narrowing')).toEqual([])
  })
})


it.each(['codex-exa', 'dsh-json', 'claude-json'] as const)('classifies %s repair from same-session receipts, not citation presence', source => {
  const proof = { ...evidence, source }
  for (const citations of [[], ['invented wording']]) {
    const output = result(queried(protocols[0], citations))
    for (const receipt of [undefined, { ...proof, completed: [], failed: 1 }, { ...proof, completed: [], incomplete: 1 }]) {
      const diagnostics = validateDismissalResearch({ ...output, ...(receipt === undefined ? {} : { nativeSearchEvidence: receipt }) })
      expect(diagnostics[0]).toContain('no successful native search queries recorded in this session')
      expect(diagnostics[0]).not.toContain('citation mismatch')
    }
    const withPrior = validateDismissalResearch(output, [{ sessionId: output.sessionId!, nativeSearchEvidence: proof }])
    expect(withPrior[0]).toContain(citations.length ? 'citation mismatch' : 'missing native search citation')
    expect(withPrior.join(' ')).not.toContain('no successful native search queries')
    expect(withPrior.at(-1)).toContain(JSON.stringify([query]))
    const foreign = validateDismissalResearch(output, [{ sessionId: 'foreign', nativeSearchEvidence: proof }])
    expect(foreign[0]).toContain('no successful native search queries recorded in this session')
  }
})
