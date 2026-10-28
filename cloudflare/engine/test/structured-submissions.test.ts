import { describe, expect, it } from 'vitest'
import refutedReferenceVariants from './fixtures/refuted-reference-variants.json' with { type: 'json' }
import type { AgentResult, ArtifactRecord, TaskDefinition } from '../src/contracts.js'
import {
  SUBMISSION_PATH,
  createCoverageUnion,
  createNegativeReviewInput,
  readSubmission,
  validateAgentResult,
} from '../src/index.js'
import { audit0Definition } from './support/audit0-config.js'
import { providerIdentity } from '../src/provider-identity.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { namespaceResearchResult } from '../src/runner.js'
import { instruction } from './support/instructions.js'

function task(id: string): TaskDefinition {
  const original = audit0Definition.stages.flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks).find(candidate => candidate.id === id || (id.startsWith('challenge-') && candidate.promptKind === 'coverage-challenge'))
  if (original === undefined) throw new Error(`missing task ${id}`)
  const value = structuredClone(original)
  value.id = id
  if (id.startsWith('challenge-')) {
    const perspective = id.slice('challenge-'.length) as NonNullable<TaskDefinition['perspective']>
    value.perspective = perspective
    value.observationPrefix = { architecture: 'ARCH', 'resource-lifecycle': 'LIFE', 'effective-state': 'STATE', 'open-adversarial': 'OPEN' }[perspective!]
  }
  // These parser fixtures exercise persisted policy-v2 documents, not current configuration.
  value.output.schema = value.output.schema.replace(/policy-v[34]$/, 'policy-v2')
  if (id === 'negative-review-replica') value.optional = true
  return value
}

function artifact(taskId: string, protocol: ArtifactRecord['protocol']): ArtifactRecord {
  return {
    id: `fixture/${taskId}`, stageId: 'discovery', waveId: 'wave-0', taskId, status: 'accepted',
    actorId: `actor-${taskId}`, model: 'gpt-codex-a', provider: 'openai-codex-subscription',
    promptDigest: 'a'.repeat(64), contentDigest: 'b'.repeat(64), uri: `memory://${taskId}`,
    files: ['evidence.md', SUBMISSION_PATH], assertions: [], protocol,
    usage: { modelCalls: 1, inputTokens: 10, outputTokens: 10, costUsd: 0 },
  }
}

function result(task: TaskDefinition, files: Record<string, string>, protocol: AgentResult['protocol']): AgentResult {
  return {
    status: 'accepted', actorId: 'fixture-actor', model: task.model,
    provider: providerIdentity(task),
    files, assertions: [], protocol, inputTokens: 10, outputTokens: 10, costUsd: 0,
  }
}

describe('structured model submissions', () => {
  it('derives research administration from the task while retaining substantive local records', async () => {
    const definition = task('core-wave-0-research-1')
    const files = {
      [definition.output.requiredFiles[0]!]: '# Arbitrary human research notes\n',
      [SUBMISSION_PATH]: JSON.stringify({
        complete: true,
        nextExperiment: 'exercise the withdrawal boundary',
        materialHighCriticalDelta: true,
        observations: [{
          id: 'A1', statement: 'An external caller can reach the transfer path.',
          conditions: ['The target retains a positive balance.'],
          consequence: 'Custody can move without the expected authorization.',
          evidence: ['src/HelloVault.sol and a focused reproduction'],
        }],
      }),
    }
    const parsed = await readSubmission(definition, files, [])
    expect(parsed.issues).toEqual([])
    expect(parsed.protocol.research).toMatchObject({
      role: definition.research?.role,
      buildsOn: definition.research?.buildsOn,
      nextExperiment: 'exercise the withdrawal boundary',
      materialHighCriticalDelta: true,
    })
    await expect(validateAgentResult(definition, result(definition, files, parsed.protocol), []))
      .resolves.toEqual([])
  })

  it('accepts only this research task’s canonical observation IDs and normalizes aliases once', async () => {
    const definition = task('core-wave-0-research-1')
    const observation = (id: string) => ({
      id, statement: 'A synthetic transition is reachable.', conditions: ['The fixture is initialized.'],
      consequence: 'The fixture changes state.', evidence: ['src/Fixture.sol:10-20'],
    })
    const submission = (ids: string[]) => ({
      complete: true, nextExperiment: 'check the next boundary', materialHighCriticalDelta: true,
      observations: ids.map(observation),
    })
    const parse = async (ids: string[], selected: TaskDefinition = definition) => readSubmission(
      selected, { [SUBMISSION_PATH]: JSON.stringify(submission(ids)) }, [],
    )
    const local = await parse(['A1'])
    const canonical = await parse(['OBS-LUNA-W0-R1-A1'])
    expect(local.issues).toEqual([])
    expect(canonical.issues).toEqual([])
    expect(canonical.protocol.research?.observations).toEqual(local.protocol.research?.observations)
    const namespaced = namespaceResearchResult(definition, result(definition, {}, canonical.protocol))
    expect(namespaced.protocol.research?.observations).toEqual([observation('OBS-LUNA-W0-R1-A1')])

    for (const id of [
      'OBS-LUNA-W1-R1-A1', 'OBS-LUNA-W0-R2-A1', 'OBS-DEEPSEEK-W0-R1-A1',
      'OBS-LUNA-W0-R1-S1', 'OBS-LUNA-W0-R1-A0',
      'OBS-LUNA-W0-R1-OBS-LUNA-W0-R1-A1',
    ]) expect((await parse([id])).issues.length).toBeGreaterThan(0)
    expect((await parse(['A1', 'OBS-LUNA-W0-R1-A1'])).issues)
      .toContain('submission observation IDs repeats A1')

    const providerATask: TaskDefinition = {
      ...definition, id: 'pool-ds-a-wave-0-research-1', modelPool: 'ds-a',
      providerClass: 'additive',
    }
    const providerCTask: TaskDefinition = { ...providerATask, id: 'pool-ds-c-wave-0-research-1', modelPool: 'ds-c' }
    expect((await parse(['OBS-DS-A-W0-R1-A1'], providerATask)).issues).toEqual([])
    expect((await parse(['OBS-DS-A-W0-R1-A1'], providerCTask)).issues.length).toBeGreaterThan(0)
  })

  it('rejects unknown fields, incomplete templates, malformed JSON, and non-local research IDs', async () => {
    const definition = task('core-wave-0-research-1')
    const document = { [definition.output.requiredFiles[0]!]: 'human evidence' }
    for (const submission of [
      '{',
      JSON.stringify({ complete: false, nextExperiment: '', materialHighCriticalDelta: false, observations: [] }),
      JSON.stringify({
        complete: true, nextExperiment: 'next', materialHighCriticalDelta: false, extra: 'forbidden',
        observations: [{
          id: 'OBS-GLOBAL-1', statement: 'statement', conditions: [], consequence: 'consequence', evidence: ['evidence'],
        }],
      }),
    ]) {
      const parsed = await readSubmission(definition, { ...document, [SUBMISSION_PATH]: submission }, [])
      expect(parsed.issues.length).toBeGreaterThan(0)
    }
  })

  it('treats the research next-step as optional without weakening evidence validation', async () => {
    const core = task('core-wave-0-research-1')
    const additive: TaskDefinition = { ...core, id: 'pool-ds-wave-0-research-1', providerClass: 'additive' }
    for (const selected of [core, additive]) {
      const input = { definition: audit0Definition, task: selected, visibleArtifacts: [], deadline: '2030-01-01T00:00:00Z' }
      const fresh = renderTaskPrompt(input)
      expect(fresh).toContain(instruction(audit0Definition, 'nextExperiment'))
      expect(renderTaskPrompt({ ...input, diagnostics: [] })).toBe(fresh)
      expect(renderTaskPrompt({ ...input, diagnostics: ['submission.observations must not be empty'] }))
        .toContain(instruction(audit0Definition, 'nextExperiment'))
    }

    const observation = { id: 'A1', statement: 'A possible failure path needs checking.', conditions: [],
      consequence: 'A protected outcome could change.', evidence: ['A source path warrants inspection.'] }
    const submission = (fields: Record<string, unknown> = {}) => ({
      complete: true, materialHighCriticalDelta: false, observations: [observation], ...fields,
    })
    for (const fields of [{}, { nextExperiment: '' }, { nextExperiment: '   ' }]) {
      const parsed = await readSubmission(core, { [SUBMISSION_PATH]: JSON.stringify(submission(fields)) }, [])
      expect(parsed.issues).toEqual([])
      expect(parsed.protocol.research?.observations).toEqual([observation])
      expect(parsed.protocol.research).not.toHaveProperty('nextExperiment')
    }
    const proposed = await readSubmission(core, { [SUBMISSION_PATH]: JSON.stringify(submission({
      nextExperiment: '  Check the remaining boundary.  ',
    })) }, [])
    expect(proposed.issues).toEqual([])
    expect(proposed.protocol.research?.nextExperiment).toBe('Check the remaining boundary.')
    const malformedNext = await readSubmission(core, { [SUBMISSION_PATH]: JSON.stringify(submission({
      nextExperiment: null,
    })) }, [])
    expect(malformedNext.issues).toContain('submission.nextExperiment must be a string when present')
    const invalidEvidence = await readSubmission(core, { [SUBMISSION_PATH]: JSON.stringify({
      ...submission(), observations: [{ ...observation, evidence: [] }],
    }) }, [])
    expect(invalidEvidence.issues).toContain('submission.observations[0].evidence must be a non-empty array of non-empty strings')
  })

  it('requires synthesis to disposition every frozen observation exactly once', async () => {
    const definition = task('synthesizer')
    const frontier = [artifact('research-1', { research: {
      role: 'researcher', buildsOn: 'none', nextExperiment: 'next', materialHighCriticalDelta: true,
      observations: [
        { id: 'OBS-LUNA-W0-R1-A1', statement: 'one', conditions: [], consequence: 'impact', evidence: ['source one'] },
        { id: 'OBS-LUNA-W0-R1-A2', statement: 'two', conditions: [], consequence: 'impact', evidence: ['source two'] },
      ],
    } })]
    const base = { complete: true, retainedReferences: ['C-1'], dispositions: [
      { id: 'OBS-LUNA-W0-R1-A1', disposition: 'candidate', reference: 'C-1', rationale: 'evidence remains material' },
    ] }
    const missing = await readSubmission(definition, { [SUBMISSION_PATH]: JSON.stringify(base) }, frontier)
    expect(missing.issues).toContain('synthesis dispositions omits OBS-LUNA-W0-R1-A2')
    const complete = await readSubmission(definition, { [SUBMISSION_PATH]: JSON.stringify({
      ...base,
      dispositions: [...base.dispositions, {
        id: 'OBS-LUNA-W0-R1-A2', disposition: 'refuted', reference: 'none', rationale: 'guard blocks this behavior',
      }],
    }) }, frontier)
    expect(complete.issues).toEqual([])
    expect(complete.protocol.retainedReferences).toEqual(['C-1'])
  })

  it('derives assignment bounds from frozen frontiers larger than 512 records', async () => {
    const observationCount = 513
    const observations = Array.from({ length: observationCount }, (_, index) => ({
      id: `OBS-LUNA-W${Math.floor(index / 64)}-R1-A${index + 1}`,
      statement: `sanitized observation ${index + 1}`,
      conditions: [],
      consequence: 'sanitized material consequence',
      evidence: [`sanitized evidence ${index + 1}`],
    }))
    const research = Array.from({ length: Math.ceil(observationCount / 64) }, (_, index) => artifact(
      `large-research-${index + 1}`,
      { research: {
        role: 'researcher', buildsOn: 'none', nextExperiment: 'next', materialHighCriticalDelta: true,
        observations: observations.slice(index * 64, (index + 1) * 64),
      } },
    ))
    const dispositions = observations.map((observation, index) => ({
      id: observation.id,
      disposition: 'candidate' as const,
      reference: `C-${index + 1}`,
      rationale: 'sanitized retained evidence',
    }))
    const references = dispositions.map(value => value.reference)
    const synthesis = await readSubmission(task('synthesizer'), { [SUBMISSION_PATH]: JSON.stringify({
      complete: true, dispositions, retainedReferences: references,
    }) }, research)
    expect(synthesis.issues).toEqual([])
    expect(synthesis.protocol.synthesisDispositions).toHaveLength(observationCount)

    const changedLast = (id: string) => [...dispositions.slice(0, -1), { ...dispositions.at(-1)!, id }]
    const duplicate = await readSubmission(task('synthesizer'), { [SUBMISSION_PATH]: JSON.stringify({
      complete: true, dispositions: changedLast(dispositions[0]!.id), retainedReferences: references,
    }) }, research)
    expect(duplicate.issues).toEqual(expect.arrayContaining([
      `synthesis dispositions repeats ${dispositions[0]!.id}`,
      `synthesis dispositions omits ${dispositions.at(-1)!.id}`,
    ]))
    const unexpected = await readSubmission(task('synthesizer'), { [SUBMISSION_PATH]: JSON.stringify({
      complete: true, dispositions: changedLast('OBS-UNEXPECTED'), retainedReferences: references,
    }) }, research)
    expect(unexpected.issues).toEqual(expect.arrayContaining([
      `synthesis dispositions omits ${dispositions.at(-1)!.id}`,
      'synthesis dispositions adds unexpected OBS-UNEXPECTED',
    ]))

    const reviewFrontier = [...research, artifact('large-synthesis', {
      synthesisDispositions: dispositions,
      retainedReferences: references,
    })]
    const packet = await createNegativeReviewInput(reviewFrontier)
    const decisions = packet.entries.map(entry => ({
      observationId: entry.observationId,
      action: 'uphold',
      finalDisposition: entry.primaryDisposition.disposition,
      finalReference: entry.primaryDisposition.reference,
      rationale: 'sanitized independent review',
    }))
    const review = await readSubmission(task('negative-review-primary'), { [SUBMISSION_PATH]: JSON.stringify({
      complete: true, decisions,
    }) }, reviewFrontier)
    expect(review.issues).toEqual([])
    expect(review.protocol.reviewDecisions).toHaveLength(observationCount)

    const outcomes = references.map(reference => ({
      reference, behavior: 'reproduced', exploitability: 'supported',
      evidenceMethod: 'fresh-execution', evidence: 'sanitized independent test and result',
    }))
    const verification = await readSubmission(task('verifier'), { [SUBMISSION_PATH]: JSON.stringify({
      complete: true, outcomes,
    }) }, [artifact('large-review-union', { dispositionReferences: references })])
    expect(verification.issues).toEqual([])
    expect(verification.protocol.verificationOutcomes).toHaveLength(observationCount)
  })

  it('rejects non-string values for every structured enum field', async () => {
    const invalidValues: unknown[] = [['candidate'], {}, 1, true, null]
    const research = artifact('enum-research', { research: {
      role: 'researcher', buildsOn: 'none', nextExperiment: 'next', materialHighCriticalDelta: true,
      observations: [{
        id: 'OBS-LUNA-W0-R1-A1', statement: 'sanitized observation', conditions: [],
        consequence: 'sanitized consequence', evidence: ['sanitized evidence'],
      }],
    } })
    const validDisposition = {
      id: 'OBS-LUNA-W0-R1-A1', disposition: 'candidate' as const, reference: 'C-1', rationale: 'sanitized evidence',
    }
    for (const value of invalidValues) {
      const parsed = await readSubmission(task('synthesizer'), { [SUBMISSION_PATH]: JSON.stringify({
        complete: true, retainedReferences: ['C-1'], dispositions: [{ ...validDisposition, disposition: value }],
      }) }, [research])
      expect(parsed.issues).toContain(
        'submission.dispositions[0].disposition must be one of: candidate, refuted, unresolved',
      )
      expect(parsed.protocol.synthesisDispositions).toEqual([])
    }

    const synthesis = artifact('enum-synthesis', {
      synthesisDispositions: [validDisposition], retainedReferences: ['C-1'],
    })
    const reviewFrontier = [research, synthesis]
    const validDecision = {
      observationId: validDisposition.id, action: 'uphold', finalDisposition: 'candidate',
      finalReference: 'C-1', rationale: 'sanitized independent review',
    }
    for (const field of ['action', 'finalDisposition'] as const) {
      for (const value of invalidValues) {
        const parsed = await readSubmission(task('negative-review-primary'), { [SUBMISSION_PATH]: JSON.stringify({
          complete: true, decisions: [{ ...validDecision, [field]: value }],
        }) }, reviewFrontier)
        expect(parsed.issues).toContain(field === 'action'
          ? 'submission.decisions[0].action must be one of: uphold, narrow, overturn, unresolved'
          : 'submission.decisions[0].finalDisposition must be one of: candidate, refuted, unresolved')
        expect(parsed.protocol.reviewDecisions).toEqual([])
      }
    }

    const verificationFrontier = [artifact('enum-review-union', { dispositionReferences: ['C-1'] })]
    const validOutcome = {
      reference: 'C-1', behavior: 'reproduced', exploitability: 'supported',
      evidenceMethod: 'fresh-execution', evidence: 'sanitized independent test and result',
    }
    for (const field of ['behavior', 'exploitability', 'evidenceMethod'] as const) {
      for (const value of invalidValues) {
        const parsed = await readSubmission(task('verifier'), { [SUBMISSION_PATH]: JSON.stringify({
          complete: true, outcomes: [{ ...validOutcome, [field]: value }],
        }) }, verificationFrontier)
        expect(parsed.issues).toContain(field === 'behavior'
          ? 'submission.outcomes[0].behavior must be one of: reproduced, not-reproduced, unresolved'
          : field === 'exploitability'
            ? 'submission.outcomes[0].exploitability must be one of: supported, refuted, unresolved'
            : 'submission.outcomes[0].evidenceMethod must be one of: fresh-execution, prior-execution-reviewed, source-inspection, not-attempted')
        expect(parsed.protocol.verificationOutcomes).toEqual([])
      }
    }
  })

  it('keeps challenge evidence in explicit records and rejects duplicate or unbound references', async () => {
    const definition = task('challenge-resource-lifecycle')
    const valid = {
      complete: true,
      observations: [{
        id: 'LIFE-OBS-1', disposition: 'candidate', reference: 'REF-LIFE-1',
        rationale: 'The lifecycle leaves an externally reachable transition.',
        referenceEvidence: 'src/HelloVault.sol and the focused lifecycle reproduction',
      }],
    }
    const accepted = await readSubmission(definition, { [SUBMISSION_PATH]: JSON.stringify(valid) }, [])
    expect(accepted.issues).toEqual([])
    expect(accepted.protocol.challengeObservations?.[0]).toMatchObject({
      perspective: 'resource-lifecycle', reference: 'REF-LIFE-1',
    })
    const challengeFiles = {
      [definition.output.requiredFiles[0]!]: '# Independent challenge\n\n### REF-LIFE-1\n\nThe focused state trace supports this cause.\n',
      [SUBMISSION_PATH]: JSON.stringify(valid),
    }
    await expect(validateAgentResult(definition, result(definition, challengeFiles, accepted.protocol), []))
      .resolves.toEqual([])
    await expect(validateAgentResult(definition, result(definition, {
      ...challengeFiles, [definition.output.requiredFiles[0]!]: '# Independent challenge\n\n### REF-1\n',
    }, accepted.protocol), [])).resolves.toContain('coverage challenge lacks evidence heading for REF-LIFE-1')
    for (const observations of [
      [valid.observations[0], valid.observations[0]],
      [{ ...valid.observations[0], referenceEvidence: null }],
      [{ ...valid.observations[0], reference: 'REF-1' }],
      [{ ...valid.observations[0], reference: 'REF-ARCH-1' }],
    ]) {
      const rejected = await readSubmission(definition, {
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations }),
      }, [])
      expect(rejected.issues.length).toBeGreaterThan(0)
    }
    const unscoped = await readSubmission(definition, { [SUBMISSION_PATH]: JSON.stringify({
      ...valid, observations: [{ ...valid.observations[0], reference: 'REF-1' }],
    }) }, [])
    expect(unscoped.issues).toContain('submission.observations[0].reference must use REF-LIFE-N')
  })

  it('normalizes only refuted no-evidence sentinels while retaining required candidate evidence', async () => {
    const definition = task('challenge-architecture')
    const candidate = {
      id: 'ARCH-OBS-1', disposition: 'candidate', reference: 'REF-ARCH-1',
      rationale: 'The synthetic fixture has a reachable adverse transition.',
      referenceEvidence: 'src/Fixture.sol:10-20 and a focused state trace',
    }
    const refuted = (index: number, referenceEvidence: unknown) => ({
      id: `ARCH-OBS-${index}`, disposition: 'refuted', reference: 'none',
      rationale: 'A focused negative control rules out this distinct hypothesis.',
      referenceEvidence,
    })
    const observations = [candidate, ...Array.from({ length: 6 }, (_, index) => refuted(index + 2, 'none'))]
    const accepted = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations }),
    }, [])
    expect(accepted.issues).toEqual([])
    expect(accepted.protocol.challengeObservations?.slice(1).map(item => item.referenceEvidence))
      .toEqual(Array(6).fill(null))
    for (const value of [null, 'none']) {
      const parsed = await readSubmission(definition, {
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [refuted(2, value)] }),
      }, [])
      expect(parsed.issues).toEqual([])
      expect(parsed.protocol.challengeObservations?.[0]?.referenceEvidence).toBeNull()
    }
    for (const value of [null, '', 'none']) {
      for (const disposition of ['candidate', 'unresolved']) {
        const parsed = await readSubmission(definition, {
          [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [{ ...candidate, disposition,
            referenceEvidence: value }] }),
        }, [])
        expect(parsed.issues.length).toBeGreaterThan(0)
      }
    }
    for (const value of ['', '   ', 'NoNe']) {
      const parsed = await readSubmission(definition, {
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [refuted(2, value)] }),
      }, [])
      expect(parsed.issues.length).toBeGreaterThan(0)
    }
    const missing = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [{
        id: 'ARCH-OBS-2', disposition: 'refuted',
        rationale: 'A focused negative control rules out this distinct hypothesis.',
      }] }),
    }, [])
    expect(missing.issues).toContain('submission.observations[0] must contain exactly: disposition, id, rationale, reference, referenceEvidence')
    const prompt = renderTaskPrompt({ definition: audit0Definition, task: definition,
      visibleArtifacts: [], deadline: '2026-10-02T00:00:00.000Z' })
    expect(prompt).toContain(instruction(audit0Definition, 'coverageReferences', { OBSERVATION_PREFIX: definition.observationPrefix! }))
  })

  it('keeps independent challenge reference numbers distinct in the review packet', async () => {
    const observations = [
      { id: 'ARCH-OBS-1', reference: 'REF-ARCH-1', perspective: 'architecture' },
      { id: 'LIFE-OBS-1', reference: 'REF-LIFE-1', perspective: 'resource-lifecycle' },
    ] as const
    const accepted = await Promise.all(observations.map(async observation => {
      const definition = task(`challenge-${observation.perspective}`)
      const parsed = await readSubmission(definition, { [SUBMISSION_PATH]: JSON.stringify({
        complete: true, observations: [{ id: observation.id, reference: observation.reference, disposition: 'candidate',
          rationale: 'A distinct source-derived failure path remains reachable.',
          referenceEvidence: 'src/Fixture.sol:10-20 and a focused state trace',
        }],
      }) }, [])
      expect(parsed.issues).toEqual([])
      return artifact(definition.id, parsed.protocol)
    }))
    const packet = await createNegativeReviewInput(accepted)
    expect(packet.entries.map(entry => entry.primaryDisposition.reference)).toEqual(['REF-ARCH-1', 'REF-LIFE-1'])
    expect(packet.entries.every(entry => !entry.reviewReasons.includes('many-to-one-mapping'))).toBe(true)
  })

  it('canonicalizes reference variants only for explicitly refuted observations', async () => {
    const definition = task('challenge-open-adversarial')
    const parsed = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify(refutedReferenceVariants),
    }, [])
    expect(parsed.issues).toEqual([])
    expect(parsed.protocol.challengeObservations?.map(observation => observation.reference)).toEqual(['none', 'none', 'none'])
    expect(parsed.protocol.challengeObservations?.map(observation => observation.referenceEvidence)).toEqual([
      'Focused trace shows that the adjacent hypothesis does not reproduce.',
      'A focused negative control rejects the second adjacent hypothesis.',
      'A focused reproduction rejects the labeled candidate while retaining its negative evidence.',
    ])

    const nonRefuted = structuredClone(refutedReferenceVariants)
    nonRefuted.observations[0]!.disposition = 'candidate'
    const rejected = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify(nonRefuted),
    }, [])
    expect(rejected.issues).toContain('submission.observations[0].reference must be a non-empty string')

    const invalidRefutation = structuredClone(refutedReferenceVariants) as unknown as {
      observations: Array<Record<string, unknown>>
    }
    invalidRefutation.observations[0]!.reference = { invalid: true }
    const invalid = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify(invalidRefutation),
    }, [])
    expect(invalid.issues).toContain('submission.observations[0].reference must be a non-empty string')
  })

  it('binds negative review administration to the frozen packet and preserves many-to-one decisions', async () => {
    const definition = task('negative-review-primary')
    const frontier = [
      artifact('research', { research: {
        role: 'researcher', buildsOn: 'none', nextExperiment: 'next', materialHighCriticalDelta: true,
        observations: [
          { id: 'OBS-LUNA-W0-R1-A1', statement: 'one', conditions: [], consequence: 'impact', evidence: ['evidence'] },
          { id: 'OBS-LUNA-W0-R1-A2', statement: 'two', conditions: [], consequence: 'impact', evidence: ['evidence'] },
        ],
      } }),
      artifact('synthesis', { synthesisDispositions: [
        { id: 'OBS-LUNA-W0-R1-A1', disposition: 'candidate', reference: 'C-1', rationale: 'first path' },
        { id: 'OBS-LUNA-W0-R1-A2', disposition: 'candidate', reference: 'C-1', rationale: 'second path' },
      ] }),
    ]
    const packet = await createNegativeReviewInput(frontier)
    const decisions = packet.entries.map(entry => ({
      observationId: entry.observationId, action: 'uphold',
      finalDisposition: entry.primaryDisposition.disposition,
      finalReference: entry.primaryDisposition.reference,
      rationale: 'independently retained from frozen evidence',
    }))
    const parsed = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, decisions }),
    }, frontier)
    expect(parsed.issues).toEqual([])
    expect(parsed.protocol.reviewInputDigest).toBe(packet.inputSha256)
    expect(parsed.protocol.reviewDecisions).toHaveLength(2)
    expect(parsed.protocol.dispositionReferences).toEqual(['C-1'])
  })

  it('requires one verification outcome per frozen identifier without parsing narrative layouts', async () => {
    const definition = task('verifier')
    const frontier = [artifact('review-union', {
      dispositionReferences: ['C-1', 'REF-7'], decisionDissentObservationIds: ['OBS-DISSENT'],
    })]
    const outcomes = ['C-1', 'OBS-DISSENT', 'REF-7'].map(reference => ({
      reference, behavior: 'reproduced', exploitability: 'supported',
      evidenceMethod: 'prior-execution-reviewed',
      evidence: `independent execution evidence for ${reference}`,
    }))
    const accepted = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes }),
    }, frontier)
    expect(accepted.issues).toEqual([])
    expect(accepted.protocol.retainedReferences).toEqual(['C-1', 'OBS-DISSENT', 'REF-7'])
    const dropped = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: outcomes.slice(1) }),
    }, frontier)
    expect(dropped.issues).toContain('verification outcomes omits C-1')
  })

  it('records the verification method and rejects claims stronger than that method', async () => {
    const definition = task('verifier')
    const frontier = [artifact('review-union', { dispositionReferences: ['C-1'] })]
    const outcome = {
      reference: 'C-1', behavior: 'unresolved', exploitability: 'supported',
      evidenceMethod: 'source-inspection', evidence: 'Source-only reasoning at a sanitized location',
    }
    const sourceOnly = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: [outcome] }),
    }, frontier)
    expect(sourceOnly.issues).toEqual([])
    expect(sourceOnly.protocol.verificationOutcomes?.[0]?.evidenceMethod).toBe('source-inspection')

    const falseReproduction = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: [{ ...outcome, behavior: 'reproduced' }] }),
    }, frontier)
    expect(falseReproduction.issues).toContain('submission.outcomes[0].behavior must be unresolved for source-inspection')

    const unattemptedClaim = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: [{ ...outcome, evidenceMethod: 'not-attempted' }] }),
    }, frontier)
    expect(unattemptedClaim.issues).toContain('submission.outcomes[0] must leave both axes unresolved for not-attempted')

    const noMethod = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, outcomes: [{
        reference: 'C-1', behavior: 'reproduced', exploitability: 'supported', evidence: 'A sanitized test claim',
      }] }),
    }, frontier)
    expect(noMethod.issues).toContain('submission.outcomes[0].evidenceMethod must be one of: fresh-execution, prior-execution-reviewed, source-inspection, not-attempted')
  })

  it('requires the reporter to acknowledge the complete retained and dissent frontier', async () => {
    const definition = task('reporter')
    const frontier = [artifact('verification', {
      dispositionReferences: ['C-1'], retainedReferences: ['REF-2'], decisionDissentObservationIds: ['OBS-DISSENT'],
    })]
    const parsed = await readSubmission(definition, {
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, retainedReferences: ['OBS-DISSENT', 'C-1'] }),
    }, frontier)
    expect(parsed.issues).toContain('report retained references omits REF-2')
  })

  it('detects protocol tampering and duplicate deterministic union sources', async () => {
    const definition = task('challenge-open-adversarial')
    const files = {
      [definition.output.requiredFiles[0]!]: 'free-form human evidence',
      [SUBMISSION_PATH]: JSON.stringify({
        complete: true,
        observations: [{
          id: 'OPEN-OBS-1', disposition: 'refuted', reference: 'none',
          rationale: 'the tested guard prevents the proposed behavior', referenceEvidence: null,
        }],
      }),
    }
    const parsed = await readSubmission(definition, files, [])
    const issues = await validateAgentResult(definition, result(definition, files, {}), [])
    expect(parsed.issues).toEqual([])
    expect(issues).toContain('protocol metadata differs from the structured submission')

    const duplicate = artifact('challenge-a', { challengeObservations: parsed.protocol.challengeObservations! })
    expect(() => createCoverageUnion([duplicate, { ...duplicate, id: 'other' }]))
      .toThrow('duplicate source observation')
  })

  it('accepts an unavailable optional model only as an empty attested receipt', async () => {
    const definition = task('negative-review-replica')
    const unavailable: AgentResult = {
      status: 'additive-unavailable', actorId: 'deepseek-budget', model: definition.model,
      provider: providerIdentity(definition), files: {}, assertions: [], protocol: {},
      inputTokens: 0, outputTokens: 0, costUsd: 0, unavailableReason: 'provider-credit',
    }
    await expect(validateAgentResult(definition, unavailable, [])).resolves.toEqual([])
    await expect(validateAgentResult(definition, { ...unavailable, files: { [SUBMISSION_PATH]: '{}' } }, []))
      .resolves.toContain('an unavailable task cannot publish output files')
  })
})
