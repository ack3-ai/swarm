import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error Container modules intentionally remain dependency-free JavaScript.
import { codexAuthCredentials, createAgentLogWriter, credentialsFromJson } from '../container/agent-log-writer.mjs'

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
