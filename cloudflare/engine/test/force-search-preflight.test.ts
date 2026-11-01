import { expect, it, vi } from 'vitest'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { PermanentRunFailure } from '../src/run-errors.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const request = { releaseDigest: 'synthetic-release', runId: 'synthetic-run' } as any
const definition = (searchConnection?: unknown) => ({
  forceSearch: { enabled: true, promptSet: 'native-exa-v1' },
  nativeSearch: { enabled: true, ...(searchConnection === undefined ? {} : { searchConnection }) },
  stages: [{ waves: [{ tasks: [{ providerClass: 'additive', backend: 'dsh-chat-completions',
    connection: { apiKeyEnv: 'MODEL_API_KEY' } }] }] }],
})

it('fails preflight before target setup when the native DSH search connection is absent', async () => {
  const provider = new SandboxAgentProvider({ MODEL_API_KEY: 'test' } as any) as any
  provider.runs = { getRelease: async () => ({ body: { definition: definition() } }) }
  const exec = vi.fn()
  await expect(provider.preflight({ exec }, request)).rejects.toMatchObject({
    category: 'invalid-configuration',
  } satisfies Partial<PermanentRunFailure>)
  expect(exec).not.toHaveBeenCalled()
})

it('fails preflight before target setup when the sealed native DSH search credential is absent', async () => {
  const provider = new SandboxAgentProvider({ MODEL_API_KEY: 'test' } as any) as any
  provider.runs = { getRelease: async () => ({ body: { definition: definition({
    provider: 'exa', apiKeyEnv: 'EXA_API_KEY',
  }) } }) }
  const exec = vi.fn()
  await expect(provider.preflight({ exec }, request)).rejects.toMatchObject({ category: 'missing-credentials' })
  expect(exec).not.toHaveBeenCalled()
})

it('checks ordinary DSH search independently of the dismissal gate', async () => {
  const provider = new SandboxAgentProvider({ MODEL_API_KEY: 'test' } as any) as any
  const exec = vi.fn()
  provider.runs = { getRelease: async () => ({ body: { definition: {
    forceSearch: undefined, nativeSearch: { enabled: true },
    stages: [{ waves: [{ tasks: [{ providerClass: 'additive', backend: 'dsh-chat-completions',
      connection: { apiKeyEnv: 'MODEL_API_KEY' } }] }] }],
  } } }) }
  await expect(provider.preflight({ exec }, request)).rejects.toMatchObject({ category: 'invalid-configuration' })
  expect(exec).not.toHaveBeenCalled()
  provider.runs = { getRelease: async () => ({ body: { definition: {
    forceSearch: undefined,
    nativeSearch: { enabled: true, searchConnection: {
      provider: 'exa', apiKeyEnv: 'EXA_API_KEY',
    } },
    stages: [{ waves: [{ tasks: [{ providerClass: 'additive', backend: 'dsh-chat-completions',
      connection: { apiKeyEnv: 'MODEL_API_KEY' } }] }] }],
  } } }) }
  await expect(provider.preflight({ exec }, request)).rejects.toMatchObject({ category: 'missing-credentials' })
  expect(exec).not.toHaveBeenCalled()
})

it('checks native Exa credentials before accepting preflight', async () => {
  const provider = new SandboxAgentProvider({ MODEL_API_KEY: 'test', EXA_API_KEY: 'exa-test' } as any) as any
  provider.runs = { getRelease: async () => ({ body: { definition: {
    forceSearch: { enabled: true, promptSet: 'native-exa-v1' },
    nativeSearch: { enabled: true, searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' } },
    pools: [{ id: 'deepseek', backend: 'dsh-chat-completions' },
      { id: 'luna', backend: 'codex' }],
    stages: [{ waves: [{ tasks: [{ providerClass: 'additive', backend: 'dsh-chat-completions',
      connection: { apiKeyEnv: 'MODEL_API_KEY' }, modelPool: 'deepseek' }] }] }],
    target: { commit: 'commit', tree: 'tree', runtime: {
      environmentBindings: {}, preflightCommands: [],
    } },
  } } }) }
  provider.runtimeEnvironment = async () => ({})
  const exec = vi.fn(async () => ({ success: true, stdout: '{}', stderr: '' }))
  const result = await provider.preflight({ exec }, request)
  expect(result.status).toBe('accepted')
  expect(exec).toHaveBeenCalledOnce()
})
