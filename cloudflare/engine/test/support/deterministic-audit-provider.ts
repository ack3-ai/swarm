import type { AgentProvider, AgentRequest, AgentResult } from '../../src/contracts.js'
import { canonicalJson } from '../../src/canonical.js'
import { SUBMISSION_PATH } from '../../src/submission.js'
import { providerIdentity } from '../../src/provider-identity.js'
import {
  createCoverageUnion,
  createFinalObservationCustody,
  createNegativeReviewInput,
  createNegativeReviewUnion,
  createNegativeReviewUnionManifest,
  renderCoverageUnion,
  sealFinalFinding,
  verificationAssignments,
} from '../../src/protocol-transforms.js'

export const deterministicReportDraft = '# Audit0 evidence report\n\n## Report item\n\nC-1 records one causal defect and its supported impact paths.\n\n## Coverage, blockers, and uncertainty\n\nAll retained evidence is preserved.\n'

function researchResult(request: AgentRequest): AgentResult {
  const assignment = request.task.research
  if (assignment === undefined) throw new TypeError('missing research assignment')
  const material = assignment.wave < 2
  const statement = assignment.wave === 0
    ? 'The withdrawal boundary requires independent authorization analysis.'
    : material
      ? 'The assigned path changes the evidence for a plausible custody consequence.'
      : 'The assigned path produced no distinct material High/Critical delta.'
  const content = [
    '# Research evidence',
    '',
    statement,
    '',
    `Evidence: src/HelloVault.sol inspected by wave ${assignment.wave} lane ${assignment.researcher}.`,
    '',
  ].join('\n')
  const observations = [{
    id: 'A1', statement, conditions: ['The pinned disposable target is applicable.'],
    consequence: material ? 'A plausible custody impact remains for downstream review.' : 'No distinct additional consequence was established.',
    evidence: [`src/HelloVault.sol inspected by wave ${assignment.wave} lane ${assignment.researcher}`],
  }]
  const path = request.task.output.requiredFiles[0] ?? ''
  return {
    status: 'accepted', actorId: `stub-${request.task.providerClass}-${assignment.wave}-${assignment.researcher}-${request.attempt}`,
    model: request.task.model, provider: providerIdentity(request.task),
    files: { [path]: content, [SUBMISSION_PATH]: JSON.stringify({
      complete: true, nextExperiment: 'none', materialHighCriticalDelta: material, observations,
      ...(request.task.output.schema === 'ack3.research-delta.policy-v3' ? { leadChecks: [] } : {}),
    }) }, assertions: [`wave-${assignment.wave}-research-${assignment.researcher}-A1`],
    protocol: { research: {
      role: assignment.role, buildsOn: assignment.buildsOn, nextExperiment: 'none',
      materialHighCriticalDelta: material, observations,
      ...(request.task.output.schema === 'ack3.research-delta.policy-v3' ? { leadChecks: [] } : {}),
    } }, inputTokens: 100, outputTokens: 50, costUsd: 0,
    sessionId: `session-${request.task.workspaceKey}`,
  }
}

export class DeterministicAuditProvider implements AgentProvider {
  constructor(private readonly failTasks: ReadonlySet<string> = new Set()) {}

  async disposeWorkspace(): Promise<void> {}

  async run(request: AgentRequest): Promise<AgentResult> {
    if (this.failTasks.has(request.task.id)) throw new Error(`sanitized provider failure for ${request.task.id}`)
    if (request.task.promptKind === 'research') return researchResult(request)
    const base = {
      status: 'accepted' as const,
      actorId: `stub-${request.task.id}-${request.attempt}`,
      model: request.task.model,
      provider: providerIdentity(request.task),
      assertions: [`${request.stage.id}:${request.task.id}:complete`],
      inputTokens: request.task.providerClass === 'deterministic' ? 0 : 100,
      outputTokens: request.task.providerClass === 'deterministic' ? 0 : 50,
      costUsd: 0,
      sessionId: `session-${request.task.workspaceKey}`,
    }
    if (request.task.promptKind === 'preflight') return { ...base, files: { 'preflight.json': '{"valid":true}' }, protocol: {} }
    if (request.task.promptKind === 'synthesis') {
      const ids = request.visibleArtifacts.flatMap(value => value.protocol.research?.observations.map(item => item.id) ?? [])
      const dispositions = ids.map(id => ({ id, disposition: 'candidate' as const, reference: 'C-1', rationale: 'retained evidence' }))
      return { ...base, files: {
        'threat-model.md': '# Threat model\n', 'coverage.md': '# Coverage\n',
        'candidates.md': '# Candidates\n\nC-1\n', 'frontier.md': '# Frontier\n',
        'observation-ledger.md': `# Observation ledger\n\n${dispositions.map(value => `- ${value.id} | ${value.disposition} | ${value.reference} | ${value.rationale}`).join('\n')}\n`,
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, dispositions, retainedReferences: ['C-1'] }),
      }, protocol: { retainedReferences: ['C-1'], synthesisDispositions: dispositions } }
    }
    if (request.task.promptKind === 'coverage-challenge') {
      const prefix = request.task.observationPrefix ?? 'OPEN'
      const table = request.task.requiredTable === undefined ? '' : `## ${request.task.requiredTable}\n\nChecked.\n\n`
      const observation = {
        id: `${prefix}-OBS-1`, disposition: 'refuted' as const, reference: 'none',
        rationale: 'no distinct mechanism', perspective: request.task.perspective!, referenceEvidence: null,
      }
      return { ...base, files: {
        'coverage-challenge.md': `# Coverage challenge\n\n## Independent coverage\n\nWhole target checked.\n\n${table}## Observation ledger\n\n- ${observation.id} | ${observation.disposition} | ${observation.reference} | ${observation.rationale}\n\n## Candidate supplement\n\nNo additional candidate.\n`,
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [{
          id: observation.id, disposition: observation.disposition, reference: observation.reference,
          rationale: observation.rationale, referenceEvidence: observation.referenceEvidence,
        }] }),
      }, protocol: { challengeObservations: [observation] } }
    }
    if (request.task.promptKind === 'coverage-union') {
      const union = createCoverageUnion(request.visibleArtifacts)
      const references = [...new Set(union.filter(value => value.observation.disposition !== 'refuted')
        .map(value => value.observation.reference))].toSorted()
      return { ...base, files: { 'coverage-challenge.md': renderCoverageUnion(union) }, protocol: { coverageUnion: union, dispositionReferences: references } }
    }
    if (request.task.promptKind === 'negative-review') {
      const packet = await createNegativeReviewInput(request.visibleArtifacts)
      const rows = packet.entries.map(entry => `- ${entry.observationId} | uphold | ${entry.primaryDisposition.disposition} | ${entry.primaryDisposition.reference} | retained independently`)
      const references = [...new Set(packet.entries.filter(entry => entry.primaryDisposition.disposition !== 'refuted').map(entry => entry.primaryDisposition.reference))]
      const sections = references.map(reference => `### ${reference}\n\nEvidence retained.`).join('\n\n')
      const content = `# Negative disposition review\n\ninput_sha256: ${packet.inputSha256}\n\n${rows.join('\n')}\n\n${sections}\n`
      const output = request.task.output.requiredFiles[0]!
      const decisions = packet.entries.map(entry => ({
        observationId: entry.observationId, action: 'uphold' as const,
        ...(request.task.output.schema === 'ack3.negative-review.policy-v3' ? {
          reviewedPrimaryDisposition: entry.primaryDisposition.disposition,
          reviewedPrimaryReference: entry.primaryDisposition.reference,
        } : {}),
        finalDisposition: entry.primaryDisposition.disposition,
        finalReference: entry.primaryDisposition.reference, rationale: 'retained independently',
      }))
      return { ...base, files: { [output]: content, [SUBMISSION_PATH]: JSON.stringify({ complete: true, decisions }) }, protocol: {
        reviewInputDigest: packet.inputSha256,
        dispositionReferences: references.toSorted(),
        reviewDecisions: decisions.map(({ observationId, action, finalDisposition, finalReference, rationale }) => ({
          observationId, action, finalDisposition, finalReference, rationale,
        })),
      } }
    }
    if (request.task.promptKind === 'review-union') {
      const union = createNegativeReviewUnion(request.visibleArtifacts)
      const manifest = createNegativeReviewUnionManifest(request.visibleArtifacts, union)
      return { ...base, files: { 'negative-disposition-review-union.json': canonicalJson(manifest) }, protocol: {
        reviewUnion: union,
        dispositionReferences: manifest.unionReferences,
        decisionDissentObservationIds: manifest.decisionDissentObservationIds,
      } }
    }
    if (request.task.promptKind === 'verification') {
      const references = [...new Set(request.visibleArtifacts.flatMap(artifact => [
        ...(artifact.protocol.dispositionReferences ?? []), ...(artifact.protocol.retainedReferences ?? []),
        ...(artifact.protocol.decisionDissentObservationIds ?? []),
      ]))].toSorted()
      const batches: string[] = []
      for (let index = 0; index < references.length; index += 3) {
        const batch = references.slice(index, index + 3)
        batches.push(`## Batch ${(index / 3) + 1}\n\nreferences: ${batch.join(', ')}\n\n${batch.map(reference => (
          `- ${reference} | behavior: reproduced | exploitability: supported | independently reproduced in the sanitized fixture`
        )).join('\n')}`)
      }
      const outcomes = references.map(reference => ({
        reference, ...(request.task.output.schema === 'ack3.verification.policy-v4'
          ? { observationIds: verificationAssignments(request.visibleArtifacts).find(item => item.reference === reference)!.observationIds } : {}),
        behavior: 'reproduced' as const, exploitability: 'supported' as const,
        evidenceMethod: 'fresh-execution' as const,
        evidence: 'independently reproduced in the sanitized fixture',
      }))
      return { ...base, files: {
        'verification.md': `# Verification\n\n${batches.join('\n\n')}\n`,
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes }),
      }, protocol: { verificationOutcomes: outcomes, retainedReferences: references } }
    }
    if (request.task.promptKind === 'final-seal') {
      const custody = await createFinalObservationCustody(request.visibleArtifacts)
      return { ...base, files: { 'finding.md': sealFinalFinding(deterministicReportDraft, custody) }, protocol: {
        finalCustody: custody, retainedReferences: custody.retainedReferences,
      } }
    }
    const identifiers = [...new Set(request.visibleArtifacts.flatMap(artifact => [
      ...(artifact.protocol.dispositionReferences ?? []), ...(artifact.protocol.retainedReferences ?? []),
      ...(artifact.protocol.decisionDissentObservationIds ?? []),
    ]))]
    const suffix = identifiers.filter(value => !deterministicReportDraft.includes(value)).join('\n')
    const retainedReferences = identifiers.toSorted()
    const reportSections = request.task.output.schema === 'ack3.finding.policy-v4'
      ? { reportSections: verificationAssignments(request.visibleArtifacts).flatMap(item => item.observationIds.map(observationId => ({
        observationId, reference: item.reference, section: '## Coverage, blockers, and uncertainty',
      }))) } : {}
    return { ...base, files: {
      'finding-draft.md': `${deterministicReportDraft}${suffix}\n`,
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, retainedReferences, ...reportSections }),
    }, protocol: { retainedReferences, ...reportSections } }
  }
}
