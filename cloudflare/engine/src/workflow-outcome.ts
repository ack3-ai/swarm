import type { RunCursor, RunState } from './contracts.js'
import { isPermanentRunFailure, PermanentRunFailure } from './run-errors.js'

export type WaveProgress = {
  status: RunState['status']
  cursor: RunCursor
  checkpointDigest: string | null
  terminalReason: string | null
  /** The step changed nothing while a pause is in force and nothing is in flight; poll slowly (E15). */
  pausedIdle?: true
}

/** `polledGeneration` is the state generation the step started from; without it the field is never set. */
export function workflowProgress(state: RunState, polledGeneration?: number): WaveProgress {
  const pausedIdle = state.status === 'running' && (state.controls?.pauses.length ?? 0) > 0
    && (state.inFlightAgentAttempts?.length ?? 0) === 0 && state.stateGeneration === polledGeneration
  return {
    status: state.status,
    cursor: state.cursor,
    checkpointDigest: state.checkpoints.at(-1)?.digest ?? null,
    terminalReason: state.terminalReason,
    ...(pausedIdle ? { pausedIdle: true } : {}),
  }
}

export function failureForWorkflowProgress(progress: WaveProgress): PermanentRunFailure | null {
  if (progress.status !== 'failed') return null
  return new PermanentRunFailure(
    progress.terminalReason ?? 'audit run failed without a recorded reason',
    'persisted-run-failed',
  )
}

export function workflowFailureDisposition(error: unknown): 'retry' | 'fail' {
  return isPermanentRunFailure(error) ? 'fail' : 'retry'
}
