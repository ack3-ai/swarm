import { admittedProviderRequest } from './support/admitted-provider-request.js'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const closeDatabases: (() => void)[] = []
afterEach(() => closeDatabases.splice(0).forEach(close => close()))

const script = new URL('../container/prepare-workspace.mjs', import.meta.url)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

function fixture(commands: string[]) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'ack3-workspace-prep-')))
  roots.push(root)
  for (const name of ['source', 'private', 'control', 'home', 'results']) mkdirSync(resolve(root, name))
  writeFileSync(resolve(root, 'source', 'package.json'), '{"private":true}\n')
  writeFileSync(resolve(root, 'source', 'package-lock.json'), '{"lockfileVersion":3}\n')
  const commit = 'a'.repeat(40)
  const tree = 'b'.repeat(40)
  writeFileSync(resolve(root, 'private', `source-tree-${tree}`), tree)
  const profile = {
    schemaVersion: 1,
    workingDirectory: '.',
    commands,
    integrityFiles: [
      { path: 'package.json', sha256: digest(readFileSync(resolve(root, 'source', 'package.json'), 'utf8')) },
      { path: 'package-lock.json', sha256: digest(readFileSync(resolve(root, 'source', 'package-lock.json'), 'utf8')) },
    ],
  }
  return { root, commit, tree, profile }
}

async function run(input: ReturnType<typeof fixture>, extraEnvironment: Record<string, string> = {}) {
  const profileDigest = await sha256(canonicalJson(input.profile))
  const result = spawnSync(process.execPath, [script.pathname], {
    encoding: 'utf8', timeout: 30_000,
    env: {
      ...process.env,
      ACK3_WORKSPACE_ROOT: input.root,
      ACK3_CONTROL_DIR: resolve(input.root, 'control'),
      ACK3_EXPECTED_COMMIT: input.commit,
      ACK3_EXPECTED_TREE: input.tree,
      ACK3_WORKSPACE_PREPARATION_JSON: canonicalJson(input.profile),
      ACK3_WORKSPACE_PREPARATION_DIGEST: profileDigest,
      ACK3_REQUEST_DIGEST: 'c'.repeat(64),
      ...extraEnvironment,
    },
  })
  return result
}

it('prepares once without passing provider credentials and preserves continuation edits', async () => {
  const input = fixture(['test -z "${PROVIDER_A_API_KEY:-}" && test -z "${ACK3_CODEX_AUTH_JSON:-}" && echo first >> prepared.log'])
  const first = await run(input, { PROVIDER_A_API_KEY: 'synthetic-secret', ACK3_CODEX_AUTH_JSON: 'synthetic-auth' })
  expect(first.status).toBe(0)
  expect(readFileSync(resolve(input.root, 'source', 'prepared.log'), 'utf8')).toBe('first\n')
  writeFileSync(resolve(input.root, 'source', 'agent-work.txt'), 'saved work')
  const second = await run(input)
  expect(second.status).toBe(0)
  expect(second.stdout).toContain('reused')
  expect(readFileSync(resolve(input.root, 'source', 'prepared.log'), 'utf8')).toBe('first\n')
  expect(readFileSync(resolve(input.root, 'source', 'agent-work.txt'), 'utf8')).toBe('saved work')
  expect(existsSync(resolve(input.root, 'home', '.cache'))).toBe(true)
  expect(readFileSync(resolve(input.root, 'control', 'workspace-environment.md'), 'utf8'))
    .toContain('archive without Git history')
})

it('notes an optional baseline build in the workspace facts', async () => {
  const optional = fixture(['true'])
  expect((await run(optional, { ACK3_BUILD_REQUIRED: 'false' })).status).toBe(0)
  expect(readFileSync(resolve(optional.root, 'control', 'workspace-environment.md'), 'utf8'))
    .toContain('The baseline build is optional for this audit')
  const required = fixture(['true'])
  expect((await run(required)).status).toBe(0)
  expect(readFileSync(resolve(required.root, 'control', 'workspace-environment.md'), 'utf8'))
    .not.toContain('baseline build is optional')
})

it('never marks a failed command ready and rejects profile or source mutation', async () => {
  const failed = fixture(['false'])
  expect((await run(failed)).status).not.toBe(0)
  expect(existsSync(resolve(failed.root, 'private', 'workspace-prepared.json'))).toBe(false)

  const changed = fixture(['echo ready > prepared.log'])
  expect((await run(changed)).status).toBe(0)
  changed.profile.commands[0] = 'echo different > prepared.log'
  expect((await run(changed)).status).not.toBe(0)
  expect(readFileSync(resolve(changed.root, 'source', 'prepared.log'), 'utf8')).toBe('ready\n')
  changed.profile.commands[0] = 'echo ready > prepared.log'
  writeFileSync(resolve(changed.root, 'source', 'package-lock.json'), '{"lockfileVersion":2}\n')
  expect((await run(changed)).status).not.toBe(0)
})

it('runs again in place after a failed try whose failure file was set aside (E10)', async () => {
  // A flaky command: fails once, then succeeds, like a registry timeout.
  const flaky = fixture(['if [ -f retried.flag ]; then echo ok; else touch retried.flag; exit 1; fi'])
  const failure = resolve(flaky.root, 'private', `workspace-preparation-failure-${'c'.repeat(64)}.json`)
  expect((await run(flaky)).status).not.toBe(0)
  expect(JSON.parse(readFileSync(failure, 'utf8'))).toMatchObject({ status: 'failed', code: 'exit-1' })
  renameSync(failure, failure.replace(/\.json$/, '.try-1.json'))
  expect((await run(flaky)).status).toBe(0)
  expect(existsSync(failure)).toBe(false)
  expect(JSON.parse(readFileSync(resolve(flaky.root, 'private', 'workspace-prepared.json'), 'utf8')))
    .toMatchObject({ status: 'prepared' })
})

it('terminates background setup work after an output-limit failure', async () => {
  const input = fixture([
    `(sleep 1; printf late > late-write) & python3 -c 'print("x"*1200000)'; sleep 3`,
  ])
  const result = await run(input)
  expect(result.status).not.toBe(0)
  expect(existsSync(resolve(input.root, 'private', 'workspace-prepared.json'))).toBe(false)
  expect(existsSync(resolve(input.root, 'private', `workspace-preparation-failure-${'c'.repeat(64)}.json`)), result.stderr).toBe(true)
  expect(JSON.parse(readFileSync(resolve(input.root, 'private', `workspace-preparation-failure-${'c'.repeat(64)}.json`), 'utf8')).code)
    .toBe('output-limit')
  await new Promise(resolve => setTimeout(resolve, 1300))
  expect(existsSync(resolve(input.root, 'source', 'late-write'))).toBe(false)
})

it('keeps old sealed manifests readable and accepts only explicit preparation profiles', () => {
  expect(compileExperimentConfig(manifest).definition.target.runtime.workspacePreparation).toBeUndefined()
  const configured = structuredClone(manifest) as any
  configured.target.runtime.workspacePreparation = {
    schemaVersion: 1, workingDirectory: '.', commands: ['npm ci --ignore-scripts --no-audit --no-fund'],
    integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }],
  }
  expect(compileExperimentConfig(configured).definition.target.runtime.workspacePreparation)
    .toEqual(configured.target.runtime.workspacePreparation)
  configured.target.runtime.workspacePreparation.commands = []
  expect(() => compileExperimentConfig(configured)).toThrow('workspace preparation must have 1 to 4 commands')
})

it('runs sealed target setup before mounting Codex credentials', async () => {
  const events: string[] = []
  const definition = compileExperimentConfig(manifest).definition
  definition.target.runtime.workspacePreparation = {
    schemaVersion: 1, workingDirectory: '.', commands: ['npm ci --ignore-scripts'],
    integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }],
  }
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic-secret', ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
  } as any)
  Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
  const sandbox = {
    mkdir: async () => {},
    exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
    writeFile: async (path: string) => { events.push(`write:${path}`) },
    exec: async (command: string) => { events.push(`exec:${command}`); return { success: true } },
  }
  await (provider as any).prepareSandbox(sandbox, { releaseDigest: 'a'.repeat(64),
    task: { providerClass: 'core', promptKind: 'research' } })
  const setup = events.findIndex(event => event.includes('ack3-prepare-workspace'))
  const auth = events.findIndex(event => event.includes('/workspace/private/codex-auth.json'))
  expect(setup).toBeGreaterThanOrEqual(0)
  expect(auth).toBeGreaterThan(setup)
})

it('mounts the resolved cloud-bound Codex auth and redacts resolved cloud keys', async () => {
  const auth = 'synthetic-cloud-auth-value'
  const key = 'synthetic-cloud-exa-key'
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: { get: async () => auth }, ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
    EXA_API_KEY: { get: async () => key },
  } as any)
  const definition = compileExperimentConfig(manifest).definition
  Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
  const writes: Record<string, string> = {}
  const sandbox = {
    mkdir: async () => {}, exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
    writeFile: async (path: string, content: string) => { writes[path] = content },
    exec: async () => ({ success: true }),
  }
  await (provider as any).prepareSandbox(sandbox, { releaseDigest: 'a'.repeat(64),
    task: { providerClass: 'core', promptKind: 'research' } })
  expect(writes['/workspace/private/codex-auth.json']).toBe(auth)
  await (provider as any).credential('EXA_API_KEY')
  expect((provider as any).redactKnownCredentials(`auth=${auth} key=${key}`))
    .toBe('auth=<redacted:ACK3_CODEX_AUTH_JSON> key=<redacted:EXA_API_KEY>')
})

it('preserves rotated native Codex auth on a same-session repair', async () => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'ack3-codex-auth-')))
  roots.push(root)
  const authFile = resolve(root, 'auth.json')
  const rotated = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"rotated-synthetic-token"}}'
  writeFileSync(authFile, rotated)
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: { get: async () => 'synthetic-bootstrap' },
    ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
  } as any)
  const definition = compileExperimentConfig(manifest).definition
  Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
  const writes: string[] = []
  const commands: string[] = []
  const sandbox = {
    mkdir: async () => {},
    exists: async (path: string) => ({ success: true,
      exists: path.includes('/source-tree-') || path === '/codex-home/auth.json' }),
    writeFile: async (path: string) => { writes.push(path) },
    exec: async (command: string) => { commands.push(command)
      if (command.includes('JSON.parse')) {
        const result = spawnSync('/bin/sh', ['-c', command.replaceAll('/codex-home/auth.json', authFile)],
          { encoding: 'utf8' })
        return { success: result.status === 0 }
      }
      return { success: true } },
  }
  await (provider as any).prepareSandbox(sandbox, { releaseDigest: 'a'.repeat(64),
    continuationMode: 'resume', task: { providerClass: 'core', promptKind: 'research' } })
  expect(writes).not.toContain('/workspace/private/codex-auth.json')
  expect(commands.some(command => command.includes('ack3-install-codex-auth'))).toBe(false)
  expect(commands.some(command => command.includes('JSON.parse') && command.includes('/codex-home/auth.json'))).toBe(true)
  expect(commands.some(command => command.includes('chown -R 10001:10001'))).toBe(true)
  expect(readFileSync(authFile, 'utf8')).toBe(rotated)

  await (provider as any).prepareSandbox(sandbox, { releaseDigest: 'a'.repeat(64),
    continuationMode: 'new', task: { providerClass: 'core', promptKind: 'research' } })
  expect(writes).not.toContain('/workspace/private/codex-auth.json')
  expect(readFileSync(authFile, 'utf8')).toBe(rotated)
})

it('fails closed when native Codex auth is missing or malformed on resume', async () => {
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: { get: async () => 'synthetic-bootstrap' },
    ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
  } as any)
  const definition = compileExperimentConfig(manifest).definition
  Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
  for (const mode of ['missing', 'malformed']) {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'ack3-codex-auth-bad-')))
    roots.push(root)
    const authFile = resolve(root, 'auth.json')
    if (mode === 'malformed') writeFileSync(authFile, '{invalid-json')
    const writes: string[] = []
    const commands: string[] = []
    const sandbox = {
      mkdir: async () => {},
      exists: async (path: string) => ({ success: true,
        exists: path.includes('/source-tree-') || (mode === 'malformed' && path === '/codex-home/auth.json') }),
      writeFile: async (path: string) => { writes.push(path) },
      exec: async (command: string) => { commands.push(command)
        if (command.includes('JSON.parse')) {
          const result = spawnSync('/bin/sh', ['-c', command.replaceAll('/codex-home/auth.json', authFile)],
            { encoding: 'utf8' })
          return { success: result.status === 0 }
        }
        return { success: true } },
    }
    await expect((provider as any).prepareSandbox(sandbox, { releaseDigest: 'a'.repeat(64),
      continuationMode: 'resume', task: { providerClass: 'core', promptKind: 'research' } })).rejects.toThrow(/native Codex auth/)
    expect(writes).not.toContain('/workspace/private/codex-auth.json')
    expect(commands.some(command => command.includes('ack3-install-codex-auth'))).toBe(false)
    if (mode === 'malformed') expect(readFileSync(authFile, 'utf8')).toBe('{invalid-json')
  }
})

it('resolves core native-search keys before observing an admitted process', async () => {
  const key = 'synthetic-native-exa-secret'
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: { get: async () => 'synthetic-codex-auth' },
    ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
    EXA_API_KEY: { get: async () => key },
  } as any)
  await (provider as any).assertProviderCredentials({
    task: { id: 'core-research', providerClass: 'core' },
    nativeSearchConnection: { apiKeyEnv: 'EXA_API_KEY' },
  })
  expect((provider as any).redactKnownCredentials(`search failed: ${key}`))
    .toBe('search failed: <redacted:EXA_API_KEY>')
})

it('persists a failed setup receipt before reporting a terminal preflight failure', async () => {
  const definition = compileExperimentConfig(manifest).definition
  const profile = {
    schemaVersion: 1 as const, workingDirectory: '.', commands: ['npm ci --ignore-scripts'],
    integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }],
  }
  definition.target.runtime.workspacePreparation = profile
  const profileDigest = await sha256(canonicalJson(profile))
  const putWorkspacePreparationFailure = vi.fn(async (_input: {
    runId: string; taskId: string; requestDigest: string; content: string
  }) => {})
  const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic-secret' } as any)
  Object.assign(provider, {
    runs: { getRelease: async () => ({ body: { definition } }) },
    executionLogs: { putWorkspacePreparationFailure },
    // A failed command is retried in place twice first (E10); no real waits here.
    preparationSleep: async () => {},
  })
  const receipt = { schemaVersion: 1, status: 'failed', commit: definition.target.commit,
    tree: definition.target.tree, profileDigest, requestDigest: 'b'.repeat(64),
    results: [{ command: 'npm ci', exitCode: 1 }],
    code: 'exit-1', stdout: '', stderr: 'dependency error' }
  const sandbox = {
    mkdir: async () => {},
    exists: async (path: string) => ({ success: true,
      exists: path.includes('/source-tree-') || path.includes('/workspace-preparation-failure-') }),
    writeFile: async () => {},
    readFile: async () => ({ content: JSON.stringify(receipt) }),
    exec: async (command: string) => ({ success: !command.includes('ack3-prepare-workspace'),
      stderr: command.includes('ack3-prepare-workspace') ? 'workspace preparation: command 1 failed' : '' }),
  }
  const request = { runId: 'synthetic-run', releaseDigest: 'a'.repeat(64),
    task: { id: 'research-1', providerClass: 'core', promptKind: 'research' } }
  await expect((provider as any).prepareSandbox(sandbox, request, 'b'.repeat(64)))
    .rejects.toMatchObject({ category: 'preflight-failed' })
  expect(putWorkspacePreparationFailure).toHaveBeenCalledOnce()
  expect(putWorkspacePreparationFailure.mock.calls[0]?.[0]).toMatchObject({
    runId: 'synthetic-run', taskId: 'research-1', requestDigest: 'b'.repeat(64),
  })
  expect(putWorkspacePreparationFailure.mock.calls[0]?.[0].content).toContain('dependency error')
  putWorkspacePreparationFailure.mockRejectedValueOnce(new Error('R2 unavailable'))
  await expect((provider as any).prepareSandbox(sandbox, request, 'b'.repeat(64)))
    .rejects.toMatchObject({ name: 'TransientRunFailure' })
})

it('reattaches to a failed pre-process claim and saves diagnostics after an R2 outage', async () => {
  const definition = compileExperimentConfig(manifest).definition
  const profile = { schemaVersion: 1 as const, workingDirectory: '.', commands: ['false'],
    integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }] }
  definition.target.runtime.workspacePreparation = profile
  const profileDigest = await sha256(canonicalJson(profile))
  let requestDigest = ''
  let claims = 0
  let preparations = 0
  const putWorkspacePreparationFailure = vi.fn()
    .mockRejectedValueOnce(new Error('synthetic R2 outage'))
    .mockResolvedValueOnce(undefined)
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: 'synthetic-auth', ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace',
  } as any)
  Object.assign(provider, {
    runs: { getRelease: async () => ({ body: { definition } }) },
    runtimeEnvironment: async () => ({}),
    executionReceipts: {
      get: async () => null,
      claimStart: async () => ({ acquired: ++claims === 1, claimedAt: new Date().toISOString() }),
    },
    executionLogs: { putWorkspacePreparationFailure },
    preparationSleep: async () => {},
  })
  const startProcess = vi.fn(async () => { throw new Error('must not start model') })
  const sandbox = {
    mkdir: async () => {}, writeFile: async () => {}, getProcess: async () => null, startProcess,
    exists: async (path: string) => ({ success: true,
      exists: path.includes('/source-tree-') || (requestDigest !== ''
        && path.endsWith(`workspace-preparation-failure-${requestDigest}.json`)) }),
    readFile: async () => ({ content: JSON.stringify({
      schemaVersion: 1, status: 'failed', commit: definition.target.commit, tree: definition.target.tree,
      profileDigest, requestDigest, results: [{ command: 'false', exitCode: 1 }],
      code: 'exit-1', stdout: '', stderr: 'synthetic compile failure',
    }) }),
    exec: async (command: string, options?: { env?: Record<string, string> }) => {
      if (command.includes('ack3-prepare-workspace')) {
        preparations += 1
        requestDigest = options?.env?.ACK3_REQUEST_DIGEST ?? ''
        return { success: false, stderr: 'workspace preparation: command 1 failed' }
      }
      return { success: true }
    },
  }
  const request = await admittedProviderRequest(provider, close => closeDatabases.push(close), 'research', {
    configure: body => { body.definition.target.runtime.workspacePreparation = profile },
  })
  await expect((provider as any).runInSandbox(sandbox, request))
    .rejects.toMatchObject({ name: 'TransientRunFailure' })
  await expect((provider as any).runInSandbox(sandbox, request))
    .rejects.toMatchObject({ category: 'preflight-failed' })
  // Three tries in the first launch step (E10); the reattach never prepares again.
  expect(preparations).toBe(3)
  expect(putWorkspacePreparationFailure).toHaveBeenCalledTimes(2)
  expect(startProcess).not.toHaveBeenCalled()
})

describe('a failed preparation command is retried in place (E10)', () => {
  const digestB = 'b'.repeat(64)
  const failurePath = `/workspace/private/workspace-preparation-failure-${digestB}.json`
  async function retrySetup(outcomes: boolean[]) {
    const definition = compileExperimentConfig(manifest).definition
    const profile = { schemaVersion: 1 as const, workingDirectory: '.', commands: ['npm ci --ignore-scripts'],
      integrityFiles: [{ path: 'package-lock.json', sha256: 'a'.repeat(64) }] }
    definition.target.runtime.workspacePreparation = profile
    const profileDigest = await sha256(canonicalJson(profile))
    const putWorkspacePreparationFailure = vi.fn(async (_input: { content: string }) => {})
    const waits: number[] = []
    const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic-secret' } as any)
    Object.assign(provider, {
      runs: { getRelease: async () => ({ body: { definition } }) },
      executionLogs: { putWorkspacePreparationFailure },
      preparationSleep: async (ms: number) => { waits.push(ms) },
    })
    const files = new Map<string, string>()
    const commands: string[] = []
    let tries = 0
    const sandbox = {
      mkdir: async () => {}, writeFile: async () => {},
      exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') || files.has(path) }),
      readFile: async (path: string) => ({ content: files.get(path)! }),
      exec: async (command: string) => {
        commands.push(command)
        if (command.includes('ack3-prepare-workspace')) {
          const success = outcomes[tries] ?? false
          tries += 1
          if (!success) files.set(failurePath, JSON.stringify({ schemaVersion: 1, status: 'failed', commit: definition.target.commit,
            tree: definition.target.tree, profileDigest, requestDigest: digestB, results: [{ index: 1, command: 'npm ci', exitCode: 1 }],
            code: 'exit-1', stdout: '', stderr: `registry timeout on try ${tries}` }))
          return { success, stderr: success ? '' : 'workspace preparation: command 1 failed (exit-1)' }
        }
        const moved = command.match(/^mv -f -- '([^']+)' '([^']+)'$/)
        if (moved !== null) { files.set(moved[2]!, files.get(moved[1]!)!); files.delete(moved[1]!) }
        return { success: true, stdout: '', stderr: '' }
      },
    }
    const request = { runId: 'synthetic-run', releaseDigest: 'a'.repeat(64), attempt: 1,
      task: { id: 'research-1', providerClass: 'core', promptKind: 'research' } }
    return { provider, sandbox, request, files, commands, waits, putWorkspacePreparationFailure, tries: () => tries }
  }

  it('tries twice more after 30 and 60 seconds, keeping each failure file, and then goes on', async () => {
    const setup = await retrySetup([false, false, true])
    const lines: string[] = []
    const logs = vi.spyOn(console, 'log').mockImplementation(line => { lines.push(String(line)) })
    try {
      await (setup.provider as any).prepareSandbox(setup.sandbox, setup.request, digestB)
    } finally { logs.mockRestore() }
    expect(setup.tries()).toBe(3)
    expect(setup.waits).toEqual([30_000, 60_000])
    expect([...setup.files.keys()].toSorted()).toEqual([1, 2].map(n =>
      `/workspace/private/workspace-preparation-failure-${digestB}.try-${n}.json`))
    expect(setup.files.get(`/workspace/private/workspace-preparation-failure-${digestB}.try-2.json`)).toContain('try 2')
    expect(setup.putWorkspacePreparationFailure).not.toHaveBeenCalled()
    const retries = lines.map(line => JSON.parse(line)).filter(line => line.event === 'workspace-preparation-retry')
    expect(retries).toEqual([1, 2].map(n => expect.objectContaining({ runId: 'synthetic-run', taskId: 'research-1',
      requestDigest: digestB, try: n, code: 'exit-1', command: 1 })))
    // The log line carries no command output.
    expect(JSON.stringify(retries)).not.toContain('registry timeout')
  })

  it('reports the last failure after three tries, as before', async () => {
    const setup = await retrySetup([false, false, false])
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await expect((setup.provider as any).prepareSandbox(setup.sandbox, setup.request, digestB))
        .rejects.toMatchObject({ category: 'preflight-failed' })
    } finally { logs.mockRestore() }
    expect(setup.tries()).toBe(3)
    expect(setup.putWorkspacePreparationFailure).toHaveBeenCalledOnce()
    expect(setup.putWorkspacePreparationFailure.mock.calls[0]?.[0].content).toContain('registry timeout on try 3')
    expect(setup.files.has(failurePath)).toBe(true)
    expect(setup.files.has(`/workspace/private/workspace-preparation-failure-${digestB}.try-2.json`)).toBe(true)
  })

  it('does not retry a failure without a failure file, or once the first try began over 10 minutes ago', async () => {
    const plain = await retrySetup([false])
    plain.sandbox.exec = async (command: string) => ({ success: !command.includes('ack3-prepare-workspace'),
      stdout: '', stderr: 'workspace preparation: source integrity mismatch: package-lock.json' })
    await expect((plain.provider as any).prepareSandbox(plain.sandbox, plain.request, digestB))
      .rejects.toMatchObject({ category: 'preflight-failed' })
    expect(plain.waits).toEqual([])

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00.000Z'))
      const slow = await retrySetup([false, false, false])
      const exec = slow.sandbox.exec
      slow.sandbox.exec = async (command: string) => {
        // The first try ends after 9.6 minutes: a 30-second wait would start the next one after 10.
        if (command.includes('ack3-prepare-workspace')) vi.setSystemTime(Date.now() + 9.6 * 60_000)
        return exec(command)
      }
      const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
      try {
        await expect((slow.provider as any).prepareSandbox(slow.sandbox, slow.request, digestB))
          .rejects.toMatchObject({ category: 'preflight-failed' })
      } finally { logs.mockRestore() }
      expect(slow.tries()).toBe(1)
    } finally { vi.useRealTimers() }
  })
})
