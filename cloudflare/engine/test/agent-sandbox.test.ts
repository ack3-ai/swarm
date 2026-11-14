import { createControlledMachine } from './support/controlled-machine.js'
import { selectedSnapshots } from './support/selected-snapshots.js'
const selectionCloses: Array<() => void> = []
afterEach(() => selectionCloses.splice(0).forEach(close => close()))
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { sealReleasePackage } from '../src/release.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { birthMutationOwner, mutationSandboxName, type WorkspaceMutationOwner } from '../src/workspace-mutation-owner.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSandbox, processStateScript, runProcessScript } from '../src/agent-sandbox.js'
import { getAgentSandbox } from '../src/agent-sandbox-client.js'
import { agentLogObservationScript } from '../src/sandbox-log-observation.js'
import { nativeSessionInspectionScript, nativeSessionMarkerInspectionScript, nativeSessionMarkerId } from '../src/native-session-observation.js'

type Reply = { exitCode?: number, stdout?: string, stderr?: string }

const image = `registry.cloudflare.com/${'e'.repeat(32)}/swarm-sandbox@sha256:${'b'.repeat(64)}`
const encode = (text = '') => new TextEncoder().encode(text).buffer

function harness(reply: (argv: string[], stdin: string) => Reply = () => ({}), name?: string) {
  const calls: { argv: string[], options: Record<string, unknown>, stdin: string }[] = []
  const container = {
    running: false,
    images: { sandbox: image } as Record<string, string>,
    start: vi.fn(() => { container.running = true }),
    setInactivityTimeout: vi.fn(async (_ms: number) => {}),
    destroy: vi.fn(async () => { container.running = false }),
    inspect: vi.fn(async () => container.running ? { image, labels: {} } : null),
    monitor: vi.fn(async () => {}),
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
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: any, value?: unknown) => {
      for (const [id, entry] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) values.set(id as string, structuredClone(entry))
    },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...values.entries()].filter(([key]) => key.startsWith(prefix)).sort()),
    getAlarm: async () => alarm,
    setAlarm: async (time: number) => { alarm = time },
    deleteAlarm: async () => { alarm = null },
  }
  const namespaceId = (name: string) => createHash('sha256').update(name).digest('hex')
  const objectId = name === undefined ? '1'.repeat(64) : namespaceId(name)
  const env = { AGENT_SANDBOX: { idFromName: vi.fn((name: string) => ({ toString: () => namespaceId(name) })) } }
  const ctx = { id: { toString: () => objectId }, container, storage,
    waitUntil: (promise: Promise<unknown>) => { void promise.catch(() => {}) },
    blockConcurrencyWhile: async (run: () => Promise<unknown>) => run() }
  const sandbox = new AgentSandbox(ctx as unknown as DurableObjectState, env as never)
  const commands = () => calls.filter(call => call.argv.join(' ') !== 'cat /proc/1/environ')
  return { sandbox, container, calls, commands, values, storage, env, objectId, alarm: () => alarm,
    restart: () => new AgentSandbox(ctx as unknown as DurableObjectState, env as never) }
}

afterEach(() => vi.restoreAllMocks())

function barrier() {
  let release!: () => void, reached!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { reached = resolve })
  return { gate, waiting, release, reached }
}

describe('command-bound native stop', () => {
  const command = 'a'.repeat(64), custody = 'b'.repeat(64)

  it('rejects coerced digest inputs before native or storage operations', async () => {
    const h = harness()
    await expect(h.sandbox.stopRevoked([command] as any, custody)).rejects.toThrow('digest is invalid')
    await expect(h.sandbox.stopRevoked(command, [custody] as any)).rejects.toThrow('digest is invalid')
    expect(h.container.inspect).not.toHaveBeenCalled()
    expect(h.values.has('native-stop-intent')).toBe(false)
  })

  it('requires persisted revocation and a stable custody identity before destruction', async () => {
    const h = harness(); h.container.running = true
    await expect(h.sandbox.stopRevoked(command, custody)).rejects.toThrow('revocation identity')
    expect(h.container.destroy).not.toHaveBeenCalled()
    await h.sandbox.revoke(command)
    const result = await h.sandbox.stopRevoked(command, custody)
    expect(result).toMatchObject({ objectId: '1'.repeat(64), commandDigest: command, custodyDigest: custody,
      status: 'stopped', physicalZeroVerified: true, evidence: { inspect: 'absent', running: false } })
    expect(h.values.get('native-stop-intent')).toMatchObject({ commandDigest: command, custodyDigest: custody })
    await expect(h.restart().stopRevoked(command, custody)).resolves.toEqual(result)
    expect(h.container.destroy).toHaveBeenCalledTimes(1)
    expect(h.container.start).not.toHaveBeenCalled()
    await expect(h.sandbox.stopRevoked(command, 'c'.repeat(64))).rejects.toThrow('intent differs')
    await expect(h.restart().exec({}, 'no-replacement')).rejects.toThrow('revoked')
  })

  it('reconciles native absence without starting a never-allocated container or requiring monitor', async () => {
    const h = harness()
    h.container.monitor.mockRejectedValue(new Error('no lifecycle in this incarnation'))
    await h.sandbox.revoke(command)
    await expect(h.restart().stopRevoked(command, custody)).resolves.toMatchObject({ status: 'stopped', physicalZeroVerified: true })
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
    expect(h.container.monitor).not.toHaveBeenCalled()
  })

  it('preserves unknown pending submissions while stopping instead of waiting for their output', async () => {
    const h = harness(), exec = h.container.exec.getMockImplementation()!
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      return argv.includes('unknown') ? { output: async () => { throw new Error('lost output') } } : result
    })
    await expect(h.sandbox.exec({}, 'unknown')).rejects.toThrow('lost output')
    await h.sandbox.revoke(command)
    const before = await h.sandbox.revocationStatus(command)
    expect(before.pendingOperations).toHaveLength(1)
    const receipt = await h.sandbox.stopRevoked(command, custody)
    expect(receipt).toMatchObject({ status: 'stopped', pendingOperations: before.pendingOperations })
    expect((await h.sandbox.revocationStatus(command)).pendingOperations).toEqual(before.pendingOperations)
  })

  it.each(['monitor', 'destroy'])('uses native readback when %s rejects after physical shutdown', async failure => {
    const h = harness(); h.container.running = true
    if (failure === 'monitor') h.container.monitor.mockRejectedValue(new Error('process exit 137'))
    else h.container.destroy.mockImplementation(async () => { h.container.running = false; throw new Error('lost stop response') })
    await h.sandbox.revoke(command)
    await expect(h.sandbox.stopRevoked(command, custody)).resolves.toMatchObject({ status: 'stopped', physicalZeroVerified: true })
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it.each(['running', 'inspect'])('does not infer shutdown from destroy/monitor when %s still shows work', async field => {
    const h = harness(); h.container.running = true
    h.container.destroy.mockImplementation(async () => {})
    if (field === 'running') h.container.inspect.mockResolvedValue(null)
    else h.container.destroy.mockImplementation(async () => { h.container.running = false })
    if (field === 'inspect') h.container.inspect.mockResolvedValue({ image, labels: {} })
    await h.sandbox.revoke(command)
    await expect(h.sandbox.stopRevoked(command, custody)).resolves.toMatchObject({ status: 'pending', physicalZeroVerified: false })
    expect(h.values.has('native-stop-receipt')).toBe(false)
  })

  it('keeps observation errors unresolved and never starts a container to inspect it', async () => {
    const h = harness()
    await h.sandbox.revoke(command)
    h.container.inspect.mockRejectedValue(new Error('inspect unavailable'))
    await expect(h.sandbox.stopRevoked(command, custody)).rejects.toThrow('inspect unavailable')
    expect(h.values.has('native-stop-receipt')).toBe(false)
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })

  it('bounds waiting, coalesces an outstanding stop, and later reconciles native absence', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(), gate = barrier(); h.container.running = true
      h.container.destroy.mockImplementation(async () => { gate.reached(); await gate.gate; h.container.running = false })
      h.container.monitor.mockRejectedValue(new Error('lost monitor response'))
      await h.sandbox.revoke(command)
      const first = h.sandbox.stopRevoked(command, custody)
      await gate.waiting
      await vi.advanceTimersByTimeAsync(5_001)
      await expect(first).resolves.toMatchObject({ status: 'pending', physicalZeroVerified: false })
      const second = h.sandbox.stopRevoked(command, custody)
      await vi.advanceTimersByTimeAsync(5_001)
      await expect(second).resolves.toMatchObject({ status: 'pending' })
      expect(h.container.destroy).toHaveBeenCalledTimes(1)
      gate.release()
      await vi.advanceTimersByTimeAsync(1)
      await expect(h.restart().stopRevoked(command, custody)).resolves.toMatchObject({ status: 'stopped', physicalZeroVerified: true })
      expect(h.container.destroy).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('also bounds initial native observation without asserting an unobserved fence', async () => {
    vi.useFakeTimers()
    try {
      const h = harness(), gate = barrier()
      await h.sandbox.revoke(command)
      h.container.inspect.mockImplementation(async () => { gate.reached(); await gate.gate; return null })
      const call = h.sandbox.stopRevoked(command, custody)
      await gate.waiting
      await vi.advanceTimersByTimeAsync(5_001)
      const pending = await call
      expect(pending).toMatchObject({ status: 'pending', physicalZeroVerified: false })
      expect(pending).not.toHaveProperty('admissionRevoked')
      expect(h.container.destroy).not.toHaveBeenCalled()
      gate.release()
      await vi.advanceTimersByTimeAsync(1)
      await expect(h.sandbox.stopRevoked(command, custody)).resolves.toMatchObject({ status: 'stopped', admissionRevoked: true })
    } finally { vi.useRealTimers() }
  })

  it('reconciles lost stop-proof persistence without repeating destruction', async () => {
    const h = harness(), put = h.storage.put; h.container.running = true
    await h.sandbox.revoke(command)
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
      await put(key, value)
      if (key === 'native-stop-receipt') throw new Error('proof response lost')
    })
    await expect(h.sandbox.stopRevoked(command, custody)).rejects.toThrow('proof response lost')
    await expect(h.restart().stopRevoked(command, custody)).resolves.toMatchObject({ status: 'stopped' })
    expect(h.container.destroy).toHaveBeenCalledTimes(1)
  })

  it('refuses malformed retained pending-operation evidence after owner restart', async () => {
    const h = harness()
    await h.sandbox.revoke(command)
    const receipt = await h.sandbox.stopRevoked(command, custody)
    h.values.set('native-stop-receipt', { ...receipt, pendingOperations: [{ id: 'bad', kind: 'command', secret: 'must-not-return' }] })
    await expect(h.restart().stopRevoked(command, custody)).rejects.toThrow('pending mutation is invalid')
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })
})

describe('sandbox log observation without execution admission', () => {
  const requestDigest = 'c'.repeat(64)
  const slice = { status: 'available', offset: 2, size: 5, bytes: 3, data: 'YWJj' }

  it('reads an active or revoked actor through a fixed program without lifetime or environment replay', async () => {
    const h = harness(() => ({ stdout: JSON.stringify(slice) }))
    h.container.running = true
    await expect(h.sandbox.observeAgentLog(requestDigest, 2, 3)).resolves.toEqual(slice)
    await h.sandbox.revoke('d'.repeat(64))
    const put = vi.spyOn(h.storage, 'put'), destroy = h.container.destroy
    await expect(h.restart().observeAgentLog(requestDigest, 2, 3)).resolves.toEqual(slice)
    expect(h.container.start).not.toHaveBeenCalled()
    expect(destroy).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(2)
    for (const call of h.calls) {
      expect(call.argv).toEqual(['/usr/bin/timeout', '--kill-after=1s', '10s', '/usr/bin/python3', '-I', '-c',
        agentLogObservationScript, requestDigest, '2', '3'])
      expect(call.options).toEqual({ cwd: '/' })
    }
    await expect(h.sandbox.exec({}, 'cannot-submit')).rejects.toThrow('revoked')
  })

  it('never creates an absent container, before or after revocation', async () => {
    const h = harness()
    await expect(h.sandbox.observeAgentLog(requestDigest, 0, 3)).rejects.toThrow('not running')
    await h.sandbox.revoke('d'.repeat(64))
    await expect(h.restart().observeAgentLog(requestDigest, 0, 3)).rejects.toThrow('not running')
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.exec).not.toHaveBeenCalled()
  })

  it('refuses unsafe selectors before issuing any native call', async () => {
    const h = harness(); h.container.running = true
    await expect(h.sandbox.observeAgentLog('../auth.json', 0, 3)).rejects.toThrow('scope')
    await expect(h.sandbox.observeAgentLog(requestDigest, 0, Infinity)).rejects.toThrow('scope')
    expect(h.container.exec).not.toHaveBeenCalled()
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it.each(['submission', 'output', 'exit', 'malformed'])('keeps %s uncertainty distinct from a missing log', async failure => {
    const h = harness(() => ({ exitCode: failure === 'exit' ? 1 : 0, stdout: '{}' }))
    h.container.running = true
    if (failure === 'submission') h.container.exec.mockRejectedValue(new Error('submission unavailable'))
    if (failure === 'output') h.container.exec.mockResolvedValue({ output: async () => { throw new Error('output unavailable') } })
    await expect(h.sandbox.observeAgentLog(requestDigest, 0, 3)).rejects.toThrow()
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })
})

describe('sandbox native session observation without execution admission', () => {
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const cwd = '/workspace/source'

  it('returns exact session bytes after revocation and owner restart without writing a marker or creating a container', async () => {
    const raw = new TextEncoder().encode('synthetic native journal')
    const observation = { status: 'available', sessionId, workingDirectory: cwd, fileName: 'session.jsonl', bytes: raw.length,
      journalDigest: Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex'),
      contentBase64: Buffer.from(raw).toString('base64'), closed: false, workState: 'present' }
    const h = harness(() => ({ stdout: JSON.stringify(observation) }))
    h.container.running = true
    await h.sandbox.revoke('d'.repeat(64))
    const put = vi.spyOn(h.storage, 'put')
    await expect(h.restart().observeDshSession(sessionId, cwd)).resolves.toEqual(observation)
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toEqual({ argv: ['/usr/bin/timeout', '--kill-after=1s', '10s', '/usr/bin/python3', '-I', '-c',
      nativeSessionInspectionScript, sessionId, cwd], options: { cwd: '/' }, stdin: '' })
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
    expect(put).not.toHaveBeenCalled()
    await expect(h.sandbox.exec({}, 'forbidden')).rejects.toThrow('revoked')
  })

  it('does not recreate absent native work or submit invalid session selectors', async () => {
    const h = harness()
    await expect(h.sandbox.observeDshSession(sessionId, cwd)).rejects.toThrow('not running')
    h.container.running = true
    await expect(h.sandbox.observeDshSession('../auth.json', cwd)).rejects.toThrow('scope')
    await expect(h.sandbox.observeDshSession(sessionId, '/opt/dsh-home')).rejects.toThrow('scope')
    expect(h.container.exec).not.toHaveBeenCalled()
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it.each(['submission', 'output', 'exit', 'invalid'])('keeps %s failures distinct from unavailable native evidence', async failure => {
    const h = harness(() => ({ exitCode: failure === 'exit' ? 1 : 0, stdout: '{}' }))
    h.container.running = true
    if (failure === 'submission') h.container.exec.mockRejectedValue(new Error('submission unavailable'))
    if (failure === 'output') h.container.exec.mockResolvedValue({ output: async () => { throw new Error('output unavailable') } })
    await expect(h.sandbox.observeDshSession(sessionId, cwd)).rejects.toThrow()
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })
})

describe('sandbox submission reconciliation', () => {
  it('orders registration before revoked status and refuses the delayed native submission', async () => {
    const h = harness(), b = barrier(), put = h.storage.put, digest = 'a'.repeat(64)
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
      if (key.startsWith('pending-mutation/')) { b.reached(); await b.gate }
      await put(key, value)
    })
    const launch = expect(h.sandbox.exec({}, 'never-submit')).rejects.toThrow('revoked')
    await b.waiting
    const revoke = h.sandbox.revoke(digest)
    let observed = false
    const status = h.sandbox.revocationStatus(digest).then(value => { observed = true; return value })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(observed).toBe(false)
    expect(h.container.start).not.toHaveBeenCalled()
    b.release(); await revoke; await status; await launch
    expect((await h.sandbox.revocationStatus(digest)).pendingOperations).toEqual([])
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it('retains uncertain registration across owner restart without replaying it', async () => {
    const h = harness(), put = h.storage.put, digest = 'b'.repeat(64)
    let failed = false
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
      await put(key, value)
      if (!failed && typeof key === 'string' && key.startsWith('pending-mutation/') && (value as any).kind === 'container-start') {
        failed = true; throw new Error('registration acknowledgment lost')
      }
    })
    await expect(h.sandbox.exec({}, 'never-submit')).rejects.toThrow('acknowledgment lost')
    await h.sandbox.revoke(digest)
    const before = await h.sandbox.revocationStatus(digest)
    expect(before.pendingOperations).toEqual([{ id: expect.any(String), kind: 'container-start' }])
    await expect(h.restart().revocationStatus(digest)).resolves.toEqual(before)
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it('keeps an already submitted ready write pending until its output is observed', async () => {
    const h = harness(), b = barrier(), exec = h.container.exec.getMockImplementation()!, digest = 'c'.repeat(64)
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      if (argv.includes('/ready')) return { output: async () => { b.reached(); await b.gate; return result.output() } }
      return result
    })
    const write = h.sandbox.writeFile({}, '/ready', 'ready')
    await b.waiting; await h.sandbox.revoke(digest)
    expect((await h.sandbox.revocationStatus(digest)).pendingOperations).toEqual([{ id: expect.any(String), kind: 'command' }])
    b.release(); await write
    await expect(h.sandbox.revocationStatus(digest)).resolves.toMatchObject({ pendingOperations: [], physicalZeroVerified: false })
    expect(h.container.running).toBe(true)
  })

  it.each(['submission', 'output'])('retains a command whose %s observation failed', async boundary => {
    const h = harness(), exec = h.container.exec.getMockImplementation()!, digest = 'd'.repeat(64)
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      if (argv.includes('unknown-outcome') && boundary === 'submission') throw new Error('output unavailable')
      return argv.includes('unknown-outcome') ? { output: async () => { throw new Error('output unavailable') } } : result
    })
    await expect(h.sandbox.exec({}, 'unknown-outcome')).rejects.toThrow('output unavailable')
    await h.sandbox.revoke(digest)
    const before = await h.sandbox.revocationStatus(digest)
    expect(before.pendingOperations).toHaveLength(1)
    expect(before.pendingOperations[0]!.kind).toBe('command')
    await expect(h.restart().revocationStatus(digest)).resolves.toEqual(before)
  })

  it.each([false, true])('reconciles actual durable state after lost deletion acknowledgment (deleted: %s)', async deleted => {
    const h = harness(), remove = h.storage.delete, digest = 'e'.repeat(64)
    await h.sandbox.exec({}, 'setup')
    vi.spyOn(h.storage, 'delete').mockImplementationOnce(async key => {
      if (deleted) await remove(key)
      throw new Error('delete acknowledgment lost')
    })
    await expect(h.sandbox.exec({}, 'observed-command')).rejects.toThrow('acknowledgment lost')
    await h.sandbox.revoke(digest)
    const status = await h.restart().revocationStatus(digest)
    expect(status.pendingOperations).toHaveLength(deleted ? 0 : 1)
    expect(status.physicalZeroVerified).toBe(false)
  })

  it('separates background registration from process exit', async () => {
    const h = harness(argv => ({ stdout: argv[2] === processStateScript ? 'running' : '' }))
    const b = barrier(), exec = h.container.exec.getMockImplementation()!, digest = 'f'.repeat(64)
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      if (argv.includes(runProcessScript)) { b.reached(); await b.gate }
      return result
    })
    const start = h.sandbox.startProcess({}, 'model-call', { processId: 'native-request' })
    await b.waiting; await h.sandbox.revoke(digest)
    expect((await h.sandbox.revocationStatus(digest)).pendingOperations).toEqual([
      { id: expect.any(String), kind: 'process-start', processId: 'native-request' },
    ])
    b.release(); await expect(start).resolves.toBe('running')
    await expect(h.sandbox.revocationStatus(digest)).resolves.toMatchObject({ pendingOperations: [], physicalZeroVerified: false })
    await expect(h.sandbox.processStatus({}, 'native-request')).resolves.toBe('running')
  })

  it('requires exact persisted revocation and validates every pending entry', async () => {
    const h = harness(), digest = 'a'.repeat(64)
    await expect(h.sandbox.revocationStatus(digest)).rejects.toThrow('identity differs')
    await h.sandbox.revoke(digest)
    await expect(h.sandbox.revocationStatus('b'.repeat(64))).rejects.toThrow('identity differs')
    const key = `pending-mutation/${crypto.randomUUID()}`
    h.values.set(key, { id: crypto.randomUUID(), kind: 'command' })
    await expect(h.sandbox.revocationStatus(digest)).rejects.toThrow('pending mutation is invalid')
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it('tracks shutdown submission without turning its acknowledgment into physical-zero evidence', async () => {
    const h = harness(), b = barrier(), digest = 'b'.repeat(64)
    await h.sandbox.exec({}, 'setup'); await h.sandbox.revoke(digest)
    h.container.destroy.mockImplementation(async () => { b.reached(); await b.gate; h.container.running = false })
    const destroy = h.sandbox.stopRevoked(digest, 'c'.repeat(64))
    await b.waiting
    expect((await h.sandbox.revocationStatus(digest)).pendingOperations).toEqual([{ id: expect.any(String), kind: 'destroy' }])
    b.release(); await destroy
    await expect(h.restart().revocationStatus(digest)).resolves.toMatchObject({ pendingOperations: [], physicalZeroVerified: false })
    expect(h.container.start).toHaveBeenCalledOnce()
  })

  it('observes terminal nonzero commands and keeps revoked status read-only', async () => {
    const h = harness(() => ({ exitCode: 3 })), digest = 'c'.repeat(64)
    await expect(h.sandbox.exec({}, 'exit 3')).resolves.toMatchObject({ exitCode: 3, success: false })
    await h.sandbox.revoke(digest)
    const put = vi.spyOn(h.storage, 'put'), remove = vi.spyOn(h.storage, 'delete')
    await expect(h.sandbox.revocationStatus(digest)).resolves.toMatchObject({ pendingOperations: [] })
    expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })
})

describe('agent sandbox', () => {
  it('refuses malformed revocation identities before storing a fence', async () => {
    const h = harness()
    for (const value of ['', 'A'.repeat(64), ['a'.repeat(64)], null]) {
      await expect(h.sandbox.revoke(value as string)).rejects.toThrow('digest is invalid')
    }
    expect(h.values.has('revoked-by-command')).toBe(false)
    expect(h.container.start).not.toHaveBeenCalled()
  })

  it('durably revokes admission without destroying custody or claiming physical shutdown', async () => {
    const h = harness(argv => ({ stdout: argv[2] === processStateScript ? 'running\n' : 'saved evidence' }))
    const commandDigest = 'a'.repeat(64)
    await h.sandbox.exec({ keepAlive: true }, 'setup')
    const receipt = await h.sandbox.revoke(commandDigest)
    expect(receipt).toEqual({ objectId: '1'.repeat(64), commandDigest, admissionRevoked: true, physicalZeroVerified: false })
    expect(h.values.get('revoked-by-command')).toBe(commandDigest)
    expect(h.values.get('settings')).toMatchObject({ keepAlive: false })
    expect(h.alarm()).toBeNull()
    expect(h.container.destroy).not.toHaveBeenCalled()
    expect(h.container.running).toBe(true)
    const sandbox = h.restart()
    await expect(sandbox.revoke(commandDigest)).resolves.toEqual(receipt)
    await expect(sandbox.revoke('b'.repeat(64))).rejects.toThrow('another command')
    const before = h.commands().length
    for (const mutation of [() => sandbox.exec({}, 'model-call'),
      () => sandbox.startProcess({}, 'model-call', { processId: 'late' }),
      () => sandbox.writeFile({}, '/workspace/private/ready', 'ready'),
      () => sandbox.mkdir({}, '/new'), () => sandbox.deleteFile({}, '/evidence'),
      () => sandbox.configure({ keepAlive: true })]) {
      await expect(mutation()).rejects.toThrow('revoked')
    }
    expect(h.commands()).toHaveLength(before)
    await expect(sandbox.readFile({ keepAlive: true }, '/evidence')).resolves.toMatchObject({ content: 'saved evidence' })
    await expect(sandbox.exists({}, '/evidence')).resolves.toMatchObject({ exists: true })
    await expect(sandbox.processStatus({}, 'existing')).resolves.toBe('running')
    await sandbox.alarm()
    expect(h.alarm()).toBeNull()
    await expect(sandbox.destroy()).rejects.toThrow('revoked')
    await sandbox.stopRevoked(commandDigest, 'f'.repeat(64))
    await expect(sandbox.readFile({}, '/evidence')).rejects.toThrow('not running')
    await expect(h.restart().exec({}, 'model-call')).rejects.toThrow('revoked')
    expect(h.container.start).toHaveBeenCalledOnce()
  })

  it('reconciles a lost revocation write acknowledgment without reopening admission', async () => {
    const h = harness(), command = 'c'.repeat(64)
    const put = h.storage.put
    const spy = vi.spyOn(h.storage, 'put').mockImplementationOnce(async (key, value) => {
      await put(key, value); throw new Error('lost write acknowledgment')
    })
    await expect(h.sandbox.revoke(command)).rejects.toThrow('lost write acknowledgment')
    await expect(h.sandbox.exec({}, 'model-call')).rejects.toThrow('revoked')
    spy.mockRestore()
    await expect(h.restart().revoke(command)).resolves.toMatchObject({ admissionRevoked: true })
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.container.destroy).not.toHaveBeenCalled()
  })

  it.each(['environment', 'process-directory'] as const)('rejects a late launch after awaiting %s', async boundary => {
    const h = harness(), exec = h.container.exec.getMockImplementation()!
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { reached = resolve })
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      if (boundary === 'environment' ? argv.join(' ') === 'cat /proc/1/environ'
        : argv[2]?.startsWith('mkdir -p -m 0700')) {
        reached(); await gate
      }
      return result
    })
    const launch = boundary === 'environment' ? h.sandbox.exec({}, 'model-call')
      : h.sandbox.startProcess({}, 'model-call', { processId: 'late' })
    const rejected = expect(launch).rejects.toThrow('revoked')
    await waiting
    await h.sandbox.revoke('d'.repeat(64))
    release(); await rejected
    expect(h.calls.some(call => call.argv.includes('model-call'))).toBe(false)
    expect(h.container.destroy).not.toHaveBeenCalled()
  })

  it('does not start a container when revocation overtakes lifetime setup', async () => {
    const h = harness(), put = h.storage.put
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { reached = resolve })
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
      if (key === 'settings' && (value as any).keepAlive) { reached(); await gate }
      await put(key, value)
    })
    const launch = h.sandbox.exec({ keepAlive: true }, 'model-call')
    const rejected = expect(launch).rejects.toThrow('revoked')
    await waiting
    const revocation = h.sandbox.revoke('e'.repeat(64))
    await vi.waitFor(() => expect(h.values.get('revoked-by-command')).toBe('e'.repeat(64)))
    release(); await revocation; await rejected
    expect(h.container.start).not.toHaveBeenCalled()
    expect(h.values.get('settings')).toMatchObject({ keepAlive: false })
    expect(h.alarm()).toBeNull()
  })

  it('does not misreport a previously submitted ready write as cancelled or physically stopped', async () => {
    const h = harness(), exec = h.container.exec.getMockImplementation()!
    let release!: () => void, reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { reached = resolve })
    h.container.exec.mockImplementation(async (argv, options = {}) => {
      const result = await exec(argv, options)
      if (argv.includes('/workspace/private/ready')) { reached(); await gate }
      return result
    })
    const write = h.sandbox.writeFile({}, '/workspace/private/ready', 'ready')
    await waiting
    await expect(h.sandbox.revoke('f'.repeat(64))).resolves.toMatchObject({ physicalZeroVerified: false })
    release(); await expect(write).resolves.toMatchObject({ success: true })
    expect(h.container.destroy).not.toHaveBeenCalled()
    await expect(h.sandbox.writeFile({}, '/workspace/private/ready', 'ready')).rejects.toThrow('revoked')
  })

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

  // The installed Linux runner uses setsid and /proc boot IDs; Ubuntu CI exercises this script.
  it.skipIf(process.platform !== 'linux')('records the exit code of a finished process and reports a running one', async () => {
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
      observeAgentLog: vi.fn(async () => ({ status: 'missing' as const })),
      observeDshSession: vi.fn(async () => ({ status: 'unavailable' as const, reason: 'missing' as const })),
      processStatus: vi.fn(async (_settings: unknown, _id: string): Promise<string | null> => 'running'),
      startProcess: vi.fn(async () => 'running'),
      configure: vi.fn(async () => {}),
      destroy: vi.fn(async () => {}),
      revoke: vi.fn(async (commandDigest: string) => ({ objectId: '2'.repeat(64), commandDigest, admissionRevoked: true, physicalZeroVerified: false })),
      revocationStatus: vi.fn(async (commandDigest: string) => ({ objectId: '2'.repeat(64), commandDigest,
        admissionRevoked: true, physicalZeroVerified: false, pendingOperations: [] })),
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

  it('passes the exact revocation identity without replaying lifetime settings', async () => {
    const { stub, sandbox } = client(), commandDigest = 'a'.repeat(64)
    await expect(sandbox.revoke(commandDigest)).resolves.toEqual({ objectId: '2'.repeat(64), commandDigest, admissionRevoked: true, physicalZeroVerified: false })
    expect(stub.revoke).toHaveBeenCalledExactlyOnceWith(commandDigest)
    expect(stub.configure).not.toHaveBeenCalled()
    expect(stub.destroy).not.toHaveBeenCalled()
    await expect(sandbox.revocationStatus(commandDigest)).resolves.toMatchObject({ objectId: '2'.repeat(64), pendingOperations: [] })
    expect(stub.revocationStatus).toHaveBeenCalledExactlyOnceWith(commandDigest)
  })

  it('observes only the selected native log without sending cached lifetime settings', async () => {
    const { sandbox, stub } = client(), digest = 'e'.repeat(64)
    await expect(sandbox.observeAgentLog(digest, 100, 200)).resolves.toEqual({ status: 'missing' })
    expect(stub.observeAgentLog).toHaveBeenCalledExactlyOnceWith(digest, 100, 200)
    expect(stub.configure).not.toHaveBeenCalled()
    expect(stub.exec).not.toHaveBeenCalled()
  })

  it('observes the exact native session without replaying lifetime settings or passing a path', async () => {
    const { sandbox, stub } = client(), sessionId = 'session-11111111-1111-4111-8111-111111111111'
    await expect(sandbox.observeDshSession(sessionId, '/workspace/source')).resolves.toEqual({ status: 'unavailable', reason: 'missing' })
    expect(stub.observeDshSession).toHaveBeenCalledExactlyOnceWith(sessionId, '/workspace/source')
    expect(stub.configure).not.toHaveBeenCalled()
    expect(stub.exec).not.toHaveBeenCalled()
  })

  it('refuses sandbox names that are not lowercase identifiers', () => {
    const namespace = { getByName: vi.fn() }
    expect(() => getAgentSandbox(namespace as never, 'A0-Lane')).toThrow('sandbox ID is invalid')
    expect(namespace.getByName).not.toHaveBeenCalled()
  })
})


async function coveredLane(reply: (argv: string[], stdin: string) => Reply = () => ({})) {
  const owner = await birthMutationOwner({ auditId: 'mutation-fixture', executionId: 'mutation-executor',
    epoch: 0, runtimeDigest: 'b'.repeat(64) }, `native-${'a'.repeat(64)}`)
  const h = harness(reply, await mutationSandboxName(owner))
  await h.sandbox.initializeMutationOwner(owner)
  return { ...h, owner, settings: { mutationOwner: owner, keepAlive: true } }
}
describe('workspace mutation ownership', () => {






  it('covers a new allocation before use and refuses every bare legacy mutation or starting read', async () => {
    const h = await coveredLane()
    await h.sandbox.exec(h.settings, 'first task')
    await h.sandbox.exec(h.settings, 'second task on same lane')
    const before = h.container.exec.mock.calls.length
    for (const call of [() => h.sandbox.exec({}, 'late'), () => h.sandbox.writeFile({}, '/late', 'late'),
      () => h.sandbox.mkdir({}, '/late'), () => h.sandbox.deleteFile({}, '/late'),
      () => h.sandbox.readFile({}, '/late'), () => h.sandbox.exists({}, '/late'),
      () => h.sandbox.processStatus({}, 'late'), () => h.sandbox.startProcess({}, 'late', { processId: 'late' }),
      () => h.sandbox.configure({ keepAlive: false }), () => h.sandbox.destroy()]) {
      await expect(call()).rejects.toThrow('mutation owner')
    }
    expect(h.container.exec).toHaveBeenCalledTimes(before)
    expect(h.container.destroy).not.toHaveBeenCalled()
    expect(h.values.has('mutation-legacy-use')).toBe(false)
    await expect(h.restart().initializeMutationOwner(h.owner)).resolves.toMatchObject({ owner: h.owner, objectId: h.objectId })
  })















  it('rejects birth on an old allocation or after any bare lifetime use, including a lost legacy write reply', async () => {
    const owner = await birthMutationOwner({ auditId: 'fixture', executionId: 'fixture-run', epoch: 0, runtimeDigest: 'a'.repeat(64) }, `native-${'b'.repeat(64)}`)
    await expect(harness().sandbox.initializeMutationOwner(owner)).rejects.toThrow('allocation differs')
    for (const lost of [false, true]) {
      const h = harness(undefined, await mutationSandboxName(owner)), put = h.storage.put
      if (lost) vi.spyOn(h.storage, 'put').mockImplementationOnce(async (key, value) => { await put(key, value); throw new Error('lost legacy marker') })
      if (lost) await expect(h.sandbox.configure({})).rejects.toThrow('lost legacy marker')
      else await h.sandbox.configure({})
      await expect(h.sandbox.initializeMutationOwner(owner)).rejects.toThrow('legacy workspace')
      expect(h.container.start).not.toHaveBeenCalled()
    }
  })


})


it.each([false, true])(
  'reconciles covered birth publication uncertainty (persisted=%s) before allowing any mutation', async persisted => {
  const owner = await birthMutationOwner({ auditId: 'birth-fixture', executionId: 'birth-execution', epoch: 0,
    runtimeDigest: 'a'.repeat(64) }, `native-${'b'.repeat(64)}`)
  const h = harness(undefined, await mutationSandboxName(owner)), put = h.storage.put
  let lost = false
  vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
    if (key === 'workspace-mutation-owner' && !lost) {
      lost = true
      if (persisted) await put(key, value)
      throw new Error('uncertain birth')
    }
    await put(key, value)
  })
  await expect(h.sandbox.initializeMutationOwner(owner)).rejects.toThrow('uncertain birth')
  await expect(h.sandbox.exec({ mutationOwner: owner }, 'early')).rejects.toThrow('mutation owner')
  await expect(h.sandbox.exec({}, 'bare')).rejects.toThrow('mutation owner')
  expect(h.container.start).not.toHaveBeenCalled()
  await h.sandbox.initializeMutationOwner(owner)
  await h.sandbox.exec({ mutationOwner: owner }, 'covered')
})

it('initializes a fork allocation only on its distinct actor and retains the source actor revocation', async () => {
  const old = await coveredLane()
  const replacement = { commandDigest: '1'.repeat(64), next: await birthMutationOwner({ ...old.owner.authority, auditId: 'fork-owner', executionId: 'fork-owner' },
    old.owner.workspaceKey) }
  await old.sandbox.revoke(replacement.commandDigest)
  await expect(old.sandbox.initializeMutationOwner(replacement.next)).rejects.toThrow()
  const fresh = harness(undefined, await mutationSandboxName(replacement.next))
  await expect(fresh.sandbox.initializeMutationOwner(old.owner)).rejects.toThrow('allocation differs')
  await fresh.sandbox.initializeMutationOwner(replacement.next)
  await fresh.sandbox.exec({ mutationOwner: replacement.next }, 'fresh')
  await expect(old.sandbox.exec(old.settings, 'stale')).rejects.toThrow('revoked')
  expect(old.container.start).not.toHaveBeenCalled()
})






it('keeps revocation available while birth container inspection is stalled', async () => {
  const owner = await birthMutationOwner({ auditId: 'mutation-fixture', executionId: 'mutation-executor', epoch: 0, runtimeDigest: 'b'.repeat(64) }, `native-${'a'.repeat(64)}`)
  const h = harness(undefined, await mutationSandboxName(owner)), gate = barrier()
  h.container.inspect.mockImplementation(async () => { gate.reached(); await gate.gate; return null })
  const birth = h.sandbox.initializeMutationOwner(owner)
  const rejected = expect(birth).rejects.toThrow('revoked')
  await gate.waiting
  await h.sandbox.revoke('c'.repeat(64))
  expect(h.values.get('revoked-by-command')).toBe('c'.repeat(64))
  gate.release()
  await rejected
  expect(h.values.has('workspace-mutation-owner')).toBe(false)
  expect(h.container.start).not.toHaveBeenCalled()
})




it.each([false, true])('reobserves birth failure in the actual runner without spending model attempts (persisted=%s)', async persisted => {
  const id = 'birth-reconciliation', authority = { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) }
  const task = audit0Definition.stages[0]!.waves[0]!.tasks[0]!
  expect(task.promptKind).toBe('preflight')
  const owner = await birthMutationOwner(authority, task.workspaceKey)
  const h = harness(undefined, await mutationSandboxName(owner)), put = h.storage.put
  const provider = new SandboxAgentProvider({ ...h.env, ACK3_CODEX_WORKSPACE_ID: 'fixture',
    AGENT_SANDBOX: { ...h.env.AGENT_SANDBOX, getByName: () => h.sandbox } } as any)
  const launch = vi.fn(async (..._args: any[]) => { throw new AgentExecutionPending('fixture-process') })
  Object.assign(provider, { executionReceipts: { get: async () => null }, observationHealth: { get: async () => null },
    runInSandbox: launch })
  let failed = false
  vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
    if (!failed && key === 'workspace-mutation-owner') {
      failed = true
      if (persisted) await put(key, value)
      throw new Error('uncertain birth publication')
    }
    await put(key, value)
  })
  const release = await sealReleasePackage(audit0PackageBody)
  const machine = await createControlledMachine(audit0Definition, release.digest, id, undefined, undefined, authority)
  const selected = selectedSnapshots(); selectionCloses.push(selected.close)
  Object.assign(provider, { runs: { getState: async () => machine.snapshot(), getRelease: async () => release, executionSources: () => selected.load } })
  const artifactStore = new MemoryArtifactStore()
  const advance = () => advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore,
    onWaveAdmission: async state => { await selected.select(state) } })
  const budget = machine.snapshot().budget
  const calls = vi.spyOn(provider, 'run')
  await advance()
  const first = machine.snapshot()
  expect(first.status).toBe('running')
  expect(first.rejectedAttempts).toEqual([])
  expect(first.budget).toEqual(budget)
  expect(failed).toBe(true)
  expect(first.waveAdmission!.taskOccurrences![0]!.mutationOwner).toEqual(owner)
  expect(launch).not.toHaveBeenCalled()
  expect(h.container.start).not.toHaveBeenCalled()
  await advance()
  expect(machine.snapshot().rejectedAttempts).toEqual([])
  expect(machine.snapshot().budget).toEqual(budget)
  expect(machine.snapshot().inFlightAgentAttempts).toEqual(first.inFlightAgentAttempts)
  expect(launch).toHaveBeenCalledOnce()
  expect(calls.mock.calls.map(([request]) => request.attempt)).toEqual([1, 1])
  expect(calls.mock.calls[1]![0]).toEqual(calls.mock.calls[0]![0])
  expect(launch.mock.calls[0]![1].execution.mutationOwner).toEqual(owner)
})


describe('fixed custody marker read after revocation', () => {
  const requestDigest = 'a'.repeat(64)
  it('observes after revocation and actor restart without mutation, lifetime update or owner adoption', async () => {
    const markerId = await nativeSessionMarkerId(requestDigest)
    const result = { status: 'available', markerId, bytes: 10, digest: 'f'.repeat(64) }
    const h = await coveredLane(() => ({ stdout: JSON.stringify(result) }))
    h.container.running = true
    await h.sandbox.revoke('c'.repeat(64))
    const restarted = h.restart()
    // Measure observation after revoked actor initialization completes.
    await restarted.revocationStatus('c'.repeat(64))
    const put = vi.spyOn(h.storage, 'put'), lifetime = h.container.setInactivityTimeout.mock.calls.length
    await expect(restarted.observeSessionMarker(requestDigest)).resolves.toEqual(result)
    expect(h.calls.at(-1)).toEqual({ argv: ['/usr/bin/timeout', '--kill-after=1s', '10s', '/usr/bin/python3', '-I', '-c',
      nativeSessionMarkerInspectionScript, markerId], options: { cwd: '/' }, stdin: '' })
    expect(put).not.toHaveBeenCalled()
    expect(h.container.setInactivityTimeout).toHaveBeenCalledTimes(lifetime)
    expect(h.container.start).not.toHaveBeenCalled()
    await expect(h.sandbox.writeFile(h.settings, '/anything', 'denied')).rejects.toThrow('revoked')
  })
  it('refuses invalid selectors and never recreates a missing container', async () => {
    const h = harness()
    await expect(h.sandbox.observeSessionMarker(requestDigest)).rejects.toThrow('not running')
    h.container.running = true
    await expect(h.sandbox.observeSessionMarker('../secret')).rejects.toThrow('scope')
    await expect(h.sandbox.observeSessionMarker([requestDigest] as any)).rejects.toThrow('scope')
    expect(h.container.exec).not.toHaveBeenCalled()
    expect(h.container.start).not.toHaveBeenCalled()
  })
  it('client observation delegates without configure or generic file operations', async () => {
    const stub = { observeSessionMarker: vi.fn(async () => ({ status: 'unavailable', reason: 'missing' })), configure: vi.fn(), exec: vi.fn() }
    const client = getAgentSandbox({ getByName: () => stub } as any, 'custody-observer')
    await client.observeSessionMarker(requestDigest)
    expect(stub.observeSessionMarker).toHaveBeenCalledExactlyOnceWith(requestDigest)
    expect(stub.configure).not.toHaveBeenCalled(); expect(stub.exec).not.toHaveBeenCalled()
  })
})


it('rejects historical held ownership before any native operation', async () => {
  const h = await coveredLane()
  await h.storage.put('workspace-mutation-owner', { owner: h.owner, held: {} })
  await expect(h.restart().exec(h.settings, 'forbidden')).rejects.toThrow('mutation state is invalid')
  expect(h.container.exec).not.toHaveBeenCalled()
  expect(h.container.start).not.toHaveBeenCalled()
})

it('preserves an uncertain covered mutation through restart and permanent stop', async () => {
  const h = await coveredLane(), original = h.container.exec.getMockImplementation()!
  await h.sandbox.exec(h.settings, 'setup')
  h.container.exec.mockImplementation(async (argv, options = {}) => {
    const result = await original(argv, options)
    return argv.includes('unknown') ? { output: async () => { throw new Error('lost native output') } } : result
  })
  await expect(h.sandbox.exec(h.settings, 'unknown')).rejects.toThrow('lost native output')
  const restarted = h.restart(), command = '9'.repeat(64)
  await restarted.revoke(command)
  await expect(restarted.stopRevoked(command, 'f'.repeat(64))).resolves.toMatchObject({ physicalZeroVerified: true,
    pendingOperations: [{ kind: 'command', ownerToken: await sha256(h.owner) }] })
  await expect(restarted.exec(h.settings, 'late')).rejects.toThrow('revoked')
})

it('freezes owner input before awaiting and rejects a different owner', async () => {
  const h = await coveredLane(), b = barrier(), put = h.storage.put
  await h.sandbox.exec(h.settings, 'setup')
  const settings = structuredClone(h.settings)
  vi.spyOn(h.storage, 'put').mockImplementationOnce(async (key, value) => { b.reached(); await b.gate; await put(key, value) })
  const call = h.sandbox.exec(settings, 'original owner')
  await b.waiting
  settings.mutationOwner.originDigest = '9'.repeat(64)
  b.release(); await call
  await expect(h.sandbox.exec(settings, 'changed owner')).rejects.toThrow('mutation owner')
  await expect(h.sandbox.destroy(settings.mutationOwner)).rejects.toThrow('mutation owner')
})

it('cleans an admitted covered lane without creating a container', async () => {
  const owner = await birthMutationOwner({ auditId: 'never-born', executionId: 'never-born', epoch: 0,
    runtimeDigest: 'b'.repeat(64) }, 'preflight')
  const h = harness(undefined, await mutationSandboxName(owner))
  const provider = new SandboxAgentProvider({ ...h.env,
    AGENT_SANDBOX: { ...h.env.AGENT_SANDBOX, getByName: () => h.sandbox } } as any)
  await expect(provider.disposeWorkspace({ runId: 'never-born', workspaceKey: 'preflight', mutationOwner: owner }))
    .resolves.toMatchObject({ status: 'destroyed' })
  expect(h.container.start).not.toHaveBeenCalled()
  expect(h.container.destroy).not.toHaveBeenCalled()
})
