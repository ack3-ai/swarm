import { expect, it, vi } from 'vitest'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))
vi.mock('../src/agent-process.js', () => ({
  agentProcessId: (digest: string) => `agent-${digest.slice(0, 40)}`,
  waitForAgentProcess: async () => 0,
}))

it('persists a completed exact receipt without requesting process logs', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any) as any
  let requestDigest = ''
  const put = vi.fn(async (_runId: string, _digest: string) => {})
  const result = { status: 'accepted', actorId: 'completed' }
  Object.assign(provider, {
    executionReceipts: {
      get: async (_runId: string, digest: string) => { requestDigest = digest; return null }, put,
    },
    ensureAgentLogRequest: async () => {},
    drainAgentLogs: async () => {},
    agentResult: async () => result,
  })
  const getLogs = vi.fn(() => new Promise<never>(() => {}))
  const sandbox = {
    exists: vi.fn(async () => ({ exists: false })),
    mkdir: vi.fn(async () => {}),
    getProcess: vi.fn(async () => ({ id: 'existing-process', getLogs })),
    readFile: vi.fn(async () => ({ content: JSON.stringify({
      requestDigest, exitCode: 0, actorId: 'completed', files: {},
      inputTokens: 5, outputTokens: 2, costUsd: 0, stderr: '',
    }) })),
  }
  const request = {
    runId: 'receipt-run', experimentId: 'receipt-run', releaseDigest: 'release',
    prompt: 'synthetic', promptDigest: 'prompt', attempt: 1, freshContext: false,
    continuationMode: 'new', sessionId: null,
    task: { id: 'research-1', workspaceKey: 'lane-1', providerClass: 'core',
      promptKind: 'research', model: 'synthetic', output: { requiredFiles: [] } },
    stage: { id: 'discovery' }, wave: { id: 'wave-0' },
  }
  await expect(provider.runInSandbox(sandbox as any, request as any)).resolves.toBe(result)
  expect(put).toHaveBeenCalledOnce()
  expect(put.mock.calls[0]?.[1]).toBe(requestDigest)
  expect(getLogs).not.toHaveBeenCalled()
})
