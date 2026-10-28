import { expect, it, vi } from 'vitest'
import type { AgentRequest, AgentResult, RuntimeRelease } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import type { AgentLogRequest } from '../src/agent-execution-log.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { RunMachine } from '../src/machine.js'
import { PromotedExecutionProvider } from '../src/promoted-execution.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave, runNextWave } from '../src/runner.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

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

const definition = {
  ...audit0Definition,
  pools: audit0Definition.pools.map(pool => pool.id === 'deepseek' ? { ...pool, agents: 1 } : pool),
  stages: audit0Definition.stages.map(stage => stage.kind !== 'discovery' ? stage : {
    ...stage,
    waves: stage.waves.map(wave => {
      const tasks = wave.tasks.filter(task => task.providerClass !== 'additive' || task.research?.researcher === 1)
      return { ...wave, tasks, minSuccessfulTasks: tasks.length, minDistinctActors: tasks.length }
    }),
  }),
}

class CompletedLateTransportProvider extends DeterministicAuditProvider {
  readonly completed: { request: AgentRequest, result: AgentResult }[] = []

  override async run(request: AgentRequest): Promise<AgentResult> {
    const result = await super.run(request)
    if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'additive') return result
    this.completed.push({ request: structuredClone(request), result: structuredClone(result) })
    throw new AgentAttemptFailure('synthetic provider returned a late 504 after the handoff', {
      includeDiagnosticsInRepair: false,
      usage: { modelCalls: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd },
    })
  }
}

async function globalFailedWaveFixture() {
  const artifacts = new MemoryArtifactStore()
  const source = await RunMachine.create(
    definition,
    'c'.repeat(64),
    'global-late-source',
    '2026-09-18T00:00:00.000Z',
    sourceRuntime,
  )
  const provider = new CompletedLateTransportProvider()
  await runNextWave({ definition, machine: source, provider, artifactStore: artifacts })
  await expect(runNextWave({
    definition, machine: source, provider, artifactStore: artifacts,
  })).resolves.toBeNull()
  await expect(runNextWave({
    definition, machine: source, provider, artifactStore: artifacts,
  })).rejects.toThrow('late 504')
  await source.fail('synthetic terminal late transport failure')
  const state = source.snapshot()
  expect(state.discoveryScheduler).toBeUndefined()
  expect(state.waveAdmission).not.toBeNull()
  const completed = provider.completed.at(-1)!
  const requestDigest = 'd'.repeat(64)
  const receipt: AgentExecutionReceipt = {
    requestDigest,
    exitCode: 1,
    actorId: completed.result.actorId,
    files: { ...completed.result.files },
    inputTokens: completed.result.inputTokens,
    outputTokens: completed.result.outputTokens,
    costUsd: completed.result.costUsd,
    providerHttpStatus: 504,
    providerErrorCode: null,
    providerRequests: [{
      schemaVersion: 1,
      provider: completed.result.provider,
      model: completed.request.task.model,
      thinking: completed.request.task.thinking ?? null,
      reasoningEffort: completed.request.task.reasoning,
      stream: true,
      maxOutputTokens: 256_000,
      startedAt: '2026-09-18T01:00:00.000Z',
      durationMs: 302_000,
      timeToFirstByteMs: null,
      providerHttpStatus: 504,
      requestId: null,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      costUsd: null,
      abortedByClient: false,
    }],
    stderr: 'synthetic late upstream timeout',
  }
  const recorded: AgentLogRequest = {
    schemaVersion: 1,
    runId: state.runId,
    stageId: completed.request.stage.id,
    waveId: completed.request.wave.id,
    taskId: completed.request.task.id,
    requestDigest,
    promptDigest: completed.request.promptDigest,
    prompt: completed.request.prompt,
    model: completed.request.task.model,
    provider: completed.result.provider,
    attempt: completed.request.attempt,
    startedAt: '2026-09-18T01:00:00.000Z',
    startedAtBasis: 'execution-admission',
  }
  return { artifacts, source: state, receipt, recorded }
}

function readers(recorded: AgentLogRequest, receipt: AgentExecutionReceipt) {
  return {
    receipts: { async get(runId: string, requestDigest: string) {
      return runId === recorded.runId && requestDigest === recorded.requestDigest ? structuredClone(receipt) : null
    } },
    requests: { async getRequest(runId: string, taskId: string, requestDigest: string) {
      return runId === recorded.runId && taskId === recorded.taskId && requestDigest === recorded.requestDigest
        ? structuredClone(recorded) : null
    } },
  }
}

async function prepareFixture(overrides?: {
  recorded?: (value: AgentLogRequest) => AgentLogRequest
  receipt?: (value: AgentExecutionReceipt) => AgentExecutionReceipt
}, expired = true) {
  const fixture = await globalFailedWaveFixture()
  const recorded = overrides?.recorded?.(structuredClone(fixture.recorded)) ?? fixture.recorded
  const receipt = overrides?.receipt?.(structuredClone(fixture.receipt)) ?? fixture.receipt
  const evidence = readers(recorded, receipt)
  const deadline = Date.parse(fixture.source.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
  vi.useFakeTimers()
  vi.setSystemTime(expired ? deadline + 1 : deadline - 1)
  let prepared
  try {
    prepared = await prepareFailedWaveRecovery({
      definition,
      checkpoint: fixture.source.checkpoints.at(-1)!,
      source: fixture.source,
      sourceStateGeneration: fixture.source.stateGeneration,
      sourceStateDigest: await sha256(fixture.source),
      targetRuntimeRelease: targetRuntime,
      artifacts: { async read(record) {
        const content = fixture.artifacts.contents.get(record.uri)
        if (content === undefined) throw new Error('fixture artifact is missing')
        return JSON.parse(content) as Readonly<Record<string, string>>
      } },
      promoteExecution: {
        taskId: fixture.recorded.taskId,
        sourceAttempt: fixture.recorded.attempt,
        requestDigest: fixture.recorded.requestDigest,
      },
      executionReceipts: evidence.receipts,
      executionRequests: evidence.requests,
    })
  } finally {
    vi.useRealTimers()
  }
  return { ...fixture, ...evidence, prepared }
}

it('promotes an exact completed late-504 handoff and ends expired global discovery without a provider call', async () => {
  const fixture = await prepareFixture()
  const child = await RunMachine.recoverFailedWave(
    definition,
    fixture.source.checkpoints.at(-1)!,
    fixture.source,
    'global-late-child',
    fixture.prepared.importedArtifacts,
    fixture.prepared.inheritedRejectedAttempts,
    fixture.prepared.evidence,
  )
  const before = child.snapshot()
  const fallbackCalls: string[] = []
  const provider = new PromotedExecutionProvider({
    async run(request) {
      fallbackCalls.push(request.task.id)
      throw new Error('unexpected provider call')
    },
  }, fixture.receipts, fixture.requests, fixture.prepared.evidence.promotedExecution)
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(before.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000 + 1)
  try {
    await advanceExperimentOneWave({
      definition,
      machine: child,
      provider,
      artifactStore: fixture.artifacts,
    })
  } finally {
    vi.useRealTimers()
  }
  const after = child.snapshot()
  expect(fallbackCalls).toEqual([])
  expect(after.cursor.stageIndex).toBe(2)
  expect(after.artifacts.some(artifact => (
    artifact.taskId === fixture.recorded.taskId && artifact.status === 'accepted'
  ))).toBe(true)
  expect(after.artifacts.find(artifact => artifact.taskId === fixture.recorded.taskId)?.usage.modelCalls).toBe(0)
  expect(after.budget).toEqual(before.budget)
  expect(after.modelStartedAt).toBe(before.modelStartedAt)
  expect(after.rejectedAttempts).toEqual(before.rejectedAttempts)
  expect(after.stageEndReceipts.at(-1)?.reason).toBe('phase-deadline')
  expect(after.waveReceipts.some(receipt => (
    receipt.stageId === fixture.recorded.stageId && receipt.waveId === fixture.recorded.waveId
  ))).toBe(true)
  await expect(RunMachine.fromState(definition, after)).resolves.toBeInstanceOf(RunMachine)
  const checkpoint = after.checkpoints.at(-1)!
  const resumeAt = new Date(Date.parse(checkpoint.body.sealedAt) + 1_000).toISOString()
  await expect(RunMachine.resume(definition, checkpoint, 'promoted-checkpoint-child', new Set(), resumeAt))
    .resolves.toBeInstanceOf(RunMachine)

  const forgedBody = structuredClone(checkpoint.body)
  const forgedArtifact = forgedBody.acceptedArtifacts.find(artifact => artifact.taskId === fixture.recorded.taskId)!
  forgedArtifact.assertions = forgedArtifact.assertions.filter(assertion => !assertion.startsWith('promoted-execution:'))
  const forged = { body: forgedBody, digest: await sha256(forgedBody) }
  await expect(RunMachine.resume(definition, forged, 'forged-promoted-checkpoint-child', new Set(), resumeAt))
    .rejects.toThrow(`checkpoint artifact identity is invalid: ${fixture.recorded.taskId}`)
})

async function quarantinedFixture(change?: 'session' | 'prompt' | 'files') {
  const fixture = await globalFailedWaveFixture()
  const source = structuredClone(fixture.source)
  const saved = { ...fixture.receipt, exitCode: 0, providerHttpStatus: null, providerErrorCode: null,
    providerRequests: [], stderr: '' }
  const files = structuredClone(saved.files)
  const digest = await sha256(files)
  const uri = await fixture.artifacts.putRejected({ id: 'fixture-quarantined-output',
    taskId: fixture.recorded.taskId, contentDigest: digest }, canonicalJson(files))
  const rejection = source.rejectedAttempts.find(value => value.taskId === fixture.recorded.taskId && value.attempt === 2)!
  rejection.outputDigest = digest
  rejection.quarantineUri = uri
  rejection.sessionId = saved.actorId
  rejection.diagnostics = ['synthetic historical format rejection']
  if (change === 'session') saved.actorId = 'session-22222222-2222-4222-8222-222222222222'
  if (change === 'files') saved.files = {}
  const recorded = change === 'prompt' ? { ...fixture.recorded, prompt: 'forged prompt' } : fixture.recorded
  const evidence = readers(recorded, saved)
  const deadline = Date.parse(source.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
  vi.useFakeTimers(); vi.setSystemTime(deadline + 1)
  try {
    const prepared = await prepareFailedWaveRecovery({
      definition, checkpoint: source.checkpoints.at(-1)!, source,
      sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
      targetRuntimeRelease: targetRuntime,
      artifacts: { async read(record) {
        return JSON.parse(fixture.artifacts.contents.get(record.uri)!) as Readonly<Record<string, string>>
      } },
      promoteExecution: { taskId: recorded.taskId, sourceAttempt: 2,
        requestDigest: recorded.requestDigest, quarantineOutputDigest: digest },
      executionReceipts: evidence.receipts, executionRequests: evidence.requests,
      quarantined: fixture.artifacts,
    })
    return { ...fixture, source, recorded, receipt: saved, ...evidence, prepared }
  } finally { vi.useRealTimers() }
}

it('accepts one exact quarantined response with zero new model calls and seals its lineage', async () => {
  const fixture = await quarantinedFixture()
  const child = await RunMachine.recoverFailedWave(definition, fixture.source.checkpoints.at(-1)!,
    fixture.source, 'quarantined-child', fixture.prepared.importedArtifacts,
    fixture.prepared.inheritedRejectedAttempts, fixture.prepared.evidence)
  const before = child.snapshot(), calls: string[] = []
  const provider = new PromotedExecutionProvider({ async run(request) {
    calls.push(request.task.id); throw new Error('unexpected paid provider call')
  } }, fixture.receipts, fixture.requests, fixture.prepared.evidence.promotedExecution)
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(before.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000 + 1)
  try { await advanceExperimentOneWave({ definition, machine: child, provider,
    artifactStore: fixture.artifacts }) } finally { vi.useRealTimers() }
  const after = child.snapshot()
  expect(calls).toEqual([])
  expect(after.budget).toEqual(before.budget)
  expect(after.rejectedAttempts).toEqual(before.rejectedAttempts)
  expect(after.artifacts.find(record => record.taskId === fixture.recorded.taskId))
    .toMatchObject({ status: 'accepted', usage: { modelCalls: 0 } })
  await expect(RunMachine.fromState(definition, after)).resolves.toBeInstanceOf(RunMachine)
  const sealed = after.checkpoints.at(-1)!
  await expect(RunMachine.resume(definition, sealed, 'quarantined-resumed')).resolves.toBeInstanceOf(RunMachine)
})

it.each(['session', 'prompt', 'files'] as const)('rejects swapped quarantined %s custody', async change => {
  await expect(quarantinedFixture(change)).rejects.toThrow()
})

it('rejects a recorded request that is not independently bound to the source rejection', async () => {
  await expect(prepareFixture({
    recorded: value => ({ ...value, promptDigest: 'e'.repeat(64) }),
  })).rejects.toThrow('request provenance mismatch')
})

it('rejects an incomplete historical handoff without terminal upstream failure evidence', async () => {
  await expect(prepareFixture({
    receipt: value => ({ ...value, files: {},
      providerRequests: value.providerRequests!.map(request => ({ ...request, providerHttpStatus: 200 })),
    }),
  })).rejects.toThrow()
})

it('rejects legacy promotion before discovery expires instead of entering the independent scheduler', async () => {
  await expect(prepareFixture(undefined, false))
    .rejects.toThrow('legacy promoted execution requires an expired discovery phase')
})

it('preserves promotion proof through a later failed-wave recovery and checkpoint resume', async () => {
  const fixture = await prepareFixture()
  const deadline = Date.parse(fixture.source.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000
  vi.useFakeTimers()
  vi.setSystemTime(deadline + 1)
  try {
    const child = await RunMachine.recoverFailedWave(
      definition,
      fixture.source.checkpoints.at(-1)!,
      fixture.source,
      'first-promoted-child',
      fixture.prepared.importedArtifacts,
      fixture.prepared.inheritedRejectedAttempts,
      fixture.prepared.evidence,
    )
    const ordinary = new DeterministicAuditProvider()
    const promotedProvider = new PromotedExecutionProvider(
      ordinary, fixture.receipts, fixture.requests, fixture.prepared.evidence.promotedExecution,
    )
    for (let guard = 0; child.snapshot().cursor.stageIndex < 4 && guard < 20; guard += 1) {
      await advanceExperimentOneWave({
        definition, machine: child, provider: promotedProvider, artifactStore: fixture.artifacts,
      })
    }
    expect(child.snapshot().cursor.stageIndex).toBe(4)

    const reviewStage = definition.stages[4]!
    const lostTask = reviewStage.waves[0]!.tasks.find(task => task.providerClass === 'additive')!
    const failingProvider = {
      async run(request: AgentRequest) {
        if (request.task.id === lostTask.id) {
          throw new AgentAttemptFailure('synthetic later transport failure', {
            includeDiagnosticsInRepair: false,
          })
        }
        return ordinary.run(request)
      },
    }
    await expect(advanceExperimentOneWave({
      definition, machine: child, provider: failingProvider, artifactStore: fixture.artifacts,
    })).resolves.toBe(false)
    await expect(advanceExperimentOneWave({
      definition, machine: child, provider: failingProvider, artifactStore: fixture.artifacts,
    })).rejects.toThrow('synthetic later transport failure')
    await child.fail('synthetic later transport failure')

    const source = child.snapshot()
    const laterRuntime: RuntimeRelease = {
      ...targetRuntime,
      id: 'runtime-later',
      frameworkCommit: 'e'.repeat(40),
      workerService: 'swarm-runtime-later',
      workerVersionId: '33333333-3333-4333-8333-333333333333',
      workflowName: 'audit-runtime-later',
    }
    const prepared = await prepareFailedWaveRecovery({
      definition,
      checkpoint: source.checkpoints.at(-1)!,
      source,
      sourceStateGeneration: source.stateGeneration,
      sourceStateDigest: await sha256(source),
      targetRuntimeRelease: laterRuntime,
      artifacts: { async read(record) {
        const content = fixture.artifacts.contents.get(record.uri)
        if (content === undefined) throw new Error('fixture artifact is missing')
        return JSON.parse(content) as Readonly<Record<string, string>>
      } },
    })
    const later = await RunMachine.recoverFailedWave(
      definition,
      source.checkpoints.at(-1)!,
      source,
      'later-recovered-child',
      prepared.importedArtifacts,
      prepared.inheritedRejectedAttempts,
      prepared.evidence,
    )
    expect(later.snapshot().promotedExecutionProofs).toEqual([
      fixture.prepared.evidence.promotedExecution,
    ])
    await advanceExperimentOneWave({
      definition, machine: later, provider: ordinary, artifactStore: fixture.artifacts,
    })
    await expect(RunMachine.resume(
      definition, later.snapshot().checkpoints.at(-1)!, 'later-resumed-child', new Set(),
      new Date(Date.now() + 1_000).toISOString(), undefined, laterRuntime,
    )).resolves.toBeInstanceOf(RunMachine)
  } finally {
    vi.useRealTimers()
  }
})
