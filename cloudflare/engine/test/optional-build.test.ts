import { describe, expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { validateExperiment } from '../src/validation.js'
import example from '../../../docs/examples/audit.json' with { type: 'json' }
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const withBuild = (buildRequired: unknown, preflightCommands: readonly string[] = example.environment.preflightCommands) =>
  ({ ...example, environment: { ...example.environment, preflightCommands, buildRequired } })

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

describe('optional baseline build', () => {
  it('seals only a relaxed build, so default releases keep their exact definition', () => {
    const plain = compileExperimentConfig(example).definition
    expect(plain.target.runtime).not.toHaveProperty('buildRequired')
    expect(canonicalJson(compileExperimentConfig(withBuild(true)).definition)).toBe(canonicalJson(plain))
    const optional = compileExperimentConfig(withBuild(false)).definition
    expect(optional.target.runtime.buildRequired).toBe(false)
    expect(compileExperimentConfig(withBuild(false, [])).definition.target.runtime.preflightCommands).toEqual([])
  })

  it('rejects invalid settings and an empty build that is still required', () => {
    expect(() => compileExperimentConfig(withBuild('no'))).toThrow('environment.buildRequired must be a boolean')
    expect(() => compileExperimentConfig(withBuild(true, []))).toThrow('non-empty array unless the build is optional')
    expect(() => compileExperimentConfig(withBuild(undefined, []))).toThrow('non-empty array unless the build is optional')
    const legacy = structuredClone(manifest) as any
    legacy.target.runtime.buildRequired = false
    expect(() => compileExperimentConfig(legacy)).toThrow('unknown keys: buildRequired')
    const definition = compileExperimentConfig(example).definition as any
    definition.target.runtime.buildRequired = true
    expect(() => validateExperiment(definition)).toThrow('may only be sealed as false')
  })

  it('tells preflight and every agent workspace that the build is optional', async () => {
    for (const buildRequired of [false, true]) {
      const definition = compileExperimentConfig(withBuild(buildRequired)).definition
      const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
      Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
      const preflight = sandbox()
      await (provider as any).preflight(preflight.client, { releaseDigest: 'a'.repeat(64), runId: 'run' })
      expect(preflight.execs[0]!.env.ACK3_TARGET_BUILD_REQUIRED).toBe(buildRequired ? undefined : 'false')

      const plain = sandbox()
      await (provider as any).prepareSandbox(plain.client, { releaseDigest: 'a'.repeat(64), task: { providerClass: 'core', promptKind: 'research' } })
      const note = plain.writes.get('/control/workspace-environment.md')!
      expect(note.includes('The baseline build is optional for this audit')).toBe(!buildRequired)

      definition.target.runtime.workspacePreparation = { schemaVersion: 1, workingDirectory: '.', commands: ['npm ci'],
        integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }] }
      const prepared = sandbox()
      await (provider as any).prepareSandbox(prepared.client, { releaseDigest: 'a'.repeat(64), task: { providerClass: 'core', promptKind: 'research' } })
      const setup = prepared.execs.find(exec => exec.command.includes('ack3-prepare-workspace'))!
      expect(setup.env.ACK3_BUILD_REQUIRED).toBe(buildRequired ? undefined : 'false')
    }
  })
})
