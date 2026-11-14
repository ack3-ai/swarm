import { sumRecordedUsage, recordedUsageMatches } from './recorded-usage.js'
import { canonicalJson, sha256 } from './canonical.js'
import type { RunState } from './contracts.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import { verifiedJournalPrefix } from './execution-journal.js'
import { assertCurrentExecutionFormat } from './run-state-pointer.js'

/** Derived evidence, never a replacement for numeric budget counters or configuration. */
export interface UsageEvidence {
  interruptions: readonly string[]
  historyComplete: boolean
  costAccountingComplete: boolean
  cacheAccountingComplete: boolean
}
type UsageState = Pick<RunState, 'journal' | 'forkOrigin' | 'parentRunId' | 'artifacts' | 'rejectedAttempts' | 'budget'>
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Existing stop protocols cannot attest usage of interrupted native work, even
 * when the logical attempt list is empty. A successful successor does not clear it. */
export function localUsageEvidence(state: UsageState): UsageEvidence {
  assertCurrentExecutionFormat(state)
  const interruptions = new Set<string>()
  const receipts = Array.isArray(state.artifacts) && Array.isArray(state.rejectedAttempts)
    ? sumRecordedUsage([...state.artifacts, ...state.rejectedAttempts].map(row => row.usage)) : undefined
  const matched = receipts !== undefined && state.budget !== undefined && recordedUsageMatches(receipts, state.budget)
  const completeness = { costAccountingComplete: matched && receipts?.costAccountingComplete === true,
    cacheAccountingComplete: matched && receipts?.cacheAccountingComplete === true }
  if (!Array.isArray(state.journal)) return { ...completeness, interruptions: [], historyComplete: false }
  for (const event of state.journal) {
    if (event.type !== 'run.cancelled') continue
    const reference = object(event.payload).proofDigest
    interruptions.add(typeof reference === 'string' ? reference : event.digest)
  }
  const unpinnedParent = state.parentRunId !== null && state.forkOrigin === undefined
  return { ...completeness, interruptions: [...interruptions].sort(), historyComplete: state.journal[0]?.type === 'run.created' && state.forkOrigin === undefined && !unpinnedParent }
}

/** Source versions summarize inherited uncertainty in the selected export.
 * The current reader never interprets historical audit records. */
export async function resolveUsageEvidence(state: UsageState, load?: ExecutionSourceLoader): Promise<UsageEvidence> {
  const local = localUsageEvidence(state)
  try {
    await verifiedJournalPrefix(state.journal)
    const created = state.journal[0], origin = state.forkOrigin
    if (canonicalJson(object(created?.payload).forkOrigin) !== canonicalJson(origin)) throw new Error('accounting origin differs from the journal')
    if (origin === undefined) return local
    if (created?.type !== 'run.created' || load?.readSavedWork === undefined) throw new Error('accounting export unavailable')
    const exported = await load.readSavedWork(origin.savedWorkDigest)
    if (await sha256(exported) !== origin.savedWorkDigest
      || canonicalJson(exported.sourceReference) !== canonicalJson(origin.source)) throw new Error('accounting export differs')
    const inherited = exported.accounting
    if (!Array.isArray(inherited?.interruptions) || inherited.interruptions.some(value => typeof value !== 'string')
      || typeof inherited.historyComplete !== 'boolean' || typeof inherited.costAccountingComplete !== 'boolean'
      || typeof inherited.cacheAccountingComplete !== 'boolean') throw new Error('accounting export is invalid')
    return { interruptions: [...new Set([...local.interruptions, ...inherited.interruptions])].sort(),
      historyComplete: inherited.historyComplete,
      costAccountingComplete: local.costAccountingComplete && inherited.costAccountingComplete,
      cacheAccountingComplete: local.cacheAccountingComplete && inherited.cacheAccountingComplete }
  } catch { return { ...local, historyComplete: false } }
}
