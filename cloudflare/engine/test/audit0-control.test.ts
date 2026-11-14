import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it } from 'vitest'
import { audit0Request, operationLatency, summarizeStatus, withOperationLatency } from '../tools/audit0-control-lib.js'
import { target } from './support/successor-fixture.js'

describe('audit0 operator control', () => {
  it('builds start/status requests and refuses retired resume creation', () => {
    expect(audit0Request('start', ['audit0-live-001'])).toMatchObject({ method: 'POST', body: { runId: 'audit0-live-001' }, timingField: 'dispatchMs' })
    expect(audit0Request('start', ['smoke-001'], 'audit0-smoke')).toMatchObject({
      path: '/v1/experiments/audit0-smoke/runs', body: { runId: 'smoke-001' },
    })
    expect(audit0Request('status', ['audit0-live-001'])).toEqual({ method: 'GET', path: '/v1/runs/audit0-live-001' })
    expect(() => audit0Request('start', ['smoke-001'], 'bad id')).toThrow('experiment ID')
    for (const command of ['resume', 'resume-revalidate', 'restart', 'amend', 'skip']) {
      expect(() => audit0Request(command, ['child', 'a'.repeat(64), 'failed', 'b'.repeat(64)]))
        .toThrow('usage: audit0 start|status|control|controls')
    }
  })

  it('uses the common command schema and explicit identities for audit adjustments', () => {
    const command = { id: 'cancel-1', expectedRevision: 0, action: 'cancel', scope: { kind: 'audit' }, reason: 'operator stop' }
    expect(audit0Request('control', ['audit-1', JSON.stringify(command)], 'experiment-1')).toEqual({
      method: 'POST', path: '/v1/experiments/experiment-1/audits/audit-1/commands', body: command })
    expect(audit0Request('controls', ['audit-1'], 'experiment-1')).toEqual({
      method: 'GET', path: '/v1/experiments/experiment-1/audits/audit-1/commands' })
    expect(audit0Request('controls', ['audit-1', command.id], 'experiment-1')).toEqual({
      method: 'GET', path: '/v1/experiments/experiment-1/audits/audit-1/commands/cancel-1' })
    expect(() => audit0Request('control', ['audit-1', JSON.stringify({ ...command, model: 'inline-override' })])).toThrow('fields')
    expect(() => audit0Request('control', ['audit-1', JSON.stringify({ ...command, expectedRevision: -1 })])).toThrow('revision')
    expect(() => audit0Request('control', ['audit-1'])).toThrow('usage')
    expect(() => audit0Request('controls', ['audit-1', '../escape'])).toThrow('command ID')
    expect(() => audit0Request('stop', ['audit-1'])).toThrow('usage')
  })

  it('reports the latency target without turning an accepted mutation into a failure', () => {
    expect(operationLatency('dispatchMs', 20, 80)).toEqual({
      endToEndMs: 80, latencyTargetMs: 1_000, latencyTargetMet: true,
    })
    expect(operationLatency('dispatchMs', 1_100, 1_250)).toEqual({
      endToEndMs: 1_250, latencyTargetMs: 1_000, latencyTargetMet: false,
    })
    expect(() => operationLatency('dispatchMs', undefined, 80)).toThrow('missing')
    expect(withOperationLatency('dispatchMs', { runId: 'a', dispatchMs: 20 }, 80)).toEqual({
      runId: 'a', dispatchMs: 20, endToEndMs: 80, latencyTargetMs: 1_000, latencyTargetMet: true,
    })
    expect(withOperationLatency('dispatchMs', { runId: 'a', dispatchPending: true }, 80)).toEqual({
      runId: 'a', dispatchPending: true, endToEndMs: 80,
    })
  })

  it('uses the same command CLI to fork a saved review boundary with a published manifest', () => {
    const command = { id: 'review-again', expectedRevision: 0, action: 'fork', reason: 'use replacement reviewers',
      source: { runId: 'completed-audit', state: { generation: 100, digest: 'a'.repeat(64) } },
      stageId: 'negative-review', releaseDigest: 'b'.repeat(64), runtimeRelease: target }
    expect(audit0Request('control', ['completed-audit', JSON.stringify(command)], 'experiment-1')).toEqual({
      method: 'POST', path: '/v1/experiments/experiment-1/audits/completed-audit/commands', body: command })
    expect(() => audit0Request('control', ['completed-audit', JSON.stringify({ ...command, models: ['reviewer-a', 'reviewer-b'] })]))
      .toThrow('fields')
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

  it('shows current controls and fork lineage without interpreting retired recovery fields', () => {
    const controls = { revision: 2, pauses: [{ kind: 'audit' }], lastReceipt: { outcome: { status: 'applied' } } }
    const forkOrigin = { source: { runId: 'source', state: { generation: 40, digest: 'a'.repeat(64) } },
      stageId: 'negative-review', savedWorkDigest: 'b'.repeat(64) }
    const summary = summarizeStatus({ state: { runId: 'child', stateGeneration: 3, controls, forkOrigin,
      recoveryEpoch: 0, parentRunId: null, parentCheckpointDigest: null,
      journal: [{ type: 'run.time-amended', payload: { retired: true } }] } })
    expect(summary).toMatchObject({ stateGeneration: 3, controls, forkOrigin })
    for (const field of ['recoveryEpoch', 'parentRunId', 'parentCheckpointDigest', 'timeAmendments', 'journal']) {
      expect(summary).not.toHaveProperty(field)
    }
  })

  it('prints why the latest attempts were rejected', () => {
    const rejectedAttempts = Array.from({ length: 7 }, (_, index) => ({
      stageId: 'negative-review', waveId: 'w', taskId: `review-${index}`, attempt: 1, formatRepairOrdinal: 1,
      promptDigest: 'p', diagnostics: [`diagnostic ${index}`], rejectedAt: 'now', usage: { large: 'omitted' },
    }))
    const summary = summarizeStatus({ state: { runId: 'run', rejectedAttempts }, workflow: null }) as {
      rejectedAttemptCount: number, recentRejections: unknown[]
    }
    expect(summary.rejectedAttemptCount).toBe(7)
    expect(summary.recentRejections).toEqual([2, 3, 4, 5, 6].map(index => ({ taskId: `review-${index}`,
      attempt: 1, formatRepairOrdinal: 1, rejectedAt: 'now', diagnostics: [`diagnostic ${index}`] })))
    // A provider backoff (P2-06) shows its failure and wait.
    const providerBackoff = { signature: 'codex:SERVER:503', delayMs: 300_000 }
    const backoff = summarizeStatus({ state: { runId: 'run', rejectedAttempts: [{ ...rejectedAttempts[0], providerBackoff }] },
      workflow: null }) as { recentRejections: Record<string, unknown>[] }
    expect(JSON.parse(JSON.stringify(backoff.recentRejections))[0]).toMatchObject({ providerBackoff })
    expect(Object.keys(JSON.parse(JSON.stringify(summary.recentRejections))[0])).not.toContain('providerBackoff')
  })

  it('reports a run as starting until its Workflow saves the first state', async () => {
    const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function auditRunStatus(')
    const end = source.indexOf('async function auditWorkflowStatus(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const auditRunStatus = new Function('assertStoredRunOwner', 'CloudflareRunStore', 'response',
      `${stripTypeScriptTypes(source.slice(start, end))}; return auditRunStatus;`,
    )(
      async () => undefined,
      class { async getStateIfPresent() { return null } },
      (_env: unknown, value: unknown) => value,
    ) as (runId: string, env: unknown) => Promise<unknown>
    const body = await auditRunStatus('fresh-run', { AUDIT_WORKFLOW: { get: async () => ({ status: async () => ({ status: 'running' }) }) } })
    expect(body).toEqual({ state: null, workflow: { status: 'running' } })
    expect(summarizeStatus(body)).toEqual({ status: 'starting', workflow: { status: 'running' } })
  })
})
