import { describe, it, expect } from 'vitest'
import { dashboardContext, nativeSessionId } from '../src/dashboard-context.js'
import type { RunState } from '../src/contracts.js'
const id = '11111111-2222-3333-4444-555555555555'
const scope = { stageId: 'discovery', waveId: 'wave-0', taskId: 'research-1', attempt: 2, promptDigest: 'a'.repeat(64) }
const state = (payload: object) => ({ journal: [{ type: 'agent.attempt-admitted', payload: { ...scope, ...payload } }] }) as unknown as RunState

describe('dashboard native context identity', () => {
  it('distinguishes a new conversation from a resumed conversation even when freshContext is false', () => {
    expect(dashboardContext(state({ continuationMode: 'new', freshContext: false }), { ...scope, actorId: id }))
      .toMatchObject({ mode: 'new', sessionId: id, sessionSource: 'receipt' })
    expect(dashboardContext(state({ continuationMode: 'resume', sessionId: id }), { ...scope, actorId: id }))
      .toMatchObject({ mode: 'resume', sessionId: id, mismatch: false })
  })
  it('keeps requested resume distinct from observed session and flags a mismatch', () => {
    expect(dashboardContext(state({ continuationMode: 'resume', sessionId: id }), scope).sessionSource).toBe('resume-request')
    expect(dashboardContext(state({ continuationMode: 'resume', sessionId: id }), { ...scope, actorId: 'session-' + id }).mismatch).toBe(true)
  })
  it('does not infer context from fallback actor IDs, another stage, or a different prompt', () => {
    expect(nativeSessionId('core-run-task-1-' + id)).toBeNull()
    expect(dashboardContext(state({ continuationMode: 'new', stageId: 'reporting' }), scope).mode).toBe('unknown')
    expect(dashboardContext(state({ continuationMode: 'new', promptDigest: 'b'.repeat(64) }), scope).mode).toBe('unknown')
    expect(dashboardContext({ journal: [] }, { ...scope, actorId: 'workspace-1' })).toMatchObject({ sessionId: null, mode: 'unknown' })
  })
})
