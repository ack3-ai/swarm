import { createControlledMachine, cancelControlledMachine } from './support/controlled-machine.js'
import { selectedSnapshots } from './support/selected-snapshots.js'
import { forkWithSavedWork } from './support/saved-work.js'
import { onTestFinished, expect, it, vi } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { sha256 } from '../src/canonical.js'
import { recordedWorkspaceTasks } from '../src/execution-workspaces.js'
import { assertStageForkSelection } from '../src/stage-fork-origin.js'
import { resolveUsageEvidence } from '../src/usage-evidence.js'
import { RunMachine } from '../src/machine.js'
import { prepareStageForkSource } from '../src/stage-fork-source.js'
import { putSavedWork, savedWork } from '../src/saved-work.js'
import { parseRunCommand } from '../src/run-commands.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentAttemptFailure, PermanentRunFailure } from '../src/run-errors.js'
import type { AgentRequest, RunState } from '../src/contracts.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { syntheticSourceFence } from './support/source-fence.js'
import { runtime, target } from './support/successor-fixture.js'
import { assertNativeTaskAdmission, assertSupervisorTaskAdmission } from '../src/native-launch-authority.js'

it.each(['ordinary', 'ordinary-accepted', 'discovery', 'discovery-with-waits'] as const)('forks the exact failed %s frontier and preserves accepted post-checkpoint work', async scenario => {
  const mode = scenario.startsWith('ordinary') ? 'ordinary' : 'discovery', allAccepted = scenario === 'ordinary-accepted'
  const config = structuredClone(manifest)
  config.modelPools.find(value => value.id === 'deepseek')!.required = true
  if (scenario === 'discovery-with-waits') Object.assign(config.modelPools.find(value => value.id === 'deepseek')!.connection!, { usageWindowWait: true })
  const old = await sealReleasePackage(compileExperimentConfig(config)), changed = structuredClone(config)
  if (mode === 'ordinary' && !allAccepted) {
    changed.modelPools.push({ ...changed.modelPools.find(value => value.id === 'luna')!, id: 'new-reviewer', model: 'gpt-codex-b', agents: 0 })
    changed.stageModelPools['negative-review'] = ['luna', 'new-reviewer']
  }
  const next = await sealReleasePackage(compileExperimentConfig(changed))
  const packages = new Map([[old.digest, old], [next.digest, next]])
  const load = async (digest: string) => {
    if (packages.has(digest)) return packages.get(digest)!
    throw new Error('missing release')
  }
  const base = new DeterministicAuditProvider(), artifacts = new MemoryArtifactStore()
  let machine = await createControlledMachine(old.body.definition, old.digest, 'source-unsealed', undefined, runtime, { auditId: 'source-unsealed', executionId: 'source-unsealed', epoch: 0, runtimeDigest: await sha256(runtime) })
  const reviewIndex = machine.definition.stages.findIndex(value => value.kind === (mode === 'ordinary' ? 'negative-review' : 'discovery'))
  const failedTask = mode === 'ordinary' ? 'negative-review-replica' : 'core-wave-0-research-1'
  while (machine.view().cursor.stageIndex < reviewIndex) await advanceExperimentOneWave({ definition: machine.definition, machine, provider: base, artifactStore: artifacts })
  if (allAccepted) vi.spyOn(machine, 'recordWaveReceipt').mockRejectedValue(new Error('synthetic framework failure'))
  await expect((async () => {
    for (let step = 0; step < 3; step++) await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts,
    provider: { async run(request) {
      if (!allAccepted && request.task.id === failedTask) {
        if (mode === 'ordinary' && request.attempt === 1) throw new AgentAttemptFailure('recorded provider failure', {
          usage: { modelCalls: 1, inputTokens: 17, outputTokens: 3, costUsd: 0, costAccountingComplete: false, cacheAccountingComplete: false },
        })
        throw new PermanentRunFailure('synthetic framework failure', 'integrity-failed')
      }
      const result = await base.run(request)
      if (scenario === 'discovery-with-waits' && request.task.modelPool === 'deepseek') {
        const started = Date.parse(machine.view().modelStartedAt!)
        return { ...result, subscriptionWaits: [{ provider: 'dsh' as const, sessionId: result.actorId,
          startedAt: new Date(started).toISOString(), resumedAt: new Date(started + 1000).toISOString(),
          resetsAt: new Date(started + 1000).toISOString() }] }
      }
      return result
    } } })
  })()).rejects.toThrow('synthetic framework failure')
  await machine.fail('synthetic framework failure')
  const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
  if (scenario === 'discovery-with-waits') expect(source.artifacts.some(value => (value.usage.subscriptionWaits?.length ?? 0) > 0)).toBe(true)
  expect(source.artifacts.length).toBeGreaterThan(checkpoint.body.acceptedArtifacts.length)
  expect(source.artifacts.some(value => value.taskId === (mode === 'ordinary' ? 'negative-review-primary' : 'core-wave-0-research-2'))).toBe(true)
  const digest = await sha256(source), selected = selectedSnapshots()
  onTestFinished(() => selected.close())
  await selected.select(machine)
  const read = {
    stateAt: selected.load,
    state: async (id: string) => { if (id !== source.runId) throw new Error('missing owner'); return structuredClone(source) },
    checkpoint: async (digest: string) => { const value = source.checkpoints.find(value => value.digest === digest); if (!value) throw new Error('missing checkpoint'); return value },
    release: load,
  }
  const command = { id: 'replace-reviewer', expectedRevision: 0, action: 'fork', sourceFrontier: true,
    source: { runId: source.runId, state: { generation: source.stateGeneration, digest } }, releaseDigest: next.digest,
    runtimeRelease: target, reason: 'replace unavailable reviewer using the ordinary manifest' }
  expect(parseRunCommand(command)).toEqual(command)
  expect(() => parseRunCommand({ ...command, stageId: 'negative-review' })).toThrow('exactly one')
  const input: Parameters<typeof prepareStageForkSource>[0] = { source: command.source, sourceFrontier: true, releaseDigest: next.digest,
    sourceFence: syntheticSourceFence(source), read,
    readArtifact: async record => artifacts.contents.get(record.uri)!, readInputs: digest => artifacts.readExecutionInputs(digest) }
  const prepared = await prepareStageForkSource(input)
  await expect(prepareStageForkSource({ ...input, readArtifact: async () => 'substituted bytes' }))
    .rejects.toThrow('artifact bytes differ')
  await expect(prepareStageForkSource({ ...input, readInputs: async () => [{ id: 'substituted', contentDigest: 'f'.repeat(64) }] }))
    .rejects.toThrow('artifact input evidence differs')
  expect(prepared.artifacts).toEqual(source.artifacts)
  expect(prepared.checkpoint).toEqual(checkpoint)
  // A checkpoint proves accepted work, not that its failed owner stopped.
  await expect(putSavedWork({} as R2Bucket, { ...savedWork(prepared), sourceFence: undefined }))
    .rejects.toThrow('native source retirement')
  // Rehashing edited source bytes must not mint the source version's selection witness.
  for (const damage of ['protocol', 'input-snapshot', 'cursor', 'budget', 'rejections',
    ...(mode === 'discovery' ? ['completion-progress'] as const : ['missing-admission'] as const)] as const) {
    const damaged = structuredClone(source), unsealed = damaged.artifacts[checkpoint.body.acceptedArtifacts.length]!
    if (damage === 'protocol') {
      Object.assign(unsealed.protocol, { fabricated: true })
      const accepted = damaged.journal.find(event => event.type === 'task.accepted'
        && (event.payload as { artifact: { id: string } }).artifact.id === unsealed.id)!
      ;(accepted.payload as { artifact: typeof unsealed }).artifact = structuredClone(unsealed)
    } else if (damage === 'input-snapshot') {
      const admission = mode === 'ordinary' ? damaged.waveAdmission! : damaged.discoveryScheduler!.admissions[0]!
      admission.inputArtifacts = [...admission.inputArtifacts!, { id: unsealed.id, contentDigest: unsealed.contentDigest }]
        .sort((a, b) => a.id.localeCompare(b.id))
      admission.inputDigest = await sha256(admission.inputArtifacts)
      const admitted = damaged.journal.find(event => (event.type === 'wave.admitted' || event.type === 'discovery.cohort-admitted')
        && (event.payload as { waveId: string }).waveId === admission.waveId
        && (!('poolId' in admission) || (event.payload as { poolId: string }).poolId === admission.poolId))!
      admitted.payload = structuredClone(admission)
    } else if (damage === 'missing-admission') damaged.waveAdmission = null
    else if (damage === 'cursor') { damaged.cursor.stageIndex++; damaged.cursor.waveIndex = 0 }
    else if (damage === 'budget') { expect(damaged.budget.modelCalls).toBeGreaterThan(0); damaged.budget.modelCalls-- }
    else if (damage === 'rejections') damaged.rejectedAttempts = [...damaged.rejectedAttempts,
      { ...structuredClone(damaged.rejectedAttempts[0]!), taskId: 'fabricated-rejection' }]
    else {
      const receipt = damaged.waveReceipts.find(value => value.poolId !== undefined)!
      receipt.materialEpochAfter = (receipt.materialEpochAfter ?? 0) + 1
      const completed = damaged.journal.find(event => event.type === 'discovery.cohort-completed'
        && (event.payload as { poolId: string }).poolId === receipt.poolId)!
      completed.payload = structuredClone(receipt)
      damaged.discoveryScheduler!.materialEpoch++
    }
    let previousDigest: string | null = null
    for (const event of damaged.journal) {
      event.previousDigest = previousDigest
      const { digest: _, ...unsigned } = event
      event.digest = await sha256(unsigned); previousDigest = event.digest
    }
    const damagedDigest = await sha256(damaged)
    await expect(prepareStageForkSource({ source: { runId: damaged.runId, state: { generation: damaged.stateGeneration, digest: damagedDigest } },
      sourceFrontier: true, releaseDigest: next.digest, sourceFence: syntheticSourceFence(damaged),
      read: { ...read, stateAt: Object.assign(async () => structuredClone(damaged), { assertSelected: selected.load.assertSelected! }) },
      readArtifact: async record => artifacts.contents.get(record.uri)!, readInputs: digest => artifacts.readExecutionInputs(digest) }))
      .rejects.toThrow('snapshot has no matching state selection receipt')
  }
  const changedPackage = structuredClone(old)
  changedPackage.body.definition.limits.maxCostUsd += 1
  await expect(forkWithSavedWork(prepared, 'invalid-release-child', target, async () => changedPackage, read.stateAt))
    .rejects.toThrow('release digest differs')
  if (mode === 'ordinary') {
    const changedAccepted = structuredClone(changed)
    changedAccepted.modelPools.find(pool => pool.id === 'luna')!.model = 'gpt-codex-a-changed'
    const invalid = await sealReleasePackage(compileExperimentConfig(changedAccepted))
    await expect(forkWithSavedWork({ ...prepared, release: invalid }, 'accepted-rewrite-child', target, load, read.stateAt))
      .rejects.toThrow('accepted task contract')
  }
  machine = await forkWithSavedWork(prepared, 'frontier-child', target, load, read.stateAt)
  await machine.start()
  expect(machine.view().checkpoints).toHaveLength(0)
  expect(machine.view().budget).toEqual(source.budget)
  expect(machine.view().rejectedAttempts).toEqual(source.rejectedAttempts)
  if (mode === 'ordinary' && !allAccepted) {
    expect(source.rejectedAttempts.length).toBeGreaterThan(0)
    const changedEvidence = machine.snapshot()
    changedEvidence.rejectedAttempts[0]!.diagnostics = ['rewritten rejection']
    expect(() => assertStageForkSelection(machine.importedSeed!, changedEvidence)).toThrow('imported prefix')
    expect(await resolveUsageEvidence(machine.view(), read.stateAt)).toMatchObject({ costAccountingComplete: false, cacheAccountingComplete: false })
    const allocations = await recordedWorkspaceTasks(machine.definition, machine.view(), machine.importedSeed)
    expect(allocations.some(record => record.execution?.runId === source.runId)).toBe(false)
  }
  expect(machine.view().modelStartedAt).toEqual(source.modelStartedAt)
  await machine.fail('synthetic startup fault before a local seal')
  const failed = await selected.select(machine), failedDigest = await sha256(failed)
  const continuation = { source: { runId: failed.runId,
    state: { generation: failed.stateGeneration, digest: failedDigest } }, sourceFrontier: true as const,
    releaseDigest: next.digest, sourceFence: syntheticSourceFence(failed),
    read: { stateAt: selected.load, checkpoint: read.checkpoint, release: load },
    readArtifact: async (record: { uri: string }) => artifacts.contents.get(record.uri)!, readInputs: (digest: string) => artifacts.readExecutionInputs(digest) }
  const { sourceFence: _fence, ...unfencedContinuation } = continuation
  await expect(prepareStageForkSource(unfencedContinuation)).rejects.toThrow('verified native retirement')
  const retained = await prepareStageForkSource(continuation)
  expect(retained.checkpoint).toBeUndefined()
  machine = await forkWithSavedWork(retained, 'continued-frontier-child', target, load, selected.load)
  await machine.start()
  expect(machine.view().artifacts).toEqual(failed.artifacts)
  expect(machine.view().rejectedAttempts).toEqual(failed.rejectedAttempts)
  expect(machine.view().budget).toEqual(failed.budget)
  expect(machine.view().rootCreatedAt).toBe(failed.rootCreatedAt)
  expect(machine.view().modelStartedAt).toBe(failed.modelStartedAt)
  expect(await resolveUsageEvidence(machine.view(), selected.load)).toEqual(await resolveUsageEvidence(failed, selected.load))
  if (failed.waveAdmission != null) {
    expect({ ...machine.view().waveAdmission, taskOccurrences: failed.waveAdmission.taskOccurrences }).toEqual(failed.waveAdmission)
  }
  if (failed.discoveryScheduler !== undefined) {
    expect({ ...machine.view().discoveryScheduler, admissions: failed.discoveryScheduler.admissions }).toEqual(failed.discoveryScheduler)
  }
  if (allAccepted) {
    expect(machine.view().waveAdmission!.taskOccurrences).toEqual([])
  } else if (mode === 'ordinary') {
    expect(machine.view().waveAdmission!.inputArtifacts).toEqual(source.waveAdmission!.inputArtifacts)
    expect(machine.view().waveAdmission!.taskOccurrences!.map(value => value.taskId)).toEqual([failedTask])
  } else {
    expect({ ...machine.view().discoveryScheduler, admissions: source.discoveryScheduler!.admissions }).toEqual(source.discoveryScheduler)
    expect(machine.view().discoveryScheduler!.admissions.flatMap(value => value.taskOccurrences!.map(item => item.taskId))).toEqual([failedTask])
  }
  const calls: AgentRequest[] = []
  for (let ticks = 0; machine.view().cursor.stageIndex < machine.definition.stages.length; ticks++) {
    expect(ticks).toBeLessThan(20)
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts,
      onWaveAdmission: async state => { await selected.select(state) },
      provider: { async run(request) {
        await (request.task.providerClass === 'deterministic' ? assertSupervisorTaskAdmission : assertNativeTaskAdmission)(machine.snapshot(), request, load, read.stateAt)
        calls.push(request); return base.run(request)
      } } })
    await selected.select(machine)
    machine = await RunMachine.fromState(machine.definition, machine.snapshot(), load, read.stateAt)
  }
  await machine.complete()
  for (const seal of machine.view().checkpoints) await machine.verifyCheckpoint(seal)
  expect(calls.some(request => source.artifacts.some(value => value.taskId === request.task.id))).toBe(false)
  if (mode === 'ordinary' && !allAccepted) {
    expect(calls.find(request => request.task.id === failedTask)!.task.model).toBe('gpt-codex-b')
    expect(calls.find(request => request.task.id === failedTask)!.attempt).toBe(1)
  }
  expect(calls.filter(request => request.task.id === failedTask)).toHaveLength(allAccepted ? 0 : 1)
  expect(machine.view().artifacts.slice(0, source.artifacts.length)).toEqual(source.artifacts)
  expect(machine.view().rejectedAttempts.slice(0, source.rejectedAttempts.length)).toEqual(source.rejectedAttempts)
  assertStageForkSelection(machine.importedSeed!, machine.view())
  expect(await sha256(source)).toBe(digest)
}, 60_000)


it.each(['failed', 'stopped', 'admitted'] as const)('validates a fenced %s bootstrap without inventing a checkpoint', async status => {
  const release = await sealReleasePackage(compileExperimentConfig(structuredClone(manifest)))
  const loadRelease = async (digest: string) => {
    if (digest !== release.digest) throw new Error('unknown release')
    return release
  }
  const machine = await createControlledMachine(release.body.definition, release.digest, 'bootstrap-source', undefined, runtime,
    { auditId: 'bootstrap-source', executionId: 'bootstrap-source', epoch: 0, runtimeDigest: await sha256(runtime) })
  await machine.start()
  if (status === 'admitted') await machine.admitWave(machine.definition.stages[0]!.id, machine.definition.stages[0]!.waves[0]!.id)
  if (status !== 'stopped') await machine.fail('framework bootstrap failure')
  else await cancelControlledMachine(machine, 'operator decision')
  const selected = selectedSnapshots(); onTestFinished(() => selected.close())
  await selected.select(machine)
  const source = machine.view(), checkpoint = vi.fn(async () => { throw new Error('no checkpoint exists') })
  const input = { source: { runId: source.runId, state: { generation: source.stateGeneration, digest: await sha256(source) } },
    sourceFrontier: true as const, releaseDigest: release.digest, sourceFence: syntheticSourceFence(source),
    read: { stateAt: selected.load, checkpoint, release: loadRelease },
    readArtifact: async () => { throw new Error('no artifact exists') }, readInputs: async () => [] }
  const { sourceFence: _fence, ...unfenced } = input
  await expect(prepareStageForkSource(unfenced)).rejects.toThrow('verified native retirement')
  const { sourceFrontier: _, ...boundary } = input
  await expect(prepareStageForkSource({ ...boundary, stageId: release.body.definition.stages[0]!.id })).rejects.toThrow('after preflight')
  const prepared = await prepareStageForkSource(input)
  const exported = savedWork(prepared)
  expect(exported.schemaVersion).toBe(2)
  await expect(putSavedWork({} as R2Bucket, { ...exported, schemaVersion: 1 } as unknown as typeof exported)).rejects.toThrow('schema')
  await expect(putSavedWork({} as R2Bucket, { ...exported, sourceFence: undefined })).rejects.toThrow('native source retirement')
  expect(prepared.checkpoint).toBeUndefined()
  expect(checkpoint).not.toHaveBeenCalled()
  const child = await forkWithSavedWork(prepared, 'bootstrap-child', target, loadRelease, selected.load)
  expect(child.view()).toMatchObject({ status: 'running', cursor: { stageIndex: 0, waveIndex: 0 },
    artifacts: [], checkpoints: [], budget: source.budget, rootCreatedAt: source.rootCreatedAt, modelStartedAt: source.modelStartedAt })
  await selected.select(child)
  const restored = await RunMachine.fromState(child.definition, child.view(), loadRelease, selected.load)
  const provider = new DeterministicAuditProvider(), artifacts = new MemoryArtifactStore()
  await advanceExperimentOneWave({ definition: restored.definition, machine: restored, provider, artifactStore: artifacts })
  expect(restored.view().cursor.stageIndex).toBe(1)
  expect(restored.view().artifacts.length).toBeGreaterThan(0)
  expect(restored.view().checkpoints.length).toBeGreaterThan(0)
})
