import type { AgentDispatch } from '../src/agent-dispatch.js'
import { afterEach, expect, it } from 'vitest'
import type { InFlightAgentAttempt } from '../src/contracts.js'
import type { LiveCompletion } from '../src/dashboard-types.js'
import { latestRecordedLaneCompletion } from '../src/lane-diagnostics.js'
import { completedForkFixture } from './support/stage-fork-command-fixture.js'

const close: (() => void)[] = []
afterEach(() => close.splice(0).forEach(fn => fn()))

it('selects only admitted durable receipts for the recorded lane', async () => {
  const f = await completedForkFixture(fn => close.push(fn))
  const admitted = f.source.journal.find(event => event.type === 'agent.attempt-admitted')!.payload as InFlightAgentAttempt
  const older: LiveCompletion = {
    requestDigest: '1'.repeat(64), stageId: admitted.stageId, waveId: admitted.waveId,
    taskId: admitted.taskId, attempt: admitted.attempt, promptDigest: admitted.promptDigest,
    model: 'synthetic', provider: 'synthetic', actorId: 'synthetic', outputDigest: 'b'.repeat(64),
    recordedAt: '2026-09-26T00:00:00.000Z',
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  }
  const newer = { ...older, recordedAt: '2026-09-26T01:00:00.000Z' }
  const unknown = { ...newer, attempt: admitted.attempt + 100, recordedAt: '2026-09-26T02:00:00.000Z' }
  const loadDispatch = async (digest: string) => {
    expect(digest).toBe(admitted.dispatchDigest)
    return { nativeRequestDigest: older.requestDigest } as AgentDispatch
  }
  const read = (lane: string, entries = [older, newer, unknown]) => latestRecordedLaneCompletion(
    f.source, f.machine.definition, lane, entries, f.loadRelease, loadDispatch, f.loadState)
  expect(await read(admitted.execution!.workspaceKey!)).toEqual(newer)
  expect(await read('invented-lane')).toBeNull()
  expect(await read(admitted.execution!.workspaceKey!, [{ ...newer, requestDigest: 'f'.repeat(64) }])).toBeNull()
  expect(await read(admitted.execution!.workspaceKey!, [unknown])).toBeNull()
  const { executionAuthority: _owner, ...historical } = f.source
  // @ts-expect-error Deliberately pass historical state without current ownership.
  await expect(latestRecordedLaneCompletion(historical,
    f.machine.definition, admitted.execution!.workspaceKey!, [newer], f.loadRelease, loadDispatch, f.loadState))
    .rejects.toThrow('historical app version')
}, 60_000)
