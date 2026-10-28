import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NativeSessionCustody, nativeSessionInspectionScript, nativeTerminalCustodyCode, nativeTransportCode } from '../src/native-session-custody.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import type { AgentRequest, NativeTransportEvidence } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { nativeDshHttp2PreloadPath, nativeDshHttp2PreloadSource } from '../src/native-dsh-http2.js'
import { AgentAttemptFailure, TransientRunFailure } from '../src/run-errors.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))

const sessionId = 'session-11111111-1111-4111-8111-111111111111'
const task = audit0Definition.stages.find(s => s.kind === 'discovery')!.waves[0]!.tasks.find(t => t.providerClass === 'additive')!
const syntheticCredentials = {
  ACK3_CODEX_AUTH_JSON: '{"fixture":true}', ACK3_CODEX_WORKSPACE_ID: 'synthetic',
  PROVIDER_A_API_KEY: 'synthetic-only', PROVIDER_B_API_KEY: 'synthetic-only',
}
const fixtureProvider = (env: Record<string, unknown>) =>
  new SandboxAgentProvider({ ...syntheticCredentials, ...env } as any)
const request = { experimentId: 'fixture', runId: 'native-custody-fixture', releaseDigest: 'a'.repeat(64),
  stage: audit0Definition.stages[1], wave: audit0Definition.stages[1]!.waves[0], task,
  attempt: 1, prompt: 'Synthetic fixture', promptDigest: 'b'.repeat(64), visibleArtifacts: [],
  diagnostics: [], repairFiles: {}, freshContext: false, continuationMode: 'new', sessionId: null } as AgentRequest
const receipt: AgentExecutionReceipt = { requestDigest: 'c'.repeat(64), exitCode: 1, actorId: sessionId,
  files: {}, inputTokens: 20, outputTokens: 3, costUsd: 0, stderr: '', providerRequests: [],
  providerErrorCode: 'TRANSPORT', providerHttpStatus: null }

class Bucket {
  objects = new Map<string, any>()
  failPut = false
  async put(key: string, text: string, options: any) {
    if (this.failPut) { this.failPut = false; throw new Error('transient archive upload failure') }
    if (this.objects.has(key)) return null
    this.objects.set(key, { text, options }); return {}
  }
  async get(key: string) {
    const saved = this.objects.get(key)
    return saved === undefined ? null : { text: async () => saved.text,
      customMetadata: saved.options.customMetadata, checksums: { toJSON: () => ({ sha256: saved.options.sha256 }) } }
  }
}

async function lane(workState: NativeTransportEvidence['workState'] = 'present') {
  const content = Buffer.from('synthetic native journal').toString('base64')
  const hash = await crypto.subtle.digest('SHA-256', Buffer.from(content, 'base64'))
  const journalDigest = [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('')
  const path = `/opt/dsh-home/sessions/--workspace-source--/${sessionId}/session.v3.jsonl.zstd`
  const files = new Map<string, string>([[path, content]])
  const sandbox = { writeFile: vi.fn(async (p: string, text: string) => { files.set(p, text) }),
    exec: vi.fn(async () => ({ success: true, stdout: JSON.stringify(files.has(path)
      ? { status: 'available', path, fileName: 'session.v3.jsonl.zstd', bytes: Buffer.from(content, 'base64').length,
        journalDigest, closed: true, workState }
      : { status: 'unavailable' }) })),
    readFile: vi.fn(async (p: string) => ({ content: files.get(p)! })),
    exists: vi.fn(async (p: string) => ({ exists: files.has(p) })), startProcess: vi.fn(), files, path }
  return sandbox
}

it('captures one exact failed session before cleanup and validates retained workspace custody', async () => {
  const bucket = new Bucket(), sandbox = await lane(), custody = new NativeSessionCustody(bucket as any)
  const evidence = (await custody.capture(sandbox as any, request, receipt))!
  expect(evidence).toMatchObject({ sessionId, sourceRunId: request.runId, workState: 'present' })
  expect(bucket.objects.size).toBe(1)
  const resumed = { ...request, attempt: 2, nativeTransport: evidence, continuationMode: 'resume' as const, sessionId }
  await custody.assertRetryCustody(sandbox as any, resumed)
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(await custody.capture(sandbox as any, request, receipt)).toEqual(evidence)
  expect(bucket.objects.size).toBe(1)
  sandbox.files.clear() // A disposed/recreated lane has no original scratch or journal.
  await expect(custody.assertRetryCustody(sandbox as any, resumed)).rejects.toMatchObject({ category: 'session-recovery-unavailable' })
  expect(sandbox.files.size).toBe(0) // No automatic restore from the archive.
})

it('binds output correction to the retained native journal and exact quarantined files', async () => {
  const sandbox = await lane(), custody = new NativeSessionCustody(new Bucket() as any)
  const repairFiles = { '.swarm/submission.json': '{"schemaVersion":1}' }
  const correction = { ...request, attempt: 2, continuationMode: 'resume' as const, sessionId,
    formatRepairOrdinal: 1, formatRepairSourceDigest: await sha256(canonicalJson(repairFiles)), repairFiles }
  await custody.assertFormatRepairCustody(sandbox as any, correction)
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  await expect(custody.assertFormatRepairCustody(sandbox as any,
    { ...correction, formatRepairSourceDigest: '0'.repeat(64) })).rejects.toMatchObject({ category: 'integrity-failed' })
  sandbox.files.clear()
  await expect(custody.assertFormatRepairCustody(sandbox as any, correction))
    .rejects.toMatchObject({ category: 'session-recovery-unavailable' })
})

it('rejects a copied journal without the original workspace custody marker', async () => {
  const bucket = new Bucket(), sandbox = await lane(), custody = new NativeSessionCustody(bucket as any)
  const evidence = (await custody.capture(sandbox as any, request, receipt))!
  for (const key of sandbox.files.keys()) if (key.includes('/native-session-custody-')) sandbox.files.delete(key)
  await expect(custody.assertRetryCustody(sandbox as any, { ...request, attempt: 2,
    nativeTransport: evidence, continuationMode: 'resume', sessionId })).rejects.toMatchObject({ category: 'session-recovery-unavailable' })
})

it('binds custody to exact task, release, journal bytes, and session', async () => {
  const bucket = new Bucket(), sandbox = await lane(), custody = new NativeSessionCustody(bucket as any)
  const evidence = (await custody.capture(sandbox as any, request, receipt))!
  const resumed = { ...request, attempt: 2, nativeTransport: evidence, continuationMode: 'resume' as const, sessionId }
  for (const changed of [{ releaseDigest: 'd'.repeat(64) }, { task: { ...task, id: 'other' } },
    { task: { ...task, workspaceKey: 'other' } }, { sessionId: 'session-22222222-2222-4222-8222-222222222222' }]) {
    await expect(custody.assertRetryCustody(sandbox as any, { ...resumed, ...changed })).rejects.toMatchObject({ category: 'integrity-failed' })
  }
  await expect(custody.assertRetryCustody(sandbox as any, { ...resumed,
    nativeTransport: { ...evidence, snapshotDigest: 'f'.repeat(64) } })).rejects.toMatchObject({ category: 'session-recovery-unavailable' })
})

it('explicitly permits a complete empty-session fresh retry within the existing allowance', async () => {
  const bucket = new Bucket(), sandbox = await lane('none'), custody = new NativeSessionCustody(bucket as any)
  const evidence = (await custody.capture(sandbox as any, request, receipt))!
  sandbox.files.clear()
  await custody.assertRetryCustody(sandbox as any, { ...request, attempt: 2, nativeTransport: evidence, freshContext: true })
  await expect(custody.assertRetryCustody(sandbox as any, { ...request, attempt: 2,
    nativeTransport: evidence, continuationMode: 'resume', sessionId })).rejects.toMatchObject({ category: 'integrity-failed' })
})

it.each(['AUTH', 'INVALID_REQUEST', 'ABORTED', 'UNKNOWN'])('does not reinterpret %s as session recovery', code => {
  expect(nativeTransportCode(request, { ...receipt, providerErrorCode: code })).toBeNull()
})
it.each([400, 401, 403])('does not reinterpret HTTP %s as recoverable transport', status => {
  expect(nativeTransportCode(request, { ...receipt, providerHttpStatus: status })).toBeNull()
})

it.each(['present', 'none'] as const)('archives terminal AUTH custody without granting an automatic retry (%s work)', async workState => {
  const bucket = new Bucket(), sandbox = await lane(workState), custody = new NativeSessionCustody(bucket as any)
  const rejected = { ...receipt, providerErrorCode: 'AUTH', providerHttpStatus: 403 }
  expect(nativeTransportCode(request, rejected)).toBeNull()
  expect(nativeTerminalCustodyCode(request, rejected)).toBe('AUTH')
  const evidence = (await custody.captureTerminal(sandbox as any, request, rejected))!
  expect(evidence).toMatchObject({ code: 'AUTH', sessionId, archiveStatus: 'available', workState })
  expect(bucket.objects.size).toBe(1)
  await expect(custody.assertRetryCustody(sandbox as any, { ...request, attempt: 2,
    nativeTransport: evidence as any, continuationMode: 'resume', sessionId })).rejects.toMatchObject({ category: 'integrity-failed' })
})

it('records unavailable terminal AUTH journal explicitly and retains unknown work', async () => {
  const bucket = new Bucket(), sandbox = await lane(), custody = new NativeSessionCustody(bucket as any)
  sandbox.files.clear()
  const evidence = (await custody.captureTerminal(sandbox as any, request,
    { ...receipt, providerErrorCode: 'AUTH', providerHttpStatus: 401 }))!
  expect(evidence).toMatchObject({ code: 'AUTH', archiveStatus: 'unavailable', workState: 'unknown', sessionId })
  expect(bucket.objects.size).toBe(1)
})

it('captures terminal AUTH before propagating failure, without another model execution', async () => {
  const bucket = new Bucket(), sandbox = await lane(), provider = fixtureProvider({ ARTIFACTS: bucket } as any)
  const get = vi.fn(async (_run: string, digest: string) => ({ ...receipt, requestDigest: digest,
    providerErrorCode: 'AUTH', providerHttpStatus: 403, stderr: 'synthetic upstream 403' }))
  Object.assign(provider, { executionReceipts: { get }, ensureAgentLogRequest: async () => {} })
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    name: 'AgentAttemptFailure', usage: { modelCalls: 1, inputTokens: 20 },
    nativeTerminalCustody: { code: 'AUTH', sessionId, archiveStatus: 'available', workState: 'present' },
  })
  expect(get).toHaveBeenCalledTimes(1)
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(bucket.objects.size).toBe(1)
})

it('retries terminal AUTH archive I/O against the same closed receipt without re-executing the model', async () => {
  const bucket = new Bucket(), sandbox = await lane(), provider = fixtureProvider({ ARTIFACTS: bucket } as any)
  const get = vi.fn(async (_run: string, digest: string) => ({ ...receipt, requestDigest: digest,
    providerErrorCode: 'AUTH', providerHttpStatus: 403, stderr: 'synthetic upstream 403' }))
  Object.assign(provider, { executionReceipts: { get }, ensureAgentLogRequest: async () => {} })
  bucket.failPut = true
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({ category: 'transport', retryable: true })
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    nativeTerminalCustody: { code: 'AUTH', archiveStatus: 'available', workState: 'present' },
  })
  expect(get).toHaveBeenCalledTimes(2)
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(bucket.objects.size).toBe(1)
})

it('retries archive upload from the closed durable receipt without another model execution or charge', async () => {
  const bucket = new Bucket(), sandbox = await lane()
  const provider = fixtureProvider({ ARTIFACTS: bucket } as any)
  const get = vi.fn(async (_run: string, digest: string) => ({ ...receipt, requestDigest: digest }))
  Object.assign(provider, { executionReceipts: { get }, ensureAgentLogRequest: async () => {} })
  bucket.failPut = true
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    category: 'transport', retryable: true, cause: expect.objectContaining({ message: 'transient archive upload failure' }),
  })
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    name: 'AgentAttemptFailure', usage: { modelCalls: 1, inputTokens: 20 }, nativeTransport: { sessionId },
  })
  expect(get.mock.calls[0]).toEqual(get.mock.calls[1])
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  expect(bucket.objects.size).toBe(1)
})

it('makes missing or unknown retained custody explicit rather than silently starting fresh', async () => {
  const bucket = new Bucket(), sandbox = await lane()
  sandbox.files.clear()
  const provider = fixtureProvider({ ARTIFACTS: bucket } as any)
  Object.assign(provider, { executionReceipts: { get: async (_r: string, digest: string) => ({ ...receipt, requestDigest: digest }) },
    ensureAgentLogRequest: async () => {} })
  const result = await (provider as any).runInSandbox(sandbox, request)
  expect(result).toMatchObject({ status: 'additive-unavailable', unavailableReason: 'platform-interruption', modelCalls: 1, inputTokens: 20 })
  expect(sandbox.startProcess).not.toHaveBeenCalled()
  await expect((provider as any).runInSandbox(sandbox, { ...request, task: { ...task, optional: false } }))
    .rejects.toMatchObject({ category: 'session-recovery-unavailable', cause: expect.any(AgentAttemptFailure) })
})

it('keeps the existing valid final-output handoff authoritative before custody recovery', async () => {
  const sandbox = await lane(), current = { ...request, attempt: 2 }
  const result = await new DeterministicAuditProvider().run(current)
  const provider = fixtureProvider({ ARTIFACTS: new Bucket() } as any)
  const capture = vi.fn()
  Object.assign(provider, { executionReceipts: { get: async (_run: string, digest: string) => ({
    ...receipt, requestDigest: digest, files: result.files,
  }) }, nativeSessions: { capture }, ensureAgentLogRequest: async () => {} })
  const accepted = await (provider as any).runInSandbox(sandbox, current)
  expect(accepted.status).toBe('accepted')
  expect(accepted.files).toEqual(result.files)
  expect(capture).not.toHaveBeenCalled()
  expect(sandbox.startProcess).not.toHaveBeenCalled()
})

it('does not clear expected outputs or scratch during native transport continuation', async () => {
  const sandbox = await lane(), starts: string[] = []
  const provider = fixtureProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const evidence = { code: 'TRANSPORT', sourceRunId: request.runId, requestDigest: 'c'.repeat(64),
    snapshotDigest: 'd'.repeat(64), sessionId, workState: 'present' } as NativeTransportEvidence
  Object.assign(provider, { executionReceipts: { get: async () => null, getStart: async () => null,
    claimStart: async () => ({ acquired: true, claimedAt: new Date().toISOString() }) },
    nativeSessions: { assertRetryCustody: async () => {} }, prepareSandbox: async () => {},
    runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {},
  })
  Object.assign(sandbox, { startProcess: vi.fn(async () => { starts.push('start'); return {} }),
    mkdir: async () => {}, getProcess: async () => null, deleteFile: vi.fn(),
    exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '' })),
  })
  sandbox.files.set('/workspace/results/retained-proof.md', 'keep this work')
  // Keep the process live; the first observation must never turn into a fresh launch.
  const original = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, { ...request, attempt: 2, nativeTransport: evidence,
      continuationMode: 'resume', sessionId })).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(sandbox.files.get('/workspace/results/retained-proof.md')).toBe('keep this work')
    expect((sandbox as any).deleteFile).not.toHaveBeenCalled()
    expect(sandbox.writeFile.mock.calls.find(([p]) => p === '/opt/dsh-home/cordis.patch.yml')?.[1]).toContain(`sessionId: "${sessionId}"`)
    expect(sandbox.writeFile.mock.calls.some(([p]) => p.endsWith('/.swarm/submission.json'))).toBe(false)
    expect(starts).toEqual(['start'])
  } finally { original.mockRestore() }
})

it.each(['additive', 'core'] as const)('launches %s output correction in its original native session', async providerClass => {
  const sandbox = await lane(), starts: string[] = []
  const selected = providerClass === 'additive' ? task : audit0Definition.stages[1]!.waves[0]!.tasks
    .find(candidate => candidate.providerClass === 'core')!
  const repairFiles = { [selected.output.requiredFiles[0]!]: '{"invalid":"retained"}' }
  const correction = { ...request, task: selected, attempt: 2, continuationMode: 'resume' as const,
    sessionId, formatRepairOrdinal: 1, formatRepairSourceDigest: await sha256(canonicalJson(repairFiles)),
    repairFiles } as AgentRequest
  const provider = fixtureProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const assertFormatRepairCustody = vi.fn(async () => {})
  Object.assign(provider, { executionReceipts: { get: async () => null, getStart: async () => null,
    claimStart: async () => ({ acquired: true, claimedAt: new Date().toISOString() }) },
    nativeSessions: { assertFormatRepairCustody }, prepareSandbox: async () => {},
    runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {},
  })
  Object.assign(sandbox, { startProcess: vi.fn(async () => { starts.push('start'); return {} }),
    mkdir: async () => {}, getProcess: async () => null, deleteFile: vi.fn(),
    exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '' })),
  })
  const observer = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, correction))
      .rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(starts).toEqual(['start'])
    expect(sandbox.files.get(`/workspace/results/${selected.output.requiredFiles[0]!}`)).toBe(repairFiles[selected.output.requiredFiles[0]!])
    expect((sandbox as any).deleteFile).not.toHaveBeenCalled()
    if (providerClass === 'additive') {
      expect(assertFormatRepairCustody).toHaveBeenCalledTimes(1)
      expect(sandbox.files.get('/opt/dsh-home/cordis.patch.yml')).toContain(`sessionId: "${sessionId}"`)
    } else {
      expect(assertFormatRepairCustody).not.toHaveBeenCalled()
      expect(sandbox.files.has('/opt/dsh-home/cordis.patch.yml')).toBe(false)
    }
  } finally { observer.mockRestore() }
})

it('seeds the provider transport preload before the fenced launch becomes ready, without rewriting an active owner', async () => {
  const sandbox = await lane(), provider = fixtureProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  let process: any = null
  Object.assign(provider, { executionReceipts: { get: async () => null, getStart: async () => null,
    claimStart: async () => ({ acquired: true, claimedAt: new Date().toISOString() }) },
    prepareSandbox: async () => {}, runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {},
    captureAgentLogs: async () => {},
  })
  Object.assign(sandbox, { mkdir: async () => {}, getProcess: async () => process,
    startProcess: vi.fn(async () => { process = {}; return process }),
    exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '' })),
    exists: async (path: string) => ({ success: true, exists: sandbox.files.has(path) }),
    deleteFile: async (path: string) => { sandbox.files.delete(path); return { success: true } },
  })
  const observer = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    const env = (sandbox.startProcess as any).mock.calls[0][1].env
    expect(env.NODE_OPTIONS).toContain(`--require=${nativeDshHttp2PreloadPath}`)
    expect(env.ACK3_DSH_DIAGNOSTIC_ORIGIN).toBe('https://llm-a.example.com')
    expect(env.ACK3_DSH_DIAGNOSTIC_PATH).toBe('/v1/chat/completions')
    expect(sandbox.files.get(nativeDshHttp2PreloadPath)).toBe(nativeDshHttp2PreloadSource)
    const paths = sandbox.writeFile.mock.calls.map(([path]) => path)
    const readyAt = paths.findIndex(path => path.startsWith('/workspace/private/agent-ready-'))
    expect(readyAt).toBeGreaterThan(-1)
    expect(paths.indexOf(nativeDshHttp2PreloadPath)).toBeLessThan(readyAt)
    sandbox.writeFile.mockClear()
    await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(sandbox.writeFile).not.toHaveBeenCalled()
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  } finally { observer.mockRestore() }
})

it('uses the same native DSH transport for another provider with only connection identity changed', async () => {
  const sandbox = await lane(), provider = fixtureProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const other = { ...request, task: { ...task, provider: 'provider-b', connection: {
    baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY',
  } } } as AgentRequest
  Object.assign(provider, { executionReceipts: { get: async () => null, getStart: async () => null,
    claimStart: async () => ({ acquired: true, claimedAt: new Date().toISOString() }) },
    prepareSandbox: async () => {}, runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {},
    captureAgentLogs: async () => {},
  })
  Object.assign(sandbox, { mkdir: async () => {}, getProcess: async () => null,
    startProcess: vi.fn(async () => ({})), exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '' })),
    exists: async (path: string) => ({ success: true, exists: sandbox.files.has(path) }),
    deleteFile: async (path: string) => { sandbox.files.delete(path); return { success: true } },
  })
  const observer = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, other)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    const env = (sandbox.startProcess as any).mock.calls[0][1].env
    expect(env.NODE_OPTIONS).toContain(`--require=${nativeDshHttp2PreloadPath}`)
    expect(env.ACK3_DSH_DIAGNOSTIC_ORIGIN).toBe('https://llm-b.example.com')
    expect(env.ACK3_DSH_DIAGNOSTIC_PATH).toBe('/v1/chat/completions')
    expect(sandbox.files.get(nativeDshHttp2PreloadPath)).toBe(nativeDshHttp2PreloadSource)
  } finally { observer.mockRestore() }
})

it('retries a transient custody precondition before claiming, then launches the same attempt exactly once', async () => {
  const bucket = new Bucket(), sandbox = await lane()
  const provider = fixtureProvider({ ARTIFACTS: bucket, ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const resumed = { ...request, attempt: 2, nativeTransport: {
    code: 'TRANSPORT', sourceRunId: request.runId, requestDigest: 'c'.repeat(64),
    snapshotDigest: 'd'.repeat(64), sessionId, workState: 'present',
  }, continuationMode: 'resume', sessionId } as AgentRequest
  const custody = vi.fn().mockRejectedValueOnce(new TransientRunFailure('synthetic custody read outage')).mockResolvedValue(undefined)
  let process: any = null
  Object.assign(provider, { nativeSessions: { assertRetryCustody: custody }, prepareSandbox: async () => {},
    runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {},
  })
  Object.assign(sandbox, { mkdir: async () => {}, getProcess: async () => process,
    startProcess: vi.fn(async () => { process = {}; return process }),
    exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '' })),
  })
  const observer = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, resumed)).rejects.toMatchObject({ category: 'transport', retryable: true })
    expect(bucket.objects.size).toBe(0)
    expect(sandbox.startProcess).not.toHaveBeenCalled()
    await expect((provider as any).runInSandbox(sandbox, resumed)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(custody).toHaveBeenCalledTimes(2)
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
    expect([...bucket.objects.keys()].filter(k => k.includes('/execution-admissions/'))).toHaveLength(1)
    await expect((provider as any).runInSandbox(sandbox, resumed)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(custody).toHaveBeenCalledTimes(2)
    expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  } finally { observer.mockRestore() }
})

it.each([false, true])('observes a claimed owner without revalidating its evolving journal (raced=%s)', async raced => {
  const sandbox = await lane(), provider = fixtureProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const resumed = { ...request, attempt: 2, nativeTransport: {
    code: 'TRANSPORT', sourceRunId: request.runId, requestDigest: 'c'.repeat(64),
    snapshotDigest: 'd'.repeat(64), sessionId, workState: 'present',
  }, continuationMode: 'resume', sessionId } as AgentRequest
  let claimed = !raced, observations = 0
  const custody = vi.fn(async () => { claimed = true; throw new TransientRunFailure('synthetic concurrent journal change') })
  const claimStart = vi.fn()
  Object.assign(provider, { executionReceipts: { get: async () => null,
    getStart: async () => claimed ? { acquired: false, claimedAt: new Date().toISOString() } : null, claimStart },
    nativeSessions: { assertRetryCustody: custody }, runtimeEnvironment: async () => ({}),
  })
  Object.assign(sandbox, { mkdir: async () => {}, getProcess: async () => ++observations === 1 ? null : {} })
  const observer = vi.spyOn(await import('../src/agent-process.js'), 'waitForAgentProcess').mockResolvedValue('running')
  try {
    await expect((provider as any).runInSandbox(sandbox, resumed)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    expect(custody).toHaveBeenCalledTimes(raced ? 1 : 0)
    expect(claimStart).not.toHaveBeenCalled()
    expect(sandbox.startProcess).not.toHaveBeenCalled()
  } finally { observer.mockRestore() }
})

it('inspects actual plain/compressed native records and distinguishes complete-empty from unknown', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-session-inspection-')))
  const root = join(dir, '--workspace-source--', sessionId)
  mkdirSync(root, { recursive: true })
  const script = join(dir, 'inspect.py')
  writeFileSync(script, nativeSessionInspectionScript.replace("root='/opt/dsh-home/sessions/'+project+'/'+session", `root=${JSON.stringify(dir)}+'/'+project+'/'+session`))
  const header = { type: 'session', id: sessionId, cwd: '/workspace/source' }
  const start = { type: 'turn/start', seq: 1, data: { turn: 1 } }, end = { type: 'turn/end', seq: 3, data: { turn: 1 } }
  const read = () => JSON.parse(execFileSync('python3', [script, sessionId, '/workspace/source'], { encoding: 'utf8' }))
  const save = (rows: any[]) => writeFileSync(join(root, 'session.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  try {
    save([header, start]); expect(read().workState).toBe('unknown')
    save([header, start, end]); expect(read().workState).toBe('none')
    save([header, start, { type: 'tool/result', data: { result: 'synthetic retained proof' } }, end]); expect(read().workState).toBe('present')
    const raw = execFileSync('zstd', ['-q', '--stdout', join(root, 'session.jsonl')])
    writeFileSync(join(root, 'session.v3.jsonl.zstd'), raw)
    expect(read()).toMatchObject({ status: 'available', workState: 'present', fileName: 'session.v3.jsonl.zstd' })
    rmSync(join(root, 'session.v3.jsonl.zstd'))
    save([{ ...header, id: 'wrong-session' }, start, end]); expect(read().status).toBe('unavailable')
    rmSync(join(root, 'session.jsonl')); symlinkSync(script, join(root, 'session.jsonl'))
    expect(read().status).toBe('unavailable')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
