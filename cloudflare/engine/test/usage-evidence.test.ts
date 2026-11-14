import { expect, it, vi } from 'vitest'
import { sha256 } from '../src/canonical.js'
import type { RunState } from '../src/contracts.js'
import { appendExecutionEvent } from '../src/execution-journal.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { localUsageEvidence, resolveUsageEvidence } from '../src/usage-evidence.js'
import { buildDashboardSnapshot } from '../src/dashboard-projection.js'
import type { SavedWork } from '../src/saved-work.js'
import { audit0Definition } from './support/audit0-config.js'

const proof = 'd'.repeat(64)
const root = async (id = 'accounting-source') => (await createControlledMachine(audit0Definition, 'a'.repeat(64), id)).snapshot()
const append = (state: RunState, type: string, payload: unknown) => appendExecutionEvent(state, type, payload, state.updatedAt)
const snapshot = (state: RunState, evidence = localUsageEvidence(state)) => buildDashboardSnapshot(state, audit0Definition,
  { entries: [], legacyCount: 0, truncated: false }, state.updatedAt, [], evidence)

it('keeps numeric counters but does not certify unknown usage after cancellation', async () => {
  const source = await root()
  expect(snapshot(source).recordedUsage.costAccountingComplete).toBe(true)
  const interrupted = await append(source, 'run.cancelled', { proofDigest: proof, abandonedAttempts: [], interruptedUsageComplete: false })
  const finished = await append(interrupted, 'run.completed', {})
  const evidence = await resolveUsageEvidence(finished)
  expect(evidence).toEqual({ costAccountingComplete: true, cacheAccountingComplete: true, historyComplete: true, interruptions: [proof] })
  expect(finished.budget).toEqual(source.budget)
  expect(snapshot(finished, evidence).recordedUsage).toMatchObject({ ...source.budget,
    costAccountingComplete: false, cacheAccountingComplete: false })
  expect(snapshot(finished, evidence).limitations.join(' ')).toContain('unreported model usage')
})

it('does not clear uncertainty or charge twice when the same stop proof recurs', async () => {
  let state = await append(await root(), 'run.cancelled', { proofDigest: proof })
  state = await append(state, 'run.cancelled', { proofDigest: proof })
  expect((await resolveUsageEvidence(state)).interruptions).toEqual([proof])
  expect(snapshot(state).recordedUsage).toMatchObject(state.budget)
})

it.each([
  ['run.executor-replaced', { proofDigest: proof }],
  ['task.occurrences-skipped', { abandonment: { proofDigest: proof } }],
  ['run.configuration-amended', { discoveryAbandonment: { proofDigest: proof } }],
  ['run.failed', { nativeControl: { nativeEffect: { inventoryDigest: proof } } }],
] as const)('leaves historical %s accounting to its owning version', async (type, payload) => {
  const historical = await append(await root(), type, payload)
  expect(() => localUsageEvidence(historical)).toThrow('historical app version')
  await expect(resolveUsageEvidence(historical)).rejects.toThrow('historical app version')
})

// Accounting consumes a source-version summary, never its historical state.
const exports = new Map<string, SavedWork>()
const loadExport = async (digest: string) => structuredClone(exports.get(digest)!)
const exportsOnly = Object.assign(async () => { throw new Error('historical source unavailable') }, { readSavedWork: loadExport })
async function fork(source: RunState, id: string): Promise<RunState> {
  const reference = { runId: source.runId, state: { generation: source.stateGeneration, digest: await sha256(source) } }
  const exported = { sourceReference: reference, accounting: await resolveUsageEvidence(source, exportsOnly) } as SavedWork
  const digest = await sha256(exported)
  exports.set(digest, exported)
  const origin = { source: reference, stageId: 'negative-review', savedWorkDigest: digest }
  const state = await root(id), payload = { ...(state.journal[0]!.payload as object), forkOrigin: origin }
  return appendExecutionEvent({ ...state, journal: [], stateGeneration: 0, forkOrigin: origin,
    budget: structuredClone(source.budget) }, 'run.created', payload, state.createdAt)
}

it('inherits later source uncertainty through an earlier checkpoint and nested forks using immutable bytes', async () => {
  const beforeStop = await root()
  const source = await append(beforeStop, 'run.cancelled', { proofDigest: proof })
  const child = await fork(source, 'accounting-child'), grandchild = await fork(child, 'accounting-grandchild')
  const historicalRead = vi.fn(async () => { throw new Error('historical source unavailable') })
  const readSavedWork = vi.fn(loadExport)
  const load = Object.assign(historicalRead, { readSavedWork })
  const evidence = await resolveUsageEvidence(grandchild, load)
  expect(evidence).toEqual({ costAccountingComplete: true, cacheAccountingComplete: true, historyComplete: true, interruptions: [proof] })
  expect(historicalRead).not.toHaveBeenCalled()
  expect(readSavedWork).toHaveBeenCalledOnce()
  expect(snapshot(grandchild, evidence).recordedUsage).toMatchObject({ ...source.budget, costAccountingComplete: false })
  // Changed export bytes cannot certify accounting.
  exports.get(grandchild.forkOrigin!.savedWorkDigest)!.accounting.historyComplete = false
  expect((await resolveUsageEvidence(grandchild, load)).historyComplete).toBe(false)
  expect(snapshot(grandchild, await resolveUsageEvidence(grandchild, load)).recordedUsage.costAccountingComplete).toBe(false)
})

it('does not assume missing ancestry or a forged journal is complete', async () => {
  const child = await fork(await root(), 'accounting-child')
  expect((await resolveUsageEvidence(child)).historyComplete).toBe(false)
  expect((await resolveUsageEvidence(child, async () => { throw new Error('missing source') })).historyComplete).toBe(false)
  const valid = await root(), corrupt = { ...valid, journal: [{ ...valid.journal[0]!, digest: '0'.repeat(64) }] }
  expect((await resolveUsageEvidence(corrupt)).historyComplete).toBe(false)
  expect((await resolveUsageEvidence({ ...await root(), parentRunId: 'historical-unpinned-parent' })).historyComplete).toBe(false)
})

it('keeps fully recorded ordinary work complete without fetching any ancestor', async () => {
  const load = vi.fn(async () => { throw new Error('unneeded lookup') })
  expect(await resolveUsageEvidence(await root(), load)).toEqual({ costAccountingComplete: true, cacheAccountingComplete: true, interruptions: [], historyComplete: true })
  expect(load).not.toHaveBeenCalled()
})


it.each(['cost', 'cache'] as const)('preserves unknown %s receipt accounting omitted by an earlier-checkpoint fork', async dimension => {
  const initial = await root()
  const rejected: RunState['rejectedAttempts'][number] = {
    stageId: 'reporting', waveId: 'wave-0', taskId: 'discarded-later-attempt', attempt: 1,
    promptDigest: 'a'.repeat(64), outputDigest: null, quarantineUri: null, diagnostics: ['unknown native accounting'],
    freshContext: false, continuationMode: 'new', sessionId: null, rejectedAt: initial.updatedAt,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      costAccountingComplete: dimension !== 'cost', cacheAccountingComplete: dimension !== 'cache' },
  }
  const source = await append({ ...initial, rejectedAttempts: [rejected] }, 'task.attempt-rejected', rejected)
  const child = await fork(source, 'accounting-child'), grandchild = await fork(child, 'accounting-grandchild')
  const load = exportsOnly
  const evidence = await resolveUsageEvidence(grandchild, load)
  expect(evidence).toEqual({ interruptions: [], historyComplete: true,
    costAccountingComplete: dimension !== 'cost', cacheAccountingComplete: dimension !== 'cache' })
  expect(grandchild.rejectedAttempts).toEqual([])
  expect(grandchild.budget).toEqual(source.budget)
  const summary = snapshot(grandchild, evidence)
  expect(summary.recordedUsage).toMatchObject({ ...source.budget,
    costAccountingComplete: dimension !== 'cost', cacheAccountingComplete: dimension !== 'cache' })
  expect(summary.limitations.join(' ')).toContain('incomplete pricing or cache accounting')
  expect(summary.limitations.join(' ')).not.toContain('unreported model usage')
})
