import { createControlledMachine } from './support/controlled-machine.js'
import { discoveryAdmissionAllowed, discoveryRepairAllowed } from '../src/discovery-policy.js'
import { expect, it, vi } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { sha256 } from '../src/canonical.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import type { AgentRequest } from '../src/contracts.js'

async function prepare(id: string) {
  const release = await sealReleasePackage(compileExperimentConfig(manifest))
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const store = new MemoryArtifactStore(), provider = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ machine, definition: machine.definition, artifactStore: store, provider })
  return { machine, store, provider, release }
}
it('rechecks the clock for each pool after awaited control reconciliation and drains only admitted work', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime('2026-11-01T00:00:00Z')
    const f = await prepare('deadline-each-admission'), requests: AgentRequest[] = []
    let controls = 0
    await advanceExperimentOneWave({ machine: f.machine, definition: f.machine.definition, artifactStore: f.store,
      reconcileControls: async () => {
        controls++
        if (f.machine.view().discoveryScheduler?.admissions.length === 1) {
          vi.setSystemTime(discoveryDeadline(f.machine.definition, f.machine.view()) + 1)
        }
      }, provider: { async run(request) { requests.push(request); throw new AgentExecutionPending(request.task.id) } } })
    expect(controls).toBeGreaterThanOrEqual(2)
    const state = f.machine.snapshot()
    expect(state.discoveryScheduler!.admissions).toHaveLength(1)
    const admitted = state.discoveryScheduler!.admissions[0]!
    expect(new Set(requests.map(request => request.task.modelPool))).toEqual(new Set([admitted.poolId]))
    expect(state.phase).toBe('discovery')
    await restoreSelected(f.machine, state)
  } finally { vi.useRealTimers() }
})

it('discards a closure decision if a control transition happens while workspace disposal awaits', async () => {
  const f = await prepare('closure-disposal-control')
  let changed = false
  await advanceExperimentOneWave({ machine: f.machine, definition: f.machine.definition, artifactStore: f.store,
    provider: { run: request => f.provider.run(request), async disposeWorkspace() {
      if (changed) return
      changed = true
      const command = { id: 'pause-disposal', expectedRevision: 0, action: 'pause' as const,
        scope: { kind: 'audit' as const }, reason: 'test concurrent control' }
      const now = new Date().toISOString()
      await f.machine.applyAdmissionControl({ auditId: f.machine.view().rootRunId, revision: 1, version: 2,
        command, commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now })
    } } })
  expect(changed).toBe(true)
  expect(f.machine.view().phase).toBe('discovery')
  expect(f.machine.view().stageEndReceipts.some(receipt => receipt.from === 'discovery')).toBe(false)
  expect(f.machine.view().controls!.revision).toBe(1)
  await restoreSelected(f.machine, f.machine.view())
})

it('rejects a new cohort beyond its admission deadline before changing state', async () => {
  const f = await prepare('deadline-producer')
  const stage = f.machine.definition.stages.find(stage => stage.kind === 'discovery')!
  await f.machine.initializeDiscoveryScheduler(stage.id)
  const before = f.machine.view()
  const pool = before.discoveryScheduler!.pools[0]!
  const late = new Date(discoveryDeadline(f.machine.definition, before) + 1).toISOString()
  await expect(f.machine.admitDiscoveryCohort({ stageId: stage.id, poolId: pool.poolId,
    waveIndex: pool.nextWaveIndex, inputArtifacts: [], peerPredecessors: {} }, late))
    .rejects.toThrow('admission policy')
  expect(f.machine.view()).toBe(before)
})

it('keeps paused required discovery pending after the deadline without model calls or implicit skipping', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime('2026-11-01T00:00:00Z')
    const f = await prepare('paused-past-deadline'), now = new Date().toISOString()
    const command = { id: 'pause-core', expectedRevision: 0, action: 'pause' as const,
      scope: { kind: 'pool' as const, poolId: 'luna' }, reason: 'test held required work' }
    await f.machine.applyAdmissionControl({ auditId: f.machine.view().rootRunId, revision: 1, version: 2,
      command, commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now })
    vi.setSystemTime(discoveryDeadline(f.machine.definition, f.machine.view()) + 1)
    const run = vi.fn(async () => { throw new Error('no paid work expected') })
    const advanced = await advanceExperimentOneWave({ machine: f.machine, definition: f.machine.definition,
      artifactStore: f.store, provider: { run } })
    expect(advanced).toBe(false); expect(run).not.toHaveBeenCalled()
    expect(f.machine.view().phase).toBe('discovery')
    expect(f.machine.view().discoveryScheduler!.admissions).toHaveLength(0)
    expect(f.machine.view().stageEndReceipts).toHaveLength(1)
    await restoreSelected(f.machine, f.machine.view())
  } finally { vi.useRealTimers() }
})


it('rejects historical task dispositions without releasing reserved usage', async () => {
  const f = await prepare('historical-disposition')
  await advanceExperimentOneWave({ machine: f.machine, definition: f.machine.definition, artifactStore: f.store,
    provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  const state = f.machine.snapshot()
  const admission = state.discoveryScheduler!.admissions[0]!
  Object.assign(admission, { abandonedTasks: [] })
  const budget = structuredClone(state.budget)
  expect(() => discoveryAdmissionAllowed(f.machine.definition, state, 'luna', [], Date.parse(state.updatedAt)))
    .toThrow('historical app version')
  expect(() => discoveryRepairAllowed(f.machine.definition, state, admission.taskIds[0]!)).toThrow('task abandonment')
  expect(state.budget).toEqual(budget)
})
