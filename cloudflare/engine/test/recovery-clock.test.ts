import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SealedCheckpoint } from '../src/contracts.js'
import {
  RunMachine, advanceExperimentOneWave, createAudit0RunPolicy, runNextWave, sealReleasePackage,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

afterEach(() => vi.useRealTimers())

describe('discovery admission clock', () => {
  it('finishes an already admitted open wave after the discovery deadline', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await createControlledMachine(audit0Definition, pkg.digest, 'open-wave-deadline', '2026-09-19T08:00:00.000Z')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    await advanceExperimentOneWave({ definition: audit0Definition, machine, provider: base, artifactStore: store })
    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine,
      artifactStore: store,
      provider: { async run() { throw new (await import('../src/run-errors.js')).AgentExecutionPending('fixture-pending') } },
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(machine.view().modelStartedAt!) + audit0Definition.limits.phaseMinutes.discovery * 60_000 + 1)
    const reloaded = await restoreSelected(machine)
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
    const machine = await createControlledMachine(audit0Definition, pkg.digest, 'durable-admission-order', '2026-09-19T08:00:00.000Z')
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
    const machine = await createControlledMachine(audit0Definition, pkg.digest, 'admission-before-results', '2026-09-19T08:00:00.000Z')
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
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse(machine.view().modelStartedAt!) + audit0Definition.limits.phaseMinutes.discovery * 60_000 + 1)
    const recovered = await restoreSelected(machine)
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
