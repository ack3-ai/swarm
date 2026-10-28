import { describe, expect, it } from 'vitest'
import type { SealedCheckpoint } from '../src/contracts.js'
import {
  RunMachine, advanceExperimentOneWave, createAudit0RunPolicy, runNextWave, sealReleasePackage,
} from '../src/index.js'
import { expiredResumeClockAmendment } from '../src/recovery-clock.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

function checkpoint(stageIndex: number, modelStartedAt: string): SealedCheckpoint {
  return { body: { cursor: { stageIndex, waveIndex: 0 }, modelStartedAt, waveReceipts: [] } } as unknown as SealedCheckpoint
}

describe('checkpoint recovery clock', () => {
  it('preserves a live phase clock and amends an expired discovery clock', () => {
    const started = '2026-09-19T08:00:00.000Z'
    expect(expiredResumeClockAmendment(audit0Definition, checkpoint(1, started), '2026-09-19T12:59:59.000Z')).toBeNull()
    expect(expiredResumeClockAmendment(audit0Definition, checkpoint(1, started), '2026-09-19T13:01:00.000Z'))
      .toMatchObject({
        reason: 'operator-resume-after-expired-phase',
        phase: 'discovery',
        previousModelStartedAt: started,
        amendedModelStartedAt: '2026-09-19T13:01:00.000Z',
      })
  })

  it('does not expire a completion-stage checkpoint', () => {
    const reportingIndex = audit0Definition.stages.findIndex(stage => stage.kind === 'reporting')
    expect(expiredResumeClockAmendment(
      audit0Definition,
      checkpoint(reportingIndex, '2026-09-19T06:00:00.000Z'),
      '2026-09-19T10:00:00.000Z',
    )).toBeNull()
  })

  it('rebases a live discovery recovery when the next complete wave no longer fits', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const parent = await RunMachine.create(audit0Definition, pkg.digest, 'admission-clock-parent', '2026-09-19T08:00:00.000Z')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    const provider = {
      async run(request: Parameters<typeof base.run>[0]) {
        await new Promise(resolve => setTimeout(resolve, 2))
        return base.run(request)
      },
    }
    await runNextWave({ definition: audit0Definition, machine: parent, provider, artifactStore: store })
    await runNextWave({ definition: audit0Definition, machine: parent, provider, artifactStore: store })
    const checkpoint = parent.snapshot().checkpoints.at(-1)!
    const previous = checkpoint.body.waveReceipts.findLast(receipt => receipt.stageId === 'discovery')!
    const deadlineMs = Date.parse(checkpoint.body.modelStartedAt!)
      + audit0Definition.limits.phaseMinutes.discovery * 60_000
    const resumedAt = new Date(deadlineMs - Math.max(previous.durationMs, 1) + 1).toISOString()
    const amendment = expiredResumeClockAmendment(audit0Definition, checkpoint, resumedAt)!

    expect(amendment).toMatchObject({
      reason: 'operator-resume-before-unadmittable-wave',
      phase: 'discovery',
      previousModelStartedAt: checkpoint.body.modelStartedAt,
    })
    const child = await RunMachine.resume(audit0Definition, checkpoint, 'admission-clock-child', new Set(), resumedAt, amendment)
    const activeDiscoveryMs = checkpoint.body.waveReceipts
      .filter(receipt => receipt.stageId === 'discovery')
      .reduce((total, receipt) => total + receipt.durationMs, 0)
    expect(child.snapshot().modelStartedAt).toBe(new Date(Date.parse(resumedAt) - activeDiscoveryMs).toISOString())
    const stage = audit0Definition.stages[child.snapshot().cursor.stageIndex]!
    const wave = stage.waves[child.snapshot().cursor.waveIndex]!
    await expect(createAudit0RunPolicy(() => Date.parse(resumedAt)).beforeWave({
      definition: audit0Definition, state: child.snapshot(), stage, wave,
    })).resolves.toBeNull()
  })

  it('finishes an already admitted open wave after the discovery deadline', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, pkg.digest, 'open-wave-deadline', '2026-09-19T08:00:00.000Z')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    await advanceExperimentOneWave({ definition: audit0Definition, machine, provider: base, artifactStore: store })
    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine,
      artifactStore: store,
      provider: { async run() { throw new (await import('../src/run-errors.js')).AgentExecutionPending('fixture-pending') } },
    })
    const expired = structuredClone(machine.snapshot())
    expired.modelStartedAt = new Date(Date.now()
      - audit0Definition.limits.phaseMinutes.discovery * 60_000 - 1).toISOString()
    const reloaded = await RunMachine.fromState(audit0Definition, expired)
    await advanceExperimentOneWave({ definition: audit0Definition, machine: reloaded, provider: base, artifactStore: store })
    expect(reloaded.snapshot().waveReceipts.filter(receipt => (
      receipt.stageId === 'discovery' && receipt.waveId === 'wave-0'
    )).map(receipt => receipt.poolId).toSorted()).toEqual(['deepseek', 'luna'])
    expect(reloaded.snapshot()).toMatchObject({
      phase: 'synthesis', cursor: { stageIndex: 2, waveIndex: 0 },
    })
    expect(reloaded.snapshot().stageEndReceipts.at(-1)).toMatchObject({
      reason: 'phase-deadline',
    })
  })

  it('persists a wave admission before dispatching its provider tasks', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, pkg.digest, 'durable-admission-order', '2026-09-19T08:00:00.000Z')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    const persisted = [] as ReturnType<typeof machine.snapshot>[]
    let providerCalls = 0

    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine,
      artifactStore: store,
      provider: {
        async run(request) {
          providerCalls += 1
          expect(persisted).toHaveLength(1)
          expect(persisted[0]?.waveAdmission).toMatchObject({ stageId: 'preflight', waveId: 'identity-tools-baseline' })
          return base.run(request)
        },
      },
      onWaveAdmission: async state => { persisted.push(state) },
    })

    expect(providerCalls).toBe(1)
    expect(machine.snapshot().waveAdmission).toBeNull()
  })

  it('recovers an admitted wave after the deadline before any result reached run state', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, pkg.digest, 'admission-before-results', '2026-09-19T08:00:00.000Z')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    await advanceExperimentOneWave({ definition: audit0Definition, machine, provider: base, artifactStore: store })
    let providerCalls = 0
    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine,
      artifactStore: store,
      provider: {
        async run() {
          providerCalls += 1
          throw new (await import('../src/run-errors.js')).AgentExecutionPending('fixture-admitted')
        },
      },
    })
    const persistedAdmission = machine.snapshot()
    expect(persistedAdmission.discoveryScheduler?.admissions.map(value => value.poolId).toSorted())
      .toEqual(['deepseek', 'luna'])
    expect(persistedAdmission.artifacts.filter(item => item.stageId === 'discovery')).toEqual([])
    const recovered = await RunMachine.fromState(audit0Definition, persistedAdmission)
    await advanceExperimentOneWave({
      definition: audit0Definition, machine: recovered, artifactStore: store, provider: base,
    })
    expect(providerCalls).toBe(6)
    expect(recovered.snapshot().waveReceipts.some(receipt => (
      receipt.stageId === 'discovery' && receipt.waveId === 'wave-0'
    ))).toBe(true)
    expect(recovered.snapshot().discoveryScheduler?.pools.every(pool => pool.nextWaveIndex >= 1)).toBe(true)
  })
})
