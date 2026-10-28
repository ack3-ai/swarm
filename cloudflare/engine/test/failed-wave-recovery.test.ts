import { expect, it } from 'vitest'
import type { AgentRequest, ArtifactRecord, RuntimeRelease } from '../src/contracts.js'
import { sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure, PermanentRunFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const baseDefinition = structuredClone(audit0Definition)
const definition = {
  ...baseDefinition,
  stages: baseDefinition.stages.map((stage, index) => index === 1
    ? { ...stage, waves: stage.waves.slice(0, 4) }
    : stage),
  discoverySafetyCeiling: 4,
  limits: { ...baseDefinition.limits, maxModelCalls: 10_000, maxCostUsd: 10_000 },
}

const sourceRuntime: RuntimeRelease = {
  schemaVersion: 1,
  id: 'runtime-source',
  frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source',
  workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source',
  containerImageDigest: `sha256:${'a'.repeat(64)}`,
}

const targetRuntime: RuntimeRelease = {
  ...sourceRuntime,
  id: 'runtime-target',
  frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target',
  workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'audit-runtime-target',
}

function acceptedReader(store: MemoryArtifactStore) {
  return {
    async read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>> {
      const content = store.contents.get(record.uri)
      if (content === undefined || await sha256(content) !== record.contentDigest) {
        throw new Error('fixture accepted artifact digest mismatch')
      }
      return JSON.parse(content) as Readonly<Record<string, string>>
    },
  }
}

it('uses the skipped resume slot as a fresh replacement when a lost core process has no session', async () => {
  const machine = await RunMachine.create(definition, 'f'.repeat(64), 'lost-core-session')
  const artifacts = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  const attempts: Array<{ attempt: number, mode: AgentRequest['continuationMode'], fresh: boolean }> = []
  let taskId: string | undefined
  const provider = {
    async run(request: AgentRequest) {
      if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'core'
        || (taskId !== undefined && request.task.id !== taskId)) return base.run(request)
      taskId = request.task.id
      attempts.push({ attempt: request.attempt, mode: request.continuationMode, fresh: request.freshContext })
      if (request.attempt === 1) {
        throw new AgentAttemptFailure('synthetic lost process and receipt', { includeDiagnosticsInRepair: false })
      }
      const result = await base.run(request)
      if (request.attempt !== 2) return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        observations: Array<{ id: string }>
      }
      submission.observations[0]!.id = 'not-a-local-id'
      return { ...result, files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) } }
    },
  }
  for (let guard = 0; guard < 8 && !machine.snapshot().artifacts.some(value => value.taskId === taskId);
    guard += 1) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
    await expect(RunMachine.fromState(definition, machine.snapshot())).resolves.toBeDefined()
  }
  expect(attempts).toEqual([
    { attempt: 1, mode: 'new', fresh: false },
    { attempt: 2, mode: 'new', fresh: true },
    { attempt: 3, mode: 'resume', fresh: false },
  ])
  expect(machine.snapshot().artifacts.some(value => value.taskId === taskId)).toBe(true)
  expect(machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId).map(value => value.attempt))
    .toEqual([1, 2])
})

it('recovers only a terminal core task with the historical skipped session slot', async () => {
  const artifacts = new MemoryArtifactStore()
  const source = await RunMachine.create(
    definition, '9'.repeat(64), 'skipped-slot-source', '2026-09-26T00:00:00.000Z', sourceRuntime,
  )
  const base = new DeterministicAuditProvider()
  let missingTaskId: string | undefined
  await advanceExperimentOneWave({ definition, machine: source, provider: base, artifactStore: artifacts })
  await advanceExperimentOneWave({ definition, machine: source, artifactStore: artifacts, provider: {
    async run(request) {
      if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'core'
        || (missingTaskId !== undefined && request.task.id !== missingTaskId)) return base.run(request)
      missingTaskId = request.task.id
      throw new AgentAttemptFailure('synthetic process and receipt loss', { includeDiagnosticsInRepair: false })
    },
  } })
  const first = source.snapshot().rejectedAttempts.find(value => value.taskId === missingTaskId)!
  expect(first).toMatchObject({ attempt: 1, outputDigest: null, sessionId: null, usage: { modelCalls: 1 } })
  const acceptedPeers = source.snapshot().artifacts.filter(value => value.stageId === 'discovery')
  expect(acceptedPeers.length).toBeGreaterThan(1)
  expect(source.snapshot().inFlightAgentAttempts).toEqual([])

  const failedTask = definition.stages.flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks).find(task => task.id === missingTaskId)!
  await source.recordRejectedAttempt({
    stageId: first.stageId, waveId: first.waveId, taskId: first.taskId,
    attempt: 3, promptDigest: first.promptDigest,
    outputDigest: 'a'.repeat(64), quarantineUri: 'r2://ARTIFACTS/quarantine/synthetic-invalid-output.json',
    diagnostics: ['submission.observations[0].id must be a local identifier such as A1'],
    freshContext: true, continuationMode: 'new', sessionId: 'synthetic-session-3',
    usage: { modelCalls: 1, inputTokens: 123, outputTokens: 45, costUsd: 0.001 },
  })
  await source.recordFailure(failedTask, new PermanentRunFailure('synthetic repair exhausted', 'agent-repair-exhausted'))
  await source.fail('synthetic terminal core task')
  const failed = source.snapshot()
  await expect(RunMachine.fromState(definition, failed)).resolves.toBeDefined()
  const checkpoint = failed.checkpoints.at(-1)!
  const input = {
    definition, checkpoint, source: failed, sourceStateGeneration: failed.stateGeneration,
    sourceStateDigest: await sha256(failed), targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  }
  const prepared = await prepareFailedWaveRecovery(input)
  expect(prepared.evidence).toMatchObject({
    importedTaskIds: acceptedPeers.map(value => value.taskId).toSorted(),
    inheritedRejectedAttemptCount: 2, unknownUsageAttemptCount: 1,
  })
  const child = await RunMachine.recoverFailedWave(
    definition, checkpoint, failed, 'skipped-slot-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence,
  )
  expect(child.snapshot().budget).toEqual(failed.budget)
  const requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition, machine: child, artifactStore: artifacts, provider: {
    async run(request) { requests.push(request); return base.run(request) },
  } })
  expect(requests.filter(request => request.wave.id === first.waveId).map(request => request.task.id))
    .toEqual([missingTaskId])
  for (const peer of acceptedPeers) {
    expect(child.snapshot().artifacts.find(record => record.id === peer.id)).toEqual(peer)
  }
  expect(child.snapshot().rejectedAttempts.filter(value => value.taskId === missingTaskId).map(value => value.attempt))
    .toEqual([1, 3])
  expect(child.snapshot().budget.modelCalls).toBe(failed.budget.modelCalls
    + requests.filter(request => request.task.providerClass !== 'deterministic').length)
  const sealed = await child.seal()
  await expect(RunMachine.resume(definition, sealed, 'skipped-slot-grandchild'))
    .resolves.toBeDefined()

  await expect(prepareFailedWaveRecovery({ ...input, source: { ...failed, status: 'running' },
    sourceStateDigest: await sha256({ ...failed, status: 'running' }) })).rejects.toThrow('exact terminal partial wave')
  const altered = structuredClone(failed)
  altered.rejectedAttempts.find(value => value.taskId === missingTaskId && value.attempt === 1)!.sessionId = 'unexpected-session'
  await expect(prepareFailedWaveRecovery({ ...input, source: altered,
    sourceStateDigest: await sha256(altered) })).rejects.toThrow('exhausted attempts')
  const withoutTerminalFailure = structuredClone(failed)
  withoutTerminalFailure.journal = withoutTerminalFailure.journal.filter(event => (
    event.type !== 'task.failed' || (event.payload as { taskId?: string }).taskId !== missingTaskId
  ))
  await expect(prepareFailedWaveRecovery({ ...input, source: withoutTerminalFailure,
    sourceStateDigest: await sha256(withoutTerminalFailure) })).rejects.toThrow('exhausted attempts')
  const secondMissing = structuredClone(failed)
  secondMissing.artifacts = secondMissing.artifacts.filter(record => record.id !== acceptedPeers[0]!.id)
  await expect(prepareFailedWaveRecovery({ ...input, source: secondMissing,
    sourceStateDigest: await sha256(secondMissing) })).rejects.toThrow('snapshot is incomplete')
})

class LostReplicaProvider extends DeterministicAuditProvider {
  override async run(request: AgentRequest) {
    if (request.task.id === 'negative-review-replica') {
      throw new AgentAttemptFailure('synthetic Sandbox process disappeared without a receipt', {
        includeDiagnosticsInRepair: false,
      })
    }
    return super.run(request)
  }
}

class RecoveredPrimaryLostReplicaProvider extends LostReplicaProvider {
  private primaryCalls = 0

  override async run(request: AgentRequest) {
    if (request.task.id === 'negative-review-primary' && this.primaryCalls++ === 0) {
      throw new AgentAttemptFailure('synthetic primary process disappeared before replacement', {
        includeDiagnosticsInRepair: false,
      })
    }
    return super.run(request)
  }
}

it('recovers one failed partial wave without replaying its accepted independent peer', async () => {
  const artifacts = new MemoryArtifactStore()
  const source = await RunMachine.create(
    definition, 'c'.repeat(64), 'failed-wave-source', '2026-09-26T00:00:00.000Z', sourceRuntime,
  )
  const provider = new RecoveredPrimaryLostReplicaProvider()
  for (let guard = 0; source.snapshot().cursor.stageIndex < 4 && guard < 30; guard += 1) {
    await advanceExperimentOneWave({ definition, machine: source, provider, artifactStore: artifacts })
  }
  expect(source.snapshot().cursor).toEqual({ stageIndex: 4, waveIndex: 0 })
  await advanceExperimentOneWave({ definition, machine: source, provider, artifactStore: artifacts })
  await expect(advanceExperimentOneWave({
    definition, machine: source, provider, artifactStore: artifacts,
  })).rejects.toThrow('Sandbox process disappeared')
  await source.fail('negative-review-replica: synthetic Sandbox process disappeared without a receipt')

  const failed = source.snapshot()
  const checkpoint = failed.checkpoints.at(-1)!
  expect(failed.artifacts.some(record => record.taskId === 'negative-review-primary')).toBe(true)
  expect(checkpoint.body.acceptedArtifacts.some(record => record.taskId === 'negative-review-primary')).toBe(false)
  const sourceStateDigest = await sha256(failed)
  const prepared = await prepareFailedWaveRecovery({
    definition,
    checkpoint,
    source: failed,
    sourceStateGeneration: failed.stateGeneration,
    sourceStateDigest,
    targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  })
  expect(prepared.evidence).toMatchObject({
    importedTaskIds: ['negative-review-primary'],
    inheritedRejectedAttemptCount: 3,
    unknownUsageAttemptCount: 3,
  })

  const recovered = await RunMachine.recoverFailedWave(
    definition, checkpoint, failed, 'failed-wave-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence,
    '2026-09-26T01:00:00.000Z',
  )
  const requests: AgentRequest[] = []
  const recoveryProvider = new DeterministicAuditProvider()
  const observingProvider = {
    disposeWorkspace: recoveryProvider.disposeWorkspace.bind(recoveryProvider),
    async run(request: AgentRequest) {
      requests.push(request)
      return recoveryProvider.run(request)
    },
  }
  for (let guard = 0; recovered.snapshot().cursor.stageIndex === 4 && guard < 10; guard += 1) {
    await advanceExperimentOneWave({
      definition, machine: recovered, provider: observingProvider, artifactStore: artifacts,
    })
  }
  const paidRequests = requests.filter(request => request.task.providerClass !== 'deterministic')
  expect(paidRequests.map(request => request.task.id)).toEqual(['negative-review-replica'])
  expect(paidRequests[0]?.visibleArtifacts.some(record => record.taskId === 'negative-review-primary')).toBe(false)
  expect(recovered.snapshot().artifacts.filter(record => record.taskId === 'negative-review-primary')).toHaveLength(1)
  expect(recovered.snapshot().failedWaveRecovery?.unknownUsageAttemptCount).toBe(3)

  const recoveredCheckpoint = recovered.snapshot().checkpoints.at(-1)!
  const resumed = await RunMachine.resume(
    definition, recoveredCheckpoint, 'failed-wave-grandchild', new Set(),
    '2026-09-26T02:00:00.000Z', undefined, targetRuntime,
  )
  expect(resumed.snapshot()).toMatchObject({
    parentCheckpointDigest: recoveredCheckpoint.digest,
    failedWaveRecovery: { sourceRunId: 'failed-wave-source', unknownUsageAttemptCount: 3 },
  })
})

it('revalidates accepted research submissions before checking their persisted observation namespace', async () => {
  const artifacts = new MemoryArtifactStore()
  const machine = await RunMachine.create(
    definition, '1'.repeat(64), 'research-recovery-source', '2026-09-26T00:00:00.000Z', sourceRuntime,
  )
  const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
  const firstWave = discovery.waves[0]!
  const lostTasks = new Set(firstWave.tasks.filter(task => task.providerClass === 'additive').map(task => task.id))
  const provider = new DeterministicAuditProvider(lostTasks)

  await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
  let failure: unknown
  for (let guard = 0; guard < 5 && failure === undefined; guard += 1) {
    try {
      await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
    } catch (error) {
      failure = error
    }
  }
  expect(failure).toBeInstanceOf(Error)
  await machine.fail('synthetic additive transport exhaustion')

  const failed = machine.snapshot()
  const accepted = failed.artifacts.filter(record => (
    record.stageId === discovery.id && record.waveId === firstWave.id && record.status === 'accepted'
  ))
  expect(accepted.map(record => record.taskId).toSorted()).toEqual(
    firstWave.tasks.filter(task => task.providerClass === 'core').map(task => task.id).toSorted(),
  )
  expect(accepted.every(record => record.protocol.research?.observations.every(observation => (
    observation.id.startsWith('OBS-')
  )))).toBe(true)

  const checkpoint = failed.checkpoints.at(-1)!
  const prepared = await prepareFailedWaveRecovery({
    definition,
    checkpoint,
    source: failed,
    sourceStateGeneration: failed.stateGeneration,
    sourceStateDigest: await sha256(failed),
    targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  })
  expect(prepared.evidence.importedTaskIds).toEqual(
    failed.artifacts.filter(record => record.stageId === discovery.id).map(record => record.taskId).toSorted(),
  )

  const tampered = structuredClone(failed)
  const observation = tampered.artifacts.find(record => record.taskId === accepted[0]!.taskId)
    ?.protocol.research?.observations[0]
  expect(observation).toBeDefined()
  observation!.id = `${observation!.id}-tampered`
  await expect(prepareFailedWaveRecovery({
    definition,
    checkpoint,
    source: tampered,
    sourceStateGeneration: tampered.stateGeneration,
    sourceStateDigest: await sha256(tampered),
    targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  })).rejects.toThrow('invalid namespaced protocol')
})

it('rejects a tampered accepted peer during failed-wave recovery preparation', async () => {
  const artifacts = new MemoryArtifactStore()
  const machine = await RunMachine.create(
    definition, 'd'.repeat(64), 'tamper-source', '2026-09-26T00:00:00.000Z', sourceRuntime,
  )
  const provider = new LostReplicaProvider()
  for (let guard = 0; machine.snapshot().cursor.stageIndex < 4 && guard < 30; guard += 1) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
  }
  await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
  await expect(advanceExperimentOneWave({
    definition, machine, provider, artifactStore: artifacts,
  })).rejects.toThrow()
  await machine.fail('synthetic terminal failure')
  const state = machine.snapshot()
  const accepted = state.artifacts.find(record => record.taskId === 'negative-review-primary')!
  artifacts.contents.set(accepted.uri, '{"tampered":"yes"}')
  await expect(prepareFailedWaveRecovery({
    definition,
    checkpoint: state.checkpoints.at(-1)!,
    source: state,
    sourceStateGeneration: state.stateGeneration,
    sourceStateDigest: await sha256(state),
    targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  })).rejects.toThrow('digest mismatch')
})

it('recovers a repeated infrastructure loss without consuming inherited repair scope', async () => {
  const artifacts = new MemoryArtifactStore()
  const source = await RunMachine.create(
    definition, 'e'.repeat(64), 'repeat-source', '2026-09-26T00:00:00.000Z', sourceRuntime,
  )
  const provider = new LostReplicaProvider()
  for (let guard = 0; source.snapshot().cursor.stageIndex < 4 && guard < 30; guard += 1) {
    await advanceExperimentOneWave({ definition, machine: source, provider, artifactStore: artifacts })
  }
  await advanceExperimentOneWave({ definition, machine: source, provider, artifactStore: artifacts })
  await expect(advanceExperimentOneWave({
    definition, machine: source, provider, artifactStore: artifacts,
  })).rejects.toThrow('Sandbox process disappeared')
  await source.fail('first synthetic infrastructure loss')

  const failed = source.snapshot()
  const checkpoint = failed.checkpoints.at(-1)!
  const prepared = await prepareFailedWaveRecovery({
    definition, checkpoint, source: failed,
    sourceStateGeneration: failed.stateGeneration,
    sourceStateDigest: await sha256(failed),
    targetRuntimeRelease: targetRuntime,
    artifacts: acceptedReader(artifacts),
  })
  const child = await RunMachine.recoverFailedWave(
    definition, checkpoint, failed, 'repeat-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence,
  )
  await advanceExperimentOneWave({ definition, machine: child, provider, artifactStore: artifacts })
  await expect(advanceExperimentOneWave({
    definition, machine: child, provider, artifactStore: artifacts,
  })).rejects.toThrow('Sandbox process disappeared')
  await child.fail('second synthetic infrastructure loss')

  const second = child.snapshot()
  const finalRuntime: RuntimeRelease = {
    ...targetRuntime,
    id: 'runtime-final',
    frameworkCommit: 'f'.repeat(40),
    workerService: 'swarm-runtime-final',
    workerVersionId: '33333333-3333-4333-8333-333333333333',
    workflowName: 'audit-runtime-final',
  }
  const retry = await prepareFailedWaveRecovery({
    definition, checkpoint, source: second,
    sourceStateGeneration: second.stateGeneration,
    sourceStateDigest: await sha256(second),
    targetRuntimeRelease: finalRuntime,
    artifacts: acceptedReader(artifacts),
  })
  expect(retry.evidence).toMatchObject({
    inheritedRejectedAttemptCount: 4,
    unknownUsageAttemptCount: 4,
  })
  expect(retry.inheritedRejectedAttempts.map(value => value.repairScopeRunId)).toEqual([
    'repeat-source', 'repeat-source', 'repeat-child', 'repeat-child',
  ])
  await expect(RunMachine.recoverFailedWave(
    definition, checkpoint, second, 'repeat-final-child',
    retry.importedArtifacts, retry.inheritedRejectedAttempts, retry.evidence,
  )).resolves.toBeInstanceOf(RunMachine)
})
