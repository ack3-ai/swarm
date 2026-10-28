import { expect, it } from 'vitest'
import type { LiveCompletion } from '../src/dashboard-types.js'
import { latestLaneCompletion } from '../src/lane-diagnostics.js'
import { audit0Definition } from './support/audit0-config.js'

function completion(taskId: string, attempt: number, recordedAt: string): LiveCompletion {
  return {
    requestDigest: String(attempt).repeat(64).slice(0, 64),
    stageId: 'discovery', waveId: 'wave-0', taskId, attempt,
    model: 'synthetic', provider: 'synthetic', actorId: 'synthetic',
    promptDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64), recordedAt,
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  }
}

it('selects the latest durable receipt for a configured lane without a Sandbox observer', () => {
  const task = audit0Definition.stages.flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks).find(candidate => candidate.providerClass !== 'deterministic')!
  const older = completion(task.id, 1, '2026-09-26T00:00:00.000Z')
  const newer = completion(task.id, 2, '2026-09-26T01:00:00.000Z')
  expect(latestLaneCompletion(audit0Definition, task.workspaceKey, [older, newer])).toEqual(newer)
  expect(latestLaneCompletion(audit0Definition, 'invented-lane', [newer])).toBeNull()
})
