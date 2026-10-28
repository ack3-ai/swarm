import { execFileSync } from 'node:child_process'
import { chmod, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// These claims catch an operator selecting the wrong login. They are not a
// substitute for the provider verifying the tokens during authentication.
export function assertCodexIdentity(source, workspaceId, email) {
  const fail = () => { throw new Error('Codex credentials must belong to the configured account email and workspace') }
  if (typeof workspaceId !== 'string' || !/^[a-f0-9-]{36}$/i.test(workspaceId)) fail()
  if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(email)) fail()
  let auth
  try {
    auth = typeof source === 'string' ? JSON.parse(source) : source
    const decode = token => {
      if (typeof token !== 'string' || token.split('.').length !== 3) fail()
      return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    }
    const identity = decode(auth?.tokens?.id_token)
    const access = decode(auth?.tokens?.access_token)
    if (identity.email !== email
      || (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.trim() !== '')
      || typeof auth.tokens.refresh_token !== 'string' || auth.tokens.refresh_token.trim() === ''
      || [auth.tokens.account_id, identity['https://api.openai.com/auth']?.chatgpt_account_id,
        access['https://api.openai.com/auth']?.chatgpt_account_id].some(account => account !== workspaceId)) fail()
  } catch {
    fail()
  }
  return auth
}

export function assertUnpublishedRuntimeVersions(value) {
  if (!Array.isArray(value)) throw new Error('Wrangler runtime version inventory is invalid')
  if (value.length !== 0) {
    throw new Error('refusing to overwrite a published runtime Worker identity')
  }
}

async function readBoundedAuthStdin() {
  if (process.stdin.isTTY) throw new Error('cloud-bound Codex auth must be piped through stdin')
  let text = ''
  for await (const chunk of process.stdin) {
    text += chunk.toString('utf8')
    if (text.length > 1_048_576) throw new Error('cloud-bound Codex auth input is too large')
  }
  return text
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  const config = process.argv[2]
  if (!config || !/^wrangler\.runtime\.[a-z0-9][a-z0-9-]{2,62}\.jsonc$/.test(config)
    || process.argv[3] !== '--secrets-store-bindings' || process.argv[4] !== undefined) {
    throw new Error('usage: deploy-runtime.mjs wrangler.runtime.<id>.jsonc --secrets-store-bindings')
  }
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required')
  const parsed = JSON.parse(await readFile(new URL(`../${config}`, import.meta.url), 'utf8'))
  if (parsed?.vars?.ENGINE_ROLE !== 'runtime' || parsed?.name === 'swarm') {
    throw new Error('runtime deployment config is invalid')
  }
  // A runtime rendered without ACK3_CODEX_WORKSPACE_ID has no Codex login to check.
  const codex = (parsed.vars?.ACK3_CODEX_WORKSPACE_ID ?? '') !== ''
  const expected = [
    ...(codex ? [['ACK3_CODEX_AUTH_JSON', 'swarm-codex-auth-json']] : []),
    ['EXA_API_KEY', 'swarm-exa-api-key'],
    ['CLOUDFLARE_OBSERVABILITY_TOKEN', 'swarm-cloudflare-observability-token'],
    // Rendered from the same Terraform runtime_secret_bindings output.
    ...Object.entries(JSON.parse(process.env.ACK3_RUNTIME_SECRET_BINDINGS ?? '{}')),
  ]
  const bindings = parsed.secrets_store_secrets
  if (!Array.isArray(bindings) || bindings.length !== expected.length
    || new Set(bindings.map(binding => binding?.store_id)).size !== 1
    || expected.some(([name, secret]) => !bindings.some(binding => binding?.binding === name
      && binding?.secret_name === secret && /^[0-9a-f]{32}$/i.test(binding?.store_id ?? '')))
    || parsed.secrets?.required?.includes('ACK3_CODEX_AUTH_JSON')) {
    throw new Error('runtime Secrets Store bindings are incomplete or invalid')
  }
  // The operator passes the cloud-stored auth in memory, not a local file.
  // Deployment still checks the configured workspace before Wrangler runs.
  if (codex) {
    assertCodexIdentity(await readBoundedAuthStdin(), parsed.vars.ACK3_CODEX_WORKSPACE_ID,
      process.env.ACK3_CODEX_ACCOUNT_EMAIL)
  }
  await chmod(new URL(`../${config}`, import.meta.url), 0o600)
  const versions = JSON.parse(execFileSync(
    'pnpm', ['exec', 'wrangler', 'versions', 'list', '--config', config, '--json'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
  ))
  assertUnpublishedRuntimeVersions(versions)
  execFileSync('pnpm', [
    'exec', 'wrangler', 'deploy', '--config', config,
  ], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'inherit',
  })
}
