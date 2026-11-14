import { afterEach, expect, it, vi } from 'vitest'
import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import type { AgentRequest, NativeTransportEvidence, RejectedAttempt } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { agentResultFromExecutionReceipt } from '../src/late-upstream-handoff.js'
import { AgentAttemptFailure, PermanentRunFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { assertAgentAttemptPolicy, countedAttempt, retryAttemptLimit } from '../src/attempt-policy.js'
import {
  nextProviderBackoff, providerBackoffCapMs, providerBackoffUntil, providerTransientSignature,
} from '../src/provider-backoff.js'
import { audit0Definition } from './support/audit0-config.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }

afterEach(() => { vi.useRealTimers() })

const minute = 60_000
const usage = { modelCalls: 1 as const, inputTokens: 25, outputTokens: 4, costUsd: 0 }

function receipt(fields: Partial<AgentExecutionReceipt>): AgentExecutionReceipt {
  return { requestDigest: 'a'.repeat(64), exitCode: 1, actorId: 'actor-1', files: {}, inputTokens: 1, outputTokens: 1,
    costUsd: 0, stderr: '', providerHttpStatus: null, providerErrorCode: null, providerRequests: [], ...fields }
}
const claude = { task: { id: 'claude-task', providerClass: 'core', backend: 'claude', retryPolicy: 'same-session-repair',
  output: { requiredFiles: [] } }, attempt: 1 } as unknown as AgentRequest
const codex = { task: { id: 'codex-task', providerClass: 'core', retryPolicy: 'same-session-repair',
  output: { requiredFiles: [] } }, attempt: 1 } as unknown as AgentRequest
const dsh = { task: { id: 'dsh-task', providerClass: 'additive', backend: 'dsh-chat-completions', retryPolicy: 'fresh-repair',
  output: { requiredFiles: [] } }, attempt: 1 } as unknown as AgentRequest

it('classifies a provider-side failure per runner from the receipt alone, never a quota or account failure (E2)', () => {
  const signature = (request: AgentRequest, fields: Partial<AgentExecutionReceipt>) =>
    providerTransientSignature(request, receipt(fields))
  // Claude: the SDK's assistant `error` after its own retries (claudeUsage upper-cases it).
  expect(signature(claude, { providerErrorCode: 'OVERLOADED' })).toBe('claude:OVERLOADED')
  expect(signature(claude, { providerErrorCode: 'SERVER_ERROR' })).toBe('claude:SERVER_ERROR')
  expect(signature(claude, { providerErrorCode: 'RATE_LIMIT', providerHttpStatus: 429 })).toBe('claude:RATE_LIMIT:429')
  for (const code of ['AUTHENTICATION_FAILED', 'BILLING_ERROR', 'INVALID_REQUEST', 'MODEL_NOT_FOUND', 'UNKNOWN',
    'MAX_OUTPUT_TOKENS', null]) expect(signature(claude, { providerErrorCode: code })).toBeNull()
  // A 429 with an exhausted subscription window is a quota wait or rejection, not an outage.
  expect(signature(claude, { providerErrorCode: 'RATE_LIMIT', providerHttpStatus: 429, subscriptionLimits: {
    provider: 'claude', observedAt: '2030-01-01T00:00:00.000Z', exhausted: true, windows: [] } })).toBeNull()
  expect(signature(claude, { exitCode: 0, providerErrorCode: 'OVERLOADED' })).toBeNull()
  // Codex: the runner maps the last `turn.failed` message (codexProviderFailure).
  expect(signature(codex, { providerErrorCode: 'SERVER', providerHttpStatus: 503 })).toBe('codex:SERVER:503')
  expect(signature(codex, { providerErrorCode: 'SERVER', providerHttpStatus: null })).toBe('codex:SERVER')
  expect(signature(codex, { providerErrorCode: 'RATE_LIMIT', providerHttpStatus: 429 })).toBe('codex:RATE_LIMIT:429')
  for (const code of ['STREAM_CLOSED', 'TRANSPORT', 'TIMEOUT', 'OVERLOADED']) {
    expect(signature(codex, { providerErrorCode: code })).toBe(`codex:${code}`)
  }
  expect(signature(codex, { providerErrorCode: 'SERVER', providerHttpStatus: 400 })).toBeNull()
  expect(signature(codex, { providerErrorCode: 'RATE_LIMIT', providerHttpStatus: null })).toBeNull()
  expect(signature(codex, { providerErrorCode: 'TRANSPORT', providerHttpStatus: 502 })).toBeNull()
  expect(signature(codex, { providerErrorCode: 'HTTP_401', providerHttpStatus: 401 })).toBeNull()
  expect(signature(codex, {})).toBeNull()
  expect(signature(codex, { providerErrorCode: 'SERVER', providerHttpStatus: 503, subscriptionLimits: {
    provider: 'codex', observedAt: '2030-01-01T00:00:00.000Z', exhausted: true, windows: [] } })).toBeNull()
  // DSH: exactly the native transport codes it already resumes after.
  expect(signature(dsh, { providerErrorCode: 'SERVER', providerHttpStatus: 529 })).toBe('dsh:SERVER:529')
  expect(signature(dsh, { providerErrorCode: 'RATE_LIMIT', providerHttpStatus: 429 })).toBe('dsh:RATE_LIMIT:429')
  for (const code of ['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'EMPTY_RESPONSE']) {
    expect(signature(dsh, { providerErrorCode: code })).toBe(`dsh:${code}`)
  }
  for (const [code, status] of [['AUTH', 401], ['QUOTA_EXCEEDED', 429], ['INVALID_REQUEST', 400], ['HTTP_402', 402],
    ['SERVER', 400]] as const) expect(signature(dsh, { providerErrorCode: code, providerHttpStatus: status })).toBeNull()
})

it('marks the attempt failure it throws for a provider-side receipt, and only then', async () => {
  const thrown = async (request: AgentRequest, fields: Partial<AgentExecutionReceipt>) => {
    const error = await agentResultFromExecutionReceipt(request, receipt(fields), 'a'.repeat(64)).catch(value => value)
    expect(error).toBeInstanceOf(AgentAttemptFailure)
    return error as AgentAttemptFailure
  }
  expect((await thrown(claude, { providerErrorCode: 'OVERLOADED', stderr: 'API Error: 529' })).providerTransient)
    .toBe('claude:OVERLOADED')
  expect((await thrown(codex, { providerErrorCode: 'STREAM_CLOSED' })).providerTransient).toBe('codex:STREAM_CLOSED')
  expect((await thrown(dsh, { providerErrorCode: 'TIMEOUT' })).providerTransient).toBe('dsh:TIMEOUT')
  expect((await thrown(claude, { stderr: 'tool crashed' })).providerTransient).toBeUndefined()
  // A quota rejection keeps its own path.
  await expect(agentResultFromExecutionReceipt(codex, receipt({ providerErrorCode: 'SERVER', providerHttpStatus: 503,
    subscriptionLimits: { provider: 'codex', observedAt: '2030-01-01T00:00:00.000Z', exhausted: true, windows: [] } }),
  'a'.repeat(64))).rejects.toBeInstanceOf(PermanentRunFailure)
})

it('waits 1, 2, 5, 15, 30, 30 … minutes and gives up after 2 hours of backoff per task', () => {
  const prior: Pick<RejectedAttempt, 'attempt' | 'rejectedAt' | 'providerBackoff'>[] = []
  const delays: number[] = []
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const backoff = nextProviderBackoff('claude:OVERLOADED', prior)
    if (backoff === null) break
    delays.push(backoff.delayMs)
    prior.push({ attempt, rejectedAt: new Date(Date.UTC(2030, 0, 1) + attempt * 3 * 60 * minute).toISOString(), providerBackoff: backoff })
  }
  expect(delays.map(value => value / minute)).toEqual([1, 2, 5, 15, 30, 30, 30, 7])
  expect(delays.reduce((total, value) => total + value, 0)).toBe(providerBackoffCapMs)
  expect(nextProviderBackoff('claude:OVERLOADED', prior)).toBeNull()
  // A later counted rejection ends the wait; the newest rejection decides.
  const last = prior.at(-1)!
  expect(providerBackoffUntil(prior)).toBe(Date.parse(last.rejectedAt) + 7 * minute)
  expect(providerBackoffUntil([...prior, { attempt: 9, rejectedAt: last.rejectedAt }])).toBeNull()
  // Malformed backoff records are ignored, never trusted.
  for (const providerBackoff of [{ signature: 'x', delayMs: -1 }, { signature: 'x', delayMs: providerBackoffCapMs + 1 },
    { signature: '', delayMs: minute }, { signature: 'x', delayMs: 1.5 }]) {
    expect(nextProviderBackoff('claude:OVERLOADED', [{ attempt: 1, providerBackoff: providerBackoff as never }])?.delayMs)
      .toBe(minute)
    expect(providerBackoffUntil([{ attempt: 1, rejectedAt: last.rejectedAt, providerBackoff: providerBackoff as never }])).toBeNull()
  }
})

it('does not count backoff attempts against the limit, and keeps the normal retry mode for a relaunch', () => {
  const backoffs = [1, 2].map(attempt => ({ attempt, providerBackoff: { signature: 'codex:SERVER:503', delayMs: minute } }))
  expect(countedAttempt(1, [])).toBe(1)
  expect(countedAttempt(3, backoffs)).toBe(1)
  expect(countedAttempt(4, [...backoffs, { attempt: 3 }])).toBe(2)
  expect(countedAttempt(5, [...backoffs, { attempt: 3 }, { attempt: 4, providerBackoff: { signature: 'x', delayMs: 0 } }])).toBe(3)
})

/* ---------- through the runner and the machine ---------- */

const definition = (() => {
  const base = structuredClone(audit0Definition)
  return { ...base, stages: base.stages.map((stage, index) => index === 1 ? { ...stage, waves: stage.waves.slice(0, 2) } : stage),
    discoverySafetyCeiling: 2, limits: { ...base.limits, maxModelCalls: 10_000, maxCostUsd: 10_000 } }
})()

function transient(signature: string, request: AgentRequest, nativeTransport?: NativeTransportEvidence) {
  return new AgentAttemptFailure(`sandbox agent failed (1): provider outage for ${request.task.id}`, {
    usage, providerTransient: signature,
    ...(nativeTransport === undefined ? {} : { includeDiagnosticsInRepair: false, nativeTransport }),
  })
}

it('a core lane rides out a provider outage longer than its attempt limit, without new launches during the wait', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
  const machine = await createControlledMachine(definition, 'f'.repeat(64), 'provider-backoff-core')
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const launches: Array<{ attempt: number, mode: AgentRequest['continuationMode'], fresh: boolean }> = []
  let taskId: string | undefined
  const provider = { async run(request: AgentRequest) {
    if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'core'
      || (taskId ?? request.task.id) !== request.task.id) return base.run(request)
    taskId = request.task.id
    launches.push({ attempt: request.attempt, mode: request.continuationMode, fresh: request.freshContext })
    if (launches.length <= 4) throw transient('claude:OVERLOADED', request)
    return base.run(request)
  } }
  const advance = () => advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
  const deadlineAtStart = discoveryDeadline(definition, machine.snapshot())
  for (let guard = 0; guard < 30 && !machine.snapshot().artifacts.some(value => value.taskId === taskId); guard += 1) {
    await advance()
    const until = providerBackoffUntil(machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId))
    if (until === null) continue
    // While the backoff runs, polling keeps the task pending and launches nothing.
    const before = launches.length
    vi.setSystemTime(until - 1_000)
    await advance()
    expect(launches.length).toBe(before)
    vi.setSystemTime(until)
  }
  expect(retryAttemptLimit({ retryPolicy: 'redirect-then-fresh-replacement' })).toBe(3)
  expect(launches.map(value => value.attempt)).toEqual([1, 2, 3, 4, 5])
  // Each relaunch is an ordinary retry: no session was returned, so a fresh replacement.
  expect(launches.slice(1).every(value => value.mode === 'new' && value.fresh)).toBe(true)
  const rejected = machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId)
  expect(rejected.map(value => value.providerBackoff)).toEqual([1, 2, 5, 15].map(minutes => ({
    signature: 'claude:OVERLOADED', delayMs: minutes * minute })))
  expect(rejected.every(value => value.usage.modelCalls === 1)).toBe(true)
  expect(machine.snapshot().artifacts.find(value => value.taskId === taskId)?.status).toBe('accepted')
  // The backoff is not discovery time: the deadline moved by the waits, as for quota waits.
  expect(discoveryDeadline(definition, machine.snapshot()) - deadlineAtStart).toBe(23 * minute)
  await expect(restoreSelected(machine)).resolves.toBeDefined()
})

it('counts provider failures again once 2 hours of backoff are spent, so a permanent outage still ends the run', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
  const machine = await createControlledMachine(definition, 'f'.repeat(64), 'provider-backoff-cap')
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const attempts: number[] = []
  let taskId: string | undefined
  const provider = { async run(request: AgentRequest) {
    if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'core'
      || (taskId ?? request.task.id) !== request.task.id) return base.run(request)
    taskId = request.task.id
    attempts.push(request.attempt)
    throw transient('codex:SERVER:503', request)
  } }
  let failure: unknown
  for (let guard = 0; guard < 40 && failure === undefined; guard += 1) {
    try { await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts }) }
    catch (error) { failure = error }
    const until = providerBackoffUntil(machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId))
    if (until !== null) vi.setSystemTime(Math.max(Date.now(), until))
  }
  expect(failure).toMatchObject({ category: 'agent-repair-exhausted' })
  // 8 backoffs (1+2+5+15+30+30+30+7 = 120 minutes), then the 3 counted attempts of a core research lane.
  expect(attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  const rejected = machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId)
  expect(rejected.map(value => value.providerBackoff?.delayMs ?? null)).toEqual([
    ...[1, 2, 5, 15, 30, 30, 30, 7].map(minutes => minutes * minute), null, null, null])
})

it('a required DSH lane resumes its saved session after a backoff, as after any transport failure', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
  const config = structuredClone(document)
  config.maxDiscoveryWaves = 4
  // An optional lane keeps dropping out as unavailable (optional-upstream-recovery.test.ts); a required one waits.
  config.modelPools = config.modelPools.map(pool => pool.backend === 'dsh-chat-completions' ? { ...pool, required: true } : pool)
  const dshDefinition = compileExperimentConfig(config).definition
  const machine = await createControlledMachine(dshDefinition, 'a'.repeat(64), 'provider-backoff-dsh')
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const evidence = (request: AgentRequest): NativeTransportEvidence => ({ code: 'TRANSPORT', sourceRunId: request.runId,
    requestDigest: String(request.attempt).repeat(64).slice(0, 64), sessionId, snapshotDigest: 'd'.repeat(64), workState: 'present' })
  const calls: AgentRequest[] = []
  let taskId: string | undefined
  const provider = { async run(request: AgentRequest) {
    if (request.task.providerClass !== 'additive' || request.task.research?.wave !== 0
      || (taskId ?? request.task.id) !== request.task.id) return base.run(request)
    taskId = request.task.id
    calls.push(request)
    if (calls.length <= 2) throw transient('dsh:TRANSPORT', request, evidence(request))
    const result = await base.run(request)
    return { ...result, actorId: sessionId, sessionId }
  } }
  for (let guard = 0; guard < 20 && !machine.snapshot().artifacts.some(value => value.taskId === taskId); guard += 1) {
    await advanceExperimentOneWave({ definition: dshDefinition, machine, provider, artifactStore: artifacts })
    const until = providerBackoffUntil(machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId))
    if (until !== null) vi.setSystemTime(Math.max(Date.now(), until))
  }
  expect(calls[0]!.task.optional).not.toBe(true)
  expect(retryAttemptLimit(calls[0]!.task)).toBe(2)
  expect(calls.map(value => value.attempt)).toEqual([1, 2, 3])
  // Each relaunch resumes the session the previous launch saved.
  expect(calls.slice(1).map(value => [value.continuationMode, value.freshContext, value.sessionId,
    value.nativeTransport?.requestDigest])).toEqual([
    ['resume', false, sessionId, '1'.repeat(64)], ['resume', false, sessionId, '2'.repeat(64)]])
  expect(machine.snapshot().artifacts.find(value => value.taskId === taskId)?.status).toBe('accepted')
  await expect(restoreSelected(machine)).resolves.toBeDefined()
  // The admission policy accepts the relaunch only with its backoff evidence in place.
  const task = calls[2]!.task, scoped = machine.snapshot().rejectedAttempts.filter(value => value.taskId === task.id)
  const { admittedAt: _admittedAt, ...admission } = machine.snapshot().journal.findLast(event => event.type === 'agent.attempt-admitted'
    && (event.payload as { taskId: string }).taskId === task.id)!.payload as RejectedAttempt & { admittedAt: string }
  expect(() => assertAgentAttemptPolicy(task, admission as never, scoped)).not.toThrow()
  expect(() => assertAgentAttemptPolicy(task, admission as never, scoped.map(({ providerBackoff: _backoff, ...value }) => value)))
    .toThrow(/agent attempt admission is invalid/)
})
