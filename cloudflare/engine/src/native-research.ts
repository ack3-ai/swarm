import { validNativeSearchEvidence } from './agent-execution-receipt.js'
import type { AgentResult, ExperimentDefinition, RejectedAttempt, StageKind, TaskDefinition } from './contracts.js'

export const DEFAULT_FORCE_SEARCH_STAGES: readonly StageKind[] = ['discovery', 'coverage', 'negative-review']
type SearchRequirement = 'leads' | 'narrowing' | 'dismissals'

/** Shared by the rendered instruction and the submission gate. */
export function mandatorySearchRequirement(
  definition: ExperimentDefinition, task: TaskDefinition, stageKind?: StageKind,
): SearchRequirement | undefined {
  if (definition.forceSearch?.enabled !== true || task.providerClass === 'deterministic') return undefined
  // Preserve the contract of already-sealed releases, without changing their digests.
  if (definition.forceSearchStages === undefined) return 'dismissals'
  const stage = stageKind ?? definition.stages.find(s => s.waves.some(w => w.tasks.some(t => t.id === task.id)))?.kind
  if (stage === undefined || !definition.forceSearchStages.includes(stage)) return undefined
  switch (task.promptKind) {
    case 'research':
    case 'coverage-challenge': return 'leads'
    case 'negative-review': return 'narrowing'
    case 'verification': return 'dismissals'
    default: return undefined
  }
}

/** Validate each required record against native tool results, never agent prose. */
export function validateDismissalResearch(
  result: AgentResult,
  prior: readonly Pick<RejectedAttempt, 'sessionId' | 'nativeSearchEvidence'>[] = [],
  requirement: SearchRequirement = 'dismissals',
): string[] {
  const p = result.protocol
  const records = requirement === 'leads' ? [
    ...(p.research?.leadChecks ?? []).map(x => ({ id: x.observationId, unresolved: x.conclusion === 'unresolved', ...x })),
    ...(p.challengeObservations ?? []).filter(x => x.disposition !== 'candidate')
      .map(x => ({ unresolved: x.disposition === 'unresolved', ...x })),
  ] : requirement === 'narrowing'
    ? (p.reviewDecisions ?? []).filter(x => x.action === 'narrow')
      .map(x => ({ id: x.observationId, unresolved: false, ...x }))
    : [
      ...(p.research?.leadChecks ?? []).filter(x => x.conclusion === 'refuted').map(x => ({ id: x.observationId, ...x })),
      ...(p.synthesisDispositions ?? []).filter(x => x.disposition === 'refuted'),
      ...(p.challengeObservations ?? []).filter(x => x.disposition === 'refuted'),
      ...(p.reviewDecisions ?? []).filter(x => x.finalDisposition === 'refuted' || x.action === 'narrow')
        .map(x => ({ id: x.observationId, ...x })),
      ...(p.verificationOutcomes ?? []).filter(x => x.exploitability === 'refuted').map(x => ({ id: x.reference, ...x })),
    ].map(x => ({ unresolved: false, ...x }))
  const session = result.sessionId ?? result.actorId
  const evidence = [result.nativeSearchEvidence, ...prior.filter(x => session !== undefined && x.sessionId === session).map(x => x.nativeSearchEvidence)]
    .filter(e => e !== undefined && validNativeSearchEvidence(e) && ['codex-exa', 'dsh-json', 'claude-json'].includes(e.source))
  const queries = new Set(evidence.flatMap(e => e!.completed.flatMap(c => (c.queries ?? []).map(q => q.trim()))))
  // Failure receipts are session-scoped; they permit retaining uncertainty, never a negative decision.
  const searchFailed = evidence.some(e => e!.failed > 0)
  const issues = records.flatMap(item => {
    if (item.unresolved && searchFailed && !item.researchQueries?.length) return []
    if (item.researchQueries?.length && item.researchQueries.every(q => queries.has(q.trim()))) return []
    if (queries.size === 0) {
      return [`${item.id}: missing native search evidence: no successful native search queries recorded in this session. A failed search may leave a lead unresolved, but cannot justify dismissal or narrowing.`]
    }
    if (item.researchQueries?.length) {
      const unmatched = item.researchQueries.filter(q => !queries.has(q.trim()))
      return [`${item.id}: native search citation mismatch; these researchQueries were not recorded as successful in this session: ${JSON.stringify(unmatched)}.`]
    }
    return [`${item.id}: missing native search citation in researchQueries; successful queries are recorded in this session, but their relevance to this observation's mechanism and condition must be checked.`]
  })
  if (issues.length > 0 && queries.size > 0) {
    issues.push(`Successful native search queries from this same session (reuse relevant citations exactly): ${JSON.stringify([...queries])}`)
  }
  return issues
}
