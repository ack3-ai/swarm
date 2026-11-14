import { createControlledMachine } from './support/controlled-machine.js'
import { pauseWhen } from './support/admission-control.js'
import { afterEach, expect, it } from 'vitest'
import { retryAttemptLimit } from '../src/attempt-policy.js'
import { sha256 } from '../src/canonical.js'
import type { AgentRequest } from '../src/contracts.js'
import { blockedTasks } from '../src/execution-failures.js'
import { selectedSnapshots } from './support/selected-snapshots.js'
const selections: ReturnType<typeof selectedSnapshots>[] = []
afterEach(() => selections.splice(0).forEach(value => value.close()))
import { RunMachine } from '../src/machine.js'
import { sealReleasePackage } from '../src/release.js'
import { AgentAttemptFailure, AgentExecutionPending, PermanentRunFailure, UnobservableAgentExecution } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

async function fixture() {
  const release = await sealReleasePackage(audit0PackageBody), id = 'controlled-discovery-failure'
  const authority = { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) }
  const machine = await createControlledMachine(audit0Definition, release.digest, id, undefined, undefined,
    authority)
  const base = new DeterministicAuditProvider(), artifacts = new MemoryArtifactStore(), requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts, provider: base })
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts, provider: {
    async run(request) { requests.push(request); throw new AgentExecutionPending(request.task.id) },
  } })
  const failed = requests.find(request => request.task.providerClass === 'core')!
  const peer = requests.find(request => request.task.providerClass === 'additive')!
  const selected = selectedSnapshots(); selections.push(selected)
  const restore = async (current: RunMachine) => RunMachine.fromState(current.definition,
    await selected.select(current), async () => release, selected.load)
  return { machine, base, artifacts, requests, failed, peer, restore }
}

function quotaFailure(request: AgentRequest) {
  return new AgentAttemptFailure('synthetic exhausted subscription', {
    usage: { modelCalls: 1, inputTokens: 17, outputTokens: 3, costUsd: 0.02 },
    nativeTerminalCustody: { code: 'AUTH', sourceRunId: request.runId, requestDigest: 'c'.repeat(64),
      snapshotDigest: 'd'.repeat(64), sessionId: 'synthetic-discovery-session', archiveStatus: 'available', workState: 'present' },
  })
}

it.each(['provider-rejected', 'agent-repair-exhausted'] as const)(
  'reports settled discovery %s without retrying or dropping accepted peers', async category => {
    const f = await fixture()
    let calls = 0, failure: unknown
    for (let tick = 0; tick < 10; tick++) {
      try { await advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: f.artifacts,
        reconcileControls: pauseWhen(f.machine, () => true), provider: { async run(request) {
          if (request.task.id !== f.failed.task.id) return f.base.run(request)
          calls++
          if (category === 'provider-rejected') throw quotaFailure(request)
          throw new AgentAttemptFailure('synthetic repeated agent failure', {
            usage: { modelCalls: 1, inputTokens: 11, outputTokens: 2, costUsd: 0.01 },
          })
        } } }) } catch (error) { failure = error; break }
    }
    expect(failure).toMatchObject({ category, retryable: false })
    const before = f.machine.snapshot()
    expect(blockedTasks(before)).toEqual([expect.objectContaining({ taskId: f.failed.task.id, category })])
    expect(calls).toBe(category === 'provider-rejected' ? 1 : retryAttemptLimit(f.failed.task))
    expect(before.status).toBe('running')
    expect(before.inFlightAgentAttempts).toEqual([])
    expect(before.artifacts.filter(record => record.stageId === f.failed.stage.id)).toHaveLength(f.requests.length - 1)
    expect(before.rejectedAttempts).toHaveLength(calls)
    expect(before.discoveryScheduler!.admissions).toHaveLength(1)
    expect(before.waveReceipts.some(receipt => receipt.poolId === f.failed.task.modelPool)).toBe(false)
    expect(before.discoveryScheduler!.pools.find(pool => pool.poolId === f.failed.task.modelPool))
      .toMatchObject({ nextWaveIndex: 0, quietCohorts: 0, parked: false })
    let machine = await f.restore(f.machine)
    for (let tick = 0; tick < 3; tick++) {
      await expect(advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: f.artifacts,
        provider: { async run() { throw new Error('must not dispatch blocked or accepted work') } } })).rejects.toMatchObject({ category })
      machine = await f.restore(machine)
    }
    const after = machine.snapshot()
    expect(after.artifacts).toEqual(before.artifacts)
    expect(after.rejectedAttempts).toEqual(before.rejectedAttempts)
    expect(after.budget).toEqual(before.budget)
    expect(after.modelStartedAt).toBe(before.modelStartedAt)
    expect(after.discoveryScheduler).toEqual(before.discoveryScheduler)
    expect(after.waveReceipts).toEqual(before.waveReceipts)
    expect(after.stageEndReceipts).toEqual(before.stageEndReceipts)
    expect((await f.restore(machine)).view()).toEqual(after)
  })

it('drains a separately admitted peer after failure without dispatching the blocked occurrence again', async () => {
  const f = await fixture()
  await advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: f.artifacts,
    reconcileControls: pauseWhen(f.machine, () => true), provider: { async run(request) {
      if (request.task.id === f.failed.task.id) throw quotaFailure(request)
      if (request.task.id === f.peer.task.id) throw new AgentExecutionPending(request.task.id, 'unavailable')
      return f.base.run(request)
    } } })
  const before = f.machine.snapshot()
  expect(before.inFlightAgentAttempts?.map(value => value.taskId)).toEqual([f.peer.task.id])
  expect(blockedTasks(before).map(value => value.taskId)).toEqual([f.failed.task.id])
  const machine = await f.restore(f.machine), calls: string[] = []
  await expect(advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: f.artifacts,
    provider: { async run(request) { calls.push(request.task.id); return f.base.run(request) } } })).rejects.toMatchObject({ category: 'provider-rejected' })
  expect(calls).toEqual([f.peer.task.id])
  expect(machine.view().inFlightAgentAttempts).toEqual([])
  expect(machine.view().artifacts.filter(record => before.artifacts.some(prior => prior.id === record.id))).toEqual(before.artifacts)
  expect(machine.view().discoveryScheduler!.admissions).toHaveLength(1)
  expect(blockedTasks(machine.view()).map(value => value.taskId)).toEqual([f.failed.task.id])
  expect((await f.restore(machine)).view()).toEqual(machine.view())
})

it.each(['same', 'separate'])('does not hide integrity failure in a %s cohort behind an adjustable failure', async cohort => {
  const f = await fixture()
  const corrupt = cohort === 'same'
    ? f.requests.find(request => request.task.id !== f.failed.task.id && request.task.modelPool === f.failed.task.modelPool)!
    : f.peer
  await expect(advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: f.artifacts,
    reconcileControls: pauseWhen(f.machine, () => true), provider: { async run(request) {
      if (request.task.id === f.failed.task.id) throw quotaFailure(request)
      if (request.task.id === corrupt.task.id) throw new PermanentRunFailure('synthetic corrupt evidence', 'integrity-failed')
      return f.base.run(request)
    } } })).rejects.toMatchObject({ category: 'integrity-failed' })
})

it('does not hide an integrity failure that settles after an adjustable failure of another cohort', async () => {
  const f = await fixture()
  await expect(advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: f.artifacts,
    reconcileControls: pauseWhen(f.machine, () => true), provider: { async run(request) {
      if (request.task.id === f.failed.task.id) throw quotaFailure(request)
      if (request.task.id === f.peer.task.id) {
        // Settle after the quota cohort was already processed in an earlier loop pass.
        await new Promise(resolve => setTimeout(resolve, 50))
        throw new PermanentRunFailure('synthetic corrupt evidence', 'integrity-failed')
      }
      return f.base.run(request)
    } } })).rejects.toMatchObject({ category: 'integrity-failed' })
})

it('does not reinterpret unobserved native work as a settled adjustable failure', async () => {
  const f = await fixture()
  await expect(advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: f.artifacts,
    reconcileControls: pauseWhen(f.machine, () => true), provider: { async run(request) {
      if (request.task.id === f.failed.task.id) throw new UnobservableAgentExecution('synthetic missing native custody')
      return f.base.run(request)
    } } })).rejects.toMatchObject({ category: 'session-recovery-unavailable' })
  expect(f.machine.view().inFlightAgentAttempts?.map(value => value.taskId)).toEqual([f.failed.task.id])
  expect(blockedTasks(f.machine.view())).toEqual([])
})
