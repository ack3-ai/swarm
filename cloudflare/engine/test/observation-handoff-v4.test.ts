import { describe, expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import type { ArtifactRecord, ProtocolMetadata, RunState, VerificationOutcome } from '../src/contracts.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import { createFinalObservationCustody, verificationAssignments } from '../src/protocol-transforms.js'
import { dashboardHandovers } from '../src/dashboard-handovers.js'
import { RunMachine } from '../src/machine.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { instruction } from './support/instructions.js'

const definition = compileExperimentConfig({ ...manifest, }).definition
const task = (id: string) => definition.stages.flatMap(s => s.waves.flatMap(w => w.tasks)).find(t => t.id === id)!
const artifact = (taskId: string, protocol: ProtocolMetadata) => ({ id: taskId, taskId, stageId: 'fixture', waveId: 'fixture',
  model: 'fixture', provider: 'fixture', actorId: taskId, status: 'accepted', contentDigest: taskId.padEnd(64, 'a'), protocol }) as ArtifactRecord
const ids = ['OBS-A1', 'OBS-A2', 'OBS-A3']
const research = artifact('research', { research: { role: 'researcher', buildsOn: 'none', materialHighCriticalDelta: true,
  observations: ids.map((id, i) => ({ id, statement: ['Authorized operation may interrupt recovery', 'Administrator may alter policy', 'Duplicate authorized recovery path'][i]!,
    conditions: [i === 1 ? 'Administrator changes policy' : 'Authorized caller uses normal operation'], consequence: 'Recovery may fail',
    evidence: ['Earlier executable test: fixture-test passed its failure assertion'] })) } })
const synthesis = artifact('synthesizer', { synthesisDispositions: ids.map(id => ({ id, disposition: 'candidate', reference: 'C-1', rationale: 'Grouped for review' })), retainedReferences: ['C-1'] })
const union = artifact('negative-review-union', { reviewUnion: ids.map(observationId => ({ observationId, decisions: [], retainedReferences: ['C-1'], dissent: false })) })
const visible = [research, synthesis, union]
const outcome = (observationIds: string[], overrides: Partial<VerificationOutcome> = {}): VerificationOutcome => ({ reference: 'C-1', observationIds,
  behavior: 'unresolved', exploitability: 'unresolved', evidenceMethod: 'source-inspection', evidence: 'Static inspection of the authorized recovery path.', ...overrides })
const parse = (outcomes: VerificationOutcome[], artifacts = visible) => readSubmission(task('verifier'), { [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes }) }, artifacts)
const links = ids.map(observationId => ({ observationId, reference: 'C-1', section: '## Coverage and uncertainty' }))
const parseReport = (reportSections = links, report = '## Coverage and uncertainty\nThe authorized recovery condition remains unresolved; administrator privileges alone do not refute it.') => readSubmission(task('reporter'), {
  [SUBMISSION_PATH]: JSON.stringify({ complete: true, retainedReferences: ['C-1'], reportSections }), 'finding-draft.md': report,
}, visible)

describe('observation-level verification and report handoff', () => {
  it('keeps distinct mechanisms in one group and permits true duplicates to share an outcome/test', async () => {
    const outcomes = [outcome(['OBS-A1', 'OBS-A3']), outcome(['OBS-A2'], { exploitability: 'refuted', evidence: 'Policy modification is an explicit administrator power.' })]
    expect((await parse(outcomes)).issues).toEqual([])
    expect((await parse(ids.map(id => outcome([id])))).issues).toEqual([])
    const projection = await dashboardHandovers({ artifacts: [...visible, artifact('verifier', { verificationOutcomes: outcomes })] } as unknown as RunState)
    expect(projection.rows[0]!.verification).toHaveLength(1)
    expect(projection.rows[0]!.verification[0]!.exploitability).toBe('unresolved')
    expect(projection.rows[1]!.verification[0]!.exploitability).toBe('refuted')
    expect(projection.rows[0]!.observation).toMatchObject({ evidence: research.protocol.research!.observations[0]!.evidence })
    expect(projection.rows[0]!.verification[0]!.evidenceMethod).toBe('source-inspection')
  })
  it('rejects omissions, foreign membership and repeated coverage even when the reference remains', async () => {
    expect((await parse([outcome(['OBS-A1', 'OBS-A2'])])).issues).toContain('verification observation coverage omits C-1/OBS-A3')
    expect((await parse([outcome([...ids, 'FOREIGN'])])).issues).toContain('verification observation coverage adds unexpected C-1/FOREIGN')
    expect((await parse([outcome([...ids, 'OBS-A1'])])).issues).toContain('verification observation coverage repeats C-1/OBS-A1')
    const archived = outcome(ids)
    delete archived.observationIds
    expect((await parse([archived])).issues.length).toBeGreaterThan(0)
  })
  it('keeps challenge, multiple retained mappings and dissent associations', async () => {
    const challenge = artifact('challenge', { challengeObservations: [{ id: 'AC-OBS-1', perspective: 'architecture', disposition: 'unresolved', reference: 'REF-AC-1', rationale: 'Separate caller assumption', referenceEvidence: 'fixture.ts:42' }] })
    const dissent = artifact('negative-review-union', { reviewUnion: [{ observationId: 'OBS-A1', decisions: [], retainedReferences: ['C-1', 'U-2'], dissent: true }] })
    const artifacts = [research, synthesis, challenge, dissent]
    expect(verificationAssignments(artifacts)).toEqual([
      { reference: 'C-1', observationIds: ids }, { reference: 'OBS-A1', observationIds: ['OBS-A1'] },
      { reference: 'REF-AC-1', observationIds: ['AC-OBS-1'] }, { reference: 'U-2', observationIds: ['OBS-A1'] },
    ])
    const outcomes = verificationAssignments(artifacts).map(a => outcome(a.observationIds, { reference: a.reference }))
    expect((await parse(outcomes, artifacts)).issues).toEqual([])
  })
  it('requires actual report sections for each eligible observation and carries them into sealed custody', async () => {
    const result = await parseReport()
    expect(result.issues).toEqual([])
    expect((await parseReport(links, '## Coverage and uncertainty\n### Mechanism\nThe original condition remains plausible pending examination.\n## Other section\nOther discussion.')).issues).toEqual([])
    expect((await parseReport(links.slice(0, 2))).issues).toContain('report observation coverage omits C-1/OBS-A3')
    const custody = await createFinalObservationCustody([...visible, artifact('reporter', result.protocol)])
    expect(custody.observations.map(o => o.reportSections)).toEqual(links.map(link => [link]))
    for (const report of ['## Coverage and uncertainty\n', '```md\n## Coverage and uncertainty\nA fabricated heading in a code fence.\n```',
      '## Coverage and uncertainty\nOBS-A1 OBS-A2 OBS-A3 C-1',
      '## Coverage and uncertainty\n### Title without supporting discussion\n## Other section\nDiscussion belongs elsewhere.',
      '## Coverage and uncertainty\nFirst discussion.\n## Coverage and uncertainty\nSecond discussion.']) {
      expect((await parseReport(links, report)).issues.some(issue => issue.includes('non-empty Markdown section'))).toBe(true)
    }
  })
  it('renders scoped handoffs without requiring one test per observation', () => {
    const input = { definition, visibleArtifacts: visible, deadline: '2030-01-01T00:00:00Z' }
    const verifier = renderTaskPrompt({ ...input, task: task('verifier') })
    expect(verifier).toContain(instruction(definition, 'verificationAssignments'))
    expect(verifier).toContain('"observationIds":["OBS-A1","OBS-A2","OBS-A3"]')
    expect(renderTaskPrompt({ ...input, task: task('reporter') })).toContain('"reportSections"')
  })
})

it('completes the ordinary v4 runner handoff and seal without model or network calls', async () => {
  const machine = await RunMachine.create(definition, 'a'.repeat(64), 'observation-handoff-v4')
  const result = await runExperiment({ definition, machine, provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore() })
  expect(result.state.status).toBe('completed')
  const verifier = result.state.artifacts.find(item => item.taskId === 'verifier')!
  expect(verifier.protocol.verificationOutcomes!.every(item => item.observationIds!.length > 0)).toBe(true)
  const custody = result.state.artifacts.find(item => item.taskId === 'seal-final')!.protocol.finalCustody!
  const expected = verificationAssignments(result.state.artifacts).flatMap(item => item.observationIds.map(id => `${item.reference}/${id}`)).sort()
  expect(custody.observations.flatMap(item => (item.reportSections ?? []).map(link => `${link.reference}/${link.observationId}`)).sort()).toEqual(expected)
})
