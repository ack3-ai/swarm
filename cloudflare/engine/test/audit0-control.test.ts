import { describe, expect, it } from 'vitest'
import { audit0Request, operationLatency, summarizeStatus } from '../tools/audit0-control-lib.js'

describe('audit0 operator control', () => {
  it('builds start, status, stop, and fresh-child resume requests', () => {
    expect(audit0Request('start', ['audit0-live-001'])).toMatchObject({ method: 'POST', body: { runId: 'audit0-live-001' }, timingField: 'dispatchMs' })
    expect(audit0Request('start', ['smoke-001'], 'audit0-smoke')).toMatchObject({
      path: '/v1/experiments/audit0-smoke/runs', body: { runId: 'smoke-001' },
    })
    expect(audit0Request('status', ['audit0-live-001'])).toEqual({ method: 'GET', path: '/v1/runs/audit0-live-001' })
    expect(audit0Request('stop', ['audit0-live-001'])).toEqual({ method: 'POST', path: '/v1/runs/audit0-live-001/stop' })
    expect(audit0Request('resume', ['audit0-child-001', 'a'.repeat(64)])).toMatchObject({
      body: { childRunId: 'audit0-child-001', checkpointDigest: 'a'.repeat(64) },
      timingField: 'resumeDispatchMs',
    })
    expect(audit0Request('resume', ['smoke-child-001', 'a'.repeat(64)], 'audit0-smoke'))
      .toMatchObject({ path: '/v1/experiments/audit0-smoke/resumes' })
    expect(() => audit0Request('start', ['smoke-001'], 'bad id')).toThrow('experiment ID')
    expect(() => audit0Request('resume', ['audit0-live-001', 'a'.repeat(64)])).not.toThrow()
    expect(() => audit0Request('resume', ['bad id', 'a'.repeat(64)])).toThrow('fresh run ID')
    expect(audit0Request('resume-revalidate', [
      'audit0-child-002', 'a'.repeat(64), 'audit0-failed-001', 'b'.repeat(64),
    ])).toMatchObject({
      body: {
        childRunId: 'audit0-child-002',
        checkpointDigest: 'a'.repeat(64),
        revalidate: { sourceRunId: 'audit0-failed-001', outputDigest: 'b'.repeat(64) },
      },
      timingField: 'resumeDispatchMs',
    })
  })

  it('reports the latency target without turning an accepted mutation into a failure', () => {
    expect(operationLatency('resumeDispatchMs', 20, 80)).toEqual({
      endToEndMs: 80, latencyTargetMs: 1_000, latencyTargetMet: true,
    })
    expect(operationLatency('resumeDispatchMs', 1_100, 1_250)).toEqual({
      endToEndMs: 1_250, latencyTargetMs: 1_000, latencyTargetMet: false,
    })
    expect(() => operationLatency('resumeDispatchMs', undefined, 80)).toThrow('missing')
  })

  it('prints checkpoint heads and accounting without full artifact bodies', () => {
    expect(summarizeStatus({
      state: {
        runId: 'parent', status: 'stopped', cursor: { stageIndex: 1, waveIndex: 0 }, recoveryEpoch: 0,
        parentRunId: null, parentCheckpointDigest: null,
        checkpoints: [{ digest: 'a'.repeat(64), body: { cursor: { stageIndex: 1, waveIndex: 0 }, sealedAt: 'now' } }],
        stageEndReceipts: [], budget: { calls: 3 }, artifacts: [{ large: 'omitted' }], rejectedAttempts: [],
        terminalReason: 'operator stop', updatedAt: 'now',
      },
      workflow: { status: 'complete' },
    })).toMatchObject({ runId: 'parent', artifactCount: 1, rejectedAttemptCount: 0, checkpoints: [{ digest: 'a'.repeat(64) }] })
  })
})
