import { admittedProviderRequest } from './support/admitted-provider-request.js'
import { afterEach, expect, it, vi } from 'vitest'
import { getAgentSandbox } from '../src/agent-sandbox-client.js'
import { waitForAgentProcess } from '../src/agent-process.js'
import { SandboxAgentProvider, agentProcessEnvironment, agentObservationIncidentMaxMs,
  terminalLogDrainMs } from '../src/sandbox-provider.js'
import { observationFailureSpacingMs } from '../src/agent-observation-health.js'
import { AgentExecutionPending } from '../src/run-errors.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))
vi.mock('../src/agent-process.js', () => ({
  agentProcessId: (digest: string) => `agent-${digest.slice(0, 40)}`,
  waitForAgentProcess: vi.fn(async (_process: unknown, _slice: number, _interval: number,
    observation?: { onStatusProbe?: (outcome: string) => void }) => {
    observation?.onStatusProbe?.('success')
    return 1
  }),
}))

const ownerReceipt = { initializeMutationOwner: async (owner: unknown) => ({ owner, objectId: 'a'.repeat(64) }) }
const closeDatabases: (() => void)[] = []
afterEach(() => closeDatabases.splice(0).forEach(close => close()))

const request = {
  runId: 'receipt-run', experimentId: 'receipt-run', releaseDigest: 'release',
  prompt: 'synthetic', promptDigest: 'prompt', attempt: 1, freshContext: false,
  continuationMode: 'new', sessionId: null,
  task: { id: 'research-1', workspaceKey: 'lane-1', providerClass: 'core',
    promptKind: 'research', model: 'synthetic', output: { requiredFiles: [] } },
  stage: { id: 'discovery' }, wave: { id: 'wave-0' },
}

it('bounds a sustained core observation outage without touching its admitted process', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.assertProviderCredentials = () => {}
  let digest = ''
  provider.executionReceipts = { get: vi.fn(async (_run: string, requestDigest: string) => {
    digest = requestDigest
    return null
  }) }
  const incidentSince = new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString()
  provider.observationHealth = { get: async () => ({ requestDigest: digest, incidentSince,
    nextObservationAfter: new Date(Date.now() + 60_000).toISOString() }) }
  vi.mocked(getAgentSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toMatchObject({
    category: 'session-recovery-unavailable', retryable: false,
  })
  expect(provider.executionReceipts.get).toHaveBeenCalledTimes(2)
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('prefers a late exact receipt over the core observation-outage boundary', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.assertProviderCredentials = () => {}
  let digest = ''
  let reads = 0
  provider.executionReceipts = { get: vi.fn(async (_run: string, requestDigest: string) => {
    digest = requestDigest
    reads += 1
    return reads === 1 ? null : { requestDigest, exitCode: 0, actorId: 'retained-session',
      files: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '' }
  }) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest,
    incidentSince: new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString(),
    nextObservationAfter: null }) }
  vi.mocked(getAgentSandbox).mockClear()
  await expect(provider.run(request as any)).resolves.toMatchObject({ actorId: 'retained-session' })
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('does not turn an unreadable late receipt into an absent receipt', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.assertProviderCredentials = () => {}
  let digest = ''
  let reads = 0
  provider.executionReceipts = { get: vi.fn(async (_run: string, requestDigest: string) => {
    digest = requestDigest
    if (++reads === 1) return null
    throw new Error('R2 temporarily unavailable')
  }) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest,
    incidentSince: new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString(),
    nextObservationAfter: null }) }
  vi.mocked(getAgentSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toMatchObject({ retryable: true })
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('yields an admitted attempt when result-file observation hangs, with no late launch', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.sandboxObservationMs = 20
  provider.executionReceipts = { get: async () => null }
  let resolveExists!: (value: { exists: boolean }) => void
  const exists = vi.fn(() => new Promise<{ exists: boolean }>(resolve => { resolveExists = resolve }))
  const sandbox = { ...ownerReceipt, exists, getProcess: vi.fn(), mkdir: vi.fn(), startProcess: vi.fn() }
  await expect(provider.runInSandbox(sandbox as any, request as any))
    .rejects.toBeInstanceOf(AgentExecutionPending)
  resolveExists({ exists: false })
  await Promise.resolve()
  await Promise.resolve()
  expect(sandbox.getProcess).not.toHaveBeenCalled()
  expect(sandbox.mkdir).not.toHaveBeenCalled()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('yields an admitted attempt when getProcess hangs, without interpreting it as missing', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.sandboxObservationMs = 20
  provider.executionReceipts = { get: async () => null }
  let resolveProcess!: (value: null) => void
  const getProcess = vi.fn(() => new Promise<null>(resolve => { resolveProcess = resolve }))
  const sandbox = { ...ownerReceipt,
    exists: vi.fn(async () => ({ exists: false })), getProcess,
    mkdir: vi.fn(), startProcess: vi.fn(),
  }
  await expect(provider.runInSandbox(sandbox as any, request as any))
    .rejects.toBeInstanceOf(AgentExecutionPending)
  resolveProcess(null)
  await Promise.resolve()
  await Promise.resolve()
  expect(sandbox.mkdir).not.toHaveBeenCalled()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('yields an admitted attempt when the initial lifetime RPC hangs, with no late process launch', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.sandboxLaunchPrerequisiteMs = 20
  provider.executionReceipts = { get: async () => null }
  provider.observationHealth = { get: async () => null, recordFailure: vi.fn() }
  const launch = vi.spyOn(provider, 'runInSandbox')
  let resolveLifetime!: () => void
  const sandbox = { ...ownerReceipt, setKeepAlive: vi.fn(() => new Promise<void>(resolve => { resolveLifetime = resolve })) }
  vi.mocked(getAgentSandbox).mockReturnValue(sandbox as any)
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  resolveLifetime()
  await Promise.resolve()
  await Promise.resolve()
  expect(launch).not.toHaveBeenCalled()
  expect(provider.observationHealth.recordProcessSuccess).toBeUndefined()
  expect(provider.observationHealth.recordFailure).toHaveBeenCalledOnce()
})

it('checks an exact durable receipt before an active observation cooldown', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  let receipt: any = null
  let digest = ''
  provider.executionReceipts = { get: async (_run: string, requestDigest: string) => { digest = requestDigest; return receipt } }
  provider.observationHealth = { get: async () => ({ requestDigest: digest, nextObservationAfter: new Date(Date.now() + 60_000).toISOString() }), recordProcessSuccess: vi.fn() }
  vi.mocked(getAgentSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(getAgentSandbox).not.toHaveBeenCalled()
  receipt = {
    requestDigest: 'a'.repeat(64), exitCode: 0, actorId: 'synthetic-session',
    files: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
  }
  const result = await provider.run(request as any)
  expect(result.actorId).toBe('synthetic-session')
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('picks up an exact local receipt after the bounded cooldown without starting an agent', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({
      ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
    } as any) as any
    const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
    const retryAfter = Date.now() + observationFailureSpacingMs
    let digest = ''
    const put = vi.fn()
    provider.executionReceipts = {
      get: async (_runId: string, requestDigest: string) => { digest = requestDigest; return null }, put,
    }
    provider.observationHealth = { get: async () => ({ requestDigest: digest, nextObservationAfter: new Date(retryAfter).toISOString() }), recordProcessSuccess: vi.fn() }
    provider.ensureAgentLogRequest = async () => {}
    provider.drainAgentLogs = async () => {}
    provider.agentResult = async () => ({ actorId: 'local-receipt' })
    const sandbox = { ...ownerReceipt,
      setKeepAlive: vi.fn(async () => {}),
      exists: vi.fn(async () => ({ exists: true })),
      readFile: vi.fn(async () => ({ content: JSON.stringify({
        requestDigest: digest, exitCode: 0, actorId: 'local-receipt', files: {},
        inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
      }) })),
      getProcess: vi.fn(), startProcess: vi.fn(), mkdir: vi.fn(),
    }
    vi.mocked(getAgentSandbox).mockClear().mockReturnValue(sandbox as any)
    await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
    expect(getAgentSandbox).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(observationFailureSpacingMs + 1)
    const result = await provider.run(request as any)
    expect(result.actorId).toBe('local-receipt')
    expect(put).toHaveBeenCalledOnce()
    expect(sandbox.getProcess).not.toHaveBeenCalled()
    expect(sandbox.startProcess).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('keeps an observation-incident reattachment read-only if process lookup returns null', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.executionReceipts = { get: async () => null }
  provider.observationHealth = { recordFailure: vi.fn() }
  const sandbox = { ...ownerReceipt,
    exists: vi.fn(async () => ({ exists: false })), getProcess: vi.fn(async () => null),
    mkdir: vi.fn(), startProcess: vi.fn(), exec: vi.fn(),
  }
  await expect(provider.runInSandbox(sandbox as any, request as any, true, {
    runId: request.runId, stageId: request.stage.id, waveId: request.wave.id,
    taskId: request.task.id, attempt: request.attempt, promptDigest: request.promptDigest,
  }))
    .rejects.toBeInstanceOf(AgentExecutionPending)
  expect(sandbox.getProcess).toHaveBeenCalledOnce()
  expect(provider.observationHealth.recordFailure).toHaveBeenCalledWith(
    expect.any(Object), expect.any(String), 'process-missing', expect.any(Date))
  expect(sandbox.mkdir).not.toHaveBeenCalled()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(sandbox.exec).not.toHaveBeenCalled()
})

it('accepts a late exact receipt during an unresolved incident before any Sandbox control RPC', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.executionReceipts = { get: async () => ({
    requestDigest: 'a'.repeat(64), exitCode: 0, actorId: 'original-session',
    files: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
  }) }
  provider.observationHealth = { recordProcessSuccess: vi.fn() }
  vi.mocked(getAgentSandbox).mockClear()
  const result = await provider.run(request as any)
  expect(result.actorId).toBe('original-session')
  expect(getAgentSandbox).not.toHaveBeenCalled()
  expect(provider.observationHealth.recordProcessSuccess).not.toHaveBeenCalled()
})

it('allows the first launch after a pre-claim observation outage', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  let digest = ''
  provider.executionReceipts = { get: async (_run: string, value: string) => { digest = value; return null },
    getStart: vi.fn(async () => null) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest, consecutiveFailures: 1,
    incidentSince: null, nextObservationAfter: null }) }
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValue({ ...ownerReceipt, setKeepAlive } as any)
  const reattach = vi.spyOn(provider, 'runInSandbox').mockResolvedValue({ actorId: 'first-launch' })
  expect((await provider.run(request as any)).actorId).toBe('first-launch')
  expect(provider.executionReceipts.getStart).toHaveBeenCalledOnce()
  expect(setKeepAlive).toHaveBeenCalledOnce()
  expect(reattach.mock.calls[0]?.[2]).toBe(false)
})

it('retains an existing launch claim and skips lifetime mutation during unresolved reattachment', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  let digest = ''
  provider.executionReceipts = { get: async (_run: string, value: string) => { digest = value; return null },
    getStart: vi.fn(async () => ({ claimedAt: '2026-10-07T00:00:00Z' })) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest, consecutiveFailures: 3,
    incidentSince: new Date(Date.now() - 11 * 60_000).toISOString(), nextObservationAfter: null }) }
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValue({ ...ownerReceipt, setKeepAlive } as any)
  const reattach = vi.spyOn(provider, 'runInSandbox').mockRejectedValue(new AgentExecutionPending('same-process', 'unavailable'))
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(provider.executionReceipts.getStart).toHaveBeenCalledOnce()
  expect(setKeepAlive).not.toHaveBeenCalled()
  expect(reattach.mock.calls[0]?.[2]).toBe(true)
})

it('records all-unavailable status probes as a failed observation without a new launch', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.executionReceipts = { get: async () => null }
  provider.observationHealth = { get: async () => null, recordFailure: vi.fn() }
  provider.ensureAgentLogRequest = async () => {}
  vi.mocked(waitForAgentProcess).mockResolvedValueOnce('unavailable')
  const sandbox = { ...ownerReceipt, setKeepAlive: vi.fn(async () => {}),
    exists: vi.fn(async () => ({ exists: false })),
    getProcess: vi.fn(async () => ({ id: 'original-process' })),
    startProcess: vi.fn(), mkdir: vi.fn() }
  vi.mocked(getAgentSandbox).mockReturnValue(sandbox as any)
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(provider.observationHealth.recordFailure).toHaveBeenCalledWith(
    expect.any(Object), expect.any(String), 'process-status-unavailable', expect.any(Date), expect.any(Date))
  expect(provider.observationHealth.recordFailure).toHaveBeenCalledOnce()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('keeps a terminal result-read expiry pending even after failed process status', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
  provider.sandboxTerminalReceiptMs = 20
  provider.executionReceipts = { get: async () => null, put: vi.fn() }
  provider.observationHealth = { recordProcessSuccess: vi.fn() }
  provider.ensureAgentLogRequest = async () => {}
  const sandbox = { ...ownerReceipt,
    exists: vi.fn(async () => ({ exists: false })),
    getProcess: vi.fn(async () => ({ id: 'existing-process' })),
    readFile: vi.fn(() => new Promise(() => {})),
  }
  await expect(provider.runInSandbox(sandbox as any, request as any, false, {
    runId: request.runId, stageId: request.stage.id, waveId: request.wave.id,
    taskId: request.task.id, attempt: request.attempt, promptDigest: request.promptDigest,
  }))
    .rejects.toBeInstanceOf(AgentExecutionPending)
  expect(sandbox.readFile).toHaveBeenCalledOnce()
  expect(provider.executionReceipts.put).not.toHaveBeenCalled()
  expect(provider.observationHealth.recordProcessSuccess).not.toHaveBeenCalled()
})

it.each([false, true])('uses no-start log observation and marks EOF complete only with terminal work (%s)', async terminal => {
  const provider = new SandboxAgentProvider({} as any) as any
  const sync = vi.fn(async (input: { complete: boolean }) => ({ complete: input.complete })), finish = vi.fn()
  provider.executionLogs = { cursor: async () => ({ ready: true, index: { sourceBytes: 2 } }), sync, finish }
  const observeAgentLog = vi.fn(async () => ({ status: 'available', offset: 2, size: 5, bytes: 3, data: 'YWJj' }))
  const sandbox = { ...ownerReceipt, observeAgentLog, exec: vi.fn(), exists: vi.fn(), startProcess: vi.fn(), setKeepAlive: vi.fn() }
  expect(await provider.captureAgentLogs(sandbox, request, 'a'.repeat(64), terminal)).toBe(terminal)
  expect(observeAgentLog).toHaveBeenCalledExactlyOnceWith('a'.repeat(64), 2, 256 * 1024)
  expect(sync).toHaveBeenCalledExactlyOnceWith({ runId: request.runId, taskId: request.task.id,
    requestDigest: 'a'.repeat(64), source: 'abc', sourceOffset: 2, complete: terminal })
  expect(finish).not.toHaveBeenCalled()
  for (const forbidden of [sandbox.exec, sandbox.exists, sandbox.startProcess, sandbox.setKeepAlive]) expect(forbidden).not.toHaveBeenCalled()
})

it.each(['missing', 'transport', 'invalid'])('keeps %s log evidence distinct during terminal capture', async status => {
  const provider = new SandboxAgentProvider({} as any) as any
  const sync = vi.fn(), finish = vi.fn()
  provider.executionLogs = { cursor: async () => ({ ready: true, index: { sourceBytes: 0 } }), sync, finish }
  const sandbox = { ...ownerReceipt, observeAgentLog: vi.fn(async () => {
    if (status === 'transport') throw new Error('native output lost')
    return status === 'missing' ? { status: 'missing' } : { status: 'available', offset: 0, bytes: 1, size: 1, data: 'YR==' }
  }) }
  expect(await provider.captureAgentLogs(sandbox, request, 'a'.repeat(64), true)).toBe(status === 'missing')
  if (status === 'missing') expect(finish).toHaveBeenCalledExactlyOnceWith({ runId: request.runId,
    taskId: request.task.id, requestDigest: 'a'.repeat(64), truncated: true })
  else expect(finish).not.toHaveBeenCalled()
  expect(sync).not.toHaveBeenCalled()
})

it('bounds terminal drain when the no-start log observation never resolves', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({} as any) as any
    let resolveObservation!: (value: { status: 'missing' }) => void
    const observeAgentLog = vi.fn(() => new Promise<{ status: 'missing' }>(resolve => { resolveObservation = resolve }))
    const finish = vi.fn()
    const sync = vi.fn()
    provider.executionLogs = {
      cursor: async () => ({ ready: true, index: { sourceBytes: 0 } }), finish, sync,
    }
    const request = { runId: 'receipt-run', task: { id: 'research-1' } }
    const drain = provider.drainAgentLogs({ observeAgentLog } as any, request as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    expect(observeAgentLog).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveObservation({ status: 'missing' })
    await Promise.resolve()
    await Promise.resolve()
    expect(finish).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('does not start a terminal log write after a late cursor response', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({} as any) as any
    let resolveCursor!: (value: { ready: boolean, index: { sourceBytes: number } }) => void
    const cursor = vi.fn(() => new Promise(resolve => { resolveCursor = resolve }))
    const finish = vi.fn()
    const sync = vi.fn()
    const observeAgentLog = vi.fn()
    provider.executionLogs = { cursor, finish, sync }
    const drain = provider.drainAgentLogs({ observeAgentLog } as any,
      { runId: 'receipt-run', task: { id: 'research-1' } } as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveCursor({ ready: true, index: { sourceBytes: 0 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(observeAgentLog).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
    expect(sync).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('does not start a terminal log sync after a late Sandbox read response', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({} as any) as any
    let resolveRead!: (value: unknown) => void
    const observeAgentLog = vi.fn(() => new Promise(resolve => { resolveRead = resolve }))
    const sync = vi.fn()
    const finish = vi.fn()
    provider.executionLogs = {
      cursor: async () => ({ ready: true, index: { sourceBytes: 0 } }), sync, finish,
    }
    const drain = provider.drainAgentLogs({
      observeAgentLog,
    } as any, { runId: 'receipt-run', task: { id: 'research-1' } } as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    expect(observeAgentLog).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveRead({ status: 'available', offset: 0, size: 0, bytes: 0, data: '' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sync).not.toHaveBeenCalled()
    expect(finish).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})

it('diagnoses the terminal observation-loss route with native metrics without touching the lost sandbox', async () => {
  const actorId = 'a'.repeat(64)
  const firstFailedAt = new Date(Date.now() - agentObservationIncidentMaxMs - 20 * 60_000).toISOString()
  const fetcher = vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: [{
    dimensions: { instanceId: actorId, applicationId: 'native-app', placementId: 'native-placement',
      datetimeMinute: new Date(Date.parse(firstFailedAt) - 2 * 60_000).toISOString() },
    max: { memory: 8_000 * 1024 * 1024 },
  }] }] } } }))
  vi.stubGlobal('fetch', fetcher)
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    const env = { ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32),
      CLOUDFLARE_OBSERVABILITY_TOKEN: { get: async () => 'monitor-private-token' },
      VERSION_METADATA: { id: 'runtime-version' }, AGENT_SANDBOX: { idFromName: vi.fn(() => ({ toString: () => actorId })) } }
    const provider = new SandboxAgentProvider(env as any) as any
    const request = await admittedProviderRequest(provider, close => closeDatabases.push(close))
    provider.assertProviderCredentials = () => {}
    let digest = ''
    provider.executionReceipts = { get: async (_run: string, requestDigest: string) => { digest = requestDigest; return null } }
    provider.observationHealth = { get: async () => ({ requestDigest: digest, firstFailedAt,
      incidentSince: new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString(), nextObservationAfter: null }) }
    vi.mocked(getAgentSandbox).mockClear()
    await expect(provider.run(request as any)).rejects.toMatchObject({
      category: 'session-recovery-unavailable', retryable: false,
      message: expect.stringContaining('suspected-memory-exhaustion'),
    })
    expect(getAgentSandbox).not.toHaveBeenCalled()
    expect(fetcher).toHaveBeenCalledTimes(1)
    const diagnostic = JSON.parse(logged.mock.calls.at(-1)![0])
    expect(diagnostic).toMatchObject({ event: 'observation-resource-assessment', workerVersionId: 'runtime-version',
      resources: { actorId, firstFailedAt, memoryLimitMiB: 8_192, oomKill: 'not-established' } })
    expect(JSON.stringify(diagnostic)).not.toContain('monitor-private-token')
  } finally { logged.mockRestore(); vi.unstubAllGlobals() }
})


it('keeps the monitoring credential out of agent credential resolution and environment', async () => {
  const get = vi.fn(async () => 'monitor-secret')
  const provider = new SandboxAgentProvider({ CLOUDFLARE_OBSERVABILITY_TOKEN: { get } } as any) as any
  expect(await provider.credential('CLOUDFLARE_OBSERVABILITY_TOKEN')).toBeNull()
  expect(get).not.toHaveBeenCalled()
  const additive = { ...request, task: { ...request.task, providerClass: 'additive',
    connection: { apiKeyEnv: 'CLOUDFLARE_OBSERVABILITY_TOKEN' } } }
  expect(() => agentProcessEnvironment(additive as any, { CLOUDFLARE_OBSERVABILITY_TOKEN: 'monitor-secret' } as any, {}))
    .toThrow('agent credential CLOUDFLARE_OBSERVABILITY_TOKEN is missing')
})


it('passes only the selected subscription to each native runner', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const env = { ACK3_CODEX_WORKSPACE_ID: 'default', CODEX_TEAM_AUTH_JSON: JSON.stringify({ tokens: { account_id: id } }),
    CLAUDE_TEAM_OAUTH_TOKEN: 'sk-ant-oat-test-only', CLOUDFLARE_OBSERVABILITY_TOKEN: 'not-for-agents' }
  const codex = agentProcessEnvironment({ ...request, task: { ...request.task,
    backend: 'codex', credentialSource: 'CODEX_TEAM_AUTH_JSON' } } as any, env as any, {})
  expect(codex.ACK3_CODEX_WORKSPACE_ID).toBe(id)
  expect(codex.CODEX_TEAM_AUTH_JSON).toBeUndefined()
  expect(codex.CLAUDE_TEAM_OAUTH_TOKEN).toBeUndefined()
  const claude = agentProcessEnvironment({ ...request, task: { ...request.task,
    backend: 'claude', credentialSource: 'CLAUDE_TEAM_OAUTH_TOKEN' } } as any, env as any, {})
  expect(claude.CLAUDE_CODE_OAUTH_TOKEN).toBe(env.CLAUDE_TEAM_OAUTH_TOKEN)
  expect(claude.ACK3_CODEX_WORKSPACE_ID).toBeUndefined()
  expect(claude.CLOUDFLARE_OBSERVABILITY_TOKEN).toBeUndefined()
})

it('exposes only selected header credentials to its native process', () => {
  const connection = { baseUrl: 'https://model.example.com/v1', apiKeyEnv: 'LOCAL_MODEL_API_KEY',
    headersEnv: { 'CF-Access-Client-Id': 'LOCAL_MODEL_HEADER_ID_API_KEY', 'CF-Access-Client-Secret': 'LOCAL_MODEL_HEADER_SECRET_API_KEY' } }
  const selected = { ...request, task: { ...request.task, backend: 'dsh-chat-completions', providerClass: 'additive', connection } }
  const env = { LOCAL_MODEL_API_KEY: 'origin-key', LOCAL_MODEL_HEADER_ID_API_KEY: 'selected-id',
    LOCAL_MODEL_HEADER_SECRET_API_KEY: 'selected-secret', OTHER_ACCESS_CLIENT_SECRET: 'not-selected',
    CLOUDFLARE_OBSERVABILITY_TOKEN: 'monitor-only' }
  const resolved = agentProcessEnvironment(selected as any, env as any, {})
  expect(resolved.LOCAL_MODEL_HEADER_ID_API_KEY).toBe('selected-id')
  expect(resolved.LOCAL_MODEL_HEADER_SECRET_API_KEY).toBe('selected-secret')
  expect(resolved.OTHER_ACCESS_CLIENT_SECRET).toBeUndefined()
  expect(resolved.CLOUDFLARE_OBSERVABILITY_TOKEN).toBeUndefined()
  expect(() => agentProcessEnvironment(selected as any, { ...env, LOCAL_MODEL_HEADER_SECRET_API_KEY: '' } as any, {}))
    .toThrow('LOCAL_MODEL_HEADER_SECRET_API_KEY is missing')
})
