import { describe, expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import type { ArtifactRecord, ProtocolMetadata, TaskDefinition } from '../src/contracts.js'
import { createNegativeReviewInput, verificationAssignments } from '../src/protocol-transforms.js'
import { readSubmission, SUBMISSION_PATH, submissionTemplate } from '../src/submission.js'

// P2-01 (W5, S18): the template written to .swarm/submission.json lists every expected ID.
const definition = compileExperimentConfig(manifest).definition
const tasks = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
const byKind = (kind: TaskDefinition['promptKind']) => tasks.find(task => task.promptKind === kind)!
const artifact = (taskId: string, protocol: ProtocolMetadata) => ({ id: taskId, taskId, stageId: 'fixture', waveId: 'fixture',
  model: 'fixture', provider: 'fixture', actorId: taskId, status: 'accepted', contentDigest: taskId.padEnd(64, 'a'), protocol }) as ArtifactRecord
const ids = ['OBS-A1', 'OBS-A2', 'OBS-A3']
const research = artifact('research', { research: { role: 'researcher', buildsOn: 'none', materialHighCriticalDelta: true,
  observations: ids.map(id => ({ id, statement: `statement ${id}`, conditions: [], consequence: 'loss', evidence: ['src/Vault.sol:1'] })) } })
const challenge = artifact('challenge', { challengeObservations: [{ id: 'OPEN-OBS-1', perspective: 'open-adversarial', disposition: 'unresolved',
  reference: 'REF-OPEN-1', rationale: 'separate caller assumption', referenceEvidence: 'src/Vault.sol:9' }] })
const synthesis = artifact('synthesizer', { synthesisDispositions: [
  { id: 'OBS-A1', disposition: 'candidate', reference: 'C-1', rationale: 'grouped for review' },
  { id: 'OBS-A2', disposition: 'candidate', reference: 'C-1', rationale: 'grouped for review' },
  { id: 'OBS-A3', disposition: 'refuted', reference: 'none', rationale: 'guarded by the owner check' },
], retainedReferences: ['C-1'] })
const union = artifact('negative-review-union', { reviewUnion: [
  { observationId: 'OBS-A1', decisions: [], retainedReferences: ['C-1', 'U-2'], dissent: true },
  { observationId: 'OBS-A2', decisions: [], retainedReferences: ['C-1'], dissent: false },
], dispositionReferences: ['C-1', 'U-2'], decisionDissentObservationIds: ['OBS-A1'] })

const template = async (kind: TaskDefinition['promptKind'], artifacts: readonly ArtifactRecord[]) =>
  JSON.parse((await submissionTemplate(byKind(kind), artifacts))!) as Record<string, unknown>
const check = async (kind: TaskDefinition['promptKind'], body: object, artifacts: readonly ArtifactRecord[], files: Record<string, string> = {}) =>
  (await readSubmission(byKind(kind), { ...files, [SUBMISSION_PATH]: JSON.stringify(body) }, artifacts)).issues
/** Problems that mean the IDs or the entry shape are wrong, which the template exists to prevent. ("omits"
 * still appears for an entry whose decision fields are invalid: validation drops it before counting.) */
const idIssue = (issue: string) => / (repeats|adds unexpected) |differs from the frozen|must contain exactly/.test(issue)

describe('the pre-filled submission template', () => {
  it('lists every input observation for synthesis, with the decision fields empty', async () => {
    const value = await template('synthesis', [research])
    expect(value).toEqual({ complete: false, retainedReferences: [],
      dispositions: ids.map(id => ({ id, disposition: '', reference: '', rationale: '' })) })
    // Left as it is (even marked complete), it still fails, on the decisions only.
    const issues = await check('synthesis', { ...value, complete: true }, [research])
    expect(issues).toContain('submission.dispositions[0].disposition must be one of: candidate, refuted, unresolved')
    expect(issues).toContain('submission.dispositions[0].rationale must be a non-empty string')
    expect(issues.filter(idIssue)).toEqual([])
    const dispositions = (value.dispositions as Record<string, string>[]).map(entry => ({
      ...entry, disposition: 'candidate', reference: 'C-1', rationale: 'one share-check defect' }))
    expect(await check('synthesis', { complete: true, dispositions, retainedReferences: ['C-1'] }, [research])).toEqual([])
  })

  it('lists every negative-review observation with the frozen primary fields it must echo', async () => {
    const artifacts = [research, challenge, synthesis]
    const packet = await createNegativeReviewInput(artifacts)
    const value = await template('negative-review', artifacts)
    expect(value).toEqual({ complete: false, decisions: packet.entries.map(entry => ({
      observationId: entry.observationId,
      reviewedPrimaryDisposition: entry.primaryDisposition.disposition,
      reviewedPrimaryReference: entry.primaryDisposition.reference,
      action: '', finalDisposition: '', finalReference: '', rationale: '',
    })) })
    expect((value.decisions as { observationId: string }[]).map(entry => entry.observationId)).toEqual(['OBS-A1', 'OBS-A2', 'OBS-A3', 'OPEN-OBS-1'])
    const issues = await check('negative-review', { ...value, complete: true }, artifacts)
    expect(issues).toContain('submission.decisions[0].action must be one of: uphold, narrow, overturn, unresolved')
    expect(issues).toContain('submission.decisions[0].finalReference must be a non-empty string')
    expect(issues.filter(idIssue)).toEqual([])
    const decisions = (value.decisions as Record<string, string>[]).map(entry => ({ ...entry, action: 'uphold',
      finalDisposition: entry.reviewedPrimaryDisposition, finalReference: entry.reviewedPrimaryReference, rationale: 'independently retained' }))
    expect(await check('negative-review', { complete: true, decisions }, artifacts)).toEqual([])
  })

  it('lists every verification assignment with its observation IDs and the outcome fields empty', async () => {
    const artifacts = [research, challenge, synthesis, union]
    const value = await template('verification', artifacts)
    expect(value).toEqual({ complete: false, outcomes: verificationAssignments(artifacts).map(({ reference, observationIds }) => ({
      reference, observationIds, behavior: '', exploitability: '', evidenceMethod: '', evidence: '' })) })
    expect((value.outcomes as { reference: string }[]).map(entry => entry.reference)).toEqual(['C-1', 'OBS-A1', 'REF-OPEN-1', 'U-2'])
    const issues = await check('verification', { ...value, complete: true }, artifacts)
    expect(issues).toContain('submission.outcomes[0].behavior must be one of: reproduced, not-reproduced, unresolved')
    expect(issues).toContain('submission.outcomes[0].evidence must be a non-empty string')
    expect(issues.filter(idIssue)).toEqual([])
    const outcomes = (value.outcomes as Record<string, unknown>[]).map(entry => ({ ...entry, behavior: 'unresolved',
      exploitability: 'unresolved', evidenceMethod: 'source-inspection', evidence: 'static reading of the recovery path' }))
    expect(await check('verification', { complete: true, outcomes }, artifacts)).toEqual([])
  })

  it('fills the reporter\'s retained references and lists every report pair with the section empty', async () => {
    const artifacts = [research, challenge, synthesis, union]
    const value = await template('reporting', artifacts)
    expect(value).toEqual({ complete: false, retainedReferences: ['C-1', 'OBS-A1', 'U-2'],
      reportSections: verificationAssignments(artifacts).flatMap(({ reference, observationIds }) =>
        observationIds.map(observationId => ({ observationId, reference, section: '' }))) })
    const report = { 'finding-draft.md': '# Report\n\n## Coverage and uncertainty\nThe recovery condition remains unresolved after review.\n' }
    const issues = await check('reporting', { ...value, complete: true }, artifacts, report)
    expect(issues).toContain('submission.reportSections[0].section must be a non-empty string')
    expect(issues.filter(idIssue)).toEqual([])
    const reportSections = (value.reportSections as Record<string, string>[]).map(entry => ({ ...entry, section: '## Coverage and uncertainty' }))
    expect(await check('reporting', { ...value, complete: true, reportSections }, artifacts, report)).toEqual([])
  })

  it('keeps complete false, so an untouched template never passes, and is unchanged without accepted inputs', async () => {
    const artifacts = [research, challenge, synthesis, union]
    for (const kind of ['synthesis', 'negative-review', 'verification', 'reporting'] as const) {
      const inputs = kind === 'synthesis' ? [research] : kind === 'negative-review' ? [research, challenge, synthesis] : artifacts
      expect(await check(kind, await template(kind, inputs), inputs)).toContain('submission.complete must be true')
    }
    expect(await template('research', artifacts)).toEqual({ complete: false, materialHighCriticalDelta: false, observations: [], leadChecks: [] })
    expect(await template('coverage-challenge', artifacts)).toEqual({ complete: false, observations: [] })
    expect(await template('synthesis', [])).toEqual({ complete: false, dispositions: [], retainedReferences: [] })
    expect(await template('negative-review', [])).toEqual({ complete: false, decisions: [] })
    expect(await template('verification', [])).toEqual({ complete: false, outcomes: [] })
    expect(await template('reporting', [])).toEqual({ complete: false, retainedReferences: [], reportSections: [] })
    expect(await submissionTemplate(byKind('preflight'), artifacts)).toBeNull()
  })
})
