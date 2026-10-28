import { describe, expect, it } from 'vitest'
import type { AgentResult, RejectedAttempt } from '../src/contracts.js'
import { RunMachine, rejectedAttemptIdentity, sealReleasePackage } from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const rejection = {
  stageId: 'discovery',
  waveId: 'wave-0',
  taskId: 'core-wave-0-research-1',
  attempt: 1,
  promptDigest: '1'.repeat(64),
  outputDigest: '2'.repeat(64),
  quarantineUri: 'r2://ARTIFACTS/quarantine/discovery/wave-0/core-wave-0-research-1/attempt-1/output.json',
  diagnostics: ['fixture rejected output'],
  freshContext: false,
  continuationMode: 'new' as const,
  sessionId: null,
  usage: {
    modelCalls: 1,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: 0.01,
    rawInputTokens: 10,
    cachedInputTokens: 0,
    cacheAccountingComplete: true,
  },
}

describe('rejected attempt idempotency', () => {
  it('does not journal or charge an exact receipt twice', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'rejection-idempotency')
    await machine.start()

    await machine.recordRejectedAttempt(rejection, '2026-09-20T19:00:00.000Z')
    await machine.recordRejectedAttempt(rejection, '2026-09-20T19:00:05.000Z')

    const state = machine.snapshot()
    expect(state.rejectedAttempts).toHaveLength(1)
    expect(state.budget).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.01 })
    expect(state.journal.filter(event => event.type === 'task.attempt-rejected')).toHaveLength(1)
  })

  it('treats timestamp-only historical duplicates as one revalidation candidate', () => {
    const first: RejectedAttempt = { ...rejection, rejectedAt: '2026-09-20T19:00:00.000Z' }
    const replay: RejectedAttempt = { ...rejection, rejectedAt: '2026-09-20T19:00:05.000Z' }
    const changed: RejectedAttempt = {
      ...rejection,
      outputDigest: '3'.repeat(64),
      rejectedAt: '2026-09-20T19:00:05.000Z',
    }

    expect(rejectedAttemptIdentity(first)).toBe(rejectedAttemptIdentity(replay))
    expect(rejectedAttemptIdentity(first)).not.toBe(rejectedAttemptIdentity(changed))
  })

  it('does not journal or charge an exact accepted receipt twice', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'accepted-idempotency')
    const stage = audit0Definition.stages[1]!
    const wave = stage.waves[0]!
    const task = wave.tasks[0]!
    const result: AgentResult = {
      status: 'accepted',
      actorId: 'fixture-core-wave-0-research-1',
      model: task.model,
      provider: 'openai-codex-subscription',
      files: { [task.output.requiredFiles[0]!]: 'fixture accepted output' },
      assertions: ['fixture-A1'],
      protocol: {},
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0,
      sessionId: 'fixture-session',
    }
    const store = new MemoryArtifactStore()
    const promptDigest = '4'.repeat(64)
    await machine.start()

    const first = await machine.recordResult({ wave, task, promptDigest, result, artifactStore: store, stageId: stage.id },
      '2026-09-20T19:00:00.000Z')
    const replay = await machine.recordResult({ wave, task, promptDigest, result, artifactStore: store, stageId: stage.id },
      '2026-09-20T19:00:05.000Z')

    const state = machine.snapshot()
    expect(replay).toEqual(first)
    expect(state.artifacts).toHaveLength(1)
    expect(state.budget).toMatchObject({ modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0 })
    expect(state.journal.filter(event => event.type === 'task.accepted')).toHaveLength(1)
    await expect(machine.recordResult({
      wave, task, promptDigest, artifactStore: store, stageId: stage.id,
      result: { ...result, files: { [task.output.requiredFiles[0]!]: 'changed output' } },
    })).rejects.toThrow(`task result already exists with different receipt: ${task.id}`)
  })

  it('accepts an exact wave-receipt replay with different timestamps', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'wave-receipt-idempotency')
    const stage = audit0Definition.stages[0]!
    const wave = stage.waves[0]!
    await machine.start()
    await machine.admitWave(stage.id, wave.id, '2026-09-20T18:59:59.000Z')

    await machine.recordWaveReceipt(stage.id, wave, '2026-09-20T19:00:00.000Z', '2026-09-20T19:01:00.000Z')
    await machine.recordWaveReceipt(stage.id, wave, '2026-09-20T19:02:00.000Z', '2026-09-20T19:03:00.000Z')

    const state = machine.snapshot()
    expect(state.waveReceipts).toHaveLength(1)
    expect(state.journal.filter(event => event.type === 'wave.completed')).toHaveLength(1)
  })
})
