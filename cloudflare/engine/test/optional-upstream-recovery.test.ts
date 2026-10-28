import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRequest, AgentResult, RuntimeRelease } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import type { AgentLogRequest } from '../src/agent-execution-log.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { agentResultFromExecutionReceipt } from '../src/late-upstream-handoff.js'
import { RunMachine } from '../src/machine.js'
import { PromotedExecutionProvider } from '../src/promoted-execution.js'
import { providerIdentity } from '../src/provider-identity.js'
import { validateAgentResult } from '../src/protocol-validation.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const usage = { inputTokens: 120, rawInputTokens: 120, cachedInputTokens: 30,
  cacheAccountingComplete: false, outputTokens: 50, costUsd: 0 }
const requestDigest = 'd'.repeat(64)
const incomplete = { [SUBMISSION_PATH]: JSON.stringify({ complete: false, observations: [], nextExperiment: '' }) }
afterEach(() => vi.useRealTimers())

function receipt(request: AgentRequest, result: AgentResult): AgentExecutionReceipt {
  return {
    requestDigest, exitCode: 1, actorId: result.actorId, files: { ...incomplete }, ...usage,
    providerHttpStatus: 504, providerErrorCode: null, stderr: 'synthetic provider outage',
    providerRequests: [{ schemaVersion: 1, provider: result.provider, model: request.task.model,
      thinking: null, reasoningEffort: request.task.reasoning, stream: true, maxOutputTokens: null,
      startedAt: new Date().toISOString(), durationMs: 270_000, timeToFirstByteMs: null,
      providerHttpStatus: null, requestId: null, finishReason: null, inputTokens: null,
      outputTokens: null, reasoningTokens: null, costUsd: null, abortedByClient: false,
      errorCategory: 'transport' }],
  }
}

async function sample() {
  const stage = audit0Definition.stages.find(stage => stage.kind === 'discovery')!
  const wave = stage.waves[0]!, task = wave.tasks.find(task => task.providerClass === 'additive')!
  const request: AgentRequest = { experimentId: audit0Definition.id, runId: 'optional-outage', stage, wave, task,
    prompt: 'synthetic fixture', promptDigest: 'a'.repeat(64), visibleArtifacts: [], releaseDigest: 'b'.repeat(64),
    attempt: 2, diagnostics: [], repairFiles: {}, freshContext: true, continuationMode: 'new', sessionId: null }
  const result = await new DeterministicAuditProvider().run(request)
  return { request, result, saved: receipt(request, result) }
}

it.each(['transport', 502, 503, 504] as const)('records exhausted optional %s without findings and retains all usage', async failure => {
  const { request, saved } = await sample()
  if (typeof failure === 'number') {
    saved.providerRequests![0]!.providerHttpStatus = failure
    delete saved.providerRequests![0]!.errorCategory
  }
  const result = await agentResultFromExecutionReceipt(request, saved, requestDigest)
  expect(result).toMatchObject({ ...usage, status: 'additive-unavailable', unavailableReason: 'platform-interruption',
    files: {}, protocol: {}, assertions: [] })
  expect(await validateAgentResult(request.task, result, [])).toEqual([])
})

it('retains complete valid evidence despite a final transport error', async () => {
  const { request, saved, result } = await sample()
  saved.files = { ...result.files }
  const recovered = await agentResultFromExecutionReceipt(request, saved, requestDigest)
  expect(recovered.status).toBe('accepted')
  expect(recovered.files).toEqual(result.files)
  expect(await validateAgentResult(request.task, recovered, [])).toEqual([])
})

async function nativeTransportSample() {
  const sampleResult = await sample()
  sampleResult.request.task = { ...sampleResult.request.task, backend: 'dsh-chat-completions' }
  Object.assign(sampleResult.saved, {
    files: {}, providerRequests: [], providerHttpStatus: null, providerErrorCode: 'TRANSPORT',
  })
  return sampleResult
}

it.each(['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 429, 500, 502, 503, 504, 599] as const)('records exhausted native %s without inventing a provider receipt or findings', async failure => {
  const { request, saved } = await nativeTransportSample()
  if (typeof failure === 'number') {
    saved.providerErrorCode = failure === 429 ? 'RATE_LIMIT' : 'SERVER'
    saved.providerHttpStatus = failure
  } else saved.providerErrorCode = failure
  const result = await agentResultFromExecutionReceipt(request, saved, requestDigest)
  expect(result).toMatchObject({ ...usage, status: 'additive-unavailable', files: {}, protocol: {}, assertions: [] })
  expect(await validateAgentResult(request.task, result, [])).toEqual([])
  expect(saved.providerRequests).toEqual([])
  expect(saved.providerHttpStatus).toBe(typeof failure === 'number' ? failure : null)
})

it('retains valid native handoff evidence despite exhausted transport', async () => {
  const { request, saved, result } = await nativeTransportSample()
  saved.files = { ...result.files }
  const recovered = await agentResultFromExecutionReceipt(request, saved, requestDigest)
  expect(recovered.status).toBe('accepted')
  expect(recovered.files).toEqual(result.files)
})

it('keeps complete required negative-review work after the final native transport failure', async () => {
  const config = structuredClone(document)
  config.maxDiscoveryWaves = 4
  const requiredConfig = { ...config,  }
  const { definition } = compileExperimentConfig(requiredConfig)
  const machine = await RunMachine.create(definition, 'a'.repeat(64), 'required-review-handoff')
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  let checked = false
  const provider = { async run(input: AgentRequest): Promise<AgentResult> {
    const valid = await base.run(input)
    if (input.task.id !== 'negative-review-replica') return valid
    expect(input.task.optional).not.toBe(true)
    expect(await validateAgentResult(input.task, valid, input.visibleArtifacts)).toEqual([])
    const request: AgentRequest = { ...input, attempt: 2,
      task: { ...input.task, backend: 'dsh-chat-completions' } }
    const saved = receipt(request, valid)
    Object.assign(saved, { files: { ...valid.files }, providerRequests: [],
      providerHttpStatus: null, providerErrorCode: 'TRANSPORT' })
    const accepted = await agentResultFromExecutionReceipt(request, saved, requestDigest)
    expect(accepted.status).toBe('accepted')
    expect(accepted.files).toEqual(valid.files)

    for (const change of ['digest', 'auth', 'partial'] as const) {
      const invalid = structuredClone(saved)
      if (change === 'digest') invalid.requestDigest = 'e'.repeat(64)
      if (change === 'auth') { invalid.providerErrorCode = 'AUTH'; invalid.providerHttpStatus = 401 }
      if (change === 'partial') invalid.files = {}
      await expect(agentResultFromExecutionReceipt(request, invalid, requestDigest))
        .rejects.toBeInstanceOf(AgentAttemptFailure)
    }
    checked = true
    return accepted
  } }
  for (let tick = 0; tick < 50 && !checked; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
  }
  expect(checked).toBe(true)
})

it.each(['first-attempt', 'required', 'core', 'digest', 'unknown-code', 'client-abort', 'http', 'server-without-status', 'server-auth', 'auth', 'invalid-request', 'rate-limit-without-429', 'empty-response-with-http', 'success', 'metadata', 'stale-files', 'killed'])(
  'does not mask native %s as an optional outage', async change => {
    const { request, saved } = await nativeTransportSample()
    if (change === 'first-attempt') request.attempt = 1
    if (change === 'required') request.task = { ...request.task, optional: false }
    if (change === 'core') request.task = { ...request.task, providerClass: 'core' }
    if (change === 'digest') saved.requestDigest = 'e'.repeat(64)
    if (change === 'unknown-code') saved.providerErrorCode = null
    if (change === 'client-abort') saved.providerErrorCode = 'ABORTED'
    if (change === 'http') saved.providerHttpStatus = 401
    if (change === 'server-without-status') saved.providerErrorCode = 'SERVER'
    if (change === 'server-auth') { saved.providerErrorCode = 'SERVER'; saved.providerHttpStatus = 401 }
    if (change === 'auth') { saved.providerErrorCode = 'AUTH'; saved.providerHttpStatus = 401 }
    if (change === 'invalid-request') { saved.providerErrorCode = 'INVALID_REQUEST'; saved.providerHttpStatus = 400 }
    if (change === 'rate-limit-without-429') saved.providerErrorCode = 'RATE_LIMIT'
    if (change === 'empty-response-with-http') { saved.providerErrorCode = 'EMPTY_RESPONSE'; saved.providerHttpStatus = 400 }
    if (change === 'success') saved.exitCode = 0
    if (change === 'metadata') saved.providerRequests = [{ ...(await sample()).saved.providerRequests![0]!, provider: 'other' }]
    if (change === 'stale-files') saved.files['stale.md'] = 'unrelated'
    if (change === 'killed') saved.exitCode = 137
    if (change === 'success') {
      const result = await agentResultFromExecutionReceipt(request, saved, requestDigest)
      expect(result.status).toBe('accepted')
      expect((await validateAgentResult(request.task, result, [])).length).toBeGreaterThan(0)
      return
    }
    await expect(agentResultFromExecutionReceipt(request, saved, requestDigest)).rejects.toBeInstanceOf(AgentAttemptFailure)
  },
)

it('keeps native transport out of the research repair prompt before exhaustion', async () => {
  const { request, saved } = await nativeTransportSample()
  request.attempt = 1
  try {
    await agentResultFromExecutionReceipt(request, saved, requestDigest)
    throw new Error('expected native provider failure')
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAttemptFailure)
    expect((error as AgentAttemptFailure).includeDiagnosticsInRepair).toBe(false)
  }
})

it('seals continuing three-agent cohorts and resumes after an exhausted native peer without replay', async () => {
  const config = structuredClone(document)
  config.maxDiscoveryWaves = 4
  config.modelPools = config.modelPools.map(pool => ({ ...pool, agents: pool.id === 'luna' ? 3 : 1 }))
  const { definition } = compileExperimentConfig(config)
  const machine = await RunMachine.create(definition, 'f'.repeat(64), 'native-peer-outage', new Date().toISOString())
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  const calls: string[] = []
  const provider = { async run(input: AgentRequest): Promise<AgentResult> {
    calls.push(`${input.task.id}:${input.attempt}`)
    const result = await base.run(input)
    if (input.task.providerClass === 'additive') {
      const saved = receipt(input, result)
      Object.assign(saved, { files: {}, providerRequests: [], providerHttpStatus: null, providerErrorCode: 'TRANSPORT' })
      return agentResultFromExecutionReceipt({ ...input, task: { ...input.task, backend: 'dsh-chat-completions' } }, saved, requestDigest)
    }
    const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
    submission.materialHighCriticalDelta = true
    return { ...result, files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
      protocol: { research: { ...result.protocol.research!, materialHighCriticalDelta: true } } }
  } }
  for (let tick = 0; tick < 10 && machine.snapshot().cursor.stageIndex === 1; tick++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
  }
  const state = machine.snapshot()
  expect(state.status).toBe('running')
  expect(state.cursor.stageIndex).toBe(2)
  expect(state.artifacts.filter(a => a.stageId === 'discovery' && a.status === 'accepted')).toHaveLength(12)
  expect(state.artifacts.filter(a => a.status === 'additive-unavailable')).toHaveLength(4)
  expect(state.rejectedAttempts).toHaveLength(4)
  expect(new Set(calls).size).toBe(calls.length)
  await expect(RunMachine.resume(definition, state.checkpoints.at(-1)!, 'native-peer-resumed')).resolves.toBeDefined()
})

it.each([['none', 1], ['redirect-then-fresh-replacement', 3]] as const)(
  'uses the configured %s retry boundary', async (retryPolicy, attempt) => {
    const { request, saved } = await sample()
    request.task = { ...request.task, retryPolicy }
    request.attempt = attempt
    expect((await agentResultFromExecutionReceipt(request, saved, requestDigest)).status).toBe('additive-unavailable')
    if (attempt > 1) {
      request.attempt--
      await expect(agentResultFromExecutionReceipt(request, saved, requestDigest)).rejects.toBeInstanceOf(AgentAttemptFailure)
    }
  },
)

it.each(['first-attempt', 'required', 'core', 'digest', 'provider', 'model', 'client-abort', 'successful-last-request', 'stale-files', 'killed'])(
  'does not mask %s as an optional outage', async change => {
    const { request, saved } = await sample()
    if (change === 'first-attempt') request.attempt = 1
    if (change === 'required') request.task = { ...request.task, optional: false }
    if (change === 'core') request.task = { ...request.task, providerClass: 'core' }
    if (change === 'digest') saved.requestDigest = 'e'.repeat(64)
    if (change === 'provider') saved.providerRequests![0]!.provider = 'other'
    if (change === 'model') saved.providerRequests![0]!.model = 'other'
    if (change === 'client-abort') saved.providerRequests![0]!.abortedByClient = true
    if (change === 'successful-last-request') {
      saved.providerRequests![0]!.providerHttpStatus = 200
      delete saved.providerRequests![0]!.errorCategory
    }
    if (change === 'stale-files') saved.files['stale.md'] = 'unrelated'
    if (change === 'killed') saved.exitCode = 137
    await expect(agentResultFromExecutionReceipt(request, saved, requestDigest)).rejects.toBeInstanceOf(AgentAttemptFailure)
  },
)

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const targetRuntime: RuntimeRelease = { ...runtime, id: 'runtime-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'audit-runtime-target' }

it.each(['broker', 'native'])('recovers ten sealed three-agent cohorts after a quarantined first attempt and terminal %s failure, without replay', async mode => {
  const config = structuredClone(document)
  config.maxDiscoveryWaves = 10
  config.modelPools = config.modelPools.map(pool => ({ ...pool, agents: pool.id === 'luna' ? 3 : 1 }))
  Object.assign(config.limits, { maxModelCalls: 10_000, maxInputTokens: 100_000_000, maxOutputTokens: 100_000_000, maxCostUsd: 10_000 })
  const { definition } = compileExperimentConfig(config)
  const machine = await RunMachine.create(definition, 'c'.repeat(64), 'optional-recovery-source', new Date().toISOString(), runtime)
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore: store })
  let failedRequest: AgentRequest | undefined, failedReceipt: AgentExecutionReceipt | undefined
  let terminal: unknown
  const provider = { async run(request: AgentRequest): Promise<AgentResult> {
    const result = await base.run(request)
    if (request.task.providerClass === 'additive') {
      if (request.attempt === 1) {
        // Reproduce the old runtime: incomplete late-504 files entered quarantine.
        const saved = receipt(request, result)
        saved.providerRequests![0]!.providerHttpStatus = 504
        delete saved.providerRequests![0]!.errorCategory
        if (mode === 'native') Object.assign(saved, { exitCode: 0, providerRequests: [], providerHttpStatus: null })
        return agentResultFromExecutionReceipt(request, saved, requestDigest)
      }
      if (machine.snapshot().artifacts.filter(a => a.stageId === 'discovery').length < 30) {
        throw new AgentExecutionPending('slow-optional-peer')
      }
      if (failedRequest === undefined) {
        failedRequest = structuredClone(request)
        failedReceipt = receipt(request, result)
      }
      if (mode === 'native') Object.assign(failedReceipt!, {
        providerRequests: [], providerHttpStatus: null, providerErrorCode: 'TRANSPORT',
      })
      throw new AgentAttemptFailure('synthetic final upstream transport failure', {
        usage: { modelCalls: 1, ...usage }, includeDiagnosticsInRepair: false,
      })
    }
    const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
    submission.materialHighCriticalDelta = true
    return { ...result, files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
      protocol: { research: { ...result.protocol.research!, materialHighCriticalDelta: true } } }
  } }
  for (let tick = 0; tick < 20 && terminal === undefined; tick++) {
    try { await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store }) }
    catch (error) { if (!(error instanceof AgentExecutionPending)) terminal = error }
  }
  expect(terminal).toBeInstanceOf(Error)
  await machine.fail('synthetic exhausted optional outage')
  // This fixture exercises promotion of a historical two-attempt failed run.
  // The current runner grants a separate transport allowance during output
  // correction, so remove its extra synthetic transport record and usage.
  const source = structuredClone(machine.snapshot()), checkpoint = source.checkpoints.at(-1)!
  const laterTransport = source.rejectedAttempts[2]
  if (laterTransport !== undefined) {
    source.rejectedAttempts = source.rejectedAttempts.slice(0, 2)
    source.budget.modelCalls -= laterTransport.usage.modelCalls
    source.budget.inputTokens -= laterTransport.usage.inputTokens
    source.budget.outputTokens -= laterTransport.usage.outputTokens
    source.budget.costUsd -= laterTransport.usage.costUsd
  }
  expect(source.artifacts.filter(a => a.stageId === 'discovery')).toHaveLength(30)
  expect(source.rejectedAttempts).toHaveLength(2)
  expect(source.rejectedAttempts[0]!.outputDigest).not.toBeNull()
  expect(source.rejectedAttempts[1]!.outputDigest).toBeNull()
  const request = failedRequest!, saved = failedReceipt!
  const recorded: AgentLogRequest = { schemaVersion: 1, runId: source.runId, stageId: request.stage.id,
    waveId: request.wave.id, taskId: request.task.id, requestDigest, promptDigest: request.promptDigest,
    prompt: request.prompt, model: request.task.model, provider: providerIdentity(request.task),
    attempt: request.attempt, startedAt: new Date().toISOString(), startedAtBasis: 'execution-admission' }
  const executionReceipts = { async get() { return structuredClone(saved) } }
  const executionRequests = { async getRequest() { return structuredClone(recorded) } }
  const input = { definition, checkpoint, source, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: targetRuntime,
    artifacts: { async read(record: { uri: string }) { return JSON.parse(store.contents.get(record.uri)!) } },
    executionReceipts, executionRequests }
  await expect(prepareFailedWaveRecovery(input)).rejects.toThrow('exhausted attempts')
  const prepared = await prepareFailedWaveRecovery({ ...input,
    promoteExecution: { taskId: request.task.id, sourceAttempt: 2, requestDigest } })
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse(source.modelStartedAt!) + definition.limits.phaseMinutes.discovery * 60_000 + 1_000)
  const child = await RunMachine.recoverFailedWave(definition, checkpoint, source, 'optional-recovery-child',
    prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
  const before = child.snapshot()
  const calls: string[] = []
  const promoted = new PromotedExecutionProvider({ async run(request) { calls.push(request.task.id); return base.run(request) } },
    executionReceipts, executionRequests, prepared.evidence.promotedExecution)
  await advanceExperimentOneWave({ definition, machine: child, provider: promoted, artifactStore: store })
  const after = child.snapshot()
  expect(calls).toEqual([])
  expect(after.cursor.stageIndex).toBe(2)
  expect(after.budget).toEqual(before.budget)
  expect(after.modelStartedAt).toBe(source.modelStartedAt)
  for (const artifact of source.artifacts) expect(after.artifacts.find(a => a.id === artifact.id)).toEqual(artifact)
  expect(after.artifacts.find(a => a.taskId === request.task.id)).toMatchObject({ status: 'additive-unavailable',
    unavailableReason: 'platform-interruption', usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 } })
  const sealed = after.checkpoints.at(-1)!
  await expect(RunMachine.fromState(definition, after)).resolves.toBeDefined()
  await expect(RunMachine.resume(definition, sealed, 'optional-recovery-resumed')).resolves.toBeDefined()
  const forged = structuredClone(sealed.body)
  forged.acceptedArtifacts.find(a => a.taskId === request.task.id)!.assertions = []
  await expect(RunMachine.resume(definition, { body: forged, digest: await sha256(forged) }, 'optional-forged'))
    .rejects.toThrow('artifact identity')
  // The first synthesis task receives every completed researcher, including all later cohorts.
  const synthesisInputs: string[] = []
  await advanceExperimentOneWave({ definition, machine: child, artifactStore: store, provider: {
    async run(request) { synthesisInputs.push(...request.visibleArtifacts.map(a => a.id)); return base.run(request) },
  } })
  for (const artifact of source.artifacts.filter(a => a.stageId === 'discovery')) expect(synthesisInputs).toContain(artifact.id)
})
