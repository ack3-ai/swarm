import MarkdownIt from 'markdown-it'
import { SUBMISSION_MAX_BYTES } from './output-limits.js'
import type {
  ArtifactRecord,
  ChallengeObservation,
  DispositionRecord,
  ObservationRecord,
  ProtocolMetadata,
  ResearchLeadCheck,
  ReportSectionLink,
  ReviewDecision,
  TaskDefinition,
  VerificationOutcome,
} from './contracts.js'
import { createNegativeReviewInput, verificationAssignments, verificationReferences } from './protocol-transforms.js'
import { researchObservationPrefix } from './research-scheduler.js'

const markdown = new MarkdownIt({ html: false, linkify: false })

export const SUBMISSION_PATH = '.swarm/submission.json'

const modelSubmissionKinds = new Set<TaskDefinition['promptKind']>([
  'research',
  'synthesis',
  'coverage-challenge',
  'negative-review',
  'verification',
  'reporting',
])

export function requiresSubmission(task: Pick<TaskDefinition, 'providerClass' | 'promptKind'>): boolean {
  return task.providerClass !== 'deterministic' && modelSubmissionKinds.has(task.promptKind)
}

export interface SubmissionRead {
  protocol: ProtocolMetadata
  issues: readonly string[]
}

function record(value: unknown, label: string, keys: readonly string[], issues: string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${label} must be an object`)
    return null
  }
  const actual = Object.keys(value).toSorted()
  const expected = [...keys, ...(Object.prototype.hasOwnProperty.call(value, 'researchQueries')
    && keys.some(k => ['conclusion', 'disposition', 'finalDisposition', 'exploitability'].includes(k))
    ? ['researchQueries'] : [])].toSorted()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const missing = expected.filter(key => !actual.includes(key))
    const unexpected = actual.filter(key => !expected.includes(key))
    issues.push(`${label} must contain exactly: ${expected.join(', ')}`
      + (missing.length === 0 ? '' : `; missing: ${missing.join(', ')}`)
      + (unexpected.length === 0 ? '' : `; unexpected: ${unexpected.join(', ')}`))
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, issues: string[], minimum = 1): string {
  if (typeof value !== 'string' || value.trim().length < minimum) {
    issues.push(`${label} must be a non-empty string`)
    return ''
  }
  return value.trim()
}

function strings(value: unknown, label: string, issues: string[], allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    issues.push(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array of non-empty strings`)
    return []
  }
  return value.map(item => (item as string).trim())
}

function array(value: unknown, label: string, issues: string[], maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    issues.push(`${label} must be an array with at most ${maximum} entries`)
    return []
  }
  return value
}

function enumeration<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
  issues: string[],
): Values[number] | null {
  if (typeof value !== 'string' || !values.includes(value)) {
    issues.push(`${label} must be one of: ${values.join(', ')}`)
    return null
  }
  return value as Values[number]
}

function exactSet(actual: readonly string[], expected: readonly string[], label: string, issues: string[]): void {
  const seen = new Set<string>()
  for (const value of actual) {
    if (seen.has(value)) issues.push(`${label} repeats ${value}`)
    seen.add(value)
  }
  const expectedSet = new Set(expected)
  for (const value of expected) if (!seen.has(value)) issues.push(`${label} omits ${value}`)
  for (const value of seen) if (!expectedSet.has(value)) issues.push(`${label} adds unexpected ${value}`)
}

function researchQueries(item: Record<string, unknown>, label: string, issues: string[]) {
  // An empty list cites no searches, the same as leaving the field out; records
  // that must cite searches are checked against the session's native search evidence.
  const omitted = item.researchQueries === undefined
    || (Array.isArray(item.researchQueries) && item.researchQueries.length === 0)
  return omitted ? {} : {
    researchQueries: strings(item.researchQueries, `${label}.researchQueries`, issues, false),
  }
}

function disposition(value: unknown, label: string, issues: string[]): DispositionRecord | null {
  const item = record(value, label, ['id', 'disposition', 'reference', 'rationale'], issues)
  if (item === null) return null
  const id = string(item.id, `${label}.id`, issues)
  const classification = enumeration(
    item.disposition,
    ['candidate', 'refuted', 'unresolved'] as const,
    `${label}.disposition`,
    issues,
  )
  const canonicalRefutationReference = classification === 'refuted'
    && (item.reference === null || typeof item.reference === 'string')
  const reference = canonicalRefutationReference ? 'none' : string(item.reference, `${label}.reference`, issues)
  const rationale = string(item.rationale, `${label}.rationale`, issues, 8)
  if (classification === 'refuted' && reference !== 'none') issues.push(`${id} refutation must use none`)
  if (classification !== null && classification !== 'refuted' && reference === 'none') {
    issues.push(`${id} non-refuted disposition requires a reference`)
  }
  if (id === '' || reference === '' || rationale === '' || classification === null) return null
  return { id, disposition: classification, reference, rationale, ...researchQueries(item, label, issues) }
}

function observations(value: unknown, issues: string[], prefix: string): ObservationRecord[] {
  const values = array(value, 'submission.observations', issues, 64)
  if (values.length === 0) issues.push('submission.observations must not be empty')
  const result: ObservationRecord[] = []
  const ids: string[] = []
  values.forEach((value, index) => {
    const label = `submission.observations[${index}]`
    const item = record(value, label, ['id', 'statement', 'conditions', 'consequence', 'evidence'], issues)
    if (item === null) return
    const rawId = string(item.id, `${label}.id`, issues).toUpperCase()
    const id = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId
    const statement = string(item.statement, `${label}.statement`, issues)
    const conditions = strings(item.conditions, `${label}.conditions`, issues)
    const consequence = string(item.consequence, `${label}.consequence`, issues)
    const evidence = strings(item.evidence, `${label}.evidence`, issues, false)
    if (!/^(?!S)[A-Z][1-9]\d*$/.test(id)) issues.push(`${label}.id must be a local identifier such as A1`)
    ids.push(id)
    if (id !== '' && statement !== '' && consequence !== '' && evidence.length > 0) {
      result.push({ id, statement, conditions, consequence, evidence })
    }
  })
  exactSet(ids, [...new Set(ids)], 'submission observation IDs', issues)
  return result
}

function leadChecks(value: unknown, observations: readonly ObservationRecord[], issues: string[], prefix: string): ResearchLeadCheck[] {
  const values = array(value, 'submission.leadChecks', issues, 64)
  const result: ResearchLeadCheck[] = []
  const ids: string[] = []
  const observationIds = new Set(observations.map(observation => observation.id))
  values.forEach((raw, index) => {
    const label = `submission.leadChecks[${index}]`
    const item = record(raw, label, [
      'observationId', 'claimConditions', 'examinedConditions', 'remainingUntestedConditions',
      'evidenceMethod', 'conclusion', 'evidence',
    ], issues)
    if (item === null) return
    const rawId = string(item.observationId, `${label}.observationId`, issues).toUpperCase()
    const observationId = rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId
    const claimConditions = strings(item.claimConditions, `${label}.claimConditions`, issues, false)
    const examinedConditions = strings(item.examinedConditions, `${label}.examinedConditions`, issues)
    const remainingUntestedConditions = strings(item.remainingUntestedConditions, `${label}.remainingUntestedConditions`, issues)
    const evidenceMethod = enumeration(item.evidenceMethod,
      ['fresh-execution', 'prior-execution-reviewed', 'source-inspection', 'not-attempted'] as const,
      `${label}.evidenceMethod`, issues)
    const conclusion = enumeration(item.conclusion, ['refuted', 'unresolved'] as const,
      `${label}.conclusion`, issues)
    const evidence = string(item.evidence, `${label}.evidence`, issues, 8)
    ids.push(observationId)
    if (!observationIds.has(observationId)) issues.push(`${label}.observationId must identify a submitted observation`)
    if (conclusion === 'refuted' && remainingUntestedConditions.length > 0) {
      issues.push(`${label} cannot refute a claim with declared untested conditions`)
    }
    if (conclusion === 'refuted' && evidenceMethod === 'not-attempted') {
      issues.push(`${label} cannot refute a claim that was not examined`)
    }
    if (evidenceMethod === 'not-attempted' && examinedConditions.length > 0) {
      issues.push(`${label} cannot claim examined conditions when not attempted`)
    }
    if (observationId !== '' && evidenceMethod !== null && conclusion !== null && evidence !== '') {
      result.push({ observationId, claimConditions, examinedConditions,
        remainingUntestedConditions, evidenceMethod, conclusion, evidence, ...researchQueries(item, label, issues) })
    }
  })
  exactSet(ids, [...new Set(ids)], 'submission lead check IDs', issues)
  return result
}

function parseEnvelope(content: string | undefined, issues: string[]): Record<string, unknown> | null {
  if (content === undefined || content.trim() === '') {
    issues.push(`missing required output file: ${SUBMISSION_PATH}`)
    return null
  }
  if (new TextEncoder().encode(content).byteLength > SUBMISSION_MAX_BYTES) {
    issues.push('structured submission is too large')
    return null
  }
  try {
    const parsed = JSON.parse(content) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('not an object')
    return parsed as Record<string, unknown>
  } catch {
    issues.push('structured submission is not valid JSON object data')
    return null
  }
}

function completed(
  envelope: Record<string, unknown>,
  keys: readonly string[],
  issues: string[],
): Record<string, unknown> | null {
  const value = record(envelope, 'submission', ['complete', ...keys], issues)
  if (value?.complete !== true) issues.push('submission.complete must be true')
  return value
}

export async function readSubmission(
  task: TaskDefinition,
  files: Readonly<Record<string, string>>,
  visibleArtifacts: readonly ArtifactRecord[],
): Promise<SubmissionRead> {
  if (!requiresSubmission(task)) return { protocol: {}, issues: [] }
  const issues: string[] = []
  const envelope = parseEnvelope(files[SUBMISSION_PATH], issues)
  if (envelope === null) return { protocol: {}, issues }

  if (task.promptKind === 'research') {
    const checksLeads = task.output.schema === 'ack3.research-delta.policy-v3'
    const hasNextExperiment = Object.prototype.hasOwnProperty.call(envelope, 'nextExperiment')
    const value = completed(envelope, [
      'materialHighCriticalDelta', 'observations', ...(checksLeads ? ['leadChecks'] : []),
      ...(hasNextExperiment ? ['nextExperiment'] : []),
    ], issues)
    const assignment = task.research
    if (value === null || assignment === undefined) return { protocol: {}, issues: [...issues, 'research assignment is missing'] }
    if (hasNextExperiment && typeof value.nextExperiment !== 'string') {
      issues.push('submission.nextExperiment must be a string when present')
    }
    const nextExperiment = typeof value.nextExperiment === 'string'
      ? value.nextExperiment.trim() : ''
    if (typeof value.materialHighCriticalDelta !== 'boolean') {
      issues.push('submission.materialHighCriticalDelta must be boolean')
    }
    const parsed = observations(value.observations, issues, researchObservationPrefix(task, assignment))
    const parsedLeadChecks = checksLeads
      ? leadChecks(value.leadChecks, parsed, issues, researchObservationPrefix(task, assignment)) : undefined
    return {
      protocol: typeof value.materialHighCriticalDelta !== 'boolean' ? {} : {
        research: {
          role: assignment.role,
          buildsOn: assignment.buildsOn,
          ...(nextExperiment === '' ? {} : { nextExperiment }),
          materialHighCriticalDelta: value.materialHighCriticalDelta,
          observations: parsed,
          ...(parsedLeadChecks === undefined ? {} : { leadChecks: parsedLeadChecks }),
        },
      },
      issues,
    }
  }

  if (task.promptKind === 'synthesis') {
    const value = completed(envelope, ['dispositions', 'retainedReferences'], issues)
    const expected = visibleArtifacts.flatMap(artifact => artifact.protocol.research?.observations.map(item => item.id) ?? [])
    const values = array(value?.dispositions, 'submission.dispositions', issues, expected.length)
    const dispositions = values.map((item, index) => disposition(item, `submission.dispositions[${index}]`, issues))
      .filter((item): item is DispositionRecord => item !== null)
    exactSet(dispositions.map(item => item.id), expected, 'synthesis dispositions', issues)
    const retainedReferences = strings(value?.retainedReferences, 'submission.retainedReferences', issues)
    exactSet(retainedReferences, [...new Set(retainedReferences)], 'synthesis retained references', issues)
    for (const reference of retainedReferences) {
      if (!/^(?:C|U)-[A-Z0-9][A-Z0-9-]*$/.test(reference)) issues.push(`synthesis retained reference is invalid: ${reference}`)
    }
    for (const item of dispositions.filter(item => item.disposition !== 'refuted')) {
      if (!retainedReferences.includes(item.reference)) issues.push(`synthesis retained references omit ${item.reference}`)
    }
    return {
      protocol: {
        synthesisDispositions: dispositions,
        retainedReferences: retainedReferences.toSorted(),
      },
      issues,
    }
  }

  if (task.promptKind === 'coverage-challenge') {
    const value = completed(envelope, ['observations'], issues)
    const values = array(value?.observations, 'submission.observations', issues, 64)
    const result: ChallengeObservation[] = []
    const ids: string[] = []
    values.forEach((raw, index) => {
      const label = `submission.observations[${index}]`
      const item = record(raw, label, ['id', 'disposition', 'reference', 'rationale', 'referenceEvidence'], issues)
      if (item === null) return
      const base = disposition({
        id: item.id, disposition: item.disposition, reference: item.reference, rationale: item.rationale,
        ...researchQueries(item, label, issues),
      }, label, issues)
      if (base === null) return
      ids.push(base.id)
      if (!new RegExp(`^${task.observationPrefix}-OBS-[1-9]\\d*$`).test(base.id)) {
        issues.push(`${label}.id must use ${task.observationPrefix}-OBS-N`)
      }
      if (base.disposition !== 'refuted'
        && !new RegExp(`^REF-${task.observationPrefix}-[1-9]\\d*$`).test(base.reference)) {
        issues.push(`${label}.reference must use REF-${task.observationPrefix}-N`)
      }
      // A refutation may have no separate reference evidence; its rationale is
      // still required. Normalize the model's no-evidence sentinel to the
      // existing null representation without relaxing non-refuted evidence.
      const absentRefutationEvidence = base.disposition === 'refuted'
        && item.referenceEvidence === 'none'
      const evidence = item.referenceEvidence === null || absentRefutationEvidence
        ? null : string(item.referenceEvidence, `${label}.referenceEvidence`, issues, 8)
      if (base.disposition !== 'refuted' && (evidence === null || evidence === '')) issues.push(`${base.id} non-refuted reference requires evidence`)
      result.push({ ...base, perspective: task.perspective!, referenceEvidence: evidence })
    })
    exactSet(ids, [...new Set(ids)], 'challenge observation IDs', issues)
    return { protocol: { challengeObservations: result }, issues }
  }

  if (task.promptKind === 'negative-review') {
    const reviewsPrimary = task.output.schema === 'ack3.negative-review.policy-v3'
    const value = completed(envelope, ['decisions'], issues)
    const packet = await createNegativeReviewInput(visibleArtifacts)
    const packetById = new Map(packet.entries.map(entry => [entry.observationId, entry]))
    const values = array(value?.decisions, 'submission.decisions', issues, packet.entries.length)
    const decisions: ReviewDecision[] = []
    values.forEach((raw, index) => {
      const label = `submission.decisions[${index}]`
      const item = record(raw, label, [
        'observationId', 'action', 'finalDisposition', 'finalReference', 'rationale',
        ...(reviewsPrimary ? ['reviewedPrimaryDisposition', 'reviewedPrimaryReference'] : []),
      ], issues)
      if (item === null) return
      const observationId = string(item.observationId, `${label}.observationId`, issues)
      const action = enumeration(item.action, ['uphold', 'narrow', 'overturn', 'unresolved'] as const, `${label}.action`, issues)
      const finalDisposition = enumeration(
        item.finalDisposition,
        ['candidate', 'refuted', 'unresolved'] as const,
        `${label}.finalDisposition`,
        issues,
      )
      const finalReference = string(item.finalReference, `${label}.finalReference`, issues)
      const rationale = string(item.rationale, `${label}.rationale`, issues, 8)
      if (reviewsPrimary) {
        const source = packetById.get(observationId)
        const reviewedDisposition = enumeration(item.reviewedPrimaryDisposition,
          ['candidate', 'refuted', 'unresolved'] as const, `${label}.reviewedPrimaryDisposition`, issues)
        const reviewedReference = string(item.reviewedPrimaryReference, `${label}.reviewedPrimaryReference`, issues)
        if (source !== undefined && reviewedDisposition !== null
          && reviewedDisposition !== source.primaryDisposition.disposition) {
          issues.push(`${label}.reviewedPrimaryDisposition differs from the frozen primary disposition`)
        }
        if (source !== undefined && reviewedReference !== ''
          && reviewedReference !== source.primaryDisposition.reference) {
          issues.push(`${label}.reviewedPrimaryReference differs from the frozen primary reference`)
        }
      }
      if (observationId !== '' && finalReference !== '' && rationale !== ''
        && action !== null && finalDisposition !== null) {
        decisions.push({
          observationId,
          action,
          finalDisposition,
          finalReference,
          rationale,
          ...researchQueries(item, label, issues),
        })
      }
    })
    exactSet(decisions.map(item => item.observationId), packet.entries.map(item => item.observationId), 'negative review decisions', issues)
    for (const decision of decisions) {
      const source = packetById.get(decision.observationId)
      if (source === undefined) continue
      if (decision.finalDisposition === 'refuted' && decision.finalReference !== 'none') issues.push(`${decision.observationId} refutation must use none`)
      if (decision.finalDisposition !== 'refuted' && decision.finalReference === 'none') issues.push(`${decision.observationId} non-refuted decision requires a reference`)
      if (decision.action === 'uphold' && (decision.finalDisposition !== source.primaryDisposition.disposition
        || decision.finalReference !== source.primaryDisposition.reference)) issues.push(`${decision.observationId} uphold changes the primary disposition`)
      if (decision.action === 'overturn' && (source.primaryDisposition.disposition !== 'refuted' || decision.finalDisposition === 'refuted')) {
        issues.push(`${decision.observationId} has an invalid overturn`)
      }
      if (source.primaryDisposition.disposition === 'refuted' && decision.finalDisposition === 'refuted' && decision.action !== 'uphold') {
        issues.push(`${decision.observationId} retained refutation must use uphold`)
      }
      if (source.primaryDisposition.disposition === 'refuted' && decision.finalDisposition !== 'refuted' && decision.action !== 'overturn') {
        issues.push(`${decision.observationId} replacement of a refutation must use overturn`)
      }
      if (decision.action === 'unresolved' && decision.finalDisposition !== 'unresolved') {
        issues.push(`${decision.observationId} unresolved action must remain unresolved`)
      }
    }
    return {
      protocol: {
        reviewInputDigest: packet.inputSha256,
        reviewDecisions: decisions,
        dispositionReferences: [...new Set(decisions
          .filter(item => item.finalDisposition !== 'refuted').map(item => item.finalReference))].toSorted(),
      },
      issues,
    }
  }

  if (task.promptKind === 'verification') {
    const value = completed(envelope, ['outcomes'], issues)
    const scoped = task.output.schema === 'ack3.verification.policy-v4'
    const assignments = scoped ? verificationAssignments(visibleArtifacts) : []
    const expected = scoped ? assignments.map(item => item.reference) : verificationReferences(visibleArtifacts)
    const values = array(value?.outcomes, 'submission.outcomes', issues, scoped
      ? assignments.reduce((sum, item) => sum + item.observationIds.length, 0) : expected.length)
    const outcomes: VerificationOutcome[] = []
    values.forEach((raw, index) => {
      const label = `submission.outcomes[${index}]`
      const item = record(raw, label, ['reference', ...(scoped ? ['observationIds'] : []), 'behavior', 'exploitability', 'evidenceMethod', 'evidence'], issues)
      if (item === null) return
      const reference = string(item.reference, `${label}.reference`, issues).toUpperCase()
      const observationIds = scoped ? strings(item.observationIds, `${label}.observationIds`, issues, false) : undefined
      const behavior = enumeration(
        item.behavior,
        ['reproduced', 'not-reproduced', 'unresolved'] as const,
        `${label}.behavior`,
        issues,
      )
      const exploitability = enumeration(
        item.exploitability,
        ['supported', 'refuted', 'unresolved'] as const,
        `${label}.exploitability`,
        issues,
      )
      const evidenceMethod = enumeration(
        item.evidenceMethod,
        ['fresh-execution', 'prior-execution-reviewed', 'source-inspection', 'not-attempted'] as const,
        `${label}.evidenceMethod`,
        issues,
      )
      const evidence = string(item.evidence, `${label}.evidence`, issues, 8)
      if (evidenceMethod === 'source-inspection' && behavior !== 'unresolved') {
        issues.push(`${label}.behavior must be unresolved for source-inspection`)
      }
      if (evidenceMethod === 'not-attempted' && (behavior !== 'unresolved' || exploitability !== 'unresolved')) {
        issues.push(`${label} must leave both axes unresolved for not-attempted`)
      }
      if (reference !== '' && evidence !== ''
        && behavior !== null && exploitability !== null && evidenceMethod !== null) {
        outcomes.push({
          reference,
          ...(observationIds === undefined ? {} : { observationIds }),
          behavior,
          exploitability,
          evidenceMethod,
          evidence,
          ...researchQueries(item, label, issues),
        })
      }
    })
    if (scoped) exactSet(
      outcomes.flatMap(item => (item.observationIds ?? []).map(id => `${item.reference}/${id}`)),
      assignments.flatMap(item => item.observationIds.map(id => `${item.reference}/${id}`)),
      'verification observation coverage', issues)
    else exactSet(outcomes.map(item => item.reference), expected, 'verification outcomes', issues)
    return { protocol: { verificationOutcomes: outcomes, retainedReferences: [...new Set(outcomes.map(item => item.reference))].toSorted() }, issues }
  }

  const scopedReport = task.output.schema === 'ack3.finding.policy-v4'
  const value = completed(envelope, ['retainedReferences', ...(scopedReport ? ['reportSections'] : [])], issues)
  const retainedReferences = strings(value?.retainedReferences, 'submission.retainedReferences', issues)
  const expected = [...new Set(visibleArtifacts.flatMap(artifact => [
    ...(artifact.protocol.dispositionReferences ?? []),
    ...(artifact.protocol.retainedReferences ?? []),
    ...(artifact.protocol.decisionDissentObservationIds ?? []),
  ]))].toSorted()
  exactSet(retainedReferences, expected, 'report retained references', issues)
  const reportSections: ReportSectionLink[] = []
  if (scopedReport) {
    const assignments = verificationAssignments(visibleArtifacts)
    const expectedPairs = assignments.flatMap(item => item.observationIds.map(id => `${item.reference}/${id}`))
    const report = files['finding-draft.md'] ?? ''
    const lines = report.split('\n')
    const tokens = markdown.parse(report, {})
    const headings = tokens.filter(token => token.type === 'heading_open' && token.map !== null)
    array(value?.reportSections, 'submission.reportSections', issues, expectedPairs.length).forEach((raw, index) => {
      const label = `submission.reportSections[${index}]`
      const item = record(raw, label, ['observationId', 'reference', 'section'], issues)
      if (item === null) return
      const observationId = string(item.observationId, `${label}.observationId`, issues)
      const reference = string(item.reference, `${label}.reference`, issues).toUpperCase()
      const section = string(item.section, `${label}.section`, issues)
      const matches = headings.filter(heading => lines[heading.map![0]]?.trim() === section)
      const heading = matches[0]
      const next = heading === undefined ? undefined : headings.find(value => value.map![0] > heading.map![0]
        && Number(value.tag.slice(1)) <= Number(heading.tag.slice(1)))
      let discussion = heading === undefined ? '' : tokens.filter((token, index) => token.type === 'inline' && tokens[index - 1]?.type !== 'heading_open' && token.map !== null
        && token.map[0] >= heading.map![1] && token.map[0] < (next?.map?.[0] ?? lines.length))
        .map(token => token.content).join(' ')
      for (const assignment of assignments) for (const id of [assignment.reference, ...assignment.observationIds]) {
        discussion = discussion.replaceAll(id, '')
      }
      if (matches.length !== 1 || heading === undefined || discussion.replace(/[^\p{L}\p{N}]/gu, '').length < 8) {
        issues.push(`${label}.section must identify one non-empty Markdown section in finding-draft.md`)
      }
      reportSections.push({ observationId, reference, section })
    })
    exactSet(reportSections.map(item => `${item.reference}/${item.observationId}`), expectedPairs,
      'report observation coverage', issues)
  }
  return { protocol: { retainedReferences: retainedReferences.toSorted(),
    ...(scopedReport ? { reportSections } : {}) }, issues }
}

export function submissionTemplate(task: TaskDefinition): string | null {
  if (!requiresSubmission(task)) return null
  const body: Record<string, unknown> = { complete: false }
  if (task.promptKind === 'research') Object.assign(body, { materialHighCriticalDelta: false, observations: [] })
  if (task.promptKind === 'synthesis') Object.assign(body, { dispositions: [], retainedReferences: [] })
  if (task.promptKind === 'coverage-challenge') Object.assign(body, { observations: [] })
  if (task.promptKind === 'negative-review') Object.assign(body, { decisions: [] })
  if (task.promptKind === 'verification') Object.assign(body, { outcomes: [] })
  if (task.promptKind === 'reporting') Object.assign(body, { retainedReferences: [],
    ...(task.output.schema === 'ack3.finding.policy-v4' ? { reportSections: [] } : {}) })
  return `${JSON.stringify(body, null, 2)}\n`
}
