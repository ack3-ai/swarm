import { expect, it, vi } from 'vitest'
import { getSandbox } from '@cloudflare/sandbox'
import { waitForAgentProcess } from '../src/agent-process.js'
import { SandboxAgentProvider, agentProcessEnvironment, agentObservationIncidentMaxMs,
  terminalLogDrainMs } from '../src/sandbox-provider.js'
import { expiredObservationCooldownMs } from '../src/agent-observation-cooldown.js'
import { AgentExecutionPending } from '../src/run-errors.js'

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))
vi.mock('../src/agent-process.js', () => ({
  agentProcessId: (digest: string) => `agent-${digest.slice(0, 40)}`,
  waitForAgentProcess: vi.fn(async (_process: unknown, _slice: number, _interval: number,
    observation?: { onStatusProbe?: (outcome: string) => void }) => {
    observation?.onStatusProbe?.('success')
    return 1
  }),
}))

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
  provider.assertProviderCredentials = () => {}
  let digest = ''
  provider.executionReceipts = { get: vi.fn(async (_run: string, requestDigest: string) => {
    digest = requestDigest
    return null
  }) }
  const incidentSince = new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString()
  provider.observationHealth = { get: async () => ({ requestDigest: digest, incidentSince,
    nextObservationAfter: new Date(Date.now() + 60_000).toISOString() }) }
  vi.mocked(getSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toMatchObject({
    category: 'session-recovery-unavailable', retryable: false,
  })
  expect(provider.executionReceipts.get).toHaveBeenCalledTimes(2)
  expect(getSandbox).not.toHaveBeenCalled()
})

it('prefers a late exact receipt over the core observation-outage boundary', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
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
  vi.mocked(getSandbox).mockClear()
  await expect(provider.run(request as any)).resolves.toMatchObject({ actorId: 'retained-session' })
  expect(getSandbox).not.toHaveBeenCalled()
})

it('does not turn an unreadable late receipt into an absent receipt', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
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
  vi.mocked(getSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toMatchObject({ retryable: true })
  expect(getSandbox).not.toHaveBeenCalled()
})

it('yields an admitted attempt when result-file observation hangs, with no late launch', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  provider.sandboxObservationMs = 20
  provider.executionReceipts = { get: async () => null }
  let resolveExists!: (value: { exists: boolean }) => void
  const exists = vi.fn(() => new Promise<{ exists: boolean }>(resolve => { resolveExists = resolve }))
  const sandbox = { exists, getProcess: vi.fn(), mkdir: vi.fn(), startProcess: vi.fn() }
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
  provider.sandboxObservationMs = 20
  provider.executionReceipts = { get: async () => null }
  let resolveProcess!: (value: null) => void
  const getProcess = vi.fn(() => new Promise<null>(resolve => { resolveProcess = resolve }))
  const sandbox = {
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
  provider.sandboxLaunchPrerequisiteMs = 20
  provider.executionReceipts = { get: async () => null }
  provider.observationCooldowns = { get: async () => null, put: vi.fn() }
  provider.observationHealth = { get: async () => null, recordFailure: vi.fn() }
  const launch = vi.spyOn(provider, 'runInSandbox')
  let resolveLifetime!: () => void
  const sandbox = { setKeepAlive: vi.fn(() => new Promise<void>(resolve => { resolveLifetime = resolve })) }
  vi.mocked(getSandbox).mockReturnValue(sandbox as any)
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  resolveLifetime()
  await Promise.resolve()
  await Promise.resolve()
  expect(launch).not.toHaveBeenCalled()
  expect(provider.observationHealth.recordProcessSuccess).toBeUndefined()
  expect(provider.observationCooldowns.put).toHaveBeenCalledOnce()
})

it('checks an exact durable receipt before an active observation cooldown', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  let receipt: any = null
  provider.executionReceipts = { get: async () => receipt }
  provider.observationCooldowns = { get: async () => Date.now() + 60_000 }
  provider.observationHealth = { get: async () => null, recordProcessSuccess: vi.fn() }
  vi.mocked(getSandbox).mockClear()
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(getSandbox).not.toHaveBeenCalled()
  receipt = {
    requestDigest: 'a'.repeat(64), exitCode: 0, actorId: 'synthetic-session',
    files: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
  }
  const result = await provider.run(request as any)
  expect(result.actorId).toBe('synthetic-session')
  expect(getSandbox).not.toHaveBeenCalled()
})

it('picks up an exact local receipt after the bounded cooldown without starting an agent', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({
      ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
    } as any) as any
    const retryAfter = Date.now() + expiredObservationCooldownMs
    let digest = ''
    const put = vi.fn()
    provider.executionReceipts = {
      get: async (_runId: string, requestDigest: string) => { digest = requestDigest; return null }, put,
    }
    provider.observationCooldowns = { get: async () => retryAfter }
    provider.observationHealth = { get: async () => null, recordProcessSuccess: vi.fn() }
    provider.ensureAgentLogRequest = async () => {}
    provider.drainAgentLogs = async () => {}
    provider.agentResult = async () => ({ actorId: 'local-receipt' })
    const sandbox = {
      setKeepAlive: vi.fn(async () => {}),
      exists: vi.fn(async () => ({ exists: true })),
      readFile: vi.fn(async () => ({ content: JSON.stringify({
        requestDigest: digest, exitCode: 0, actorId: 'local-receipt', files: {},
        inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
      }) })),
      getProcess: vi.fn(), startProcess: vi.fn(), mkdir: vi.fn(),
    }
    vi.mocked(getSandbox).mockClear().mockReturnValue(sandbox as any)
    await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
    expect(getSandbox).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(expiredObservationCooldownMs + 1)
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
  provider.executionReceipts = { get: async () => null }
  provider.observationHealth = { recordFailure: vi.fn() }
  const sandbox = {
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
  provider.executionReceipts = { get: async () => ({
    requestDigest: 'a'.repeat(64), exitCode: 0, actorId: 'original-session',
    files: {}, inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '',
  }) }
  provider.observationHealth = { recordProcessSuccess: vi.fn() }
  vi.mocked(getSandbox).mockClear()
  const result = await provider.run(request as any)
  expect(result.actorId).toBe('original-session')
  expect(getSandbox).not.toHaveBeenCalled()
  expect(provider.observationHealth.recordProcessSuccess).not.toHaveBeenCalled()
})

it('allows the first launch after a pre-claim observation outage', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  } as any) as any
  let digest = ''
  provider.executionReceipts = { get: async (_run: string, value: string) => { digest = value; return null },
    getStart: vi.fn(async () => null) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest, consecutiveFailures: 1,
    incidentSince: null, nextObservationAfter: null }) }
  provider.observationCooldowns = { get: async () => null }
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValue({ setKeepAlive } as any)
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
  let digest = ''
  provider.executionReceipts = { get: async (_run: string, value: string) => { digest = value; return null },
    getStart: vi.fn(async () => ({ claimedAt: '2026-10-07T00:00:00Z' })) }
  provider.observationHealth = { get: async () => ({ requestDigest: digest, consecutiveFailures: 3,
    incidentSince: new Date(Date.now() - 11 * 60_000).toISOString(), nextObservationAfter: null }) }
  provider.observationCooldowns = { get: async () => null }
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValue({ setKeepAlive } as any)
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
  provider.executionReceipts = { get: async () => null }
  provider.observationHealth = { get: async () => null, recordFailure: vi.fn() }
  provider.observationCooldowns = { get: async () => null, put: vi.fn() }
  provider.ensureAgentLogRequest = async () => {}
  vi.mocked(waitForAgentProcess).mockResolvedValueOnce('unavailable')
  const sandbox = { setKeepAlive: vi.fn(async () => {}),
    exists: vi.fn(async () => ({ exists: false })),
    getProcess: vi.fn(async () => ({ id: 'original-process' })),
    startProcess: vi.fn(), mkdir: vi.fn() }
  vi.mocked(getSandbox).mockReturnValue(sandbox as any)
  await expect(provider.run(request as any)).rejects.toBeInstanceOf(AgentExecutionPending)
  expect(provider.observationHealth.recordFailure).toHaveBeenCalledWith(
    expect.any(Object), expect.any(String), 'process-status-unavailable', expect.any(Date))
  expect(provider.observationCooldowns.put).toHaveBeenCalledOnce()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('keeps a terminal result-read expiry pending even after failed process status', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  provider.sandboxTerminalReceiptMs = 20
  provider.executionReceipts = { get: async () => null, put: vi.fn() }
  provider.observationHealth = { recordProcessSuccess: vi.fn() }
  provider.ensureAgentLogRequest = async () => {}
  const sandbox = {
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

it('returns an exact completed receipt even when terminal log existence never resolves', async () => {
  vi.useFakeTimers()
  try {
    const provider = new SandboxAgentProvider({} as any) as any
    let resolveExists!: (value: { exists: boolean }) => void
    const exists = vi.fn(() => new Promise<{ exists: boolean }>(resolve => { resolveExists = resolve }))
    const finish = vi.fn()
    const sync = vi.fn()
    provider.executionLogs = {
      cursor: async () => ({ ready: true, index: { sourceBytes: 0 } }), finish, sync,
    }
    const request = { runId: 'receipt-run', task: { id: 'research-1' } }
    const drain = provider.drainAgentLogs({ exists } as any, request as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    expect(exists).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveExists({ exists: false })
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
    const exists = vi.fn()
    provider.executionLogs = { cursor, finish, sync }
    const drain = provider.drainAgentLogs({ exists } as any,
      { runId: 'receipt-run', task: { id: 'research-1' } } as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveCursor({ ready: true, index: { sourceBytes: 0 } })
    await Promise.resolve()
    await Promise.resolve()
    expect(exists).not.toHaveBeenCalled()
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
    let resolveRead!: (value: { success: boolean, stdout: string }) => void
    const exec = vi.fn(() => new Promise(resolve => { resolveRead = resolve }))
    const sync = vi.fn()
    const finish = vi.fn()
    provider.executionLogs = {
      cursor: async () => ({ ready: true, index: { sourceBytes: 0 } }), sync, finish,
    }
    const drain = provider.drainAgentLogs({
      exists: async () => ({ exists: true }), exec,
    } as any, { runId: 'receipt-run', task: { id: 'research-1' } } as any, 'a'.repeat(64))
    await vi.advanceTimersByTimeAsync(0)
    expect(exec).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(terminalLogDrainMs + 1)
    await expect(drain).resolves.toBeUndefined()
    resolveRead({ success: true, stdout: JSON.stringify({ size: 0, bytes: 0, data: '' }) })
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
      VERSION_METADATA: { id: 'runtime-version' }, Sandbox: { idFromName: vi.fn(() => ({ toString: () => actorId })) } }
    const provider = new SandboxAgentProvider(env as any) as any
    provider.assertProviderCredentials = () => {}
    let digest = ''
    provider.executionReceipts = { get: async (_run: string, requestDigest: string) => { digest = requestDigest; return null } }
    provider.observationHealth = { get: async () => ({ requestDigest: digest, firstFailedAt,
      incidentSince: new Date(Date.now() - agentObservationIncidentMaxMs - 1).toISOString(), nextObservationAfter: null }) }
    vi.mocked(getSandbox).mockClear()
    await expect(provider.run(request as any)).rejects.toMatchObject({
      category: 'session-recovery-unavailable', retryable: false,
      message: expect.stringContaining('suspected-memory-exhaustion'),
    })
    expect(getSandbox).not.toHaveBeenCalled()
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
