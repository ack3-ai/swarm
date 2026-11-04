import { expect, it } from 'vitest'
import { RunMachine } from '../src/machine.js'
import { sha256 } from '../src/canonical.js'
import { applyAdmissionControl, admissionPaused, assertRunControls, settledControlState } from '../src/run-control-state.js'
import type { RunOperation } from '../src/run-command-journal.js'
import type { RunCommandScope } from '../src/run-commands.js'
import { audit0Definition } from './support/audit0-config.js'

const now = '2026-01-01T00:00:00.000Z'
async function fixture() {
  const machine = await RunMachine.create(audit0Definition, 'a'.repeat(64), 'audit', now)
  await machine.start(now)
  const state = machine.snapshot()
  state.executionAuthority = { auditId: state.rootRunId, executionId: state.runId, epoch: 0, runtimeDigest: 'b'.repeat(64) }
  const decide = async (action: 'pause' | 'continue', scope: RunCommandScope): Promise<RunOperation> => {
    const revision = state.controls?.revision ?? 0
    const command = { id: `command-${revision}`, expectedRevision: revision, action, scope, reason: 'synthetic operator decision' }
    return { auditId: state.rootRunId, revision: revision + 1, version: 2, command,
      commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now }
  }
  return { state, decide }
}

it('continues only the exact scope and preserves overlapping holds', async () => {
  const { state, decide } = await fixture(), stage = audit0Definition.stages[0]!
  const task = stage.waves[0]!.tasks[0]!
  state.controls = await applyAdmissionControl(audit0Definition, state, await decide('pause', { kind: 'audit' }), now)
  state.controls = await applyAdmissionControl(audit0Definition, state, await decide('pause', { kind: 'tasks', taskIds: [task.id] }), now)
  state.controls = await applyAdmissionControl(audit0Definition, state, await decide('continue', { kind: 'audit' }), now)
  expect(state.controls.pauses).toEqual([{ kind: 'tasks', taskIds: [task.id] }])
  expect(admissionPaused(state, stage.id, [task])).toBe(true)
  state.controls = await applyAdmissionControl(audit0Definition, state, await decide('continue', { kind: 'tasks', taskIds: [task.id] }), now)
  expect(admissionPaused(state, stage.id, [task])).toBe(false)
})

it('returns the original effect after a lost acknowledgement without changing the audit', async () => {
  const { state, decide } = await fixture(), before = structuredClone(state)
  const operation = await decide('pause', { kind: 'audit' })
  const effect = await applyAdmissionControl(audit0Definition, state, operation, now)
  expect(state).toEqual(before)
  expect(effect.lastReceipt.previousStateDigest).toBe(await sha256(before))
  state.controls = effect
  expect(await applyAdmissionControl(audit0Definition, state, operation, '2026-01-02T00:00:00Z')).toEqual(effect)
  await expect(settledControlState(state, operation, [], { status: 'rejected', detail: { code: 'different', message: 'changed' } }, now)).rejects.toThrow('outcome differs')
})

it('rejects missing scopes and persists a rejection without releasing existing pauses', async () => {
  const { state, decide } = await fixture()
  state.controls = await applyAdmissionControl(audit0Definition, state, await decide('pause', { kind: 'audit' }), now)
  const operation = await decide('pause', { kind: 'stage', stageId: 'missing' })
  await expect(applyAdmissionControl(audit0Definition, state, operation, now)).rejects.toMatchObject({ code: 'scope-unavailable' })
  const outcome = { status: 'rejected' as const, detail: { code: 'scope-unavailable', message: 'No stage' } }
  await expect(settledControlState(state, operation, [], outcome, now)).rejects.toThrow('changed admission pauses')
  const effect = await settledControlState(state, operation, state.controls.pauses, outcome, now)
  expect(effect.pauses).toEqual(state.controls.pauses)
})

it('rejects a stale revision, missing owner and tampered receipt', async () => {
  const { state, decide } = await fixture(), operation = await decide('pause', { kind: 'audit' })
  const { executionAuthority: _authority, ...unowned } = state
  await expect(applyAdmissionControl(audit0Definition, unowned, operation, now)).rejects.toThrow('lifecycle')
  const effect = await applyAdmissionControl(audit0Definition, state, operation, now)
  await expect(assertRunControls({ ...state, controls: { ...effect, pauses: [] } })).rejects.toThrow('receipt')
  state.controls = effect
  const stale = { ...operation, command: { ...operation.command, id: 'stale' } }
  stale.commandDigest = await sha256(stale.command)
  await expect(applyAdmissionControl(audit0Definition, state, stale, now)).rejects.toThrow('revision')
})

it('rejects a tampered persisted effect on a same-command retry', async () => {
  const { state, decide } = await fixture(), operation = await decide('pause', { kind: 'audit' })
  const effect = await applyAdmissionControl(audit0Definition, state, operation, now)
  for (const controls of [
    { ...effect, pauses: [] },
    { ...effect, lastReceipt: { ...effect.lastReceipt, pausesDigest: 'c'.repeat(64) } },
  ]) {
    await expect(applyAdmissionControl(audit0Definition, { ...state, controls }, operation, now)).rejects.toThrow('receipt')
  }
})
