import { describe, expect, it } from 'vitest'
import { assertReleaseProviderCredentials } from '../src/release-provider-credentials.js'
import type { ExperimentDefinition } from '../src/contracts.js'

const definition = (): ExperimentDefinition => ({
  pools: [{ id: 'luna', backend: 'codex' }, { id: 'deepseek', backend: 'dsh-chat-completions' }],
  forceSearch: { enabled: true, promptSet: 'native-exa-v1' },
  nativeSearch: { enabled: true, searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' } },
  stages: [{ waves: [{ tasks: [
    { id: 'core', providerClass: 'core', backend: 'codex', modelPool: 'luna' },
    { id: 'additive-discovery', providerClass: 'additive', backend: 'dsh-chat-completions',
      modelPool: 'deepseek', connection: { apiKeyEnv: 'PROVIDER_B_API_KEY' } },
    { id: 'additive-review', providerClass: 'additive', backend: 'dsh-chat-completions',
      modelPool: 'deepseek', connection: { apiKeyEnv: 'PROVIDER_B_API_KEY' } },
  ] }] }],
} as unknown as ExperimentDefinition)
const env = { ACK3_CODEX_AUTH_JSON: 'auth', ACK3_CODEX_WORKSPACE_ID: 'workspace',
  PROVIDER_B_API_KEY: 'provider', EXA_API_KEY: 'search' }

describe('sealed release credential preflight', () => {
  it('Claude resolves only its selected subscription binding, with no Codex or API-key fallback', async () => {
    const selected = { ...definition(), stages: [{ waves: [{ tasks: [{
      id: 'claude', providerClass: 'core', backend: 'claude', credentialSource: 'CLAUDE_TEAM_OAUTH_TOKEN',
    }] }] }] } as unknown as ExperimentDefinition
    const bound = { ...env, ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '',
      CLAUDE_TEAM_OAUTH_TOKEN: { get: async () => 'sk-ant-oat-test-only' } }
    await expect(assertReleaseProviderCredentials(selected, bound)).resolves.toBeUndefined()
    await expect(assertReleaseProviderCredentials(selected, { ...bound, CLAUDE_TEAM_OAUTH_TOKEN: 'api-key' }))
      .rejects.toThrow('Claude subscription token')
  })

  it('selects a named Codex account without falling back to the default account', async () => {
    const selected = definition()
    const task = selected.stages[0]!.waves[0]!.tasks[0]!
    task.credentialSource = 'CODEX_TEAM_AUTH_JSON'
    const bound = { ...env, ACK3_CODEX_WORKSPACE_ID: '', CODEX_TEAM_AUTH_JSON: {
      get: async () => JSON.stringify({ tokens: { account_id: '11111111-1111-4111-8111-111111111111' } }),
    } }
    await expect(assertReleaseProviderCredentials(selected, bound)).resolves.toBeUndefined()
    await expect(assertReleaseProviderCredentials(selected, env)).rejects.toThrow('credentials are missing')
    await expect(assertReleaseProviderCredentials(selected, { ...bound, CODEX_TEAM_AUTH_JSON: '{bad' }))
      .rejects.toThrow('selected Codex account is invalid')
  })

  it('rejects the missing selected DeepSeek key before any model admission', async () => {
    await expect(assertReleaseProviderCredentials(definition(), { ...env, PROVIDER_B_API_KEY: '' }))
      .rejects.toThrow('additive provider credential is missing for additive-discovery')
  })
  it('checks core and search credentials independently', async () => {
    await expect(assertReleaseProviderCredentials(definition(), { ...env, ACK3_CODEX_AUTH_JSON: '' }))
      .rejects.toThrow('core provider credentials are missing')
    await expect(assertReleaseProviderCredentials(definition(), { ...env, EXA_API_KEY: '' }))
      .rejects.toThrow('native Exa credential is missing')
  })
  it('requires Exa for core-only releases too, and when research is optional', async () => {
    const onlyCore = { ...definition(), forceSearch: undefined, stages: [{ waves: [{ tasks: [
      { id: 'core', providerClass: 'core', backend: 'codex', modelPool: 'luna' },
    ] }] }] } as unknown as ExperimentDefinition
    await expect(assertReleaseProviderCredentials(onlyCore, { ...env, EXA_API_KEY: '' }))
      .rejects.toThrow('native Exa credential is missing')
    await expect(assertReleaseProviderCredentials(onlyCore, env)).resolves.toBeUndefined()
  })
  it('rejects incomplete native search configuration before paid work', async () => {
    await expect(assertReleaseProviderCredentials({ ...definition(), nativeSearch: { enabled: true } }, env))
      .rejects.toThrow('native Exa connection is not configured')
  })
  it('accepts selected bindings without disclosing their values and allows fully offline manifests', async () => {
    await expect(assertReleaseProviderCredentials(definition(), env)).resolves.toBeUndefined()
    const { forceSearch: _force, nativeSearch: _native, ...offline } = definition()
    await expect(assertReleaseProviderCredentials(offline, { ...env, EXA_API_KEY: '' })).resolves.toBeUndefined()
  })
  it('resolves official Secrets Store bindings and fails closed if a value is absent', async () => {
    const bound = {
      ...env,
      ACK3_CODEX_AUTH_JSON: { get: async () => env.ACK3_CODEX_AUTH_JSON },
      PROVIDER_B_API_KEY: { get: async () => env.PROVIDER_B_API_KEY },
      EXA_API_KEY: { get: async () => env.EXA_API_KEY },
    }
    await expect(assertReleaseProviderCredentials(definition(), bound)).resolves.toBeUndefined()
    await expect(assertReleaseProviderCredentials(definition(), {
      ...bound, EXA_API_KEY: { get: async () => '' },
    })).rejects.toThrow('native Exa credential is missing')
    await expect(assertReleaseProviderCredentials(definition(), {
      ...bound, PROVIDER_B_API_KEY: { get: async () => { throw new Error('private-secret-marker') } },
    })).rejects.toThrow('temporarily unavailable')
  })
})

it('requires optional header bindings before admission and supports Secrets Store', async () => {
  const selected = definition()
  const connection = { baseUrl: 'https://model.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY',
    headersEnv: { 'CF-Access-Client-Id': 'LOCAL_MODEL_HEADER_ID_API_KEY', 'CF-Access-Client-Secret': 'LOCAL_MODEL_HEADER_SECRET_API_KEY' } }
  for (const task of selected.stages[0]!.waves[0]!.tasks) if (task.providerClass === 'additive') task.connection = connection
  await expect(assertReleaseProviderCredentials(selected, env)).rejects.toThrow('LOCAL_MODEL_HEADER_ID_API_KEY is missing')
  const bound = { ...env, LOCAL_MODEL_HEADER_ID_API_KEY: { get: async () => 'selected-client-id' },
    LOCAL_MODEL_HEADER_SECRET_API_KEY: { get: async () => 'selected-client-secret' } }
  await expect(assertReleaseProviderCredentials(selected, bound)).resolves.toBeUndefined()
  await expect(assertReleaseProviderCredentials(selected, { ...bound, LOCAL_MODEL_HEADER_SECRET_API_KEY: '' }))
    .rejects.toThrow('LOCAL_MODEL_HEADER_SECRET_API_KEY is missing')
})
