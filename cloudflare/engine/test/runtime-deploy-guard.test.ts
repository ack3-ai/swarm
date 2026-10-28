import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error The operator entry point is intentionally plain Node.js.
import { assertCodexIdentity, assertUnpublishedRuntimeVersions } from '../tools/deploy-runtime.mjs'

const workspaceId = '11111111-2222-3333-4444-555555555555'
const accountEmail = 'codex-service@example.com'
function auth(email = accountEmail, accountId = workspaceId) {
  const token = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`
  const account = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }
  return { tokens: {
    id_token: token({ email, ...account }), access_token: token(account),
    refresh_token: 'synthetic-not-a-credential', account_id: accountId,
  } }
}

describe('immutable runtime deployment guard', () => {
  it('accepts the dedicated login only when every account claim matches the configured workspace', () => {
    expect(() => assertCodexIdentity(JSON.stringify(auth()), workspaceId, accountEmail)).not.toThrow()
    expect(() => assertCodexIdentity(JSON.stringify(auth()), workspaceId, undefined)).toThrow('must belong to the configured account')
    for (const invalid of [
      auth('personal@example.test'), auth(accountEmail, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      { ...auth(), OPENAI_API_KEY: 'synthetic-api-key' },
      { tokens: { ...auth().tokens, account_id: 'different-account' } },
      { tokens: { ...auth().tokens, id_token: 'malformed' } },
      { tokens: { ...auth().tokens, access_token: 'malformed' } },
      { tokens: { ...auth().tokens, refresh_token: '' } },
      {},
    ]) expect(() => assertCodexIdentity(invalid, workspaceId, accountEmail)).toThrow('must belong to the configured account')
  })

  it('allows only a Worker identity with no published versions', () => {
    expect(() => assertUnpublishedRuntimeVersions([])).not.toThrow()
    expect(() => assertUnpublishedRuntimeVersions([{ id: 'existing-version' }]))
      .toThrow('refusing to overwrite a published runtime Worker identity')
    expect(() => assertUnpublishedRuntimeVersions({})).toThrow('version inventory is invalid')
  })

  it('deploys verified cloud bindings with auth supplied only through stdin', () => {
    const engine = new URL('..', import.meta.url).pathname
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-cloud-store-'))
    const config = 'wrangler.runtime.test-cloud-store.jsonc'
    const capture = join(root, 'calls.jsonl')
    const storeId = 'a'.repeat(32)
    const bindings = [
      ['ACK3_CODEX_AUTH_JSON', 'swarm-codex-auth-json'],
      ['EXA_API_KEY', 'swarm-exa-api-key'],
      ['CLOUDFLARE_OBSERVABILITY_TOKEN', 'swarm-cloudflare-observability-token'],
      ['PROVIDER_API_KEY', 'swarm-provider-api-key'],
    ].map(([binding, secret_name]) => ({ binding, secret_name, store_id: storeId }))
    try {
      writeFileSync(join(engine, config), JSON.stringify({
        name: 'swarm-test-cloud-store', vars: { ENGINE_ROLE: 'runtime', ACK3_CODEX_WORKSPACE_ID: workspaceId },
        secrets: { required: [] }, secrets_store_secrets: bindings,
      }))
      writeFileSync(join(root, 'pnpm'), `#!/usr/bin/env node
const fs = require('node:fs')
fs.appendFileSync(process.env.ACK3_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.includes('versions')) process.stdout.write('[]')
`)
      chmodSync(join(root, 'pnpm'), 0o700)
      const run = (input: string, token = 'synthetic-cloudflare-token') => execFileSync(process.execPath,
        ['tools/deploy-runtime.mjs', config, '--secrets-store-bindings'], {
          cwd: engine, input, stdio: 'pipe',
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ACK3_TEST_CAPTURE: capture, CLOUDFLARE_API_TOKEN: token,
            ACK3_CODEX_ACCOUNT_EMAIL: accountEmail,
            ACK3_RUNTIME_SECRET_BINDINGS: JSON.stringify({ PROVIDER_API_KEY: 'swarm-provider-api-key' }) },
        })
      for (const invalid of ['', JSON.stringify(auth('personal@example.test')), '{']) {
        expect(() => run(invalid)).toThrow()
      }
      expect(existsSync(capture)).toBe(false)
      expect(() => run(JSON.stringify(auth()), '')).toThrow()
      expect(existsSync(capture)).toBe(false)
      run(JSON.stringify(auth()))
      const calls = readFileSync(capture, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
      const deploy = calls.find(call => call.includes('deploy'))!
      expect(deploy).not.toContain('--secrets-file')
      expect(JSON.stringify(calls)).not.toContain('refresh_token')
      rmSync(capture)
      writeFileSync(join(root, 'pnpm'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.ACK3_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write('[{"id":"already-published"}]')
`)
      expect(() => run(JSON.stringify(auth()))).toThrow()
      expect(readFileSync(capture, 'utf8')).not.toContain('"deploy"')
      rmSync(capture)
      for (const invalidBindings of [[], bindings.slice(1), bindings.map(b => ({ ...b, store_id: '' }))]) {
        writeFileSync(join(engine, config), JSON.stringify({
          name: 'swarm-test-cloud-store', vars: { ENGINE_ROLE: 'runtime', ACK3_CODEX_WORKSPACE_ID: workspaceId },
          secrets_store_secrets: invalidBindings,
        }))
        expect(() => run(JSON.stringify(auth()))).toThrow()
        expect(existsSync(capture)).toBe(false)
      }
      expect(() => execFileSync(process.execPath,
        ['tools/deploy-runtime.mjs', config, '--secrets-file', '/nonexistent'], {
          cwd: engine, stdio: 'pipe',
        })).toThrow()
      // Without a Codex login: no Codex binding and no auth on stdin.
      writeFileSync(join(root, 'pnpm'), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.ACK3_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.argv.includes('versions')) process.stdout.write('[]')
`)
      const withoutCodex = (secrets: typeof bindings) => writeFileSync(join(engine, config), JSON.stringify({
        name: 'swarm-test-cloud-store', vars: { ENGINE_ROLE: 'runtime', ACK3_CODEX_WORKSPACE_ID: '' },
        secrets: { required: [] }, secrets_store_secrets: secrets,
      }))
      withoutCodex(bindings)
      expect(() => run('')).toThrow()
      expect(existsSync(capture)).toBe(false)
      withoutCodex(bindings.slice(1))
      run('')
      expect(readFileSync(capture, 'utf8')).toContain('"deploy"')
    } finally {
      rmSync(join(engine, config), { force: true })
      rmSync(root, { force: true, recursive: true })
    }
  })

})
