/** Content-addressed state selected by the existing run index. */
export interface RunStatePointer {
  generation: number
  digest: string
}

export const runStateKey = (runId: string, generation: number, digest: string): string =>
  `runs/${runId}/states/${String(generation).padStart(12, '0')}-${digest}.json`

export interface SavedStateReference { runId: string; state: RunStatePointer }
