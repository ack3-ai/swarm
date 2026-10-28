import type {
  ArtifactRecord,
  ChallengeObservation,
  CoverageUnionEntry,
  DispositionRecord,
  FinalObservationCustody,
  ObservationRecord,
  ResearchLeadCheck,
  ReviewUnionEntry,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'

export interface NegativeReviewEntry {
  observationId: string
  sourceKind: 'research' | 'challenge'
  sourceLabel: string
  observation: ObservationRecord | ChallengeObservation
  observationSha256: string
  primaryDisposition: DispositionRecord
  primaryDispositionSha256: string
  leadCheck?: ResearchLeadCheck
  reviewReasons: readonly ('primary-refutation' | 'meaning-preservation-unproven' | 'many-to-one-mapping' | 'source-blind-control')[]
}

export interface NegativeReviewInput {
  version: 2
  entries: readonly NegativeReviewEntry[]
  inputSha256: string
}

/** Fail closed if imported accepted metadata would silently lose a declared lead. */
export function assertResearchLeadCustody(artifact: ArtifactRecord): void {
  const research = artifact.protocol.research
  if (research?.leadChecks === undefined) return
  const ids = new Set(research.observations.map(observation => observation.id))
  const seen = new Set<string>()
  for (const check of research.leadChecks) {
    if (!ids.has(check.observationId) || seen.has(check.observationId)) {
      throw new Error(`research lead check lacks a unique observation: ${check.observationId}`)
    }
    seen.add(check.observationId)
  }
}

/** A reading aid for new reviewers; the version-2 packet remains the authority. */
export function negativeReviewReadingView(packet: NegativeReviewInput): string {
  const entries = packet.entries.map(entry => ({
    observationId: entry.observationId,
    sourceKind: entry.sourceKind,
    sourceLabel: entry.sourceLabel,
    observation: entry.sourceKind === 'research'
      ? {
          statement: (entry.observation as ObservationRecord).statement,
          conditions: (entry.observation as ObservationRecord).conditions,
          consequence: (entry.observation as ObservationRecord).consequence,
          evidence: (entry.observation as ObservationRecord).evidence,
        }
      : {
          rationale: (entry.observation as ChallengeObservation).rationale,
          referenceEvidence: (entry.observation as ChallengeObservation).referenceEvidence,
        },
    primaryDisposition: entry.primaryDisposition,
    ...(entry.leadCheck === undefined ? {} : { leadCheck: entry.leadCheck }),
    reviewReasons: entry.reviewReasons,
  }))
  return canonicalJson({ inputSha256: packet.inputSha256, entries })
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export async function createNegativeReviewInput(artifacts: readonly ArtifactRecord[]): Promise<NegativeReviewInput> {
  const accepted = artifacts.filter(artifact => artifact.status === 'accepted')
  const dispositions = new Map(accepted.flatMap(artifact => artifact.protocol.synthesisDispositions ?? []).map(item => [item.id, item]))
  const pending: Omit<NegativeReviewEntry, 'reviewReasons'>[] = []
  for (const artifact of accepted) {
    assertResearchLeadCustody(artifact)
    for (const observation of artifact.protocol.research?.observations ?? []) {
      const primaryDisposition = dispositions.get(observation.id)
      if (primaryDisposition === undefined) throw new Error(`synthesis omitted primary disposition for ${observation.id}`)
      const leadCheck = artifact.protocol.research?.leadChecks?.find(check => check.observationId === observation.id)
      pending.push({
        observationId: observation.id, sourceKind: 'research', sourceLabel: `${artifact.stageId}/${artifact.waveId}/${artifact.taskId}`,
        observation, observationSha256: await sha256(JSON.stringify(observation)),
        primaryDisposition, primaryDispositionSha256: await sha256(JSON.stringify(primaryDisposition)),
        ...(leadCheck === undefined ? {} : { leadCheck }),
      })
    }
    for (const observation of artifact.protocol.challengeObservations ?? []) {
      pending.push({
        observationId: observation.id, sourceKind: 'challenge', sourceLabel: observation.perspective,
        observation, observationSha256: await sha256(JSON.stringify(observation)),
        primaryDisposition: observation, primaryDispositionSha256: await sha256(JSON.stringify(observation)),
      })
    }
  }
  pending.sort((left, right) => compare(left.observationId, right.observationId))
  if (new Set(pending.map(item => item.observationId)).size !== pending.length) throw new Error('negative review input has duplicate observation IDs')
  const referenceCounts = new Map<string, number>()
  for (const { primaryDisposition } of pending) {
    if (primaryDisposition.disposition === 'refuted') continue
    const key = primaryDisposition.reference.toLowerCase()
    referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1)
  }
  const mandatory = new Set(pending.filter(({ primaryDisposition }) => primaryDisposition.disposition === 'refuted'
    || (referenceCounts.get(primaryDisposition.reference.toLowerCase()) ?? 0) > 1).map(item => item.observationId))
  const eligible = await Promise.all(pending.filter(item => !mandatory.has(item.observationId)).map(async item => ({
    id: item.observationId,
    digest: await sha256(`${item.observationId}\0${JSON.stringify(item.observation)}`),
  })))
  eligible.sort((left, right) => compare(left.digest, right.digest))
  const controlCount = eligible.length === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil(pending.length * 0.1)))
  const controls = new Set(eligible.slice(0, controlCount).map(item => item.id))
  const entries = pending.map(item => ({
    ...item,
    reviewReasons: [
      ...(item.primaryDisposition.disposition === 'refuted' ? ['primary-refutation' as const] : ['meaning-preservation-unproven' as const]),
      ...((referenceCounts.get(item.primaryDisposition.reference.toLowerCase()) ?? 0) > 1 ? ['many-to-one-mapping' as const] : []),
      ...(controls.has(item.observationId) ? ['source-blind-control' as const] : []),
    ],
  }))
  const payload = { version: 2 as const, entries }
  return { ...payload, inputSha256: await sha256(JSON.stringify(payload)) }
}

export function createCoverageUnion(artifacts: readonly ArtifactRecord[]): readonly CoverageUnionEntry[] {
  const entries = artifacts.flatMap(artifact => (artifact.protocol.challengeObservations ?? []).map(observation => ({
    observation,
    sourceTaskId: artifact.taskId,
    actorId: artifact.actorId,
    model: artifact.model,
    provider: artifact.provider,
  })))
  entries.sort((left, right) => compare(
    `${left.observation.id}\0${left.sourceTaskId}\0${left.actorId}`,
    `${right.observation.id}\0${right.sourceTaskId}\0${right.actorId}`,
  ))
  const sources = new Set<string>()
  for (const entry of entries) {
    const source = `${entry.sourceTaskId}\0${entry.observation.id}`
    if (sources.has(source)) throw new Error(`coverage union has duplicate source observation ${entry.observation.id}`)
    sources.add(source)
  }
  return entries
}

export function createNegativeReviewUnion(artifacts: readonly ArtifactRecord[]): readonly ReviewUnionEntry[] {
  const grouped = new Map<string, ReviewUnionEntry['decisions'][number][]>()
  for (const artifact of artifacts) {
    for (const decision of artifact.protocol.reviewDecisions ?? []) {
      const values = grouped.get(decision.observationId) ?? []
      values.push({
        ...decision,
        reviewerTaskId: artifact.taskId,
        actorId: artifact.actorId,
        model: artifact.model,
        provider: artifact.provider,
      })
      grouped.set(decision.observationId, values)
    }
  }
  const union = [...grouped.entries()].map(([observationId, decisions]) => {
    decisions.sort((left, right) => compare(
      `${left.reviewerTaskId}\0${left.actorId}`,
      `${right.reviewerTaskId}\0${right.actorId}`,
    ))
    const retainedReferences = [...new Set(decisions
      .filter(value => value.finalDisposition !== 'refuted' && value.finalReference !== 'none')
      .map(value => value.finalReference))].toSorted()
    const outcomes = new Set(decisions.map(value => `${value.finalDisposition}\0${value.finalReference}`))
    return { observationId, decisions, retainedReferences, dissent: outcomes.size > 1 }
  })
  union.sort((left, right) => compare(left.observationId, right.observationId))
  return union
}

export function renderCoverageUnion(entries: readonly CoverageUnionEntry[]): string {
  const rows = entries.map(entry => (
    `- ${entry.observation.id} | ${entry.observation.disposition} | ${entry.observation.reference} | ${entry.sourceTaskId} | ${entry.provider}/${entry.model}/${entry.actorId} | ${entry.observation.rationale}`
  ))
  return `# Dissent-preserving coverage union\n\n${rows.join('\n')}\n`
}

export function retainedEvidenceReferences(artifacts: readonly ArtifactRecord[]): string[] {
  return [...new Set(artifacts
    .filter(artifact => artifact.status === 'accepted'
      && !['verifier', 'reporter', 'seal-final'].includes(artifact.taskId))
    .flatMap(artifact => [
      ...(artifact.protocol.dispositionReferences ?? []),
      ...(artifact.protocol.retainedReferences ?? []),
    ]))].toSorted()
}

export function verificationReferences(artifacts: readonly ArtifactRecord[]): string[] {
  return [...new Set(artifacts.flatMap(artifact => [
    ...(artifact.protocol.dispositionReferences ?? []),
    ...(artifact.protocol.retainedReferences ?? []),
    ...(artifact.protocol.decisionDissentObservationIds ?? []),
  ]).map(reference => reference.toUpperCase()))].toSorted()
}

/** Explicit eligibility associations; grouping never transfers a result between observations. */
export function verificationAssignments(artifacts: readonly ArtifactRecord[]): { reference: string, observationIds: string[] }[] {
  const byReference = new Map<string, Set<string>>()
  const add = (reference: string, observationId: string) => {
    if (reference === 'none') return
    const key = reference.toUpperCase()
    const ids = byReference.get(key) ?? new Set<string>()
    ids.add(observationId)
    byReference.set(key, ids)
  }
  for (const artifact of artifacts.filter(item => item.status === 'accepted')) {
    for (const item of [...artifact.protocol.synthesisDispositions ?? [], ...artifact.protocol.challengeObservations ?? [],
      ...(artifact.protocol.coverageUnion ?? []).map(entry => entry.observation)]) {
      if (item.disposition !== 'refuted') add(item.reference, item.id)
    }
    for (const entry of artifact.protocol.reviewUnion ?? []) {
      for (const reference of entry.retainedReferences) add(reference, entry.observationId)
      if (entry.dissent) add(entry.observationId, entry.observationId)
    }
  }
  return [...byReference].sort(([a], [b]) => compare(a, b))
    .map(([reference, ids]) => ({ reference, observationIds: [...ids].toSorted() }))
}

export function createNegativeReviewUnionManifest(
  artifacts: readonly ArtifactRecord[],
  reviews: readonly ReviewUnionEntry[] = createNegativeReviewUnion(artifacts),
) {
  return {
    schemaVersion: 1 as const,
    mergePolicy: 'union-preserve-dissent' as const,
    unionReferences: retainedEvidenceReferences(artifacts),
    decisionDissentObservationIds: reviews.filter(value => value.dissent)
      .map(value => value.observationId).toSorted(),
    reviews,
  }
}

export async function createFinalObservationCustody(artifacts: readonly ArtifactRecord[]): Promise<FinalObservationCustody> {
  const reporter = artifacts.find(artifact => artifact.status === 'accepted' && artifact.taskId === 'reporter')
  const review = artifacts.find(artifact => artifact.status === 'accepted' && artifact.taskId === 'negative-review-union')
  if (reporter === undefined || (review !== undefined && review.protocol.reviewUnion === undefined)) {
    throw new Error('final custody requires the reporter and any executed negative-review union')
  }
  const packet = await createNegativeReviewInput(artifacts)
  const reviewById = new Map((review?.protocol.reviewUnion ?? []).map(entry => [entry.observationId, entry]))
  const observations = await Promise.all(packet.entries.map(async entry => {
    const union = reviewById.get(entry.observationId)
    if (review !== undefined && union === undefined) throw new Error(`final custody lacks reviewed observation ${entry.observationId}`)
    return {
      observationId: entry.observationId,
      observationDigest: entry.observationSha256,
      primaryDispositionDigest: entry.primaryDispositionSha256,
      ...(reporter.protocol.reportSections === undefined ? {} : {
        reportSections: reporter.protocol.reportSections.filter(link => link.observationId === entry.observationId),
      }),
      retainedReferences: union === undefined ? (entry.primaryDisposition.disposition === 'refuted' ? [] : [entry.primaryDisposition.reference]) : [...union.retainedReferences],
      decisionDissent: union?.dissent ?? false,
    }
  }))
  const retainedReferences = [...new Set([
    ...retainedEvidenceReferences(artifacts),
    ...observations.flatMap(entry => entry.retainedReferences),
  ])].toSorted()
  const decisionDissentObservationIds = observations.filter(entry => entry.decisionDissent)
    .map(entry => entry.observationId).toSorted()
  return {
    schemaVersion: 1,
    sourceReportArtifactDigest: reporter.contentDigest,
    negativeReviewUnionArtifactDigest: review?.contentDigest ?? null,
    retainedReferences,
    decisionDissentObservationIds,
    observations,
  }
}

export function sealFinalFinding(draft: string, custody: FinalObservationCustody): string {
  if (draft.trim() === '') throw new Error('finding draft is empty')
  const marker = '<!-- ACK3_FINAL_OBSERVATION_CUSTODY_V1 -->'
  if (draft.includes(marker)) throw new Error('finding draft contains a reserved custody marker')
  return `${draft.trimEnd()}\n\n${marker}\n${canonicalJson(custody)}\n<!-- /ACK3_FINAL_OBSERVATION_CUSTODY_V1 -->\n`
}
