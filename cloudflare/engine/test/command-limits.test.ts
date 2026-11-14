import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { containerCapacity, workspaceLimitNotes } from '../src/container-resource-diagnostics.js'
import { executionRequestBody } from '../src/native-request.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { validateExperiment } from '../src/validation.js'
import example from '../../../docs/examples/audit.json' with { type: 'json' }
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const withLimit = (commandTimeoutMinutes: unknown) =>
  ({ ...example, environment: { ...example.environment, commandTimeoutMinutes } })

function sandbox() {
  const writes = new Map<string, string>(), execs: { command: string, env: Record<string, string> }[] = []
  return { writes, execs, client: {
    mkdir: async () => {},
    exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
    writeFile: async (path: string, content: string) => { writes.set(path, content) },
    exec: async (command: string, options: { env?: Record<string, string> } = {}) => {
      execs.push({ command, env: options.env ?? {} })
      return { success: true, stdout: '{"valid":true}', stderr: '' }
    },
  } }
}

const request = (commandTimeoutMs?: number) => ({
  prompt: 'p', runId: 'run', attempt: 1, freshContext: false, continuationMode: 'new', sessionId: null,
  releaseDigest: 'a'.repeat(64), stage: { id: 'discovery' }, wave: { id: 'wave-0' },
  task: { id: 'task', model: 'm', providerClass: 'core', backend: 'codex', reasoning: 'low', promptKind: 'research',
    output: { requiredFiles: ['out.md'] } },
  ...(commandTimeoutMs === undefined ? {} : { commandTimeoutMs }),
}) as any

describe('command time limit', () => {
  it('seals the limit only when set, so other releases keep their exact definition', () => {
    const plain = compileExperimentConfig(example).definition
    expect(plain.target.runtime).not.toHaveProperty('commandTimeoutMinutes')
    expect(canonicalJson(compileExperimentConfig(withLimit(undefined)).definition)).toBe(canonicalJson(plain))
    expect(compileExperimentConfig(withLimit(30)).definition.target.runtime.commandTimeoutMinutes).toBe(30)
  })

  it('rejects invalid limits, the legacy runtime form and a tampered definition', () => {
    for (const value of [0, 721, 1.5, '30', null]) {
      expect(() => compileExperimentConfig(withLimit(value))).toThrow('between 1 and 720')
    }
    const legacy = structuredClone(manifest) as any
    legacy.target.runtime.commandTimeoutMinutes = 30
    expect(() => compileExperimentConfig(legacy)).toThrow('unknown keys: commandTimeoutMinutes')
    const definition = compileExperimentConfig(withLimit(30)).definition as any
    definition.target.runtime.commandTimeoutMinutes = 0
    expect(() => validateExperiment(definition)).toThrow('between 1 and 720')
  })

  it('adds the limit to the native request only when sealed', () => {
    expect(executionRequestBody(request(), 'workspace')).not.toHaveProperty('commandTimeoutMs')
    expect(executionRequestBody(request(30 * 60_000), 'workspace').commandTimeoutMs).toBe(30 * 60_000)
  })

  it('tells every agent workspace about resources, and about the limit when there is one', async () => {
    for (const limit of [undefined, 30]) {
      const definition = compileExperimentConfig(withLimit(limit)).definition
      const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
      Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
      const plain = sandbox()
      await (provider as any).prepareSandbox(plain.client, { releaseDigest: 'a'.repeat(64), task: { providerClass: 'core', promptKind: 'research' } })
      const note = plain.writes.get('/control/workspace-environment.md')!
      for (const line of workspaceLimitNotes(limit)) expect(note).toContain(line)
      expect(note.includes('Command time limit')).toBe(limit !== undefined)

      definition.target.runtime.workspacePreparation = { schemaVersion: 1, workingDirectory: '.', commands: ['npm ci'],
        integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }] }
      const prepared = sandbox()
      await (provider as any).prepareSandbox(prepared.client, { releaseDigest: 'a'.repeat(64), task: { providerClass: 'core', promptKind: 'research' } })
      const setup = prepared.execs.find(exec => exec.command.includes('ack3-prepare-workspace'))!
      expect(setup.env.ACK3_COMMAND_TIMEOUT_MINUTES).toBe(limit === undefined ? undefined : '30')
    }
  })

  it('states the real container size and keeps the prepared-workspace note in step', () => {
    expect(workspaceLimitNotes(undefined)[0]).toContain(`${containerCapacity.vcpu} CPU and ${containerCapacity.memoryMiB / 1024} GB`)
    const script = readFileSync(new URL('../container/prepare-workspace.mjs', import.meta.url), 'utf8')
    expect(script).toContain(`'${workspaceLimitNotes(undefined)[0]}'`)
    expect(script).toContain(workspaceLimitNotes(15)[1]!.replace('15', '${process.env.ACK3_COMMAND_TIMEOUT_MINUTES}'))
  })
})
