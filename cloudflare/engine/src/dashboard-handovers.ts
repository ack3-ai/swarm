import type { ArtifactRecord, ChallengeObservation, DispositionRecord, ObservationRecord, ReviewDecision, RunState } from './contracts.js'
import { createNegativeReviewInput } from './protocol-transforms.js'

const source = (artifact: ArtifactRecord) => ({ task: artifact.taskId, stage: artifact.stageId, wave: artifact.waveId,
  model: artifact.model, digest: artifact.contentDigest })
type Source = ReturnType<typeof source>
type Decision = ReviewDecision & { source: Source }
interface HandoverRow {
  id: string
  observation: ObservationRecord | ChallengeObservation | null
  source: Source | null
  dispositions: (DispositionRecord & { source: Source })[]
  reviews: Decision[]
  verification: (NonNullable<ArtifactRecord['protocol']['verificationOutcomes']>[number] & { source: Source })[]
  custody: { references: readonly string[], reportSections?: ArtifactRecord['protocol']['reportSections'], source: Source }[]
  dissent: boolean
}

/** Read accepted structured records only. Never infer security outcomes from narrative text. */
export async function dashboardHandovers(state: RunState) {
  const accepted = state.artifacts.filter(artifact => artifact.status === 'accepted')
  const rows = new Map<string, HandoverRow>()
  const row = (id: string) => {
    let value = rows.get(id)
    if (!value) {
      value = { id, observation: null, source: null, dispositions: [], reviews: [], verification: [], custody: [], dissent: false }
      rows.set(id, value)
    }
    return value
  }
  for (const artifact of accepted) {
    const p = artifact.protocol
    for (const observation of [...p.research?.observations ?? [], ...p.challengeObservations ?? []]) {
      Object.assign(row(observation.id), { observation, source: source(artifact) })
    }
    for (const disposition of [...p.synthesisDispositions ?? [], ...p.challengeObservations ?? []]) {
      row(disposition.id).dispositions.push({ ...disposition, source: source(artifact) })
    }
    for (const decision of p.reviewDecisions ?? []) row(decision.observationId).reviews.push({ ...decision, source: source(artifact) })
    for (const custody of p.finalCustody?.observations ?? []) {
      row(custody.observationId).custody.push({ references: custody.retainedReferences, ...(custody.reportSections === undefined ? {} : { reportSections: custody.reportSections }), source: source(artifact) })
      row(custody.observationId).dissent ||= custody.decisionDissent
    }
  }
  // Historical exports may retain the unions but omit their individual producers.
  // Attribute these to the union document; do not fabricate a source artifact link.
  for (const artifact of accepted) {
    for (const entry of artifact.protocol.coverageUnion ?? []) {
      const value = row(entry.observation.id)
      if (!value.observation) value.observation = entry.observation
      if (!value.dispositions.length) value.dispositions.push({ ...entry.observation, source: source(artifact) })
    }
    for (const entry of artifact.protocol.reviewUnion ?? []) {
      const value = row(entry.observationId)
      value.dissent ||= entry.dissent
      for (const decision of entry.decisions) {
        if (!value.reviews.some(review => review.source.task === decision.reviewerTaskId)) {
          value.reviews.push({ ...decision, source: { ...source(artifact), task: decision.reviewerTaskId, model: decision.model } })
        }
      }
    }
  }
  for (const value of rows.values()) {
    value.dissent ||= new Set(value.reviews.map(review => `${review.finalDisposition}\0${review.finalReference}`)).size > 1
    for (const artifact of accepted) for (const outcome of artifact.protocol.verificationOutcomes ?? []) {
      if (outcome.observationIds?.includes(value.id)) value.verification.push({ ...outcome, source: source(artifact) })
    }
  }
  let packet: Awaited<ReturnType<typeof createNegativeReviewInput>> | null = null
  let packetStatus = 'Not available yet: the complete structured inputs have not been recorded.'
  const reviewers = accepted.filter(artifact => artifact.protocol.reviewInputDigest)
  if (rows.size && accepted.some(artifact => artifact.protocol.synthesisDispositions)) {
    try {
      const reconstructed = await createNegativeReviewInput(accepted)
      if (reviewers.length && reviewers.every(artifact => artifact.protocol.reviewInputDigest === reconstructed.inputSha256)) {
        packet = reconstructed
        packetStatus = `Review evidence matches the input hash recorded by all ${reviewers.length} accepted reviewers.`
      } else packetStatus = reviewers.length
        ? 'Review evidence could not be verified against every accepted reviewer. The source records remain available.'
        : 'Reviewers have not yet recorded a matching input hash. Source records remain available below.'
    } catch { packetStatus = 'Complete review evidence cannot be reconstructed from the saved records. Available source records remain visible below.' }
  }
  return { runId: state.runId, generation: state.stateGeneration, packet, packetStatus,
    rows: [...rows.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })),
    artifacts: accepted.map(artifact => ({ ...source(artifact), kinds: Object.keys(artifact.protocol) })),
  }
}
