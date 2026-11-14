import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRequest, AgentResult, RuntimeRelease } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { agentResultFromExecutionReceipt } from '../src/late-upstream-handoff.js'
import { SUBMIT_CHECK_UNFINISHED } from '../src/submission-check.js'
import { RunMachine } from '../src/machine.js'
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

it('keeps complete evidence when the provider ended the session before ack3-submit ran', async () => {
  const { request: plain, saved, result } = await sample()
  const request = { ...plain, task: { ...plain.task, submitCheck: true as const } }
  saved.files = { ...result.files }
  saved.submitCheck = { done: false, issues: [] }
  const recovered = await agentResultFromExecutionReceipt(request, saved, requestDigest)
  expect(recovered.status).toBe('accepted')
  // The runner's validation then asks the agent to finish with ack3-submit in a correction turn.
  expect(await validateAgentResult(request.task, recovered, [])).toEqual([SUBMIT_CHECK_UNFINISHED])
  saved.submitCheck = { done: false, issues: ['A1 is not in the research document'] }
  expect((await agentResultFromExecutionReceipt(request, saved, requestDigest)).status).toBe('additive-unavailable')
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
  const machine = await createControlledMachine(definition, 'a'.repeat(64), 'required-review-handoff')
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
  const machine = await createControlledMachine(definition, 'f'.repeat(64), 'native-peer-outage', new Date().toISOString())
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
  await expect(restoreSelected(machine, state)).resolves.toBeDefined()
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
