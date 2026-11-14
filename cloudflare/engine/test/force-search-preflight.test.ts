import { expect, it, vi } from 'vitest'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

it('runs deterministic source preflight after bootstrap readiness without rereading model secrets', async () => {
  const secret = { get: vi.fn(() => { throw new Error('readiness must be owned by bootstrap') }) }
  const provider = new SandboxAgentProvider({ MODEL_API_KEY: secret, EXA_API_KEY: secret } as any) as any
  provider.runs = { getRelease: async () => ({ body: { definition: {
    nativeSearch: { enabled: true, searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' } },
    stages: [{ waves: [{ tasks: [{ providerClass: 'additive', backend: 'dsh-chat-completions',
      connection: { apiKeyEnv: 'MODEL_API_KEY' } }] }] }],
    target: { commit: 'commit', tree: 'tree', runtime: { environmentBindings: {}, preflightCommands: [] } },
  } } }) }
  provider.runtimeEnvironment = async () => ({})
  const exec = vi.fn(async () => ({ success: true, stdout: '{}', stderr: '' }))
  const result = await provider.preflight({ exec }, { releaseDigest: 'synthetic-release', runId: 'synthetic-run' })
  expect(result.status).toBe('accepted')
  expect(result.files).toEqual({ 'preflight.json': '{}' })
  expect(exec).toHaveBeenCalledOnce()
  expect(exec.mock.calls[0]).toMatchObject(['/usr/local/bin/ack3-preflight', { env: {
    ACK3_EXPECTED_COMMIT: 'commit', ACK3_EXPECTED_TREE: 'tree',
  } }])
  expect(secret.get).not.toHaveBeenCalled()
})
