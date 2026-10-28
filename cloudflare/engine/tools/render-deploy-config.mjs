import { chmod, readFile, writeFile } from 'node:fs/promises'
import { applyDeploymentOptions } from './deployment-options.mjs'

const databaseId = process.env.ACK3_D1_DATABASE_ID ?? ''
const workspaceId = process.env.ACK3_CODEX_WORKSPACE_ID ?? ''
if (!/^[0-9a-f-]{16,64}$/i.test(databaseId)) throw new Error('ACK3_D1_DATABASE_ID is required')
if (workspaceId !== '' && !/^[A-Za-z0-9_-]{3,128}$/.test(workspaceId)) throw new Error('ACK3_CODEX_WORKSPACE_ID is invalid')

const source = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
const config = JSON.parse(source
  .replace('set-by-terraform-output', databaseId)
  .replace('set-by-cloudflare-environment', workspaceId))
// Dashboard Access identity: the Access team issuer, the Terraform dashboard_access_audience
// output, and comma-separated allowed addresses or @domains.
const accessIssuer = process.env.ACK3_DASHBOARD_ACCESS_ISSUER ?? ''
const accessAudience = process.env.ACK3_DASHBOARD_ACCESS_AUDIENCE ?? ''
const accessEmails = process.env.ACK3_DASHBOARD_ACCESS_EMAILS ?? ''
if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessIssuer)) throw new Error('ACK3_DASHBOARD_ACCESS_ISSUER is required')
if (!/^[a-f0-9]{64}$/.test(accessAudience)) throw new Error('ACK3_DASHBOARD_ACCESS_AUDIENCE is required')
if (accessEmails.split(',').some(entry => !/^[^@\s]*@[^@\s]+$/.test(entry.trim()))) {
  throw new Error('ACK3_DASHBOARD_ACCESS_EMAILS must list addresses or @domains')
}
const catalogFile = process.env.ACK3_RUNTIME_CATALOG_FILE
const requestedRole = process.env.ACK3_ENGINE_ROLE
const rotatingPool = process.env.ACK3_RUNTIME_SLOT_POOL_ENABLED
if (rotatingPool !== undefined && rotatingPool !== '1') {
  throw new Error('ACK3_RUNTIME_SLOT_POOL_ENABLED must be 1 when supplied')
}

// Cloudflare limits each environment variable to 5 KiB. Keep small catalogs
// unchanged and split larger ones without dropping historical runtime routes.
function catalogBindings(catalog) {
  const serialized = JSON.stringify(catalog)
  const encoder = new TextEncoder()
  if (encoder.encode(serialized).length <= 5120) return { RUNTIME_CATALOG_JSON: serialized }
  const chunks = []
  let chunk = '', bytes = 0
  for (const character of serialized) {
    const size = encoder.encode(character).length
    if (bytes + size > 5120) {
      chunks.push(chunk)
      chunk = ''; bytes = 0
    }
    chunk += character; bytes += size
  }
  chunks.push(chunk)
  if (chunks.length > 64) throw new Error('runtime catalog exceeds 64 variable parts')
  return {
    RUNTIME_CATALOG_JSON: JSON.stringify({ runtimeCatalogParts: chunks.length }),
    ...Object.fromEntries(chunks.map((part, index) => [`RUNTIME_CATALOG_JSON_PART_${index}`, part])),
  }
}

if (catalogFile === undefined || catalogFile === '') {
  throw new Error('ACK3_RUNTIME_CATALOG_FILE is required for the front door')
}
if (requestedRole !== undefined && requestedRole !== 'front-door') {
  throw new Error('ACK3_ENGINE_ROLE must be front-door when a runtime catalog is supplied')
}
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'))
const runtimeWorkersFile = process.env.ACK3_RUNTIME_WORKERS_FILE
if (!runtimeWorkersFile) throw new Error('ACK3_RUNTIME_WORKERS_FILE is required with ACK3_RUNTIME_CATALOG_FILE')
const runtimeWorkers = JSON.parse(await readFile(runtimeWorkersFile, 'utf8'))
if (catalog?.schemaVersion !== 1 || typeof catalog.latest !== 'string'
  || catalog.releases === null
  || typeof catalog.releases !== 'object' || Array.isArray(catalog.releases)
  || !Object.hasOwn(catalog.releases, catalog.latest)) {
  throw new Error('runtime catalog is invalid')
}
if (rotatingPool === '1' && Object.keys(catalog.releases).length < 2) {
  throw new Error('the rotating runtime pool requires at least two bound slots')
}
config.vars = {
  ...config.vars,
  ENGINE_ROLE: 'front-door',
  DASHBOARD_ACCESS_ISSUER: accessIssuer,
  DASHBOARD_ACCESS_AUDIENCE: accessAudience,
  DASHBOARD_ACCESS_EMAILS: accessEmails,
  ...(rotatingPool === '1' ? { RUNTIME_SLOT_POOL_ENABLED: '1' } : {}),
  ...catalogBindings(catalog),
}
config.secrets = { required: ['CONTROL_API_TOKEN'] }
config.workers_dev = true
config.version_metadata = { binding: 'VERSION_METADATA' }
config.services = Object.values(catalog.releases).map(release => {
  if (typeof release?.binding !== 'string' || typeof release?.workerService !== 'string') {
    throw new Error('runtime catalog service binding is invalid')
  }
  if (runtimeWorkers?.[release.id] !== release.workerService) {
    throw new Error(`runtime catalog Worker must match the Terraform output: ${release.id}`)
  }
  return { binding: release.binding, service: release.workerService }
})
config.durable_objects.bindings = config.durable_objects.bindings.filter(binding => binding.name === 'COORDINATORS')
if (config.durable_objects.bindings.length !== 1) throw new Error('front-door coordinator binding is invalid')
delete config.containers
delete config.workflows
applyDeploymentOptions(config, process.env, { containers: false })
const rendered = `${JSON.stringify(config, null, 2)}\n`
if (rendered.includes('set-by-')) throw new Error('deploy configuration still contains placeholders')
await writeFile(new URL('../wrangler.deploy.jsonc', import.meta.url), rendered, { mode: 0o600 })
await chmod(new URL('../wrangler.deploy.jsonc', import.meta.url), 0o600)
console.log('wrote owner-only wrangler.deploy.jsonc')
