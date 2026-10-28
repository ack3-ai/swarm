import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runtimeCatalogFromBindings } from '../src/runtime-release.js'

const engine = new URL('..', import.meta.url).pathname
const deployOutput = join(engine, 'wrangler.deploy.jsonc')
const runtimeOutput = join(engine, 'wrangler.runtime.runtime-a.jsonc')
const runtimeBOutput = join(engine, 'wrangler.runtime.runtime-b.jsonc')
const roots: string[] = []

afterEach(() => {
  for (const path of [deployOutput, runtimeOutput, runtimeBOutput]) rmSync(path, { force: true })
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function environment(runtimeWorkersFile: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    ACK3_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
    ACK3_CLOUDFLARE_ACCOUNT_ID: 'e'.repeat(32),
    ACK3_BUILD_COMMIT_SHA: 'a'.repeat(40),
    ACK3_SECRETS_STORE_ID: 'c'.repeat(32),
    ACK3_CODEX_WORKSPACE_ID: 'workspace-fixture',
    ACK3_RUNTIME_WORKERS_FILE: runtimeWorkersFile,
    ACK3_DASHBOARD_ACCESS_ISSUER: 'https://example-team.cloudflareaccess.com',
    ACK3_DASHBOARD_ACCESS_AUDIENCE: 'a'.repeat(64),
    ACK3_DASHBOARD_ACCESS_EMAILS: '@example.com',
    ...extra,
  }
}

describe('runtime release deployment config', () => {
  it('renders one private runtime with its own Workflow and Sandbox namespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-config-'))
    roots.push(root)
    const declaration = {
      schemaVersion: 1,
      id: 'runtime-a',
      frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a',
      workflowName: 'ack3-audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }
    const declarationPath = join(root, 'runtime.json')
    writeFileSync(declarationPath, JSON.stringify(declaration))
    const workersPath = join(root, 'runtime-workers.json')
    writeFileSync(workersPath, JSON.stringify({
      'runtime-a': 'swarm-runtime-a',
      'runtime-b': 'swarm-runtime-b',
    }))

    execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
      cwd: engine,
      env: environment(workersPath, { ACK3_RUNTIME_SECRET_BINDINGS: JSON.stringify({
        CODEX_TEAM_AUTH_JSON: 'swarm-codex-team', PROVIDER_API_KEY: 'swarm-provider-api-key',
      }) }),
      stdio: 'pipe',
    })
    const config = JSON.parse(readFileSync(runtimeOutput, 'utf8'))
    expect(config).toMatchObject({
      name: 'swarm-runtime-a',
      workers_dev: false,
      preview_urls: false,
      vars: { ENGINE_ROLE: 'runtime', ACK3_CLOUDFLARE_ACCOUNT_ID: 'e'.repeat(32) },
      version_metadata: { binding: 'VERSION_METADATA' },
      durable_objects: { bindings: [{ name: 'Sandbox', class_name: 'Sandbox' }] },
    })
    expect(config.durable_objects.bindings).toHaveLength(1)
    expect(config.secrets.required).toEqual([])
    expect(config.r2_buckets).toEqual([
      { binding: 'PACKAGES', bucket_name: 'ack3-experiment-packages' },
      { binding: 'ARTIFACTS', bucket_name: 'ack3-experiment-artifacts' },
    ])
    expect(config.secrets_store_secrets).toContainEqual({ binding: 'CODEX_TEAM_AUTH_JSON', store_id: 'c'.repeat(32), secret_name: 'swarm-codex-team' })
    expect(config.secrets_store_secrets).toContainEqual({ binding: 'PROVIDER_API_KEY', store_id: 'c'.repeat(32), secret_name: 'swarm-provider-api-key' })
    expect(config.routes).toBeUndefined()
    expect(config.containers).toHaveLength(1)
    expect(config.containers[0].instance_type.memory_mib).toBe(8_192)
    expect(config.containers[0].max_instances).toBe(4)
    expect(config.containers[0].constraints).toBeUndefined()
    expect(config.vars.LOCATION_HINT).toBeUndefined()
    expect(config.containers[0].image).toBe(
      `registry.cloudflare.com/${'e'.repeat(32)}/swarm-sandbox@sha256:${'b'.repeat(64)}`,
    )
    expect(config.workflows).toEqual([
      { binding: 'AUDIT_WORKFLOW', name: 'ack3-audit-workflow-a', class_name: 'AuditWorkflow' },
      {
        binding: 'RUNTIME_ISOLATION_WORKFLOW',
        name: 'ack3-audit-workflow-a-isolation',
        class_name: 'RuntimeIsolationWorkflow',
      },
    ])

    const declarationB = {
      ...declaration,
      id: 'runtime-b',
      frameworkCommit: 'c'.repeat(40),
      workerService: 'swarm-runtime-b',
      workflowName: 'ack3-audit-workflow-b',
      containerImageDigest: `sha256:${'d'.repeat(64)}`,
    }
    const declarationBPath = join(root, 'runtime-b.json')
    writeFileSync(declarationBPath, JSON.stringify(declarationB))
    execFileSync('node', ['tools/render-runtime-config.mjs', declarationBPath], {
      cwd: engine,
      env: environment(workersPath, { ACK3_BUILD_COMMIT_SHA: 'c'.repeat(40) }),
      stdio: 'pipe',
    })
    const configB = JSON.parse(readFileSync(runtimeBOutput, 'utf8'))
    expect(configB.name).toBe('swarm-runtime-b')
    expect(configB.name).not.toBe(config.name)
    expect(configB.workflows.map((workflow: { name: string }) => workflow.name)).toEqual([
      'ack3-audit-workflow-b',
      'ack3-audit-workflow-b-isolation',
    ])
    expect(configB.workflows).not.toEqual(config.workflows)
  })

  it('applies optional data jurisdiction, placement and container capacity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-options-'))
    roots.push(root)
    const declarationPath = join(root, 'runtime.json')
    const workersPath = join(root, 'workers.json')
    writeFileSync(declarationPath, JSON.stringify({
      schemaVersion: 1, id: 'runtime-a', frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a', workflowName: 'audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }))
    writeFileSync(workersPath, JSON.stringify({ 'runtime-a': 'swarm-runtime-a' }))
    const options = { ACK3_DATA_JURISDICTION: 'fedramp', ACK3_LOCATION_HINT: 'enam',
      ACK3_CONTAINER_REGIONS: 'ENAM,WNAM', ACK3_CONTAINER_MAX_INSTANCES: '12' }
    execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
      cwd: engine, env: environment(workersPath, options), stdio: 'pipe',
    })
    const config = JSON.parse(readFileSync(runtimeOutput, 'utf8'))
    expect(config.r2_buckets.map((bucket: { jurisdiction?: string }) => bucket.jurisdiction)).toEqual(['fedramp', 'fedramp'])
    expect(config.containers[0]).toMatchObject({ max_instances: 12, constraints: { regions: ['ENAM', 'WNAM'], jurisdiction: 'fedramp' } })
    expect(config.vars.LOCATION_HINT).toBe('enam')
    for (const invalid of [{ ACK3_DATA_JURISDICTION: 'us' }, { ACK3_LOCATION_HINT: 'mars' },
      { ACK3_CONTAINER_REGIONS: 'enam' }, { ACK3_CONTAINER_REGIONS: 'MARS' }, { ACK3_CONTAINER_MAX_INSTANCES: '0' }]) {
      expect(() => execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
        cwd: engine, env: environment(workersPath, invalid), stdio: 'pipe',
      })).toThrow()
    }
  })

  it('requires official Secrets Store credentials without a local runtime secrets file', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-store-'))
    roots.push(root)
    const declarationPath = join(root, 'runtime.json')
    const workersPath = join(root, 'workers.json')
    writeFileSync(declarationPath, JSON.stringify({
      schemaVersion: 1, id: 'runtime-a', frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a', workflowName: 'ack3-audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }))
    writeFileSync(workersPath, JSON.stringify({ 'runtime-a': 'swarm-runtime-a' }))
    const storeId = 'c'.repeat(32)
    expect(() => execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
      cwd: engine, env: environment(workersPath, { ACK3_SECRETS_STORE_ID: '' }), stdio: 'pipe',
    })).toThrow()
    execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
      cwd: engine, env: environment(workersPath, { ACK3_SECRETS_STORE_ID: storeId }), stdio: 'pipe',
    })
    const config = JSON.parse(readFileSync(runtimeOutput, 'utf8'))
    expect(config.secrets.required).toEqual([])
    expect(config.secrets_store_secrets).toEqual([
      { binding: 'ACK3_CODEX_AUTH_JSON', store_id: storeId, secret_name: 'swarm-codex-auth-json' },
      { binding: 'EXA_API_KEY', store_id: storeId, secret_name: 'swarm-exa-api-key' },
      { binding: 'CLOUDFLARE_OBSERVABILITY_TOKEN', store_id: storeId, secret_name: 'swarm-cloudflare-observability-token' },
    ])
    for (const invalid of [{ EXA_API_KEY: 'swarm-other-exa' }, { PROVIDER_TOKEN: 'swarm-provider' }, { PROVIDER_API_KEY: 'provider' }]) {
      expect(() => execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], {
        cwd: engine, env: environment(workersPath, { ACK3_RUNTIME_SECRET_BINDINGS: JSON.stringify(invalid) }), stdio: 'pipe',
      })).toThrow()
    }
  })

  it('renders runtimes and the front door without a Codex login when none is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-no-codex-'))
    roots.push(root)
    const declaration = {
      schemaVersion: 1, id: 'runtime-a', frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a', workflowName: 'ack3-audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }
    const declarationPath = join(root, 'runtime.json')
    const workersPath = join(root, 'runtime-workers.json')
    const catalogPath = join(root, 'catalog.json')
    writeFileSync(declarationPath, JSON.stringify(declaration))
    writeFileSync(workersPath, JSON.stringify({ 'runtime-a': 'swarm-runtime-a' }))
    writeFileSync(catalogPath, JSON.stringify({ schemaVersion: 1, latest: 'runtime-a',
      releases: { 'runtime-a': { ...declaration, binding: 'RUNTIME_A' } } }))
    const env = environment(workersPath, { ACK3_CODEX_WORKSPACE_ID: '', ACK3_RUNTIME_CATALOG_FILE: catalogPath })
    execFileSync('node', ['tools/render-runtime-config.mjs', declarationPath], { cwd: engine, env, stdio: 'pipe' })
    const runtime = JSON.parse(readFileSync(runtimeOutput, 'utf8'))
    expect(runtime.vars.ACK3_CODEX_WORKSPACE_ID).toBe('')
    expect(runtime.secrets_store_secrets.map((binding: { binding: string }) => binding.binding))
      .toEqual(['EXA_API_KEY', 'CLOUDFLARE_OBSERVABILITY_TOKEN'])
    execFileSync('node', ['tools/render-deploy-config.mjs'], { cwd: engine, env, stdio: 'pipe' })
    expect(JSON.parse(readFileSync(deployOutput, 'utf8')).vars.ACK3_CODEX_WORKSPACE_ID).toBe('')
    for (const tool of ['tools/render-runtime-config.mjs', 'tools/render-deploy-config.mjs']) {
      expect(() => execFileSync('node', [tool, declarationPath], {
        cwd: engine, env: { ...env, ACK3_CODEX_WORKSPACE_ID: 'x' }, stdio: 'pipe',
      })).toThrow()
    }
  })

  it('renders the front door with retained named runtime service bindings', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-catalog-'))
    roots.push(root)
    const declaration = {
      schemaVersion: 1,
      id: 'runtime-a',
      frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a',
      workflowName: 'ack3-audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }
    const catalog = {
      schemaVersion: 1,
      latest: 'runtime-a',
      releases: { 'runtime-a': { ...declaration, binding: 'RUNTIME_A' } },
    }
    const catalogPath = join(root, 'catalog.json')
    writeFileSync(catalogPath, JSON.stringify(catalog))
    const workersPath = join(root, 'runtime-workers.json')
    writeFileSync(workersPath, JSON.stringify({ 'runtime-a': 'swarm-runtime-a' }))

    execFileSync('node', ['tools/render-deploy-config.mjs'], {
      cwd: engine,
      env: environment(workersPath, { ACK3_RUNTIME_CATALOG_FILE: catalogPath }),
      stdio: 'pipe',
    })
    const config = JSON.parse(readFileSync(deployOutput, 'utf8'))
    expect(config.workers_dev).toBe(true)
    expect(config.preview_urls).toBe(false)
    expect(config.vars).toMatchObject({
      ENGINE_ROLE: 'front-door',
      DASHBOARD_ACCESS_ISSUER: 'https://example-team.cloudflareaccess.com',
      DASHBOARD_ACCESS_AUDIENCE: 'a'.repeat(64),
      DASHBOARD_ACCESS_EMAILS: '@example.com',
      RUNTIME_CATALOG_JSON: JSON.stringify(catalog),
    })
    for (const invalid of [
      { ACK3_DASHBOARD_ACCESS_ISSUER: '' }, { ACK3_DASHBOARD_ACCESS_AUDIENCE: 'not-an-audience' },
      { ACK3_DASHBOARD_ACCESS_EMAILS: '' }, { ACK3_DASHBOARD_ACCESS_EMAILS: 'example.com' },
    ]) {
      expect(() => execFileSync('node', ['tools/render-deploy-config.mjs'], {
        cwd: engine, env: environment(workersPath, { ACK3_RUNTIME_CATALOG_FILE: catalogPath, ...invalid }), stdio: 'pipe',
      })).toThrow()
    }
    expect(config.services).toEqual([{ binding: 'RUNTIME_A', service: 'swarm-runtime-a' }])
    expect(config.version_metadata).toEqual({ binding: 'VERSION_METADATA' })
    expect(config.secrets.required).toEqual(['CONTROL_API_TOKEN'])
    expect(config.durable_objects.bindings).toEqual([
      { name: 'COORDINATORS', class_name: 'ExperimentCoordinator' },
    ])
    expect(config.containers).toBeUndefined()
    expect(config.workflows).toBeUndefined()
  })

  it('losslessly renders a catalog above 5 KiB with every historical binding retained', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-large-catalog-'))
    roots.push(root)
    const releases = Object.fromEntries(Array.from({ length: 24 }, (_, index) => {
      const id = `runtime-${index}`
      return [id, {
        schemaVersion: 1, id, frameworkCommit: 'a'.repeat(40),
        workerService: `swarm-${id}`, workflowName: `ack3-audit-${id}`,
        containerImageDigest: `sha256:${'b'.repeat(64)}`, binding: `RUNTIME_${index}`,
      }]
    }))
    const catalog = { schemaVersion: 1, latest: 'runtime-23', releases }
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(5120)
    const catalogPath = join(root, 'catalog.json')
    const workersPath = join(root, 'runtime-workers.json')
    writeFileSync(catalogPath, JSON.stringify(catalog))
    writeFileSync(workersPath, JSON.stringify(Object.fromEntries(
      Object.values(releases).map(release => [release.id, release.workerService]),
    )))
    execFileSync('node', ['tools/render-deploy-config.mjs'], {
      cwd: engine, env: environment(workersPath, { ACK3_RUNTIME_CATALOG_FILE: catalogPath }), stdio: 'pipe',
    })
    const config = JSON.parse(readFileSync(deployOutput, 'utf8'))
    expect(JSON.parse(config.vars.RUNTIME_CATALOG_JSON).runtimeCatalogParts).toBeGreaterThan(1)
    for (const value of Object.values(config.vars)) {
      expect(Buffer.byteLength(value as string)).toBeLessThanOrEqual(5120)
    }
    expect(runtimeCatalogFromBindings(config.vars)).toEqual(catalog)
    expect(config.services).toEqual(Object.values(releases).map(release => ({
      binding: release.binding, service: release.workerService,
    })))
    writeFileSync(catalogPath, JSON.stringify({ ...catalog, latest: 'runtime-missing' }))
    expect(() => execFileSync('node', ['tools/render-deploy-config.mjs'], {
      cwd: engine, env: environment(workersPath, { ACK3_RUNTIME_CATALOG_FILE: catalogPath }), stdio: 'pipe',
    })).toThrow()
  })

  it('fails closed without a runtime catalog, including the retired monolith mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-runtime-migration-'))
    roots.push(root)
    const workersPath = join(root, 'runtime-workers.json')
    writeFileSync(workersPath, '{}')
    expect(() => execFileSync('node', ['tools/render-deploy-config.mjs'], {
      cwd: engine,
      env: environment(workersPath),
      stdio: 'pipe',
    })).toThrow()
    expect(() => execFileSync('node', ['tools/render-deploy-config.mjs'], {
      cwd: engine,
      env: environment(workersPath, { ACK3_ENGINE_ROLE: 'legacy-monolith' }),
      stdio: 'pipe',
    })).toThrow()
  })
})
