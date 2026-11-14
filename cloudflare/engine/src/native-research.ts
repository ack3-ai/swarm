import { validNativeSearchEvidence } from './agent-execution-receipt.js'
import type { AgentResult, ExperimentDefinition, ProtocolMetadata, RejectedAttempt, StageKind, TaskDefinition } from './contracts.js'

export const DEFAULT_FORCE_SEARCH_STAGES: readonly StageKind[] = ['discovery', 'coverage', 'negative-review']
export type SearchRequirement = 'leads' | 'narrowing' | 'dismissals' | 'recon'
export const SEARCH_REQUIREMENTS: readonly SearchRequirement[] = ['leads', 'narrowing', 'dismissals', 'recon']

/** Shared by the rendered instruction and the submission gate. */
export function mandatorySearchRequirement(
  definition: ExperimentDefinition, task: TaskDefinition, stageKind?: StageKind,
): SearchRequirement | undefined {
  // Recon always needs one successful search, whatever forceSearch says.
  if (task.promptKind === 'recon' && task.providerClass !== 'deterministic') return 'recon'
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

/** Citations and recorded queries are compared in this form, so a retyped citation with other quotes,
 * spacing, case or closing mark still matches; the stored evidence stays exact. Quote marks are removed
 * wherever they are, since agents often drop the quotes around part of a query. */
export function normalizedSearchQuery(query: string): string {
  return query.normalize('NFKC').replace(/["'`\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.?!]$/, '').trim()
}

/** Validate each required record against native tool results, never agent prose. */
export function validateDismissalResearch(
  result: AgentResult,
  prior: readonly Pick<RejectedAttempt, 'sessionId' | 'nativeSearchEvidence'>[] = [],
  requirement: SearchRequirement = 'dismissals',
): string[] {
  const session = result.sessionId ?? result.actorId
  const evidence = [result.nativeSearchEvidence, ...prior.filter(x => session !== undefined && x.sessionId === session).map(x => x.nativeSearchEvidence)]
    .filter(e => e !== undefined && validNativeSearchEvidence(e) && ['codex-exa', 'dsh-json', 'claude-json'].includes(e.source))
  // Failure receipts are session-scoped; they permit retaining uncertainty, never a negative decision.
  return searchCitationIssues(result.protocol, evidence.flatMap(e => e!.completed.flatMap(c => c.queries ?? [])),
    evidence.some(e => e!.failed > 0), requirement)
}

/**
 * The per-record check behind validateDismissalResearch, given the session's successful queries and
 * whether a search failed. `ack3-submit` runs it on the queries the root runner recorded in the session.
 */
export function searchCitationIssues(
  protocol: ProtocolMetadata,
  successfulQueries: readonly string[],
  searchFailed: boolean,
  requirement: SearchRequirement = 'dismissals',
): string[] {
  const p = protocol
  const records = requirement === 'recon' ? [{ id: 'recon', unresolved: false, researchQueries: p.recon?.researchQueries }]
    : requirement === 'leads' ? [
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
  const queries = new Set(successfulQueries.map(q => q.trim()))
  const recorded = new Set([...queries].map(normalizedSearchQuery))
  const cited = (query: string) => { const key = normalizedSearchQuery(query); return key !== '' && recorded.has(key) }
  const issues = records.flatMap(item => {
    if (item.unresolved && searchFailed && !item.researchQueries?.length) return []
    if (item.researchQueries?.length && item.researchQueries.every(cited)) return []
    if (queries.size === 0) {
      return [`${item.id}: missing native search evidence: no successful native search queries recorded in this session. A failed search may leave a lead unresolved, but cannot justify dismissal or narrowing.`]
    }
    if (item.researchQueries?.length) {
      const unmatched = item.researchQueries.filter(q => !cited(q))
      return [`${item.id}: native search citation mismatch; these researchQueries were not recorded as successful in this session: ${JSON.stringify(unmatched)}.`]
    }
    return [`${item.id}: missing native search citation in researchQueries; successful queries are recorded in this session, but their relevance to this observation's mechanism and condition must be checked.`]
  })
  if (issues.length > 0 && queries.size > 0) {
    issues.push(`Successful native search queries from this same session (reuse relevant citations exactly): ${JSON.stringify([...queries])}`)
  }
  return issues
}
