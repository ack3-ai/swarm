import type { RunState } from './contracts.js'

// Runner fallback actor IDs identify an execution, not a native conversation.
export function nativeSessionId(value: unknown): string | null {
  return typeof value === 'string' && /^(?:session-)?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value) ? value : null
}

export function dashboardContext(state: Pick<RunState, 'journal'>, scope: {
  stageId: string; waveId: string; taskId: string; attempt?: number | undefined; promptDigest?: string | undefined; actorId?: string | undefined
}) {
  const admissions = (state.journal ?? []).filter(event => event.type === 'agent.attempt-admitted')
    .map(event => event.payload as Record<string, unknown>).filter(p => p.stageId === scope.stageId
      && p.waveId === scope.waveId && p.taskId === scope.taskId && p.attempt === scope.attempt
      && p.promptDigest === scope.promptDigest)
  const admission = admissions.length === 1 ? admissions[0] : undefined
  const mode = admission?.continuationMode === 'new' || admission?.continuationMode === 'resume'
    ? admission.continuationMode : 'unknown'
  const requestedSessionId = mode === 'resume' ? nativeSessionId(admission?.sessionId) : null
  const observed = nativeSessionId(scope.actorId)
  return { mode, sessionId: observed ?? requestedSessionId, requestedSessionId,
    sessionSource: observed ? 'receipt' : requestedSessionId ? 'resume-request' : 'unavailable',
    freshContextFallback: admission?.freshContext === true,
    mismatch: !!(observed && requestedSessionId && observed !== requestedSessionId) }
}
