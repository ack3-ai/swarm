import { describe, expect, it, vi } from 'vitest'
import type { RuntimeRelease } from '../src/contracts.js'
import { RunMachine, runNextWave, sealReleasePackage } from '../src/index.js'
import {
  localRuntimeRelease, parseRuntimeCatalog, pinnedRuntime, resolveRuntimeSelector, RuntimeRouter,
  sameRuntimeRelease, runtimeCatalogFromBindings,
} from '../src/runtime-release.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const declaration = {
  schemaVersion: 1 as const,
  id: 'runtime-a',
  frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-a',
  workflowName: 'ack3-audit-workflow-a',
  containerImageDigest: `sha256:${'b'.repeat(64)}`,
}
const release: RuntimeRelease = {
  ...declaration,
  workerVersionId: '11111111-1111-4111-8111-111111111111',
}
const catalog = {
  schemaVersion: 1,
  latest: 'runtime-a',
  releases: {
    'runtime-a': { ...declaration, binding: 'RUNTIME_A' },
  },
}

function runtime(responseRelease: RuntimeRelease = release) {
  return {
    fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(responseRelease, {
      headers: { 'x-ack3-runtime-worker-version': responseRelease.workerVersionId },
    })),
  }
}

describe('immutable runtime release routing', () => {
  it('resolves latest through a private named runtime binding', async () => {
    const binding = runtime()
    const router = new RuntimeRouter({
      RUNTIME_CATALOG_JSON: JSON.stringify(catalog),
      RUNTIME_A: binding,
    })

    await expect(router.latest()).resolves.toEqual(release)
    expect(binding.fetch).toHaveBeenCalledTimes(1)
    expect(() => parseRuntimeCatalog(JSON.stringify({ ...catalog, legacy: 'runtime-a' }))).toThrow()
  })

  it('refuses a missing explicit release instead of falling back to latest', async () => {
    const router = new RuntimeRouter({
      RUNTIME_CATALOG_JSON: JSON.stringify(catalog),
      RUNTIME_A: runtime(),
    })
    await expect(router.resolve('runtime-gone')).rejects.toThrow('runtime release is unavailable: runtime-gone')
  })

  it('rejects a changed Worker version on a routed request', async () => {
    const binding = runtime({
      ...release,
      workerVersionId: '22222222-2222-4222-8222-222222222222',
    })
    const router = new RuntimeRouter({
      RUNTIME_CATALOG_JSON: JSON.stringify(catalog),
      RUNTIME_A: binding,
    })

    await expect(router.fetch(release, '/internal/runtime/runs/run-a'))
      .rejects.toThrow('runtime release worker version changed: runtime-a')
  })

  it('does not forward front-door credentials through the private runtime binding', async () => {
    const binding = runtime()
    const router = new RuntimeRouter({
      RUNTIME_CATALOG_JSON: JSON.stringify(catalog),
      RUNTIME_A: binding,
    })
    await router.fetch(release, '/internal/runtime/audit-runs', {
      method: 'POST',
      headers: {
        authorization: 'Bearer control-secret',
        cookie: 'CF_Authorization=browser-secret',
        'cf-access-jwt-assertion': 'access-secret',
        'content-type': 'application/json',
      },
      body: '{}',
    })
    const [, init] = binding.fetch.mock.calls[0]!
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('cf-access-jwt-assertion')).toBeNull()
    expect(headers.get('content-type')).toBe('application/json')
  })

  it('binds local identity to Cloudflare Worker version metadata', () => {
    expect(localRuntimeRelease({
      RUNTIME_RELEASE_JSON: JSON.stringify(declaration),
      VERSION_METADATA: {
        id: release.workerVersionId,
        tag: 'runtime-a',
        timestamp: '2026-09-24T00:00:00.000Z',
      },
    })).toEqual(release)
  })

  it('compares runtime identity by fields rather than JSON key order', () => {
    const reordered = {
      workerVersionId: release.workerVersionId,
      containerImageDigest: release.containerImageDigest,
      workflowName: release.workflowName,
      workerService: release.workerService,
      frameworkCommit: release.frameworkCommit,
      id: release.id,
      schemaVersion: 1 as const,
    }
    expect(sameRuntimeRelease(release, reordered)).toBe(true)
  })

  it('rejects malformed or inconsistent catalogs before routing', () => {
    expect(() => parseRuntimeCatalog(JSON.stringify({ ...catalog, latest: 'runtime-missing' })))
      .toThrow('runtime catalog latest release must exist')
    expect(() => parseRuntimeCatalog(JSON.stringify({
      ...catalog,
      releases: { 'runtime-a': { ...catalog.releases['runtime-a'], id: 'runtime-b' } },
    }))).toThrow('runtime catalog entry runtime-a is invalid')
  })

  it('rejects missing, extra, oversized, malformed, and ambiguous variable parts', () => {
    const text = JSON.stringify(catalog)
    const parts = {
      RUNTIME_CATALOG_JSON: JSON.stringify({ runtimeCatalogParts: 2 }),
      RUNTIME_CATALOG_JSON_PART_0: text.slice(0, 50),
      RUNTIME_CATALOG_JSON_PART_1: text.slice(50),
    }
    expect(runtimeCatalogFromBindings(parts)).toEqual(catalog)
    const { RUNTIME_CATALOG_JSON_PART_1: _, ...missing } = parts
    expect(() => runtimeCatalogFromBindings(missing)).toThrow('parts are missing or unexpected')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON_PART_2: 'extra' }))
      .toThrow('parts are missing or unexpected')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON_PART_0: 'x'.repeat(5121) }))
      .toThrow('variable part is invalid')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON_PART_0: null }))
      .toThrow('variable part is invalid')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON_PART_0: '' }))
      .toThrow('variable part is invalid')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON: JSON.stringify(catalog) }))
      .toThrow('unexpected variable parts')
    for (const count of [1, 65, 2.5, '2']) {
      expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON: JSON.stringify({ runtimeCatalogParts: count }) }))
        .toThrow('variable part count is invalid')
    }
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON: JSON.stringify({ runtimeCatalogParts: 2, releases: {} }) }))
      .toThrow('variable manifest has invalid keys')
    expect(() => runtimeCatalogFromBindings({ ...parts, RUNTIME_CATALOG_JSON_PART_1: 'broken' })).toThrow()
    const invalid = JSON.stringify({ ...catalog, latest: 'runtime-missing' })
    expect(() => runtimeCatalogFromBindings({
      ...parts, RUNTIME_CATALOG_JSON_PART_0: invalid.slice(0, 50), RUNTIME_CATALOG_JSON_PART_1: invalid.slice(50),
    })).toThrow('latest release must exist')
  })

  it('seals the exact runtime into checkpoints and preserves it on resume', async () => {
    const sealed = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(
      audit0Definition, sealed.digest, 'runtime-bound-root', new Date().toISOString(), release,
    )
    const checkpoint = await runNextWave({
      definition: audit0Definition,
      machine,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    })
    expect(checkpoint?.body.runtimeRelease).toEqual(release)
    const child = await RunMachine.resume(
      audit0Definition, checkpoint!, 'runtime-bound-child', new Set(), new Date().toISOString(), undefined, release,
    )
    expect(child.snapshot().runtimeRelease).toEqual(release)
    await expect(RunMachine.resume(
      audit0Definition,
      checkpoint!,
      'runtime-mismatch-child',
      new Set(),
      new Date().toISOString(),
      undefined,
      { ...release, workerVersionId: '22222222-2222-4222-8222-222222222222' },
    )).rejects.toThrow('resume runtime release mismatch')
  })

  it('binds a legacy checkpoint to the explicit migration runtime on first resume', async () => {
    const sealed = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, sealed.digest, 'legacy-runtime-root')
    const checkpoint = await runNextWave({
      definition: audit0Definition,
      machine,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    })
    expect(checkpoint?.body.runtimeRelease).toBeUndefined()
    const child = await RunMachine.resume(
      audit0Definition, checkpoint!, 'legacy-runtime-child', new Set(), new Date().toISOString(), undefined, release,
    )
    expect(child.snapshot().runtimeRelease).toEqual(release)
  })

  it('keeps A routable after latest advances to B and binds a child back to A', async () => {
    const declarationB = {
      ...declaration,
      id: 'runtime-b',
      frameworkCommit: 'c'.repeat(40),
      workerService: 'swarm-runtime-b',
      workflowName: 'ack3-audit-workflow-b',
      containerImageDigest: `sha256:${'d'.repeat(64)}`,
    }
    const releaseB: RuntimeRelease = {
      ...declarationB,
      workerVersionId: '22222222-2222-4222-8222-222222222222',
    }
    const runtimeA = runtime(release)
    const runtimeB = runtime(releaseB)
    const catalogText = JSON.stringify({
        schemaVersion: 1,
        latest: 'runtime-b',
        releases: {
          'runtime-a': { ...declaration, binding: 'RUNTIME_A' },
          'runtime-b': { ...declarationB, binding: 'RUNTIME_B' },
        },
      })
    const env = {
      RUNTIME_CATALOG_JSON: JSON.stringify({ runtimeCatalogParts: 2 }),
      RUNTIME_CATALOG_JSON_PART_0: catalogText.slice(0, 50),
      RUNTIME_CATALOG_JSON_PART_1: catalogText.slice(50),
      RUNTIME_A: runtimeA,
      RUNTIME_B: runtimeB,
    }
    const router = new RuntimeRouter(env)

    await expect(router.fetch(release, '/internal/runtime/fixtures/a-child'))
      .resolves.toHaveProperty('ok', true)
    await expect(router.latest()).resolves.toEqual(releaseB)
    await expect(resolveRuntimeSelector({ mode: 'latest' }, router)).resolves.toEqual(releaseB)
    await expect(resolveRuntimeSelector({ mode: 'release', id: release.id }, router)).resolves.toEqual(release)
    await expect(router.resolve(release.id)).resolves.toEqual(release)
    const latestCallsBeforePinnedRetry = runtimeB.fetch.mock.calls.length
    expect(pinnedRuntime(release)).toEqual(release)
    expect(() => pinnedRuntime(undefined)).toThrow('run has no pinned runtime release')
    expect(() => pinnedRuntime(null)).toThrow('run has no pinned runtime release')
    expect(runtimeB.fetch).toHaveBeenCalledTimes(latestCallsBeforePinnedRetry)
    await router.fetch(release, '/internal/runtime/audit-runs/a-root')
    await router.fetch(release, '/internal/runtime/audit-runs/a-root/stop', { method: 'POST' })
    expect(runtimeA.fetch.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      'https://runtime.internal/internal/runtime/audit-runs/a-root',
      'https://runtime.internal/internal/runtime/audit-runs/a-root/stop',
    ]))

    const sealed = await sealReleasePackage(audit0PackageBody)
    const root = await RunMachine.create(
      audit0Definition, sealed.digest, 'a-root', new Date().toISOString(), release,
    )
    const checkpoint = await runNextWave({
      definition: audit0Definition,
      machine: root,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    })
    const child = await RunMachine.resume(
      audit0Definition, checkpoint!, 'a-child', new Set(), new Date().toISOString(), undefined,
      await router.resolve(checkpoint!.body.runtimeRelease!.id),
    )
    expect(child.snapshot().runtimeRelease).toEqual(release)
  })
})
