import { chmod, readFile, writeFile } from 'node:fs/promises'
import { applyDeploymentOptions } from './deployment-options.mjs'

const declarationFile = process.argv[2]
if (!declarationFile) throw new Error('usage: render-runtime-config.mjs RUNTIME_RELEASE.json')
const runtimeWorkersFile = process.env.ACK3_RUNTIME_WORKERS_FILE
if (!runtimeWorkersFile) throw new Error('ACK3_RUNTIME_WORKERS_FILE is required')
const databaseId = process.env.ACK3_D1_DATABASE_ID ?? ''
const workspaceId = process.env.ACK3_CODEX_WORKSPACE_ID ?? ''
const accountId = process.env.ACK3_CLOUDFLARE_ACCOUNT_ID ?? ''
const buildCommit = process.env.ACK3_BUILD_COMMIT_SHA ?? ''
if (!/^[0-9a-f-]{16,64}$/i.test(databaseId)) throw new Error('ACK3_D1_DATABASE_ID is required')
// Optional: without a Codex login the runtime has no Codex binding and refuses Codex pools.
if (workspaceId !== '' && !/^[A-Za-z0-9_-]{3,128}$/.test(workspaceId)) throw new Error('ACK3_CODEX_WORKSPACE_ID is invalid')
if (!/^[0-9a-f]{32}$/i.test(accountId)) throw new Error('ACK3_CLOUDFLARE_ACCOUNT_ID is required')
if (!/^[0-9a-f]{40}$/.test(buildCommit)) throw new Error('ACK3_BUILD_COMMIT_SHA is required')

const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const config = JSON.parse(source
  .replace('set-by-terraform-output', databaseId)
  .replace('set-by-cloudflare-environment', workspaceId))
const declaration = JSON.parse(await readFile(declarationFile, 'utf8'))
const runtimeWorkers = JSON.parse(await readFile(runtimeWorkersFile, 'utf8'))
const required = ['schemaVersion', 'id', 'frameworkCommit', 'workerService', 'workflowName', 'containerImageDigest']
if (declaration?.schemaVersion !== 1
  || JSON.stringify(Object.keys(declaration).sort()) !== JSON.stringify(required.sort())
  || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(declaration.id ?? '')
  || !/^[0-9a-f]{40}$/.test(declaration.frameworkCommit ?? '')
  || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(declaration.workerService ?? '')
  || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(declaration.workflowName ?? '')
  || !/^sha256:[0-9a-f]{64}$/.test(declaration.containerImageDigest ?? '')) {
  throw new Error('runtime release declaration is invalid')
}
if (runtimeWorkers === null || typeof runtimeWorkers !== 'object' || Array.isArray(runtimeWorkers)
  || runtimeWorkers[declaration.id] !== declaration.workerService) {
  throw new Error('runtime release Worker must match the Terraform output')
}
if (declaration.frameworkCommit !== buildCommit) {
  throw new Error('runtime release framework commit must match ACK3_BUILD_COMMIT_SHA')
}

config.name = declaration.workerService
config.vars = {
  ACK3_CODEX_WORKSPACE_ID: workspaceId,
  ENGINE_ROLE: 'runtime',
  ACK3_CLOUDFLARE_ACCOUNT_ID: accountId,
  RUNTIME_RELEASE_JSON: JSON.stringify(declaration),
}
config.define = { __ACK3_RUNTIME_BUILD_COMMIT_SHA__: JSON.stringify(buildCommit) }
const secretsStoreId = process.env.ACK3_SECRETS_STORE_ID
if (!/^[0-9a-f]{32}$/i.test(secretsStoreId ?? '')) throw new Error('ACK3_SECRETS_STORE_ID is required')
const engineBindings = [
  ...(workspaceId === '' ? [] : [['ACK3_CODEX_AUTH_JSON', 'swarm-codex-auth-json']]),
  ['EXA_API_KEY', 'swarm-exa-api-key'],
  ['CLOUDFLARE_OBSERVABILITY_TOKEN', 'swarm-cloudflare-observability-token'],
]
// Model provider keys and subscription accounts come from Terraform's runtime_secret_bindings output.
const runtimeBindings = JSON.parse(process.env.ACK3_RUNTIME_SECRET_BINDINGS ?? '{}')
if (runtimeBindings === null || typeof runtimeBindings !== 'object' || Array.isArray(runtimeBindings)
  || Object.entries(runtimeBindings).some(([binding, name]) =>
    !/^(CLAUDE_[A-Z0-9_]*OAUTH_TOKEN|CODEX_[A-Z0-9_]*AUTH_JSON|[A-Z][A-Z0-9_]{0,119}_API_KEY)$/.test(binding)
    || engineBindings.some(([reserved]) => reserved === binding)
    || typeof name !== 'string' || !/^swarm-[a-z0-9-]{1,100}$/.test(name))) {
  throw new Error('ACK3_RUNTIME_SECRET_BINDINGS must contain Terraform runtime binding names')
}
config.secrets_store_secrets = [...engineBindings, ...Object.entries(runtimeBindings)]
  .map(([binding, secret_name]) => ({ binding, store_id: secretsStoreId, secret_name }))
config.secrets.required = []
config.version_metadata = { binding: 'VERSION_METADATA' }
config.durable_objects = {
  bindings: [{ name: 'Sandbox', class_name: 'Sandbox' }],
}
config.migrations = [{ tag: 'v1', new_sqlite_classes: ['Sandbox'] }]
if (!Array.isArray(config.containers) || config.containers.length !== 1
  || config.containers[0]?.class_name !== 'Sandbox') {
  throw new Error('base Sandbox container configuration is invalid')
}
config.containers[0].image = `registry.cloudflare.com/${accountId}/swarm-sandbox@${declaration.containerImageDigest}`
config.workflows = [
  { binding: 'AUDIT_WORKFLOW', name: declaration.workflowName, class_name: 'AuditWorkflow' },
  {
    binding: 'RUNTIME_ISOLATION_WORKFLOW',
    name: `${declaration.workflowName}-isolation`,
    class_name: 'RuntimeIsolationWorkflow',
  },
]
delete config.services
applyDeploymentOptions(config, process.env, { containers: true })

const output = new URL(`../wrangler.runtime.${declaration.id}.jsonc`, import.meta.url)
const rendered = `${JSON.stringify(config, null, 2)}\n`
if (rendered.includes('set-by-')) throw new Error('runtime configuration still contains placeholders')
await writeFile(output, rendered, { mode: 0o600 })
await chmod(output, 0o600)
console.log(`wrote owner-only ${output.pathname.split('/').at(-1)}`)
