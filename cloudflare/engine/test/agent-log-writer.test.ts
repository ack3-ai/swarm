import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Container modules intentionally remain dependency-free JavaScript.
import { codexAuthCredentials, createAgentLogWriter, credentialsFromJson, redactionCredentials, replaceCredentials } from '../container/agent-log-writer.mjs'
// @ts-expect-error Container modules intentionally remain dependency-free JavaScript.
import { subscriptionWaitStatusReader } from '../container/subscription-limits.mjs'
import { parseLocalAgentLog } from '../src/agent-execution-log.js'

describe('container agent log capture', () => {
  it('preserves both streams while redacting a credential split across chunks', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-log-'))
    try {
      const path = join(directory, 'capture.jsonl')
      const writer = createAgentLogWriter(path, {
        PROVIDER_C_API_KEY: 'split-private-credential',
        HARMLESS_CONFIGURATION: 'visible-setting',
      }, () => '2026-09-26T12:00:00.000Z')
      writer.write('stdout', 'before split-private-')
      writer.write('stdout', 'credential after\n')
      writer.write('stderr', 'diagnostic\n')
      await writer.close()
      const source = await readFile(path, 'utf8')
      const events = source.trim().split('\n').map(line => JSON.parse(line))
      expect(events.map(event => event.stream)).toContain('stdout')
      expect(events.map(event => event.stream)).toContain('stderr')
      expect(events.filter(event => event.stream === 'stdout').map(event => event.text).join(''))
        .toBe('before <redacted:PROVIDER_C_API_KEY> after\n')
      expect(source).not.toContain('split-private-credential')
      expect(source).not.toContain('visible-setting')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('never turns an unavailable capture destination into an execution error', async () => {
    const writer = createAgentLogWriter('/missing-parent/agent-log.jsonl', { API_TOKEN: 'private-token' })
    expect(() => writer.write('stdout', 'still executes')).not.toThrow()
    await expect(writer.close()).resolves.toBeUndefined()
  })

  it('redacts nested auth-file tokens without adding them to the child environment', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-auth-log-'))
    try {
      const path = join(directory, 'capture.jsonl')
      const credentials = credentialsFromJson(JSON.stringify({
        tokens: { access_token: 'private-access-token', refresh_token: 'private-refresh-token' },
        account: { id_token: 'private-id-token' },
      }))
      const writer = createAgentLogWriter(path, {}, () => '2026-09-26T12:00:00.000Z', credentials)
      writer.write('stderr', 'private-access-token / private-refresh-token / private-id-token')
      await writer.close()
      const source = await readFile(path, 'utf8')
      expect(source).not.toContain('private-access-token')
      expect(source).not.toContain('private-refresh-token')
      expect(source).not.toContain('private-id-token')
      expect(source).toContain('<redacted:ACK3_CODEX_AUTH_TOKENS_ACCESS_TOKEN>')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('gives the runner the log writer\'s own credential list and replacement, for the stderr it puts in the result (T3)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-stderr-'))
    try {
      const env = { PROVIDER_C_API_KEY: 'private-provider-key', GH_TOKEN: 'private-gh-token-value', HARMLESS: 'visible-value' }
      const codex = credentialsFromJson(JSON.stringify({ tokens: { access_token: 'private-access-token' } }))
      const credentials = redactionCredentials(env, [...codex, ...codex])
      expect(credentials.map((item: { name: string }) => item.name))
        .toEqual(['GH_TOKEN', 'ACK3_CODEX_AUTH_TOKENS_ACCESS_TOKEN', 'PROVIDER_C_API_KEY'])
      const stderr = 'failed: private-provider-key, private-gh-token-value, private-access-token, visible-value\n'
      const path = join(directory, 'capture.jsonl')
      const writer = createAgentLogWriter(path, env, () => '2026-09-26T12:00:00.000Z', codex)
      writer.write('stderr', stderr)
      await writer.close()
      const logged = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line).text).join('')
      expect(replaceCredentials(stderr, credentials)).toBe(logged)
      expect(logged).toBe('failed: <redacted:PROVIDER_C_API_KEY>, <redacted:GH_TOKEN>, '
        + '<redacted:ACK3_CODEX_AUTH_TOKENS_ACCESS_TOKEN>, visible-value\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('agent runner redacts the stderr it puts in the result with that list, the Codex login before and after the launches (T3)', async () => {
    const source = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
    const launchLoginAt = source.indexOf('const launchCodexCredentials = await codexAuthCredentials()')
    const firstLaunchAt = source.indexOf("execute('setpriv'")
    const listAt = source.indexOf('const credentials = redactionCredentials(process.env, [...launchCodexCredentials, ...await codexAuthCredentials()])')
    const lastLaunchAt = source.lastIndexOf("execute('setpriv'")
    const resultAt = source.indexOf('const result = {')
    expect(launchLoginAt).toBeGreaterThan(-1)
    expect(firstLaunchAt).toBeGreaterThan(launchLoginAt)
    expect(listAt).toBeGreaterThan(lastLaunchAt)
    expect(resultAt).toBeGreaterThan(listAt)
    expect(source.slice(resultAt)).toContain('stderr: replaceCredentials(execution.stderr, credentials).slice(-20_000),')
    expect(source).not.toContain('stderr: execution.stderr.slice(')
  })

  it('reads auth tokens from the installed Codex login after the staged file is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-auth-installed-'))
    try {
      const installed = join(directory, 'auth.json')
      await writeFile(installed, JSON.stringify({ tokens: { access_token: 'installed-access-token' } }))
      const credentials = await codexAuthCredentials([installed, join(directory, 'removed-staged-auth.json')])
      expect(credentials).toEqual([{ name: 'ACK3_CODEX_AUTH_TOKENS_ACCESS_TOKEN', value: 'installed-access-token' }])
      expect(await codexAuthCredentials([join(directory, 'missing.json')])).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('container quota wait status', () => {
  const started = JSON.stringify({ type: 'subscription_wait_started', provider: 'claude', sessionId: 'session-1',
    startedAt: '2026-11-06T09:00:00.000Z', resetsAt: '2026-11-10T08:00:00.000Z' }) + '\n'

  it('records the wait ahead of the stream tail the redactor still holds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-wait-log-'))
    try {
      const path = join(directory, 'capture.jsonl')
      const writer = createAgentLogWriter(path, { CLAUDE_CODE_OAUTH_TOKEN: 'private-subscription-token-value' },
        () => '2026-11-06T09:00:01.000Z')
      writer.write('stdout', started)
      writer.status({ provider: 'claude', resetsAt: '2026-11-10T08:00:00Z' })
      for (const invalid of [{ provider: 'codex', resetsAt: null }, { provider: 'claude', resetsAt: 'later' },
        { provider: 'claude' }, null]) writer.status(invalid)
      await writer.close()
      writer.status({ provider: 'claude', resetsAt: null })
      const source = await readFile(path, 'utf8')
      const lines = source.trim().split('\n').map(line => JSON.parse(line))
      const statusAt = lines.findIndex(line => line.kind === 'subscription-wait')
      expect(lines.filter(line => line.kind === 'subscription-wait')).toEqual([{ schemaVersion: 1,
        kind: 'subscription-wait', at: '2026-11-06T09:00:01.000Z', provider: 'claude', resetsAt: '2026-11-10T08:00:00.000Z' }])
      // The held tail reaches the file only when more output (here: close) releases it.
      expect(statusAt).toBeGreaterThan(0)
      expect(statusAt).toBeLessThan(lines.length - 1)
      expect(lines.filter(line => line.stream === 'stdout').map(line => line.text).join('')).toBe(started)
      expect(parseLocalAgentLog(source, true)).toMatchObject({ truncated: false,
        subscriptionWait: { provider: 'claude', since: '2026-11-06T09:00:01.000Z', resetsAt: '2026-11-10T08:00:00.000Z' } })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('agent runner reports waits from raw Claude runner stdout, beside the redacted capture', async () => {
    const source = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
    const readerAt = source.indexOf("request.backend === 'claude' ? subscriptionWaitStatusReader() : null")
    const captureAt = source.indexOf("logWriter.write('stdout', text)")
    const statusAt = source.indexOf('for (const status of waitStatuses?.(text) ?? []) logWriter.status(status)')
    expect(readerAt).toBeGreaterThan(-1)
    expect(captureAt).toBeGreaterThan(readerAt)
    expect(statusAt).toBeGreaterThan(captureAt)
  })

  it('reads Claude wait lines across chunks and skips other or oversized lines', () => {
    const read = subscriptionWaitStatusReader(200)
    expect(read(started.slice(0, 40))).toEqual([])
    expect(read(started.slice(40))).toEqual([{ provider: 'claude', resetsAt: '2026-11-10T08:00:00.000Z' }])
    expect(read(JSON.stringify({ type: 'subscription_wait_started', provider: 'dsh',
      resetsAt: '2026-11-10T08:00:00.000Z' }) + '\n' + '{"type":"assistant","text":"subscription_wait"}\n')).toEqual([])
    expect(read('x'.repeat(150))).toEqual([])
    expect(read('y'.repeat(150))).toEqual([])
    // The rest of a line over the bound is skipped, even if it ends like a status.
    expect(read(started)).toEqual([])
    expect(read(JSON.stringify({ type: 'subscription_wait', wait: { provider: 'claude' } }) + '\n'))
      .toEqual([{ provider: 'claude', resetsAt: null }])
  })
})
