import type { RunState } from './contracts.js'
import type { RunStatePointer } from './run-state-pointer.js'

export type ExecutionSourceLoader = ((executionId: string, pointer: RunStatePointer) => Promise<RunState>) & {
  /** Exact database selection witness; an archived object alone is insufficient. */
  assertSelected?: (state: RunState) => Promise<void>
  /** Source-owned immutable evidence for a continuation. */
  readSavedWork?: (digest: string) => Promise<import('./saved-work.js').SavedWork>

}
