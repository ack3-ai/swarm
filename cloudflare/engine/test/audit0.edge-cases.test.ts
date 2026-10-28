import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest, AgentResult } from '../src/contracts.js'
import {
  RunMachine, SUBMISSION_PATH, advanceExperimentOneWave, createAudit0RunPolicy, runNextWave, sealReleasePackage,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { AgentAttemptFailure, PermanentRunFailure } from '../src/run-errors.js'
// @ts-expect-error JavaScript container module intentionally has no TS build step.
import { dshUsage } from '../container/dsh-usage.mjs'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import {
  agentResultFromExecutionReceipt,
  isLateUpstreamHandoffCandidate,
} from '../src/late-upstream-handoff.js'
import { validateAgentResult } from '../src/protocol-validation.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const startedAt = '2026-09-18T20:00:00.000Z'

it.each(['codex', 'claude'] as const)('does not send exhausted %s quota back to the agent as a repair', async backend => {
  const attempts: number[] = []
  const provider = wrapped(async (request, result) => {
    if (request.task.id !== 'core-wave-0-research-1') return result
    attempts.push(request.attempt)
    const receipt = late504Receipt(request, result, { providerRequests: [], providerHttpStatus: null,
      subscriptionLimits: { provider: backend, observedAt: startedAt, exhausted: true,
        windows: [{ name: 'five_hour', usedPercent: 100, resetsAt: '2026-09-19T01:00:00.000Z' }] } })
    return agentResultFromExecutionReceipt({ ...request, task: { ...request.task, backend } },
      receipt, receipt.requestDigest, false)
  })
  await expect(run(`quota-${backend}`, provider)).rejects.toMatchObject({
    message: expect.stringContaining('subscription quota exhausted'),
    rejections: expect.arrayContaining([expect.objectContaining({
      usage: expect.objectContaining({ inputTokens: 12_345 }),
    })]),
  })
  expect(attempts).toEqual([1])
})

async function run(runId: string, provider: AgentProvider) {
  const release = await sealReleasePackage(audit0PackageBody)
  const machine = await RunMachine.create(audit0Definition, release.digest, runId, startedAt)
  const store = new MemoryArtifactStore()
  const outcome = await runExperiment({
    definition: audit0Definition, machine, provider, artifactStore: store,
    policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
  })
  return { outcome, store }
}

function wrapped(mutate: (request: AgentRequest, result: AgentResult) => AgentResult | Promise<AgentResult>): AgentProvider {
  const base = new DeterministicAuditProvider()
  return { async run(request) { return mutate(request, await base.run(request)) } }
}

function late504Receipt(
  request: AgentRequest,
  result: AgentResult,
  overrides: Partial<AgentExecutionReceipt> = {},
): AgentExecutionReceipt {
  const requestDigest = 'c'.repeat(64)
  return {
    requestDigest,
    exitCode: 1,
    actorId: result.actorId,
    files: { ...result.files },
    inputTokens: 12_345,
    rawInputTokens: 12_345,
    cachedInputTokens: 0,
    cacheAccountingComplete: false,
    outputTokens: 678,
    costUsd: 0.045,
    providerHttpStatus: 504,
    providerErrorCode: null,
    providerRequests: [{
      schemaVersion: 1,
      provider: result.provider,
      model: request.task.model,
      thinking: request.task.thinking ?? null,
      reasoningEffort: request.task.reasoning,
      stream: true,
      maxOutputTokens: null,
      startedAt: '2026-09-27T06:00:00.000Z',
      durationMs: 302_114,
      timeToFirstByteMs: null,
      providerHttpStatus: 504,
      requestId: 'late-504-fixture',
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      costUsd: null,
      abortedByClient: false,
    }],
    stderr: 'upstream request returned HTTP 504 after the handoff was written',
    ...overrides,
  }
}

describe('audit0 sanitized edge contracts', () => {
  it('seals a completed DSH result with partial cache detail without rerunning the agent', async () => {
    const usage = dshUsage([
      { type: 'session', sessionId: 'cache-fixture' },
      { type: 'status', phase: 'step_end', turn: 1, step: 0,
        usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 3, totalTokens: 103 } },
      { type: 'status', phase: 'step_end', turn: 1, step: 1,
        usage: { inputTokens: 20, outputTokens: 2, totalTokens: 22 } },
      { type: 'final', text: 'done' },
    ].map(event => JSON.stringify(event)).join('\n'))
    const attempts: number[] = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'additive-wave-0-research-1') return result
      attempts.push(request.attempt)
      return { ...result, inputTokens: usage.inputTokens, rawInputTokens: usage.rawInputTokens,
        cachedInputTokens: usage.cachedInputTokens, cacheAccountingComplete: usage.cacheAccountingComplete,
        outputTokens: usage.outputTokens }
    })
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'partial-dsh-cache')
    const input = { definition: audit0Definition, machine, provider, artifactStore: new MemoryArtifactStore() }
    await runNextWave(input)
    expect(await runNextWave(input)).not.toBeNull()
    expect(attempts).toEqual([1])
    expect(machine.snapshot().rejectedAttempts).toEqual([])
    expect(machine.snapshot().artifacts.find(value => value.taskId === 'additive-wave-0-research-1')?.usage)
      .toMatchObject({ inputTokens: 120, rawInputTokens: 120, cachedInputTokens: 90,
        cacheAccountingComplete: false, outputTokens: 5 })
  })

  it('validates and accepts an exact late-504 handoff without a fresh paid attempt', async () => {
    const attempts: number[] = []
    const provider = wrapped(async (request, result) => {
      if (request.task.id !== 'additive-wave-0-research-1') return result
      attempts.push(request.attempt)
      const receipt = late504Receipt(request, result)
      expect(isLateUpstreamHandoffCandidate(request, receipt, receipt.requestDigest)).toBe(true)
      return agentResultFromExecutionReceipt(request, receipt, receipt.requestDigest, false)
    })

    const { outcome } = await run('late-504-valid-handoff', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toEqual([1])
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === 'additive-wave-0-research-1'))
      .toEqual([])
    expect(outcome.state.artifacts.find(value => value.taskId === 'additive-wave-0-research-1')?.usage)
      .toEqual({
        modelCalls: 1,
        inputTokens: 12_345,
        rawInputTokens: 12_345,
        cachedInputTokens: 0,
        cacheAccountingComplete: false,
        outputTokens: 678,
        costUsd: 0.045,
      })
    expect(outcome.state.budget.modelCalls).toBe(outcome.state.artifacts
      .reduce((total, artifact) => total + artifact.usage.modelCalls, 0))
    await expect(RunMachine.resume(
      audit0Definition,
      outcome.checkpoints.at(-1)!,
      'late-504-valid-handoff-child',
    )).resolves.toBeDefined()
  })

  it('quarantines a malformed late-504 handoff and preserves the normal repair policy', async () => {
    const attempts: number[] = []
    let retainedSession: string | null = null
    const provider = wrapped(async (request, result) => {
      if (request.task.id !== 'additive-wave-0-research-1') return result
      attempts.push(request.attempt)
      if (request.attempt !== 1) return { ...result, sessionId: retainedSession! }
      const receipt = late504Receipt(request, {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: '{' },
      })
      const recovered = await agentResultFromExecutionReceipt(request, receipt, receipt.requestDigest, false)
      retainedSession = recovered.sessionId ?? null
      return recovered
    })

    const { outcome, store } = await run('late-504-malformed-handoff', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toEqual([1, 2])
    const rejected = outcome.state.rejectedAttempts
      .filter(value => value.taskId === 'additive-wave-0-research-1')
    expect(rejected).toEqual([expect.objectContaining({
      attempt: 1,
      diagnostics: ['structured submission is not valid JSON object data'],
      usage: expect.objectContaining({ modelCalls: 1, inputTokens: 12_345, outputTokens: 678 }),
    })])
    expect(rejected[0]?.outputDigest).not.toBeNull()
    expect(rejected[0]?.quarantineUri).not.toBeNull()
    expect(store.contents.has(rejected[0]!.quarantineUri!)).toBe(true)
  })

  it('never imports mismatched receipts or stale files through late-504 recovery', async () => {
    const request = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks
      .find(task => task.id === 'additive-wave-0-research-1')!
    const baseProvider = new DeterministicAuditProvider()
    const agentRequest = {
      experimentId: audit0Definition.id,
      runId: 'late-504-integrity',
      stage: audit0Definition.stages.find(stage => stage.kind === 'discovery')!,
      wave: audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!,
      task: request,
      prompt: 'fixture',
      promptDigest: 'd'.repeat(64),
      visibleArtifacts: [],
      releaseDigest: 'e'.repeat(64),
      attempt: 1,
      diagnostics: [],
      repairFiles: {},
      freshContext: false,
      continuationMode: 'new' as const,
      sessionId: null,
    }
    const result = await baseProvider.run(agentRequest)
    const receipt = late504Receipt(agentRequest, result)
    const mismatched = { ...receipt, requestDigest: 'f'.repeat(64) }
    expect(isLateUpstreamHandoffCandidate(agentRequest, mismatched, receipt.requestDigest)).toBe(false)
    await expect(agentResultFromExecutionReceipt(agentRequest, mismatched, receipt.requestDigest, false))
      .rejects.toBeInstanceOf(AgentAttemptFailure)

    const stale = { ...receipt, files: { ...receipt.files, 'waves/stale-prior-task.md': 'stale' } }
    expect(isLateUpstreamHandoffCandidate(agentRequest, stale, receipt.requestDigest)).toBe(false)
    await expect(agentResultFromExecutionReceipt(agentRequest, stale, receipt.requestDigest, false))
      .rejects.toBeInstanceOf(AgentAttemptFailure)

    const missing = { ...receipt, files: { [SUBMISSION_PATH]: receipt.files[SUBMISSION_PATH]! } }
    expect(isLateUpstreamHandoffCandidate(agentRequest, missing, receipt.requestDigest)).toBe(true)
    const missingCandidate = await agentResultFromExecutionReceipt(
      agentRequest, missing, receipt.requestDigest, false,
    )
    expect(await validateAgentResult(agentRequest.task, missingCandidate, [])).toContain(
      `missing required output file: ${agentRequest.task.output.requiredFiles[0]}`,
    )

    const killed = { ...receipt, exitCode: 137 }
    expect(isLateUpstreamHandoffCandidate(agentRequest, killed, receipt.requestDigest)).toBe(false)
    await expect(agentResultFromExecutionReceipt(agentRequest, killed, receipt.requestDigest, false))
      .rejects.toBeInstanceOf(AgentAttemptFailure)

    const badGateway = {
      ...receipt,
      providerHttpStatus: 502,
      providerRequests: receipt.providerRequests!.map(value => ({ ...value, providerHttpStatus: 502 })),
    }
    expect(isLateUpstreamHandoffCandidate(agentRequest, badGateway, receipt.requestDigest)).toBe(true)
  })

  it('applies accounting ceilings only to discovery and always completes admitted downstream work', async () => {
    const definition = structuredClone(audit0Definition)
    const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
    definition.limits.maxInputTokens = discovery.waves.slice(0, 4).flatMap(wave => wave.tasks)
      .filter(task => task.providerClass !== 'deterministic').length * 100
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'downstream-completion-after-cap', startedAt)
    const outcome = await runExperiment({
      definition,
      machine,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })

    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.budget.inputTokens).toBeGreaterThan(definition.limits.maxInputTokens)
    await expect(RunMachine.resume(
      definition, outcome.state.checkpoints.at(-1)!, 'downstream-completion-child',
    )).resolves.toBeDefined()
  })

  it('accounts and seals every result from a wave admitted before its measured token overrun', async () => {
    const definition = structuredClone(audit0Definition)
    definition.limits.maxInputTokens = 1
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'paid-overrun-accounting')
    const store = new MemoryArtifactStore()
    const provider = new DeterministicAuditProvider()
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
    await expect(advanceExperimentOneWave({
      definition, machine, provider, artifactStore: store, policy: createAudit0RunPolicy(),
    })).resolves.toBe(true)
    const state = machine.snapshot()
    const discoveryArtifacts = state.artifacts.filter(value => value.stageId === 'discovery')
    expect(discoveryArtifacts).toHaveLength(
      definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks.length,
    )
    expect(state.budget.inputTokens).toBe(discoveryArtifacts.reduce((total, value) => total + value.usage.inputTokens, 0))
    expect(state.waveReceipts.some(value => value.stageId === 'discovery')).toBe(true)
    const laterCheckpoint = machine.snapshot().checkpoints.at(-1)!
    expect(laterCheckpoint.body.cursor).toEqual({ stageIndex: 2, waveIndex: 0 })
    expect(machine.snapshot().stageEndReceipts.at(-1)?.reason).toBe('measured-budget-inability')
    await expect(RunMachine.resume(definition, laterCheckpoint, 'paid-overrun-stage-child'))
      .resolves.toBeDefined()
  })

  it('resumes a pool-scoped model-call receipt that lands exactly on a measured cap', async () => {
    const definition = structuredClone(audit0Definition)
    const discoveryWave = definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!
    const paidTaskCount = discoveryWave.tasks.filter(task => task.providerClass !== 'deterministic').length
    definition.limits.maxModelCalls = paidTaskCount
    definition.limits.maxInputTokens = paidTaskCount * 100
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'legacy-budget-receipt')
    const input = {
      definition,
      machine,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    }
    await advanceExperimentOneWave(input)
    await advanceExperimentOneWave({ ...input, policy: createAudit0RunPolicy() })

    const checkpoint = machine.snapshot().checkpoints.at(-1)!
    const receipt = checkpoint.body.stageEndReceipts.at(-1)!
    const evidence = { ...(receipt.evidence as Record<string, unknown>) }
    expect((evidence.budget as { inputTokens: number }).inputTokens).toBe(definition.limits.maxInputTokens)
    expect(checkpoint.body.budget.inputTokens).toBe(definition.limits.maxInputTokens)
    await expect(RunMachine.resume(definition, checkpoint, 'pool-budget-child'))
      .resolves.toBeDefined()
  })

  it('denies a concurrent wave before any provider call when the model-call ceiling cannot admit it', async () => {
    const definition = structuredClone(audit0Definition)
    definition.limits.maxModelCalls = 1
    const release = await sealReleasePackage({ ...audit0PackageBody, definition })
    const machine = await RunMachine.create(definition, release.digest, 'budget-admission')
    const provider = new DeterministicAuditProvider()
    let calls = 0
    const counted: AgentProvider = { run: async request => {
      calls += 1
      return provider.run(request)
    } }
    const store = new MemoryArtifactStore()
    await runNextWave({ definition, machine, provider: counted, artifactStore: store })
    expect(calls).toBe(1)
    await expect(runNextWave({ definition, machine, provider: counted, artifactStore: store }))
      .rejects.toThrow('model-call budget cannot admit wave discovery/wave-0')
    expect(calls).toBe(1)
  })

  it('quarantines invalid submissions and keeps the third correction in the same context', async () => {
    const attempts: { attempt: number, freshContext: boolean }[] = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'core-wave-0-research-1') return result
      attempts.push({ attempt: request.attempt, freshContext: request.freshContext })
      if (request.attempt === 3) return result
      return {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: '{"complete":false}' },
        protocol: {},
      }
    })
    const { outcome, store } = await run('invalid-submission-repair', provider)
    expect(attempts).toEqual([
      { attempt: 1, freshContext: false },
      { attempt: 2, freshContext: false },
      { attempt: 3, freshContext: false },
    ])
    const rejected = outcome.state.rejectedAttempts.filter(value => value.taskId === 'core-wave-0-research-1')
    expect(rejected).toHaveLength(2)
    expect(rejected.every(value => value.quarantineUri !== null && store.contents.has(value.quarantineUri))).toBe(true)
    expect(outcome.state.artifacts.find(value => value.taskId === 'core-wave-0-research-1')
      ?.protocol.research?.observations[0]?.id).toBe('OBS-LUNA-W0-R1-A1')
  })

  it('returns exact gate diagnostics to additive research for one same-session correction', async () => {
    const attempts: Array<{
      attempt: number
      mode: AgentRequest['continuationMode']
      freshContext: boolean
      diagnostics: readonly string[]
    }> = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'additive-wave-0-research-1') return result
      attempts.push({
        attempt: request.attempt,
        mode: request.continuationMode,
        freshContext: request.freshContext,
        diagnostics: request.diagnostics,
      })
      if (request.attempt !== 1) return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        complete: true
        observations: Array<{ id: string }>
      }
      submission.observations[0]!.id = 'OBS-DEEPSEEK-W1-R1-A1'
      const research = result.protocol.research!
      return {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
        protocol: {
          ...result.protocol,
          research: {
            ...research,
            observations: research.observations.map((observation, index) => index === 0
              ? { ...observation, id: 'OBS-DEEPSEEK-W1-R1-A1' }
              : observation),
          },
        },
      }
    })

    const { outcome } = await run('additive-research-fresh-repair', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toEqual([
      { attempt: 1, mode: 'new', freshContext: false, diagnostics: [] },
      {
        attempt: 2,
        mode: 'resume',
        freshContext: false,
        diagnostics: ['submission.observations[0].id must be a local identifier such as A1'],
      },
    ])
    const rejected = outcome.state.rejectedAttempts.filter(value => value.taskId === 'additive-wave-0-research-1')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.diagnostics).toEqual([
      'submission.observations[0].id must be a local identifier such as A1',
    ])
    await expect(RunMachine.resume(
      audit0Definition,
      outcome.checkpoints.at(-1)!,
      'additive-research-fresh-repair-child',
    )).resolves.toBeDefined()
  })

  it('repairs a verifier enum defect in the same session without weakening the gate', async () => {
    const attempts: Array<{ attempt: number, mode: AgentRequest['continuationMode'], diagnostics: readonly string[] }> = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'verifier') return result
      attempts.push({ attempt: request.attempt, mode: request.continuationMode, diagnostics: request.diagnostics })
      if (request.attempt !== 1) return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        complete: true
        outcomes: Array<{ exploitability: unknown }>
      }
      submission.outcomes[0]!.exploitability = 'unsupported'
      const verificationOutcomes = result.protocol.verificationOutcomes!.slice(1)
      return {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
        protocol: {
          verificationOutcomes,
          retainedReferences: verificationOutcomes.map(value => value.reference).toSorted(),
        },
      }
    })

    const { outcome, store } = await run('verification-same-session-repair', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toEqual([
      { attempt: 1, mode: 'new', diagnostics: [] },
      {
        attempt: 2,
        mode: 'resume',
        diagnostics: expect.arrayContaining([
          'submission.outcomes[0].exploitability must be one of: supported, refuted, unresolved',
          expect.stringContaining('verification observation coverage omits C-1/'),
        ]),
      },
    ])
    const rejected = outcome.state.rejectedAttempts.filter(value => value.taskId === 'verifier')
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.quarantineUri).not.toBeNull()
    expect(store.contents.has(rejected[0]!.quarantineUri!)).toBe(true)
    expect(outcome.state.artifacts.find(value => value.taskId === 'verifier')?.protocol.retainedReferences)
      .toContain('C-1')
  })

  it('returns exact gate diagnostics to an additive fixed-stage agent in the same session', async () => {
    const attempts: Array<{ attempt: number, mode: AgentRequest['continuationMode'], freshContext: boolean, diagnostics: readonly string[] }> = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'negative-review-replica') return result
      attempts.push({
        attempt: request.attempt, mode: request.continuationMode,
        freshContext: request.freshContext, diagnostics: request.diagnostics,
      })
      if (request.attempt !== 1) return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        complete: true
        decisions: Array<{ finalDisposition: string, finalReference: string }>
      }
      const candidate = submission.decisions.find(decision => decision.finalDisposition === 'candidate')!
      candidate.finalReference = ''
      return {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
        protocol: { dispositionReferences: [], reviewDecisions: [] },
      }
    })

    const { outcome } = await run('additive-review-fresh-repair', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual({ attempt: 1, mode: 'new', freshContext: false, diagnostics: [] })
    expect(attempts[1]).toMatchObject({ attempt: 2, mode: 'resume', freshContext: false })
    expect(attempts[1]?.diagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('finalReference must be a non-empty string'),
    ]))
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === 'negative-review-replica'))
      .toHaveLength(1)
    await expect(RunMachine.resume(
      audit0Definition,
      outcome.checkpoints.at(-1)!,
      'additive-review-fresh-repair-child',
    )).resolves.toBeDefined()
  })

  it('uses the configured fresh repair after an additive process failure and preserves its usage', async () => {
    const attempts: Array<{
      attempt: number
      mode: AgentRequest['continuationMode']
      freshContext: boolean
      diagnostics: readonly string[]
    }> = []
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'negative-review-replica') return result
      attempts.push({
        attempt: request.attempt,
        mode: request.continuationMode,
        freshContext: request.freshContext,
        diagnostics: request.diagnostics,
      })
      if (request.attempt === 1) {
        throw new AgentAttemptFailure('fixture DSH exited after a successful provider response', {
          usage: {
            modelCalls: 1,
            inputTokens: 12_345,
            outputTokens: 678,
            costUsd: 0.045,
            rawInputTokens: 12_345,
            cachedInputTokens: 0,
            cacheAccountingComplete: false,
          },
        })
      }
      return result
    })

    const { outcome } = await run('additive-process-fresh-repair', provider)
    expect(outcome.state.status).toBe('completed')
    expect(attempts).toEqual([
      { attempt: 1, mode: 'new', freshContext: false, diagnostics: [] },
      {
        attempt: 2,
        mode: 'new',
        freshContext: true,
        diagnostics: ['fixture DSH exited after a successful provider response'],
      },
    ])
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === 'negative-review-replica'))
      .toEqual([expect.objectContaining({
        attempt: 1,
        outputDigest: null,
        includeDiagnosticsInRepair: true,
        usage: {
          modelCalls: 1,
          inputTokens: 12_345,
          outputTokens: 678,
          costUsd: 0.045,
          rawInputTokens: 12_345,
          cachedInputTokens: 0,
          cacheAccountingComplete: false,
        },
      })])
    await expect(RunMachine.resume(
      audit0Definition,
      outcome.checkpoints.at(-1)!,
      'additive-process-fresh-repair-child',
    )).resolves.toBeDefined()
  })

  it('preserves paid receipt usage through a permanent resource classification', async () => {
    const usage = {
      modelCalls: 1,
      inputTokens: 12_345,
      outputTokens: 678,
      costUsd: 0.045,
      rawInputTokens: 12_345,
      cachedInputTokens: 0,
      cacheAccountingComplete: false,
    } as const
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'additive-wave-0-research-1') return result
      const processFailure = new AgentAttemptFailure('sandbox additive agent failed (137)', { usage })
      throw new PermanentRunFailure('container resource exhaustion: memory', 'resource-exhausted', {
        cause: processFailure,
      })
    })

    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'resource-usage-custody')
    const input = {
      definition: audit0Definition,
      machine,
      provider,
      artifactStore: new MemoryArtifactStore(),
    }
    await runNextWave(input)
    await expect(runNextWave(input)).rejects.toMatchObject({ category: 'resource-exhausted', retryable: false })
    const rejection = machine.snapshot().rejectedAttempts
      .find(value => value.taskId === 'additive-wave-0-research-1')
    expect(rejection).toMatchObject({ usage })
    expect(rejection).not.toHaveProperty('includeDiagnosticsInRepair')
  })

  it('exposes the cumulative sealed index without same-wave or future-wave artifacts', async () => {
    const provider = wrapped((request, result) => {
      if (request.stage.kind === 'discovery') {
        const current = request.task.research?.wave ?? -1
        const observed = [...new Set(request.visibleArtifacts.map(artifact => (
          Number(artifact.waveId.replace('wave-', ''))
        )))].toSorted((left, right) => left - right)
        expect(observed).toEqual(Array.from({ length: current }, (_, index) => index))
      }
      return result
    })
    expect((await run('barrier-visibility', provider)).outcome.state.status).toBe('completed')
  })

  it('preserves conflicting replicated review decisions and every retained reference in the deterministic union', async () => {
    const provider = wrapped((request, result) => {
      if (request.task.id !== 'negative-review-replica') return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        complete: true
        decisions: Array<{
          observationId: string
          action: 'uphold' | 'narrow' | 'overturn' | 'unresolved'
          finalDisposition: 'candidate' | 'refuted' | 'unresolved'
          finalReference: string
          rationale: string
        }>
      }
      const target = submission.decisions.find(decision => decision.finalDisposition === 'candidate')
      if (target === undefined) throw new Error('fixture review lacks a candidate decision')
      Object.assign(target, {
        action: 'unresolved', finalDisposition: 'unresolved', finalReference: 'U-9',
        rationale: 'independent replica retained material uncertainty',
      })
      const references = [...new Set(submission.decisions
        .filter(decision => decision.finalDisposition !== 'refuted').map(decision => decision.finalReference))].toSorted()
      return {
        ...result,
        files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
        protocol: { ...result.protocol, dispositionReferences: references, reviewDecisions: submission.decisions.map(({ observationId, action, finalDisposition, finalReference, rationale }) => ({ observationId, action, finalDisposition, finalReference, rationale })) },
      }
    })
    const { outcome } = await run('review-dissent-union', provider)
    const union = outcome.state.artifacts.find(value => value.taskId === 'negative-review-union')
    expect(union?.protocol.decisionDissentObservationIds).toHaveLength(1)
    expect(union?.protocol.dispositionReferences).toEqual(expect.arrayContaining(['C-1', 'U-9']))
    expect(union?.protocol.reviewUnion?.[0]?.decisions).toHaveLength(2)
    expect(outcome.state.artifacts.find(value => value.taskId === 'verifier')?.protocol.retainedReferences)
      .toEqual(expect.arrayContaining(['U-9']))
    expect(outcome.state.artifacts.find(value => value.taskId === 'seal-final')
      ?.protocol.finalCustody?.retainedReferences).toEqual(expect.arrayContaining(['C-1', 'U-9']))
  })
})
