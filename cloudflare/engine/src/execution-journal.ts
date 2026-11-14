import type { JournalEvent, RunState } from './contracts.js'
import { sha256 } from './canonical.js'

/** A checkpoint is authorized by its exact prefix, never by later decisions. */
export async function verifiedJournalPrefix(journal: readonly JournalEvent[], head?: string): Promise<readonly JournalEvent[]> {
  const end = head === undefined ? journal.length : journal.findIndex(event => event.digest === head) + 1
  if (head !== undefined && end === 0) throw new Error('checkpoint journal head is missing')
  let previousDigest: string | null = null
  for (let index = 0; index < end; index++) {
    const event = journal[index]!
    if (event.sequence !== index || event.previousDigest !== previousDigest) throw new Error('run journal chain is invalid')
    const { digest, ...unsigned } = event
    if (await sha256(unsigned) !== digest) throw new Error('run journal digest mismatch')
    previousDigest = digest
  }
  return journal.slice(0, end)
}

/** Journal append shared by ordinary execution and command transitions. */
export async function appendExecutionEvent(state: RunState, type: string, payload: unknown, at: string): Promise<RunState> {
  const unsigned = { sequence: state.journal.length, type, at, payload,
    previousDigest: state.journal.at(-1)?.digest ?? null }
  const event: JournalEvent = { ...unsigned, digest: await sha256(unsigned) }
  return { ...state, stateGeneration: state.stateGeneration + 1, journal: [...state.journal, event], updatedAt: at }
}
