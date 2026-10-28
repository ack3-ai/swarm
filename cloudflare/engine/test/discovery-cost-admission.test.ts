import { describe, expect, it } from 'vitest'
import type {
  AgentProvider,
  ArtifactRecord,
  RejectedAttempt,
  WaveReceipt,
} from '../src/contracts.js'
import {
  RunMachine, createAudit0RunPolicy, remainingRecordedCostUsd, runNextWave, sealedWaveRecordedCostUsd, sealReleasePackage, sha256,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

function pricedDiscoveryProvider(): AgentProvider {
  const base = new DeterministicAuditProvider()
  return {
    async run(request) {
      const result = await base.run(request)
      const wave = request.task.research?.wave
      const costUsd = request.stage.kind !== 'discovery'
        ? 0
        : wave === 0 ? 0.25 : 0.75
      return { ...result, costUsd }
    },
  }
}

describe('discovery cost admission', () => {
  it('uses only receipt-bound accepted and rejected usage and counts each record once', () => {
    const receipt = {
      stageId: 'discovery', waveId: 'wave-1', artifactDigests: ['sealed'],
      startedAt: '2026-09-25T00:00:00.000Z', completedAt: '2026-09-25T00:00:01.000Z', durationMs: 1_000,
    } satisfies WaveReceipt
    const accepted = (taskId: string, costUsd: number, overrides: Partial<ArtifactRecord> = {}) => ({
      stageId: 'discovery', waveId: 'wave-1', taskId, contentDigest: 'sealed', usage: { costUsd },
      ...overrides,
    }) as ArtifactRecord
    const rejected = (taskId: string, costUsd: number, overrides: Partial<RejectedAttempt> = {}) => ({
      stageId: 'discovery', waveId: 'wave-1', taskId, attempt: 1,
      promptDigest: 'prompt', outputDigest: 'output', usage: { costUsd },
      ...overrides,
    }) as RejectedAttempt
    const first = accepted('accepted-1', 1.25)
    const firstRejection = rejected('rejected-1', 0.75)

    expect(sealedWaveRecordedCostUsd(receipt, [
      first,
      first,
      accepted('accepted-2', 2),
      accepted('unsealed', 100, { contentDigest: 'not-in-receipt' }),
      accepted('other-wave', 100, { waveId: 'wave-0' }),
    ], [
      firstRejection,
      firstRejection,
      rejected('other-rejection', 100, { waveId: 'wave-0' }),
    ])).toBe(4)
    expect(remainingRecordedCostUsd(0.3, 0.1)).toBe(0.2)
  })

  it('keeps one pool retry out of another pool cost estimate at the same local wave', () => {
    const receipt = {
      stageId: 'discovery', waveId: 'wave-1', artifactDigests: ['shared'],
      startedAt: '2026-09-25T00:00:00.000Z', completedAt: '2026-09-25T00:00:01.000Z', durationMs: 1_000,
    } satisfies WaveReceipt
    const artifact = (taskId: string, costUsd: number) => ({
      stageId: 'discovery', waveId: 'wave-1', taskId, contentDigest: 'shared', usage: { costUsd },
    }) as ArtifactRecord
    const rejection = {
      stageId: 'discovery', waveId: 'wave-1', taskId: 'pool-b-task', attempt: 1,
      promptDigest: 'prompt-b', outputDigest: 'output-b', usage: { costUsd: 9 },
    } as RejectedAttempt

    expect(sealedWaveRecordedCostUsd(receipt, [artifact('pool-a-task', 1), artifact('pool-b-task', 2)],
      [rejection], ['pool-a-task'])).toBe(1)
  })

  it('declines an unadmitted wave when the last sealed wave cannot fit, then completes downstream', async () => {
    const definition = structuredClone(audit0Definition)
    definition.limits.maxCostUsd = 10
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'projected-cost-stop')
    const provider = pricedDiscoveryProvider()
    const artifactStore = new MemoryArtifactStore()
    const input = { definition, machine, provider, artifactStore }

    await runNextWave(input)
    await runNextWave(input)
    const afterWave0 = machine.snapshot()
    const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
    expect(afterWave0.budget.costUsd).toBe(1.5)
    await expect(createAudit0RunPolicy().beforeWave({
      definition,
      state: afterWave0,
      stage: discovery,
      wave: discovery.waves[1]!,
    })).resolves.toBeNull()
    const exactFitDefinition = structuredClone(definition)
    exactFitDefinition.limits.maxCostUsd = 3
    await expect(createAudit0RunPolicy().beforeWave({
      definition: exactFitDefinition,
      state: afterWave0,
      stage: discovery,
      wave: discovery.waves[1]!,
    })).resolves.toBeNull()

    const scheduledMachine = await RunMachine.create(definition, release.digest, 'projected-cost-independent')
    const outcome = await runExperiment({
      definition, machine: scheduledMachine, provider, artifactStore: new MemoryArtifactStore(), policy: createAudit0RunPolicy(),
    })
    const checkpoint = outcome.state.checkpoints.find(value => value.body.cursor.stageIndex === 2)!
    const stop = outcome.state.stageEndReceipts.find(value => value.stageIndex === 1)!
    expect(stop.reason).toBe('measured-budget-inability')
    const evidence = stop.evidence as { remainingCostUsd: number, estimates: Array<{ poolId: string, costUsd: number }> }
    expect(new Set(evidence.estimates.map(value => value.poolId))).toEqual(new Set(['luna', 'deepseek']))
    expect(evidence.estimates.every(value => value.costUsd > evidence.remainingCostUsd)).toBe(true)
    await expect(RunMachine.resume(definition, checkpoint, 'projected-cost-resume')).resolves.toBeDefined()

    expect(outcome.state.status).toBe('completed')
  })

  it('completes downstream after a checkpoint-proven budget stop immediately after wave 0', async () => {
    const definition = structuredClone(audit0Definition)
    definition.limits.maxCostUsd = 0.5
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'wave-zero-cost-stop')
    const outcome = await runExperiment({
      definition,
      machine,
      provider: pricedDiscoveryProvider(),
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(),
    })

    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.waveReceipts.filter(receipt => receipt.stageId === 'discovery').map(receipt => receipt.waveId))
      .toEqual(['wave-0', 'wave-0'])
    expect(outcome.state.stageEndReceipts.find(receipt => receipt.stageIndex === 1)?.reason)
      .toBe('measured-budget-inability')

    const withoutAdmissionProof = structuredClone(outcome.state)
    const discoveryStop = withoutAdmissionProof.stageEndReceipts.find(receipt => receipt.stageIndex === 1)!
    discoveryStop.reason = 'stage-complete'
    expect(createAudit0RunPolicy().assessCompletion({ definition, state: withoutAdmissionProof }))
      .toEqual([])
  })

  it('preserves an admitted wave and rejects tampered estimate evidence', async () => {
    const definition = structuredClone(audit0Definition)
    definition.limits.maxCostUsd = 6
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'projected-cost-integrity')
    const provider = pricedDiscoveryProvider()
    const artifactStore = new MemoryArtifactStore()
    const input = { definition, machine, provider, artifactStore }

    const outcome = await runExperiment({ ...input, policy: createAudit0RunPolicy() })
    const checkpoint = outcome.state.checkpoints.find(value => value.body.cursor.stageIndex === 2)!
    const receipt = checkpoint.body.stageEndReceipts.at(-1)!
    const evidence = {
      ...(receipt.evidence as Record<string, unknown>),
      remainingCostUsd: 1,
    }
    const tamperedReceipt = { ...receipt, evidence, evidenceDigest: await sha256(evidence) }
    const body = {
      ...checkpoint.body,
      stageEndReceipts: [...checkpoint.body.stageEndReceipts.slice(0, -1), tamperedReceipt],
    }
    const tampered = { body, digest: await sha256(body) }

    await expect(RunMachine.resume(definition, tampered, 'projected-cost-tampered'))
      .rejects.toThrow('independent discovery budget receipt is invalid')
  })
})
