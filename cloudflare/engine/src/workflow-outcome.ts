import type { RunCursor, RunState } from './contracts.js'
import { isPermanentRunFailure, PermanentRunFailure } from './run-errors.js'

export interface WaveProgress {
  status: RunState['status']
  cursor: RunCursor
  checkpointDigest: string | null
  terminalReason: string | null
}

export function workflowProgress(state: RunState): WaveProgress {
  return {
    status: state.status,
    cursor: state.cursor,
    checkpointDigest: state.checkpoints.at(-1)?.digest ?? null,
    terminalReason: state.terminalReason,
  }
}

export function failureForWorkflowProgress(progress: WaveProgress): PermanentRunFailure | null {
  if (progress.status !== 'failed') return null
  return new PermanentRunFailure(
    progress.terminalReason ?? 'audit run failed without a recorded reason',
    'persisted-run-failed',
  )
}

export function canStopAtSealedWaveBoundary(state: RunState, requested: boolean): boolean {
  return requested && state.status === 'running'
    && (state.waveAdmission === null || state.waveAdmission === undefined)
    && (state.discoveryScheduler?.admissions.length ?? 0) === 0
    && (state.inFlightAgentAttempts?.length ?? 0) === 0
}

export function workflowFailureDisposition(error: unknown): 'retry' | 'fail' {
  return isPermanentRunFailure(error) ? 'fail' : 'retry'
}
