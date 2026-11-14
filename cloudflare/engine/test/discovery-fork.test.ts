import { createControlledMachine, cancelControlledMachine } from './support/controlled-machine.js'
import { pauseWhen } from './support/admission-control.js'
import { forkWithSavedWork } from './support/saved-work.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { taskPromptDeadline } from '../src/runner.js'
import { discoveryAdmissionAllowed, discoveryClosureDecision } from '../src/discovery-policy.js'
import type { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { afterEach, expect, it, vi } from 'vitest'
import { selectedSnapshots } from './support/selected-snapshots.js'
const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { syntheticSourceFence } from './support/source-fence.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import type { AgentRequest, RunState, SealedCheckpoint, RuntimeRelease } from '../src/contracts.js'
import { RunMachine } from '../src/machine.js'
import { prepareStageForkSource } from '../src/stage-fork-source.js'
import { assertStageForkSelection } from '../src/stage-fork-origin.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../src/runner.js'
import { sealReleasePackage } from '../src/release.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { assertNativeTaskAdmission, reserveNativeLaunch } from '../src/native-launch-authority.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-source', workflowName: 'runtime-source', containerImageDigest: `sha256:${'b'.repeat(64)}`,
  workerVersionId: '11111111-1111-4111-8111-111111111111' }

async function fixture(withWaits = false) {
  const config = { ...structuredClone(manifest), researchPlan: {
    first: [{ role: 'researcher', buildsOn: 'none' }],
    cycle: [[{ role: 'researcher', buildsOn: 'previous-wave/research-1' }]],
  } }
  if (withWaits) Object.assign(config.modelPools.find(pool => pool.id === 'deepseek')!.connection!, { usageWindowWait: true })
  config.maxDiscoveryWaves = 8
  for (const pool of config.modelPools) pool.agents = 1
  const release = await sealReleasePackage(compileExperimentConfig(config)), artifacts = new MemoryArtifactStore('source')
  const machine = await createControlledMachine(release.body.definition, release.digest, 'discovery-source', undefined, runtime, { auditId: 'discovery-source', executionId: 'discovery-source', epoch: 0, runtimeDigest: await sha256(runtime) })
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ machine, definition: machine.definition, artifactStore: artifacts, provider: base, policy: audit0RunPolicy })
  const started = Date.parse(machine.view().modelStartedAt!)
  let rejectedWait = false
  let releaseSlow!: () => void
  const slow = new Promise<void>(resolve => { releaseSlow = resolve })
  const shouldStop = () => (machine.view().discoveryScheduler?.pools.find(pool => pool.poolId === 'luna')?.nextWaveIndex ?? 0) >= 4
  const advanceDiscovery = () => advanceExperimentOneWave({ machine, definition: machine.definition, artifactStore: artifacts, policy: audit0RunPolicy,
    reconcileControls: pauseWhen(machine, shouldStop), onWaveAdmission: async () => { if (shouldStop()) releaseSlow() },
    provider: { run: async request => {
      if (request.task.modelPool !== 'deepseek') return base.run(request)
      await slow
      const result = await base.run(request), submission = JSON.parse(result.files[SUBMISSION_PATH]!)
      if (withWaits && !rejectedWait) {
        rejectedWait = true
        vi.setSystemTime(started + 60_000)
        return { ...result, files: { ...result.files, [SUBMISSION_PATH]: 'invalid JSON' }, subscriptionWaits: [{
          provider: 'dsh' as const, sessionId: result.actorId, startedAt: new Date(started + 10_000).toISOString(),
          resumedAt: new Date(started + 40_000).toISOString(), resetsAt: new Date(started + 40_000).toISOString(),
        }] }
      }
      submission.materialHighCriticalDelta = false
      return { ...result, ...(withWaits ? { subscriptionWaits: [{ provider: 'dsh' as const, sessionId: result.actorId,
        startedAt: new Date(started + 20_000).toISOString(), resumedAt: new Date(started + 50_000).toISOString(),
        resetsAt: new Date(started + 50_000).toISOString() }] } : {}), files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
        protocol: { ...result.protocol, research: { ...result.protocol.research!, materialHighCriticalDelta: false } } }
    } },
  })
  await advanceDiscovery()
  if (withWaits && machine.view().discoveryScheduler!.admissions.length > 0) await advanceDiscovery()
  expect(machine.view().discoveryScheduler?.admissions).toEqual([])
  expect(machine.view().discoveryScheduler?.pools.map(pool => [pool.poolId, pool.nextWaveIndex, pool.parked]))
    .toEqual([['deepseek', 1, false], ['luna', 4, true]])
  const checkpoint = await machine.seal()
  await cancelControlledMachine(machine, 'operator cancellation')
  const selected = selectedSnapshots(); closes.push(selected.close)
  const source = await selected.select(machine), digest = await sha256(source)
  const states = new Map<string, RunState>([[`${source.runId}/${source.stateGeneration}/${digest}`, source]])
  const checkpoints = new Map<string, SealedCheckpoint>(source.checkpoints.map(value => [value.digest, value]))
  const load = async (id: string, pointer: { generation: number; digest: string }) => {
    const state = states.get(`${id}/${pointer.generation}/${pointer.digest}`)
    if (state === undefined) throw new Error('missing immutable source')
    return structuredClone(state)
  }
  load.assertSelected = selected.load.assertSelected!
  const select = async (machine: RunMachine) => { const state = await selected.select(machine);
    states.set(`${state.runId}/${state.stateGeneration}/${await sha256(state)}`, state); return state }
  const releases = new Map([[release.digest, release]])
  const read = { stateAt: load, state: async (id: string) => {
    const state = [...states.values()].find(value => value.runId === id)
    if (!state) throw new Error('missing checkpoint owner')
    return structuredClone(state)
  }, checkpoint: async (digest: string) => {
    const checkpoint = checkpoints.get(digest)
    if (!checkpoint) throw new Error('missing checkpoint')
    return structuredClone(checkpoint)
  }, release: async (digest: string) => {
    const saved = releases.get(digest)
    if (!saved) throw new Error('missing release')
    return structuredClone(saved)
  } }
  const input = { source: { runId: source.runId, state: { generation: source.stateGeneration, digest } },
    checkpointDigest: checkpoint.digest, releaseDigest: release.digest, sourceFence: syntheticSourceFence(source), read,
    readArtifact: async (record: { uri: string }) => artifacts.contents.get(record.uri)!, readInputs: artifacts.readExecutionInputs.bind(artifacts) }
  return { config, release, releases, source, checkpoint, input, states, checkpoints, load, base, select }
}

it('continues unequal sealed pool frontiers through the common fork without repeating accepted research', async () => {
  const f = await fixture(), original = canonicalJson(f.source), seed = await prepareStageForkSource(f.input)
  expect(seed.artifacts).toEqual(f.checkpoint.body.acceptedArtifacts)
  expect(seed.discoveryScheduler).toEqual(f.checkpoint.body.discoveryScheduler)
  let child = await forkWithSavedWork(seed, 'discovery-child', runtime, f.input.read.release, f.load)
  expect(child.view().discoveryScheduler).toEqual(seed.discoveryScheduler)
  expect(child.view().budget).toEqual(f.source.budget)
  await child.start(); await child.seal()
  child = await RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.load)
  const calls: AgentRequest[] = []
  const result = await runExperiment({ machine: child, definition: child.definition, artifactStore: new MemoryArtifactStore('child'), policy: audit0RunPolicy,
    provider: { run: async request => {
      calls.push(request)
      if (calls.length === 1) await assertNativeTaskAdmission(await f.select(child), request, f.input.read.release, f.load)
      return f.base.run(request)
    } },
  })
  expect(result.state.status).toBe('completed')
  expect(calls.some(request => seed.artifacts.some(record => record.taskId === request.task.id))).toBe(false)
  const first = calls[0]!
  expect(first.task.id).toBe('additive-wave-1-research-1')
  expect(first.visibleArtifacts).toEqual(seed.artifacts.filter(record => record.protocol.research !== undefined).toSorted((a, b) => a.id.localeCompare(b.id)))
  expect(first.task.research!.buildsOn).toBe('wave-0/research-1')
  const completions = result.state.journal.filter(event => event.type === 'discovery.cohort-completed')
  expect(completions[0]!.payload).toMatchObject({ materialEpochAfter: seed.discoveryScheduler!.materialEpoch + 1 })
  expect(completions[0]!.payload).not.toHaveProperty('coalescedWith')
  for (const checkpoint of result.state.checkpoints) await child.verifyCheckpoint(checkpoint)
  await RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.load)
  expect(canonicalJson(f.source)).toBe(original)
  const replay = child.snapshot(); replay.artifacts = [...replay.artifacts, seed.artifacts.at(-1)!]
  expect(() => assertStageForkSelection(seed, replay)).toThrow('retained prefix')
}, 60_000)


it('preserves removed pools and progress beyond a lowered ceiling when a later fork re-enables them', async () => {
  const f = await fixture(), reduced = structuredClone(f.config)
  reduced.modelPools.find(pool => pool.id === 'deepseek')!.agents = 0
  reduced.maxDiscoveryWaves = 2
  const smaller = await sealReleasePackage(compileExperimentConfig(reduced)); f.releases.set(smaller.digest, smaller)
  const seed = await prepareStageForkSource({ ...f.input, releaseDigest: smaller.digest })
  const first = await forkWithSavedWork(seed, 'reduced-child', runtime, f.input.read.release, f.load)
  await first.start(); const boundary = await first.seal()
  expect(first.view().discoveryScheduler!.pools.map(pool => [pool.poolId, pool.nextWaveIndex])).toEqual([['deepseek', 1], ['luna', 4]])
  const calls: AgentRequest[] = []
  const result = await runExperiment({ machine: first, definition: first.definition, artifactStore: new MemoryArtifactStore('reduced'), policy: audit0RunPolicy,
    provider: { run: async request => { calls.push(request); return f.base.run(request) } } })
  expect(calls.some(request => request.task.promptKind === 'research')).toBe(false)
  const source = await f.select(first), digest = await sha256(source)
  f.states.set(`${source.runId}/${source.stateGeneration}/${digest}`, source)
  for (const checkpoint of source.checkpoints) f.checkpoints.set(checkpoint.digest, checkpoint)
  const expanded = structuredClone(f.config)
  expanded.modelPools.find(pool => pool.id === 'luna')!.agents = 2
  expanded.researchPlan.first.push({ role: 'researcher', buildsOn: 'none' })
  expanded.researchPlan.cycle[0]!.push({ role: 'researcher', buildsOn: 'previous-wave/research-1' })
  const larger = await sealReleasePackage(compileExperimentConfig(expanded)); f.releases.set(larger.digest, larger)
  const { sourceFence: _, ...input } = f.input
  const restoredSeed = await prepareStageForkSource({ ...input, source: { runId: source.runId, state: { generation: source.stateGeneration, digest } },
    checkpointDigest: boundary.digest, releaseDigest: larger.digest })
  const second = await forkWithSavedWork(restoredSeed, 'expanded-child', runtime, f.input.read.release, f.load)
  expect(second.view().discoveryScheduler!.pools.map(pool => [pool.poolId, pool.nextWaveIndex])).toEqual([['deepseek', 1], ['luna', 4]])
  expect(second.view().budget).toEqual(source.budget)
  calls.length = 0
  await runExperiment({ machine: second, definition: second.definition, artifactStore: new MemoryArtifactStore('expanded'), policy: audit0RunPolicy,
    provider: { run: async request => { calls.push(request); return f.base.run(request) } } })
  const research = calls.filter(request => request.task.promptKind === 'research')
  expect(research.some(request => request.task.modelPool === 'deepseek')).toBe(true)
  expect(research.some(request => request.task.modelPool === 'luna' && request.task.research!.researcher === 2)).toBe(true)
  expect(research.every(request => request.task.research!.wave >= (request.task.modelPool === 'deepseek' ? 1 : 4))).toBe(true)
  for (const checkpoint of second.view().checkpoints) await second.verifyCheckpoint(checkpoint)
  await RunMachine.fromState(second.definition, await f.select(second), f.input.read.release, f.load)
}, 60_000)

it('refuses changed imported progress before a child can start and seal its execution', async () => {
  const f = await fixture(), seed = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(seed, 'tampered-frontier', runtime, f.input.read.release, f.load)
  for (const mutate of [
    (state: RunState) => { state.discoveryScheduler!.pools[0]!.nextWaveIndex++ },
    (state: RunState) => { state.discoveryScheduler!.materialEpoch++ },
    (state: RunState) => { state.discoveryScheduler!.pools[1]!.quietEpoch-- },
    (state: RunState) => { state.discoveryScheduler!.pools[1]!.quietCohorts = 0; state.discoveryScheduler!.pools[1]!.parked = false },
    (state: RunState) => { state.discoveryScheduler!.pools = state.discoveryScheduler!.pools.slice(1) },
  ]) {
    const changed = child.snapshot(); mutate(changed)
    await expect((async () => {
      const restored = await RunMachine.fromState(child.definition, changed, f.input.read.release, f.load)
      await restored.start()
    })()).rejects.toThrow(/state selection/)
  }
})


it('rejects a forged later admission after the initial seal before reserving native work', async () => {
  const f = await fixture(), seed = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(seed, 'forged-admission', runtime, f.input.read.release, f.load)
  await child.start(); await child.seal()
  const valid = await f.select(child), forged = structuredClone(valid)
  forged.discoveryScheduler!.pools.find(pool => pool.poolId === 'deepseek')!.nextWaveIndex = 2
  await expect(RunMachine.fromState(child.definition, forged, f.input.read.release, f.load)).rejects.toThrow('no matching state selection')
  const admitLaunch = vi.fn(), putAgentDispatch = vi.fn(), assertActive = vi.fn()
  let checked = false
  await advanceExperimentOneWave({ machine: child, definition: child.definition, artifactStore: new MemoryArtifactStore('forged'), policy: audit0RunPolicy,
    provider: { run: async request => {
      const admitted = await f.select(child)
      for (const mutate of [
        (state: RunState) => { state.discoveryScheduler!.pools[0]!.nextWaveIndex++ },
        (state: RunState) => { state.discoveryScheduler!.pools = state.discoveryScheduler!.pools.slice(0, 1) },
        (state: RunState) => { state.discoveryScheduler!.pools[1]!.nextWaveIndex = 2 },
        (state: RunState) => { delete state.discoveryScheduler },
      ]) {
        const changed = structuredClone(admitted); mutate(changed)
        await expect(reserveNativeLaunch({ getState: async () => changed, getRelease: f.input.read.release,
          executionSources: () => f.load, putAgentDispatch },
          { assertActive, admitLaunch } as unknown as ExecutionAuthorityStore, request, 'c'.repeat(64)))
          .rejects.toThrow('state selection')
      }
      expect(putAgentDispatch).not.toHaveBeenCalled()
      expect(admitLaunch).not.toHaveBeenCalled()
      checked = true
      throw new AgentExecutionPending('synthetic-pending', 'unfinished')
    } },
  })
  expect(checked).toBe(true)
  expect(valid.discoveryScheduler!.pools[0]!.nextWaveIndex).toBe(1)
}, 60_000)


it('preserves rejection evidence while carrying only checkpoint quota waits through nested forks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const f = await fixture(true), seed = await prepareStageForkSource(f.input)
    expect(f.source.rejectedAttempts).toHaveLength(1)
    expect(seed.discoveryWaits).toHaveLength(2)
    const child = await forkWithSavedWork(seed, 'wait-child', runtime, f.input.read.release, f.load)
    expect(child.view().rejectedAttempts).toEqual(f.source.rejectedAttempts)
    expect(child.view().budget).toEqual(f.source.budget)
    const deadline = discoveryDeadline(f.release.body.definition, f.source)
    expect(deadline).toBe(Date.parse(f.source.modelStartedAt!) + f.release.body.definition.limits.phaseMinutes.discovery * 60_000 + 40_000)
    expect(discoveryDeadline(child.definition, child.view(), child.importedDiscoveryWaits)).toBe(deadline)
    await child.start(); const boundary = await child.seal()
    const stage = child.definition.stages[child.view().cursor.stageIndex]!
    expect(Date.parse(taskPromptDeadline(child.definition, child.snapshot(), stage, stage.waves[1]!, child.importedDiscoveryWaits))).toBe(deadline)
    const at = deadline - 5_000
    expect(discoveryAdmissionAllowed(child.definition, child.view(), 'deepseek', [], at, child.importedDiscoveryWaits)).toBe(true)
    expect(discoveryAdmissionAllowed(child.definition, child.view(), 'deepseek', [], at)).toBe(true)
    expect(discoveryClosureDecision(child.definition, child.view(), [], at, child.importedDiscoveryWaits)).toBeNull()
    expect(discoveryClosureDecision(child.definition, child.view(), [], at)).toBeNull()
    // Retained rejected receipts now carry the earlier wait too; imported waits must not double it.
    expect(discoveryDeadline(child.definition, child.view())).toBe(deadline)
    let laterWait = false
    await runExperiment({ machine: child, definition: child.definition, artifactStore: new MemoryArtifactStore('wait-child'), policy: audit0RunPolicy,
      provider: { run: async request => {
        const result = await f.base.run(request)
        if (request.task.promptKind !== 'research' || request.task.modelPool !== 'deepseek' || laterWait) return result
        laterWait = true; vi.setSystemTime(new Date('2026-01-01T00:04:00Z'))
        return { ...result, subscriptionWaits: [{ provider: 'dsh' as const, sessionId: result.actorId,
          startedAt: '2026-01-01T00:02:00Z', resumedAt: '2026-01-01T00:03:00Z', resetsAt: '2026-01-01T00:03:00Z' }] }
      } },
    })
    expect(laterWait).toBe(true)
    const completed = await f.select(child), digest = await sha256(completed)
    expect(discoveryDeadline(child.definition, completed, child.importedDiscoveryWaits)).toBe(deadline + 60_000)
    f.states.set(`${completed.runId}/${completed.stateGeneration}/${digest}`, completed)
    for (const checkpoint of completed.checkpoints) f.checkpoints.set(checkpoint.digest, checkpoint)
    const { sourceFence: _, ...input } = f.input
    const nested = await prepareStageForkSource({ ...input, source: { runId: completed.runId,
      state: { generation: completed.stateGeneration, digest } }, checkpointDigest: boundary.digest })
    const next = await forkWithSavedWork(nested, 'wait-grandchild', runtime, f.input.read.release, f.load)
    expect(discoveryDeadline(next.definition, next.view(), next.importedDiscoveryWaits)).toBe(deadline)
    expect(next.view().rejectedAttempts).toEqual(completed.rejectedAttempts)
    expect(next.view().budget).toEqual(completed.budget)
    await next.start(); await next.seal()
    await RunMachine.fromState(next.definition, await f.select(next), f.input.read.release, f.load)
  } finally { vi.useRealTimers() }
}, 60_000)
