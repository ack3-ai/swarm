import { expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sha256 } from '../src/canonical.js'
import type { ArtifactRecord, AvailabilityBoundary, ExecutionConfiguration, ExperimentDefinition } from '../src/contracts.js'
import { applicableAvailabilityBoundaries, importAvailabilityContext } from '../src/execution-availability.js'

async function fixture(reason: AvailabilityBoundary['reason'] = 'provider-credit') {
  const original = compileExperimentConfig(structuredClone(manifest)).definition
  const changedConfig = structuredClone(manifest)
  changedConfig.modelPools.find(pool => pool.id === 'deepseek')!.connection!.baseUrl = 'https://changed.example/v1'
  const changed = compileExperimentConfig(changedConfig).definition
  const definitions = new Map<string, ExperimentDefinition>()
  const reference = async (definition: ExperimentDefinition, release: string): Promise<ExecutionConfiguration> => {
    const ref = { releaseDigest: await sha256(release), definitionDigest: await sha256(definition) }
    definitions.set(ref.releaseDigest, definition)
    return ref
  }
  const a = await reference(original, 'source'), b = await reference(changed, 'replacement'), child = await reference(original, 'child')
  const boundary: AvailabilityBoundary = { provider: 'provider-a', poolId: 'deepseek', sourceTaskId: 'source-task',
    effectiveFromWave: 1, reason, sealedAt: '2026-11-03T00:00:00Z' }
  // Only the producer identity is consumed by this pure route projection. Full
  // artifact/manifest/journal validation belongs to the import integration test.
  const artifact = { taskId: boundary.sourceTaskId } as ArtifactRecord
  const state = { artifacts: [artifact], availabilityBoundaries: [boundary] }
  const resolve = async (ref: ExecutionConfiguration) => {
    const definition = definitions.get(ref.releaseDigest)
    if (definition === undefined || await sha256(definition) !== ref.definitionDigest) throw new Error('unpublished configuration')
    return definition
  }
  return { original, a, b, child, boundary, state, resolve, reference }
}

it('bridges a source boundary to an immutable child route without rewriting evidence', async () => {
  const f = await fixture()
  const same = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), f.child)
  expect(await applicableAvailabilityBoundaries(f.state, f.child, await f.resolve(f.child), same)).toEqual([f.boundary])
  expect(same.entries[0]!.boundary).toEqual(f.boundary)
  const changed = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), f.b)
  expect(await applicableAvailabilityBoundaries(f.state, f.b, await f.resolve(f.b), changed)).toEqual([])
})

it('keeps a broken route inactive after A to B to A through nested forks', async () => {
  const f = await fixture(), imported = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), f.b)
  expect(await applicableAvailabilityBoundaries(f.state, f.b, await f.resolve(f.b), imported)).toEqual([])
  const nested = await importAvailabilityContext(f.state, f.b, await f.resolve(f.b), f.a, imported)
  expect(nested.entries[0]!.route).toBeNull()
  expect(await applicableAvailabilityBoundaries(f.state, f.a, await f.resolve(f.a), nested)).toEqual([])
})

it('retains a boundary through a same-route fork without reading its foreign source configuration', async () => {
  const f = await fixture(), imported = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), f.child)
  const nested = await importAvailabilityContext(f.state, f.child, f.original, f.child, imported)
  expect(await applicableAvailabilityBoundaries(f.state, f.child, f.original, nested)).toEqual([f.boundary])
})

it('rejects historical configuration carriers instead of reinterpreting their routes', async () => {
  const f = await fixture()
  await expect(applicableAvailabilityBoundaries({ ...f.state, configurationHistory: { initial: f.a, amendments: [] } } as any,
    f.a, await f.resolve(f.a))).rejects.toThrow('historical app version')
})

it.each(['budget', 'provider-credit'] as const)('includes limit changes only for %s boundaries', async reason => {
  const f = await fixture(reason), enlarged = structuredClone(f.original)
  enlarged.limits.maxModelCalls++
  const next = await f.reference(enlarged, 'enlarged')
  const imported = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), next)
  expect(await applicableAvailabilityBoundaries(f.state, next, enlarged, imported)).toEqual(reason === 'budget' ? [] : [f.boundary])
})

it('rejects conflicting legacy origins instead of treating them as the child initial release', async () => {
  const f = await fixture()
  await expect(importAvailabilityContext({ ...f.state, availabilityBoundaries: [{ ...f.boundary, configuration: f.b }] },
    f.a, await f.resolve(f.a), f.child)).rejects.toThrow('source configuration is not authorized')
  const artifact = { ...f.state.artifacts[0], execution: f.b } as ArtifactRecord
  await expect(importAvailabilityContext({ ...f.state, artifacts: [artifact] }, f.a, await f.resolve(f.a), f.child))
    .rejects.toThrow('source configuration is not authorized')
  await expect(importAvailabilityContext({ artifacts: [artifact], availabilityBoundaries: [{ ...f.boundary, configuration: f.a }] },
    f.a, await f.resolve(f.a), f.child)).rejects.toThrow('differs from its source execution')
})

it('requires exact imported boundary records and their producer artifacts on replay', async () => {
  const f = await fixture(), imported = await importAvailabilityContext(f.state, f.a, await f.resolve(f.a), f.child)
  await expect(applicableAvailabilityBoundaries({ ...f.state, availabilityBoundaries: [] }, f.child, await f.resolve(f.child), imported)).rejects.toThrow('evidence is missing')
  await expect(applicableAvailabilityBoundaries({ ...f.state, artifacts: [] }, f.child, await f.resolve(f.child), imported)).rejects.toThrow('source artifact is missing')
  await expect(applicableAvailabilityBoundaries({ ...f.state, availabilityBoundaries: [{ ...f.boundary, effectiveFromWave: 99 }] }, f.child, await f.resolve(f.child), imported))
    .rejects.toThrow('evidence is missing')
})

it('rejects a definition that differs from the selected availability configuration', async () => {
  const f = await fixture(), imported = await importAvailabilityContext(f.state, f.a, f.original, f.child)
  await expect(applicableAvailabilityBoundaries(f.state, f.child, await f.resolve(f.b), imported))
    .rejects.toThrow('definition digest differs')
})
