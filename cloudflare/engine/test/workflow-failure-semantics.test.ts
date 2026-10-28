import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest, AgentResult } from '../src/contracts.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending, PermanentRunFailure, TransientRunFailure } from '../src/run-errors.js'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
import {
  canStopAtSealedWaveBoundary,
  failureForWorkflowProgress,
  workflowFailureDisposition,
  workflowProgress,
} from '../src/workflow-outcome.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const releaseDigest = 'a'.repeat(64)

class InterceptingProvider implements AgentProvider {
  readonly base = new DeterministicAuditProvider()

  constructor(private readonly intercept: (
    request: AgentRequest,
    next: () => Promise<AgentResult>,
  ) => Promise<AgentResult>) {}

  run(request: AgentRequest): Promise<AgentResult> {
    return this.intercept(request, () => this.base.run(request))
  }

  disposeWorkspace(input: { runId: string, workspaceKey: string }): Promise<void> {
    void input
    return this.base.disposeWorkspace()
  }
}

async function executeWithWorkflowRetries(operation: () => Promise<boolean>, limit = 3): Promise<void> {
  let lastError: unknown = null
  let failures = 0
  for (let cycle = 0; cycle < 20; cycle += 1) {
    try {
      if (await operation()) return
    } catch (error) {
      lastError = error
      if (workflowFailureDisposition(error) === 'fail') throw error
      failures += 1
      if (failures >= limit) throw error
    }
  }
  throw lastError ?? new Error('fixture exceeded its durable polling cycles')
}

async function machineAtDiscovery(
  runId: string,
  provider: AgentProvider,
  definition = audit0Definition,
): Promise<RunMachine> {
  const machine = await RunMachine.create(definition, releaseDigest, runId)
  await advanceExperimentOneWave({
    definition,
    machine,
    provider,
    artifactStore: new MemoryArtifactStore(),
  })
  expect(definition.stages[machine.snapshot().cursor.stageIndex]?.kind).toBe('discovery')
  return machine
}

describe('Workflow failure semantics', () => {
  it('retries quarantine storage without granting another agent repair or repeating paid work', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    const requests: AgentRequest[] = []
    const receipts = new Map<number, AgentResult>()
    let paidExecutions = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id !== target.id) return next()
      requests.push(structuredClone(request))
      const saved = receipts.get(request.attempt)
      if (saved !== undefined) return saved
      const result = await next()
      paidExecutions += 1
      const received = request.attempt === 1
        ? { ...result, files: { ...result.files, [SUBMISSION_PATH]: '{"complete":false}' }, protocol: {} }
        : result
      receipts.set(request.attempt, received)
      return received
    })
    const machine = await machineAtDiscovery('quarantine-transport-retry', provider)
    const artifacts = new MemoryArtifactStore()
    const originalPutRejected = artifacts.putRejected.bind(artifacts)
    let writes = 0
    artifacts.putRejected = async (record, content) => {
      writes += 1
      if (writes === 1) throw new TransientRunFailure('synthetic quarantine R2 outage')
      return originalPutRejected(record, content)
    }

    await executeWithWorkflowRetries(async () => advanceExperimentOneWave({
      definition: audit0Definition, machine, provider, artifactStore: artifacts,
    }))

    expect(requests.map(request => request.attempt)).toEqual([1, 1, 2])
    expect(requests[0]?.promptDigest).toBe(requests[1]?.promptDigest)
    expect(paidExecutions).toBe(2)
    expect(writes).toBe(2)
    expect(machine.snapshot().rejectedAttempts.filter(value => value.taskId === target.id)).toHaveLength(1)
    expect(machine.snapshot().artifacts.filter(value => value.taskId === target.id)).toHaveLength(1)
  })

  it('executes a permanent preflight failure once', async () => {
    let calls = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.promptKind !== 'preflight') return next()
      calls += 1
      throw new PermanentRunFailure('fixture preflight rejected the target', 'preflight-failed')
    })
    const machine = await RunMachine.create(audit0Definition, releaseDigest, 'permanent-preflight')

    await expect(executeWithWorkflowRetries(async () => {
      return advanceExperimentOneWave({
        definition: audit0Definition,
        machine,
        provider,
        artifactStore: new MemoryArtifactStore(),
      })
    })).rejects.toMatchObject({ category: 'preflight-failed', retryable: false })
    expect(calls).toBe(1)
  })

  it('retries a temporary transport failure and reuses the paid execution result', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    let targetCalls = 0
    let paidExecutions = 0
    let receipt: AgentResult | null = null
    const calls = new Map<string, number>()
    const provider = new InterceptingProvider(async (request, next) => {
      calls.set(request.task.id, (calls.get(request.task.id) ?? 0) + 1)
      if (request.task.id !== target.id) return next()
      targetCalls += 1
      if (receipt !== null) return receipt
      receipt = await next()
      paidExecutions += 1
      throw new TransientRunFailure('fixture R2 receipt publication was interrupted')
    })
    const machine = await machineAtDiscovery('transport-retry', provider)
    const artifacts = new MemoryArtifactStore()

    await executeWithWorkflowRetries(async () => {
      return advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: artifacts })
    })

    const state = machine.snapshot()
    expect(targetCalls).toBe(2)
    expect(paidExecutions).toBe(1)
    expect([...calls].filter(([taskId]) => taskId !== target.id).every(([, count]) => count === 1)).toBe(true)
    expect(state.artifacts.filter(artifact => artifact.taskId === target.id)).toHaveLength(1)
    expect(state.rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toEqual([])
    expect(state.artifacts.find(artifact => artifact.taskId === target.id)?.usage.modelCalls).toBe(1)
    await expect(RunMachine.resume(
      audit0Definition, state.checkpoints.at(-1)!, 'transport-retry-child',
    )).resolves.toBeDefined()
  })

  it('survives three observation transport faults and recovers the same admitted attempt', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    const requests: AgentRequest[] = []
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id !== target.id) return next()
      requests.push(structuredClone(request))
      if (requests.length <= 3) throw new TransientRunFailure('fixture status transport unavailable')
      return next()
    })
    const machine = await machineAtDiscovery('three-transport-faults', provider)
    const artifacts = new MemoryArtifactStore()

    await executeWithWorkflowRetries(async () => advanceExperimentOneWave({
      definition: audit0Definition, machine, provider, artifactStore: artifacts,
    }))

    expect(requests).toHaveLength(4)
    expect(new Set(requests.map(request => JSON.stringify({
      attempt: request.attempt,
      prompt: request.prompt,
      promptDigest: request.promptDigest,
      sessionId: request.sessionId,
      continuationMode: request.continuationMode,
    }))).size).toBe(1)
    expect(machine.snapshot().rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toEqual([])
    expect(machine.snapshot().inFlightAgentAttempts).toEqual([])
  })

  it('replays a durable result after state ingestion fails without a second paid execution', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    let receipt: AgentResult | null = null
    let paidExecutions = 0
    let targetCalls = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id !== target.id) return next()
      targetCalls += 1
      if (receipt !== null) return receipt
      receipt = await next()
      paidExecutions += 1
      return receipt
    })
    class InterruptedArtifactStore extends MemoryArtifactStore {
      private interrupted = false

      async put(record: Parameters<MemoryArtifactStore['put']>[0], content: string) {
        if (record.taskId === target.id && !this.interrupted) {
          this.interrupted = true
          throw new TransientRunFailure('fixture state ingestion interrupted after durable receipt')
        }
        return super.put(record, content)
      }
    }
    const machine = await machineAtDiscovery('receipt-before-state', provider)
    const artifacts = new InterruptedArtifactStore()

    await expect(advanceExperimentOneWave({
      definition: audit0Definition, machine, provider, artifactStore: artifacts,
    })).rejects.toThrow('state ingestion interrupted after durable receipt')
    expect(machine.snapshot().inFlightAgentAttempts).toEqual([
      expect.objectContaining({ taskId: target.id, attempt: 1 }),
    ])

    const recovered = await RunMachine.fromState(audit0Definition, machine.snapshot())
    await expect(advanceExperimentOneWave({
      definition: audit0Definition, machine: recovered, provider, artifactStore: artifacts,
    })).resolves.toBe(true)
    expect(targetCalls).toBe(2)
    expect(paidExecutions).toBe(1)
    expect(recovered.snapshot().inFlightAgentAttempts).toEqual([])
    expect(recovered.snapshot().artifacts.filter(artifact => artifact.taskId === target.id)).toHaveLength(1)
  })

  it('retries admission persistence without misclassifying it as a budget failure', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    let persistenceFailures = 0
    let targetCalls = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id === target.id) targetCalls += 1
      return next()
    })
    const machine = await machineAtDiscovery('admission-persistence-retry', provider)
    const artifacts = new MemoryArtifactStore()
    const persist = async (state: ReturnType<RunMachine['snapshot']>) => {
      if (persistenceFailures === 0 && (state.inFlightAgentAttempts ?? [])
        .some(admission => admission.taskId === target.id)) {
        persistenceFailures += 1
        throw new Error('fixture run-state write unavailable')
      }
    }

    await expect(advanceExperimentOneWave({
      definition: audit0Definition, machine, provider, artifactStore: artifacts, onWaveAdmission: persist,
    })).rejects.toMatchObject({ category: 'transport', retryable: true })
    expect(machine.snapshot().rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toEqual([])
    expect(targetCalls).toBe(0)

    await expect(advanceExperimentOneWave({
      definition: audit0Definition, machine, provider, artifactStore: artifacts, onWaveAdmission: persist,
    })).resolves.toBe(true)
    expect(targetCalls).toBe(1)
    expect(machine.snapshot().inFlightAgentAttempts).toEqual([])
  })

  it('continues a healthy admitted process in a later durable polling slice', async () => {
    const definition = structuredClone(audit0Definition)
    const discoveryWave = definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!
    const paidLaneCount = discoveryWave.tasks.filter(task => task.providerClass !== 'deterministic').length
    definition.limits.maxModelCalls = paidLaneCount
    definition.limits.maxCostUsd = paidLaneCount - 1
    const target = discoveryWave.tasks.find(task => task.providerClass === 'core')!
    const requests: AgentRequest[] = []
    let targetCalls = 0
    let targetAdmissionPersisted = false
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id !== target.id) {
        const result = await next()
        return request.task.providerClass === 'deterministic' ? result : { ...result, costUsd: 1 }
      }
      expect(targetAdmissionPersisted).toBe(true)
      requests.push(structuredClone(request))
      targetCalls += 1
      if (targetCalls === 1) throw new AgentExecutionPending(`fixture-${request.promptDigest.slice(0, 12)}`)
      return { ...await next(), costUsd: 1 }
    })
    const machine = await machineAtDiscovery('durable-polling-slice', provider, definition)
    const artifacts = new MemoryArtifactStore()

    await expect(advanceExperimentOneWave({
      definition, machine, provider, artifactStore: artifacts,
      onWaveAdmission: async state => {
        targetAdmissionPersisted ||= (state.inFlightAgentAttempts ?? [])
          .some(admission => admission.taskId === target.id)
      },
    })).resolves.toBe(false)

    const pendingState = machine.snapshot()
    expect(pendingState.status).toBe('running')
    expect(pendingState.waveAdmission).toBeNull()
    expect(pendingState.discoveryScheduler?.admissions).toContainEqual(expect.objectContaining({
      stageId: 'discovery', waveId: 'wave-0', poolId: configuredResearchTaskPoolId(target),
    }))
    expect(pendingState.artifacts.some(artifact => artifact.taskId !== target.id && artifact.waveId === 'wave-0')).toBe(true)
    expect(pendingState.artifacts.some(artifact => artifact.taskId === target.id && artifact.waveId === 'wave-0')).toBe(false)
    expect(pendingState.rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toEqual([])
    expect(pendingState.budget.modelCalls).toBe(definition.limits.maxModelCalls - 1)
    expect(pendingState.budget.costUsd).toBe(definition.limits.maxCostUsd)
    expect(pendingState.inFlightAgentAttempts).toEqual([
      expect.objectContaining({ taskId: target.id, attempt: 1, promptDigest: requests[0]?.promptDigest }),
    ])
    expect(canStopAtSealedWaveBoundary(pendingState, true)).toBe(false)
    const reconstructed = await RunMachine.fromState(definition, structuredClone(pendingState))

    await expect(advanceExperimentOneWave({
      definition, machine: reconstructed, provider, artifactStore: artifacts,
      onWaveAdmission: async state => {
        targetAdmissionPersisted ||= (state.inFlightAgentAttempts ?? [])
          .some(admission => admission.taskId === target.id)
      },
    })).resolves.toBe(true)

    expect(targetCalls).toBe(2)
    expect(requests[1]).toMatchObject({ attempt: requests[0]?.attempt, promptDigest: requests[0]?.promptDigest })
    expect(reconstructed.snapshot().waveReceipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'discovery', waveId: 'wave-0' }),
    ]))
    expect(reconstructed.snapshot().rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toEqual([])
    expect(reconstructed.snapshot().budget.costUsd).toBeGreaterThan(definition.limits.maxCostUsd)
    expect(reconstructed.snapshot().inFlightAgentAttempts).toEqual([])
    expect(canStopAtSealedWaveBoundary(reconstructed.snapshot(), true)).toBe(true)
  })

  it('gives a permanent exhausted repair precedence over a parallel transport failure', async () => {
    const wave = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!
    const transientTarget = wave.tasks[0]!
    const exhaustedTarget = wave.tasks.find((task, index) => index > 0 && task.providerClass === 'core')!
    let transientCalls = 0
    let exhaustedCalls = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id === transientTarget.id) {
        transientCalls += 1
        if (transientCalls < 3) throw new TransientRunFailure('fixture parallel transport loss')
        return next()
      }
      const result = await next()
      if (request.task.id !== exhaustedTarget.id) return result
      exhaustedCalls += 1
      return { ...result, files: {}, protocol: {} }
    })
    const machine = await machineAtDiscovery('parallel-failure-precedence', provider)
    const artifacts = new MemoryArtifactStore()

    await expect(executeWithWorkflowRetries(async () => {
      return advanceExperimentOneWave({
        definition: audit0Definition, machine, provider, artifactStore: artifacts,
      })
    })).rejects.toMatchObject({ category: 'agent-repair-exhausted', retryable: false })
    expect(transientCalls).toBe(3)
    expect(exhaustedCalls).toBe(11) // Initial malformed output plus ten bounded same-session corrections.
  })

  it('preserves an exact same-session repair across multiple pending slices', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    const requests: AgentRequest[] = []
    let pendingSlices = 0
    const provider = new InterceptingProvider(async (request, next) => {
      if (request.task.id !== target.id) return next()
      requests.push(structuredClone(request))
      if (request.attempt === 2 && pendingSlices < 2) {
        pendingSlices += 1
        throw new AgentExecutionPending(`fixture-repair-${request.promptDigest.slice(0, 12)}`)
      }
      const result = await next()
      return request.attempt === 1 ? { ...result, files: {}, protocol: {} } : result
    })
    const machine = await machineAtDiscovery('persisted-repair-progress', provider)
    const artifacts = new MemoryArtifactStore()

    await executeWithWorkflowRetries(async () => {
      return advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: artifacts })
    })

    expect(requests.map(request => request.attempt)).toEqual([1, 2, 2, 2])
    for (const replay of requests.slice(2)) {
      expect(replay.prompt).toBe(requests[1]?.prompt)
      expect(replay.promptDigest).toBe(requests[1]?.promptDigest)
      expect(replay.sessionId).toBe(requests[1]?.sessionId)
      expect(replay.continuationMode).toBe(requests[1]?.continuationMode)
      expect(replay.diagnostics).toEqual(requests[1]?.diagnostics)
      expect(replay.repairFiles).toEqual(requests[1]?.repairFiles)
    }
    expect(requests[1]?.continuationMode).toBe('resume')
    expect(requests[1]?.sessionId).toBeTruthy()
  })

  it('does not grant exhausted output repairs another Workflow allowance', async () => {
    const target = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'core')!
    let calls = 0
    const provider = new InterceptingProvider(async (request, next) => {
      const result = await next()
      if (request.task.id !== target.id) return result
      calls += 1
      return { ...result, files: {}, protocol: {} }
    })
    const machine = await machineAtDiscovery('repair-exhaustion', provider)
    const artifacts = new MemoryArtifactStore()

    await expect(executeWithWorkflowRetries(async () => {
      return advanceExperimentOneWave({
        definition: audit0Definition,
        machine,
        provider,
        artifactStore: artifacts,
      })
    })).rejects.toMatchObject({ category: 'agent-repair-exhausted', retryable: false })
    expect(calls).toBe(11)
    expect(machine.snapshot().rejectedAttempts.filter(attempt => attempt.taskId === target.id)).toHaveLength(11)
  })

  it('maps persisted failed, completed, and stopped states to distinct Workflow outcomes', async () => {
    const failedMachine = await RunMachine.create(audit0Definition, releaseDigest, 'persisted-failed')
    await failedMachine.start()
    await failedMachine.fail('fixture terminal reason')
    const failed = workflowProgress(failedMachine.snapshot())
    expect(failed).toMatchObject({ status: 'failed', terminalReason: 'fixture terminal reason' })
    expect(failureForWorkflowProgress(failed)).toMatchObject({
      category: 'persisted-run-failed', retryable: false, message: 'fixture terminal reason',
    })

    for (const status of ['completed', 'stopped'] as const) {
      const progress = { ...failed, status, terminalReason: status === 'stopped' ? 'operator stop' : null }
      expect(failureForWorkflowProgress(progress)).toBeNull()
      expect(progress.status).toBe(status)
    }
  })
})
