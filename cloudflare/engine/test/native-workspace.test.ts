import { assertCurrentTaskOwner } from '../src/command-custody.js'
import { birthMutationOwner, mutationSandboxName } from '../src/workspace-mutation-owner.js'
import { expect, it, vi } from 'vitest'
import { getAgentSandbox } from '../src/agent-sandbox-client.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { nativeWorkspaceKey, nativeSandboxName } from '../src/native-workspace.js'
import { sha256 } from '../src/canonical.js'
import { compileExperimentConfig } from './support/compile-config.js'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { AgentRequest } from '../src/contracts.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

it('selects a new native HOME for a replacement account and preserves the old rotated credential', async () => {
  const definition = compileExperimentConfig(manifest).definition
  const stage = definition.stages.find(stage => stage.kind === 'discovery')!, wave = stage.waves[0]!
  const task = wave.tasks.find(task => task.backend === 'codex')!
  const oldAuth = JSON.stringify({ tokens: { account_id: '11111111-1111-1111-1111-111111111111' } })
  const newAuth = JSON.stringify({ tokens: { account_id: '22222222-2222-2222-2222-222222222222' } })
  const homes = new Map<string, { auth?: string; staged?: string; installs: number }>()
  vi.mocked(getAgentSandbox).mockImplementation((_namespace, id) => {
    let home = homes.get(id)
    if (home === undefined) { home = { installs: 0 }; homes.set(id, home) }
    const selected = home
    return { setKeepAlive: async () => {}, mkdir: async () => {},
      exists: async (path: string) => ({ exists: path.includes('/source-tree-')
        || path === '/codex-home/auth.json' && selected.auth !== undefined }),
      writeFile: async (path: string, value: string) => {
        if (path === '/workspace/private/codex-auth.json') selected.staged = value
      },
      exec: async (command: string) => {
        if (command === '/usr/local/bin/ack3-install-codex-auth') {
          if (selected.staged === undefined) throw new Error('installer missing staged auth')
          selected.auth = selected.staged; selected.installs++
        }
        return { success: true }
      },
    } as any
  })
  const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: oldAuth, ACK3_CODEX_WORKSPACE_ID: 'workspace',
    CODEX_REPLACEMENT_AUTH_JSON: newAuth } as any)
  Object.assign(provider, {
    runs: { getRelease: async () => ({ body: { definition } }) },
  })
  // Exercise credential installation in the selected native HOME. Admission,
  // dispatch and owner setup are covered by the provider/control integration tests.
  const prepare = async (request: AgentRequest) => {
    const sandbox = getAgentSandbox({} as any, await nativeSandboxName(request))
    await (provider as any).prepareSandbox(sandbox, request)
  }
  const request = { experimentId: definition.id, runId: 'workspace-account-test', stage, wave, task,
    taskExecutionId: 'synthetic-task-execution', prompt: 'synthetic prompt', promptDigest: 'a'.repeat(64),
    visibleArtifacts: [], releaseDigest: 'b'.repeat(64), attempt: 1, diagnostics: [], repairFiles: {},
    freshContext: true, continuationMode: 'new', sessionId: null,
    executionAuthority: { auditId: 'workspace-account-test', executionId: 'workspace-account-test', epoch: 0,
      runtimeDigest: await sha256(null) },
  } as AgentRequest
  await prepare(request)
  const oldKey = await nativeWorkspaceKey(task), oldHome = [...homes.values()][0]!
  expect(oldHome.auth).toBe(oldAuth); expect(oldHome.installs).toBe(1)
  oldHome.auth = 'synthetic-rotated-native-auth'
  await prepare({ ...request, task: { ...task, id: `${task.id}-next-wave`, reasoning: 'high' } })
  expect(homes.size).toBe(1); expect(oldHome.auth).toBe('synthetic-rotated-native-auth'); expect(oldHome.installs).toBe(1)
  const replacement = { ...task, credentialSource: 'CODEX_REPLACEMENT_AUTH_JSON' }
  await prepare({ ...request, task: replacement })
  expect(await nativeWorkspaceKey(replacement)).not.toBe(oldKey)
  expect(homes.size).toBe(2)
  expect([...homes.values()][1]).toMatchObject({ auth: newAuth, installs: 1 })
  expect(oldHome.auth).toBe('synthetic-rotated-native-auth')
  await prepare(request)
  expect(homes.size).toBe(2); expect(oldHome.installs).toBe(1)
})

it('isolates changed DSH routes and credentials while retaining unchanged routes across manifest edits', async () => {
  const definition = compileExperimentConfig(manifest).definition
  const task = definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks.find(task => task.connection !== undefined)!
  const key = await nativeWorkspaceKey(task)
  expect(await nativeWorkspaceKey({ ...task, reasoning: 'high', retryPolicy: 'none', objective: 'new instructions' })).toBe(key)
  for (const changed of [{ ...task, model: 'replacement-model' },
    { ...task, connection: { ...task.connection!, apiKeyEnv: 'REPLACEMENT_API_KEY' } },
    { ...task, connection: { ...task.connection!, baseUrl: 'https://replacement.example/v1' } }]) {
    expect(await nativeWorkspaceKey(changed)).not.toBe(key)
  }
})


it('accepts original workspace ownership without storage and rejects historical live handoffs', async () => {
  const owner = await birthMutationOwner({ auditId: 'owner-test', executionId: 'owner-test', epoch: 0,
    runtimeDigest: 'a'.repeat(64) }, 'research')
  const request = (mutationOwner?: typeof owner) => ({ execution: { mutationOwner } }) as AgentRequest
  expect(() => assertCurrentTaskOwner(request())).not.toThrow()
  expect(() => assertCurrentTaskOwner(request(owner))).not.toThrow()
  for (const changed of [{ ...owner, ordinal: 1 }, { ...owner, allocation: { ordinal: 1, originDigest: 'b'.repeat(64) } }]) {
    expect(() => assertCurrentTaskOwner(request(changed))).toThrow('historical app version')
    await expect(mutationSandboxName(changed)).rejects.toThrow('owner is invalid')
  }
})
