import { describe, expect, it } from 'vitest'
import type { ArtifactRecord, RunState } from '../src/contracts.js'
import { dashboardHandovers } from '../src/dashboard-handovers.js'
import { createNegativeReviewInput } from '../src/protocol-transforms.js'
const artifact = (taskId: string, protocol: ArtifactRecord['protocol'], status = 'accepted') => ({
  id: taskId, taskId, stageId: 'stage', waveId: 'wave', model: 'test-model', provider: 'test', actorId: taskId,
  contentDigest: taskId.padEnd(64, 'a'), status, protocol,
}) as ArtifactRecord
const state = (artifacts: ArtifactRecord[]) => ({ runId: 'test', stateGeneration: 1, artifacts }) as unknown as RunState
const observation = { id: 'OBS-LUNA-W0-R1-1', statement: 'Test observation', conditions: ['condition'], consequence: 'consequence', evidence: ['file:1'] }
const synthesis = artifact('synthesis', { synthesisDispositions: [{ id: observation.id, disposition: 'candidate', reference: 'C-1', rationale: 'reason' }] })
const research = artifact('research', { research: { observations: [observation], buildsOn: 'none', role: 'researcher', nextExperiment: '', materialHighCriticalDelta: false } } as ArtifactRecord['protocol'])
const decision = { observationId: observation.id, action: 'uphold' as const, finalDisposition: 'candidate' as const, finalReference: 'C-1', rationale: 'checked' }

describe('read-only handover projection', () => {
  it('joins source, mappings, independent disagreement, verification and custody without treating custody as confirmation', async () => {
    const packet = await createNegativeReviewInput([research, synthesis])
    const review = artifact('review', { reviewInputDigest: packet.inputSha256, reviewDecisions: [decision] })
    const other = artifact('other', { reviewInputDigest: packet.inputSha256,
      reviewDecisions: [{ ...decision, action: 'unresolved', finalDisposition: 'unresolved', finalReference: 'U-1' }] })
    const result = await dashboardHandovers(state([research, synthesis, review, other,
      artifact('verify', { verificationOutcomes: [{ observationIds: [observation.id], reference: 'U-1', behavior: 'reproduced', exploitability: 'unresolved', evidence: 'test output' }] }),
      artifact('final', { finalCustody: { schemaVersion: 1, sourceReportArtifactDigest: '', negativeReviewUnionArtifactDigest: '', retainedReferences: ['U-1'], decisionDissentObservationIds: [], observations: [{ observationId: observation.id, observationDigest: '', primaryDispositionDigest: '', retainedReferences: ['U-1'], decisionDissent: true }] } }),
      artifact('unavailable', { research: research.protocol.research! }, 'additive-unavailable')]))
    expect(result.packet).toEqual(packet)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ source: { task: 'research' }, dissent: true,
      verification: [{ reference: 'U-1', exploitability: 'unresolved' }], custody: [{ references: ['U-1'] }] })
    expect(result.rows[0]!.reviews).toHaveLength(2)
    expect(result.artifacts).toHaveLength(6)
  })
  it('does not spread an archived reference-only result across observation statuses', async () => {
    const result = await dashboardHandovers(state([research, synthesis, artifact('verify', {
      verificationOutcomes: [{ reference: 'C-1', behavior: 'reproduced', exploitability: 'supported', evidence: 'Historical group assessment' }],
    })]))
    expect(result.rows[0]!.verification).toEqual([])
    expect(result.artifacts.some(value => value.task === 'verify')).toBe(true)
  })
  it('does not claim an unverified or mismatched reconstruction was the reviewer input', async () => {
    expect((await dashboardHandovers(state([research]))).packet).toBeNull()
    expect((await dashboardHandovers(state([research, synthesis]))).packet).toBeNull()
    const result = await dashboardHandovers(state([research, synthesis, artifact('review', { reviewInputDigest: 'wrong', reviewDecisions: [decision] })]))
    expect(result.packet).toBeNull()
    expect(result.packetStatus).toContain('could not be verified')
    expect(result.rows[0]!.reviews).toHaveLength(1)
  })
  it('preserves union-only evidence and explicitly leaves missing source attribution unknown', async () => {
    const result = await dashboardHandovers(state([artifact('union', { reviewUnion: [{ observationId: observation.id, decisions: [{ ...decision, reviewerTaskId: 'absent', model: 'model', actorId: 'actor', provider: 'test' }], dissent: false, retainedReferences: ['C-1'] }] })]))
    expect(result.rows[0]).toMatchObject({ observation: null, source: null, reviews: [{ source: { task: 'absent', digest: 'union'.padEnd(64, 'a') } }] })
    expect(result.packet).toBeNull()
  })
})
