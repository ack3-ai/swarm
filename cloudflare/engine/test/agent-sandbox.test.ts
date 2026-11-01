import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSandbox, processStateScript, runProcessScript } from '../src/agent-sandbox.js'
import { getAgentSandbox } from '../src/agent-sandbox-client.js'

type Reply = { exitCode?: number, stdout?: string, stderr?: string }

const image = `registry.cloudflare.com/${'e'.repeat(32)}/swarm-sandbox@sha256:${'b'.repeat(64)}`
const encode = (text = '') => new TextEncoder().encode(text).buffer

function harness(reply: (argv: string[], stdin: string) => Reply = () => ({})) {
  const calls: { argv: string[], options: Record<string, unknown>, stdin: string }[] = []
  const container = {
    running: false,
    images: { sandbox: image } as Record<string, string>,
    start: vi.fn(() => { container.running = true }),
    setInactivityTimeout: vi.fn(async (_ms: number) => {}),
    destroy: vi.fn(async () => { container.running = false }),
    exec: vi.fn(async (argv: string[], options: Record<string, unknown> = {}) => {
      const stdin = options.stdin === undefined ? '' : await new Response(options.stdin as ReadableStream).text()
      calls.push({ argv, options, stdin })
      const result = argv.join(' ') === 'cat /proc/1/environ'
        ? { stdout: 'PATH=/opt/harness/node_modules/.bin:/usr/bin\0XDG_DATA_HOME=/workspace/home/.local/share\0' }
        : reply(argv, stdin)
      return { output: async () => ({
        exitCode: result.exitCode ?? 0, stdout: encode(result.stdout), stderr: encode(result.stderr),
      }) }
    }),
  }
  const values = new Map<string, unknown>()
  let alarm: number | null = null
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => { values.set(key, value) },
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarm = time },
    deleteAlarm: async () => { alarm = null },
  }
  const ctx = { container, storage, blockConcurrencyWhile: async (run: () => Promise<unknown>) => run() }
  const sandbox = new AgentSandbox(ctx as unknown as DurableObjectState, {} as never)
  const commands = () => calls.filter(call => call.argv.join(' ') !== 'cat /proc/1/environ')
  return { sandbox, container, calls, commands, values, alarm: () => alarm }
}

afterEach(() => vi.restoreAllMocks())

describe('agent sandbox', () => {
  it('starts its container on first use with the image, size, Internet access and bounded labels', async () => {
    const { sandbox, container, commands } = harness(() => ({ stdout: 'ok\n' }))
    const result = await sandbox.exec({ inactivityTimeoutMs: 60_000, labels: {
      purpose: 'readiness', 'name-longer-than-16': 'x', probe: `p\n${'v'.repeat(80)}`,
    } }, 'echo ok')
    expect(container.start).toHaveBeenCalledOnce()
    expect(container.start).toHaveBeenCalledWith({
      image, instance: { vcpu: 1, memoryMib: 8_192, diskMb: 6_000 }, enableInternet: true,
      entrypoint: ['sleep', 'infinity'],
      labels: { purpose: 'readiness', 'name-longer-than': 'x', probe: `p${'v'.repeat(63)}` },
    })
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(60_000)
    expect(commands()).toEqual([{ argv: ['bash', '-c', 'echo ok'], stdin: '', options: {
      cwd: '/workspace',
      env: { HOME: '/root', PATH: '/opt/harness/node_modules/.bin:/usr/bin', XDG_DATA_HOME: '/workspace/home/.local/share' },
    } }])
    expect(result).toEqual({ success: true, exitCode: 0, stdout: 'ok\n', stderr: '', command: 'echo ok' })
    await sandbox.exec({}, 'true')
    expect(container.start).toHaveBeenCalledOnce()
  })

  it('stops a command at its timeout and throws, keeping an ordinary failure as a result', async () => {
    const { sandbox, commands } = harness(() => ({ exitCode: 124 }))
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValueOnce(1_000).mockReturnValue(12_000)
    await expect(sandbox.exec({}, 'sleep 60', { timeout: 10_000, cwd: '/workspace/source', env: { A: '1' } }))
      .rejects.toThrow('command timed out after 10000 ms')
    expect(commands()[0]).toMatchObject({
      argv: ['timeout', '--kill-after=5s', '10s', 'bash', '-c', 'sleep 60'],
      options: { cwd: '/workspace/source', env: expect.objectContaining({ A: '1', HOME: '/root' }) },
    })
    now.mockReturnValue(1_000)
    await expect(sandbox.exec({}, 'exit 124', { timeout: 10_000 }))
      .resolves.toMatchObject({ success: false, exitCode: 124 })
  })

  it('writes, reads, checks and deletes files with the 0.12 result shapes', async () => {
    const { sandbox, commands } = harness(argv => {
      if (argv[0] === 'cat') return { stdout: 'content' }
      if (argv[0] === 'base64') return { stdout: 'Y29udGVudA==' }
      if (argv[0] === 'test') return { exitCode: argv[2] === '/present' ? 0 : 1 }
      return {}
    })
    await expect(sandbox.writeFile({}, '/workspace/private/a.json', '{"a":1}'))
      .resolves.toEqual({ success: true, path: '/workspace/private/a.json' })
    expect(commands()[0]).toMatchObject({
      argv: ['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >"$1"', 'sh', '/workspace/private/a.json'], stdin: '{"a":1}',
    })
    await sandbox.writeFile({}, '/workspace/private/source.tar.zst', new Blob(['bytes']).stream())
    expect(commands()[1]?.stdin).toBe('bytes')
    await expect(sandbox.readFile({}, '/r')).resolves.toEqual({ success: true, path: '/r', content: 'content' })
    await expect(sandbox.readFile({}, '/r', { encoding: 'base64' })).resolves.toMatchObject({ content: 'Y29udGVudA==' })
    expect(commands()[3]?.argv).toEqual(['base64', '-w0', '--', '/r'])
    await expect(sandbox.exists({}, '/present')).resolves.toEqual({ success: true, exists: true })
    await expect(sandbox.exists({}, '/absent')).resolves.toEqual({ success: true, exists: false })
    await sandbox.mkdir({}, '/workspace/a/b', { recursive: true })
    expect(commands().at(-1)?.argv).toEqual(['mkdir', '-p', '--', '/workspace/a/b'])
    await sandbox.deleteFile({}, '/workspace/results/stale.md')
    expect(commands().at(-1)?.argv).toEqual(['rm', '--', '/workspace/results/stale.md'])
  })

  it('throws when a file cannot be read, as callers expect', async () => {
    const { sandbox } = harness(() => ({ exitCode: 1, stderr: 'No such file or directory' }))
    await expect(sandbox.readFile({}, '/missing')).rejects.toThrow('file read failed: /missing')
  })

  it('keeps the container running with alarms until keep-alive is turned off', async () => {
    const { sandbox, container, values, alarm } = harness()
    const before = Date.now()
    await sandbox.exec({ keepAlive: true, inactivityTimeoutMs: 30 * 60_000 }, 'true')
    expect(values.get('settings')).toEqual({ keepAlive: true, inactivityTimeoutMs: 30 * 60_000 })
    expect(alarm()).toBeGreaterThanOrEqual(before + 5 * 60_000)
    await sandbox.alarm()
    expect(alarm()).toBeGreaterThanOrEqual(Date.now() + 5 * 60_000 - 1_000)
    // A short timeout gets alarms well inside it.
    await sandbox.configure({ inactivityTimeoutMs: 10_000 })
    await sandbox.alarm()
    expect((alarm() ?? 0) - Date.now()).toBeLessThanOrEqual(3_334)
    await sandbox.configure({ keepAlive: false })
    expect(alarm()).toBeNull()
    expect(container.running).toBe(true)
  })

  it('stops re-arming when the container is gone and clears keep-alive on destroy', async () => {
    const { sandbox, container, values, alarm } = harness()
    await sandbox.exec({ keepAlive: true }, 'true')
    await sandbox.destroy()
    expect(container.destroy).toHaveBeenCalledOnce()
    expect(values.get('settings')).toMatchObject({ keepAlive: false })
    expect(alarm()).toBeNull()
    await sandbox.alarm()
    expect(alarm()).toBeNull()
  })

  it('applies keep-alive without starting a stopped container', async () => {
    const { sandbox, container } = harness()
    await sandbox.configure({ keepAlive: false })
    expect(container.start).not.toHaveBeenCalled()
    await sandbox.destroy()
    expect(container.destroy).not.toHaveBeenCalled()
  })

  it('refuses inactivity timeouts beyond the platform limit', async () => {
    const { sandbox } = harness()
    await expect(sandbox.exec({ inactivityTimeoutMs: 7 * 60 * 60_000 }, 'true')).rejects.toThrow('1 second to 6 hours')
  })

  it('starts a background process once and reports its state', async () => {
    let state = 'running'
    const { sandbox, commands } = harness(argv => {
      if (argv[2] === processStateScript) return { stdout: `${state}\n` }
      if (argv[2]?.startsWith('mkdir -p -m 0700')) return { exitCode: argv[5]?.endsWith('/agent-dup') ? 1 : 0 }
      return {}
    })
    await expect(sandbox.startProcess({}, 'node runner.mjs', { processId: 'agent-1', cwd: '/workspace/source', env: { KEY: 'v' } }))
      .resolves.toBe('running')
    const launch = commands().find(call => call.argv[2] === runProcessScript)
    expect(launch).toMatchObject({
      argv: ['sh', '-c', runProcessScript, 'sh', '/var/lib/ack3-processes/agent-1', 'bash', '-c', 'node runner.mjs'],
      options: { cwd: '/workspace/source', stdout: 'ignore', stderr: 'ignore', env: expect.objectContaining({ KEY: 'v' }) },
    })
    for (const [reported, status] of [['running', 'running'], ['exited 0', 'completed'], ['exited 3', 'failed'],
      ['lost', 'error'], ['missing', null]] as const) {
      state = reported
      await expect(sandbox.processStatus({}, 'agent-1')).resolves.toBe(status)
    }
    await expect(sandbox.startProcess({}, 'x', { processId: 'agent-dup' })).rejects.toThrow('Process agent-dup already exists')
    await expect(sandbox.processStatus({}, '../escape')).rejects.toThrow('process ID is invalid')
  })
})

describe('agent sandbox process scripts', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

  const state = (dir: string) => spawnSync('sh', ['-c', processStateScript, 'sh', dir], { encoding: 'utf8' }).stdout.trim()

  it('records the exit code of a finished process and reports a running one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-processes-'))
    roots.push(root)
    expect(state(join(root, 'absent'))).toBe('missing')
    const done = join(root, 'done')
    mkdirSync(done)
    spawnSync('sh', ['-c', runProcessScript, 'sh', done, 'bash', '-c', 'echo out; echo err >&2; exit 3'])
    expect(state(done)).toBe('exited 3')
    const running = join(root, 'running')
    mkdirSync(running)
    // Detach the output pipes, as the Worker's exec() call does with stdout and stderr ignored.
    const child = spawnSync('sh', ['-c', `(sh -c "$0" sh "$1" bash -c 'sleep 2' </dev/null >/dev/null 2>&1 &) ; sleep 0.3`,
      runProcessScript, running])
    expect(child.status).toBe(0)
    expect(state(running)).toBe('running')
    await new Promise(resolve => setTimeout(resolve, 2_200))
    expect(state(running)).toBe('exited 0')
  })
})

describe('agent sandbox client', () => {
  function client() {
    const stub = {
      exec: vi.fn(async () => ({ success: true })),
      processStatus: vi.fn(async (_settings: unknown, _id: string): Promise<string | null> => 'running'),
      startProcess: vi.fn(async () => 'running'),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
    }
    const namespace = { getByName: vi.fn(() => stub) }
    return { stub, namespace, sandbox: getAgentSandbox(namespace as never, 'a0-lane', { keepAlive: true, inactivityTimeoutMs: 1_800_000 }) }
  }

  it('sends its lifetime settings with every call and updates them on keep-alive changes', async () => {
    const { stub, namespace, sandbox } = client()
    expect(namespace.getByName).toHaveBeenCalledWith('a0-lane')
    await sandbox.exec('true', { timeout: 1_000 })
    expect(stub.exec).toHaveBeenCalledWith({ keepAlive: true, inactivityTimeoutMs: 1_800_000 }, 'true', { timeout: 1_000 })
    await sandbox.setKeepAlive(false)
    expect(stub.configure).toHaveBeenCalledWith({ keepAlive: false, inactivityTimeoutMs: 1_800_000 })
    await sandbox.exec('true')
    expect(stub.exec).toHaveBeenLastCalledWith({ keepAlive: false, inactivityTimeoutMs: 1_800_000 }, 'true', undefined)
  })

  it('returns process handles whose status probe reports a missing process as not found', async () => {
    const { stub, sandbox } = client()
    const process = await sandbox.startProcess('node runner.mjs', { processId: 'agent-1' })
    await expect(process.getStatus()).resolves.toBe('running')
    stub.processStatus.mockResolvedValue(null)
    await expect(process.getStatus()).rejects.toThrow('Process agent-1 not found')
    await expect(sandbox.getProcess('agent-1')).resolves.toBeNull()
  })

  it('refuses sandbox names that are not lowercase identifiers', () => {
    const namespace = { getByName: vi.fn() }
    expect(() => getAgentSandbox(namespace as never, 'A0-Lane')).toThrow('sandbox ID is invalid')
    expect(namespace.getByName).not.toHaveBeenCalled()
  })
})
