import { describe, expect, it } from 'vitest'
import type { AgentResult, ArtifactRecord, ResearchLeadCheck, TaskDefinition } from '../src/contracts.js'
import { canonicalJson } from '../src/canonical.js'
import { writeAccepted, researchIndexPath } from '../src/accepted-mounts.js'
import { audit0Definition } from './support/audit0-config.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { negativeReviewReadingView, createNegativeReviewInput } from '../src/protocol-transforms.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { namespaceResearchResult } from '../src/runner.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import { instruction } from './support/instructions.js'

function task(id: string): TaskDefinition {
  const found = v3Definition.stages.flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks).find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`missing ${id}`)
  return found
}

const v3Definition = compileExperimentConfig({ ...structuredClone(document), }).definition

function artifact(id: string, protocol: ArtifactRecord['protocol']): ArtifactRecord {
  return {
    id: `fixture/${id}`, stageId: 'discovery', waveId: 'wave-0', taskId: id, status: 'accepted',
    actorId: `actor-${id}`, model: 'fixture-model', provider: 'fixture-provider',
    promptDigest: 'a'.repeat(64), contentDigest: 'b'.repeat(64), uri: `memory://${id}`,
    files: ['evidence.md', SUBMISSION_PATH], assertions: [], protocol,
    usage: { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: 0 },
  }
}

function workspace() {
  const files = new Map<string, string>()
  return {
    files,
    async exec() {},
    async mkdir() {},
    async writeFile(path: string, content: string) { files.set(path, content) },
  }
}

const observation = {
  id: 'A1', statement: 'A later transition may reach a privileged operation.',
  conditions: ['The object has completed setup.'],
  consequence: 'A protected state change may become reachable.',
  evidence: ['A source branch and an adjacent setup-path trace.'],
}

function researchSubmission(check: Record<string, unknown>) {
  return {
    complete: true, materialHighCriticalDelta: true, observations: [observation],
    leadChecks: [check],
  }
}

const unresolvedCheck = {
  observationId: 'A1', claimConditions: ['The object has completed setup.'],
  examinedConditions: ['The object is being created.'],
  remainingUntestedConditions: ['The object has completed setup.'],
  evidenceMethod: 'fresh-execution', conclusion: 'unresolved',
  evidence: 'The setup-path trace does not exercise the later transition.',
}

describe('opt-in v3 review and lead custody', () => {
  it('uses current research and review contracts without schema switches', () => {
    const defaultResearch = audit0Definition.stages.flatMap(stage => stage.waves)
      .flatMap(wave => wave.tasks).find(candidate => candidate.id === 'core-wave-0-research-1')
    expect(defaultResearch?.output.schema).toBe('ack3.research-delta.policy-v3')
    expect(task('core-wave-0-research-1').output.schema).toBe('ack3.research-delta.policy-v3')
    expect(task('negative-review-primary').output.schema).toBe('ack3.negative-review.policy-v3')
    expect(task('negative-review-replica').output.schema).toBe('ack3.negative-review.policy-v3')
    const researchTasks = v3Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves.flatMap(wave => wave.tasks).filter(candidate => candidate.promptKind === 'research')
    expect(researchTasks.length).toBeGreaterThan(3)
    expect(researchTasks.every(candidate => candidate.output.schema === 'ack3.research-delta.policy-v3')).toBe(true)
    expect(renderTaskPrompt({ definition: v3Definition, task: researchTasks[0]!, visibleArtifacts: [],
      deadline: '2099-01-01T00:00:00Z', diagnostics: ['leadChecks must be an array'],
      formatRepairOnly: true })).toContain('leadChecks')
    const handoff = renderTaskPrompt({ definition: v3Definition, task: researchTasks[0]!,
      visibleArtifacts: [], deadline: '2099-01-01T00:00:00Z' })
    expect(handoff).toContain(instruction(v3Definition, 'leadReconciliation'))
    expect(handoff).toContain(instruction(v3Definition, 'researchLeadCheckRules'))
    const v2Handoff = renderTaskPrompt({ definition: audit0Definition, task: defaultResearch!,
      visibleArtifacts: [], deadline: '2099-01-01T00:00:00Z' })
    expect(v2Handoff).toContain(instruction(audit0Definition, 'leadReconciliation'))
    expect(() => compileExperimentConfig({ ...structuredClone(document), outputContractVersion: 5 }))
      .toThrow('unknown keys')
  })

  it('keeps an adjacent-path lead unresolved and carries it to synthesis and both review inputs', async () => {
    const researchTask = task('core-wave-0-research-1')
    expect(researchTask.output.schema).toBe('ack3.research-delta.policy-v3')
    const parsed = await readSubmission(researchTask, {
      [SUBMISSION_PATH]: JSON.stringify(researchSubmission(unresolvedCheck)),
    }, [])
    expect(parsed.issues).toEqual([])
    const result = namespaceResearchResult(researchTask, {
      status: 'accepted', actorId: 'fixture', model: researchTask.model, provider: 'fixture',
      files: {}, assertions: [], protocol: parsed.protocol, inputTokens: 1, outputTokens: 1, costUsd: 0,
    } satisfies AgentResult)
    const research = artifact(researchTask.id, result.protocol)
    const id = research.protocol.research!.observations[0]!.id
    expect(research.protocol.research?.leadChecks?.[0]?.observationId).toBe(id)

    const synthesis = workspace()
    await writeAccepted(synthesis, { task: task('synthesizer'), visibleArtifacts: [research] }, {
      async read() { return { 'evidence.md': 'Source evidence', [SUBMISSION_PATH]: '{}' } },
    })
    expect(synthesis.files.get(researchIndexPath)).toContain(`Lead check ${id} | unresolved`)
    expect(synthesis.files.get(researchIndexPath)).toContain('The object has completed setup.')

    const frontier = [research, artifact('synthesizer', { synthesisDispositions: [{
      id, disposition: 'unresolved', reference: 'U-1', rationale: 'Later transition remains untested.',
    }] })]
    const packet = await createNegativeReviewInput(frontier)
    expect(packet.entries[0]?.leadCheck?.remainingUntestedConditions).toEqual(['The object has completed setup.'])
    const primary = workspace()
    const replica = workspace()
    await writeAccepted(primary, { task: task('negative-review-primary'), visibleArtifacts: frontier }, {
      async read() { throw new Error('review must not mount peer raw files') },
    })
    await writeAccepted(replica, { task: task('negative-review-replica'), visibleArtifacts: frontier }, {
      async read() { throw new Error('review must not mount peer raw files') },
    })
    for (const [mount, prefix] of [[primary, '/workspace/results'], [replica, '/input']] as const) {
      const raw = mount.files.get(`${prefix}/negative-disposition-review-input.json`)
      const view = mount.files.get(`${prefix}/negative-disposition-review-view.json`)
      expect(raw).toBe(canonicalJson(packet))
      expect(view).toBe(negativeReviewReadingView(packet))
      expect(view).toContain('remainingUntestedConditions')
      expect(JSON.parse(view!).entries[0].primaryDisposition).toEqual(packet.entries[0]!.primaryDisposition)
    }
  })

  it('rejects internally contradictory refutations but permits source-only refutation', async () => {
    const research = task('core-wave-0-research-1')
    const parse = (check: Record<string, unknown>) => readSubmission(research, {
      [SUBMISSION_PATH]: JSON.stringify(researchSubmission(check)),
    }, [])
    const adjacent = await parse({ ...unresolvedCheck, conclusion: 'refuted' })
    expect(adjacent.issues).toContain('submission.leadChecks[0] cannot refute a claim with declared untested conditions')
    const unexamined = await parse({ ...unresolvedCheck, conclusion: 'refuted',
      remainingUntestedConditions: [], evidenceMethod: 'not-attempted', examinedConditions: [] })
    expect(unexamined.issues).toContain('submission.leadChecks[0] cannot refute a claim that was not examined')
    const sourceOnly = await parse({ ...unresolvedCheck, conclusion: 'refuted',
      remainingUntestedConditions: [], evidenceMethod: 'source-inspection',
      examinedConditions: ['A source guard makes the later transition unreachable.'],
      evidence: 'The source guard excludes the later transition in every branch.' })
    expect(sourceOnly.issues).toEqual([])
    const absent = await parse({ ...unresolvedCheck, observationId: 'A2' })
    expect(absent.issues).toContain('submission.leadChecks[0].observationId must identify a submitted observation')
  })

  it('rejects a false empty-primary echo while leaving v2 packet and decisions compatible', async () => {
    const id = 'OBS-LUNA-W0-R1-A1'
    const frontier = [artifact('research', { research: {
      role: 'researcher', buildsOn: 'none', materialHighCriticalDelta: true,
      observations: [{ ...observation, id }],
    } }), artifact('synthesizer', { synthesisDispositions: [{
      id, disposition: 'candidate', reference: 'C-1', rationale: 'Recorded mechanism remains open.',
    }] })]
    const packet = await createNegativeReviewInput(frontier)
    expect(packet.entries[0]).not.toHaveProperty('leadCheck')
    const v3 = task('negative-review-primary')
    expect(v3.output.schema).toBe('ack3.negative-review.policy-v3')
    const falseEmpty = { observationId: id, reviewedPrimaryDisposition: 'refuted',
      reviewedPrimaryReference: 'none', action: 'unresolved', finalDisposition: 'unresolved',
      finalReference: 'REF-EMPTY', rationale: 'The input observation looked empty.' }
    const invalid = await readSubmission(v3, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, decisions: [falseEmpty] }),
    }, frontier)
    expect(invalid.issues).toContain('submission.decisions[0].reviewedPrimaryDisposition differs from the frozen primary disposition')
    expect(invalid.issues).toContain('submission.decisions[0].reviewedPrimaryReference differs from the frozen primary reference')
    expect(invalid.issues.filter(issue => issue.includes('reviewedPrimary'))).toHaveLength(2)
    const valid = await readSubmission(v3, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, decisions: [{
        ...falseEmpty, reviewedPrimaryDisposition: 'candidate', reviewedPrimaryReference: 'C-1',
        action: 'unresolved', finalDisposition: 'unresolved', finalReference: 'U-1',
      }] }),
    }, frontier)
    expect(valid.issues).toEqual([])
    const v2 = audit0Definition.stages.flatMap(stage => stage.waves)
      .flatMap(wave => wave.tasks).find(candidate => candidate.id === 'negative-review-primary')!
    const legacy = await readSubmission({ ...v2, output: { ...v2.output, schema: 'ack3.negative-review.policy-v2' } }, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, decisions: [{
        observationId: id, action: 'unresolved', finalDisposition: 'unresolved',
        finalReference: 'REF-EMPTY', rationale: 'The input observation looked empty.',
      }] }),
    }, frontier)
    expect(legacy.issues).toEqual([])
    expect(legacy.protocol.reviewInputDigest).toBe(packet.inputSha256)
    expect(renderTaskPrompt({ definition: v3Definition, task: v3, visibleArtifacts: frontier,
      deadline: '2099-01-01T00:00:00Z' })).toContain('reviewedPrimaryDisposition')
    expect(renderTaskPrompt({ definition: v3Definition, task: v3, visibleArtifacts: frontier,
      deadline: '2099-01-01T00:00:00Z', diagnostics: ['reviewedPrimaryDisposition differs'],
      formatRepairOnly: true })).toContain('reviewedPrimaryDisposition')
  })

  it('renders a challenge observation with the same primaryDisposition object shape', async () => {
    const packet = await createNegativeReviewInput([artifact('challenge-architecture', {
      challengeObservations: [{ id: 'ARCH-OBS-1', perspective: 'architecture',
        disposition: 'refuted', reference: 'none',
        rationale: 'A synthetic boundary check excludes this path.', referenceEvidence: null }],
    })])
    const view = JSON.parse(negativeReviewReadingView(packet)) as { entries: Array<Record<string, unknown>> }
    expect(view.entries[0]?.sourceKind).toBe('challenge')
    expect(view.entries[0]?.primaryDisposition).toEqual(packet.entries[0]?.primaryDisposition)
    expect(view.entries[0]?.observation).toEqual({
      rationale: 'A synthetic boundary check excludes this path.', referenceEvidence: null,
    })
  })

  it('fails closed when accepted lead metadata would vanish from later packets', async () => {
    const orphan = artifact('research', { research: {
      role: 'researcher', buildsOn: 'none', materialHighCriticalDelta: true,
      observations: [{ ...observation, id: 'OBS-LUNA-W0-R1-A1' }],
      leadChecks: [{ ...unresolvedCheck, observationId: 'OBS-LUNA-W0-R1-A2' } as ResearchLeadCheck],
    } })
    await expect(createNegativeReviewInput([orphan])).rejects.toThrow('research lead check lacks a unique observation')
  })
})
