import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { readDashboardDefinition } from '../src/dashboard-release.js'
import { sealReleasePackage } from '../src/release.js'
import { audit0PackageBody } from './support/audit0-config.js'

async function fixture(change: (body: typeof audit0PackageBody) => void = () => {}) {
  const body = structuredClone(audit0PackageBody)
  change(body)
  const digest = await sha256(body)
  const content = canonicalJson({ digest, body })
  const checksum = await sha256(content)
  const object = {
    text: vi.fn(async () => content),
    customMetadata: { bodySha256: digest, objectSha256: checksum },
    checksums: { toJSON: vi.fn(() => ({ sha256: checksum })) },
  }
  const packages = { get: vi.fn(async () => object as unknown as R2ObjectBody | null) }
  const run = { releaseDigest: digest, definitionDigest: await sha256(body.definition), experimentId: body.definition.id }
  return { body, content, object, packages, run }
}

describe('immutable dashboard release reader', () => {
  it('reads historical prompt contracts rejected by current execution validation without weakening execution', async () => {
    const test = await fixture(body => {
      ;(body.definition.prompts as unknown as Record<string, string>).retiredGuidance = 'Historical instruction'
    })
    await expect(sealReleasePackage(test.body)).rejects.toThrow('unknown keys: retiredGuidance')
    expect(await readDashboardDefinition(test.packages, test.run)).toMatchObject({ stages: test.body.definition.stages })
    expect(test.packages.get).toHaveBeenCalledWith(`releases/sha256/${test.run.releaseDigest}.json`)
  })

  it('projects each run from its exact immutable release instead of the current compiled topology', async () => {
    const historical = await fixture(body => {
      const wave = body.definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]! as any
      const task = structuredClone(wave.tasks[0]!)
      wave.tasks.push({ ...task, id: 'historical-extra-lane', workspaceKey: 'historical-extra-lane' })
    })
    const current = await fixture()
    const objects = new Map([
      [`releases/sha256/${historical.run.releaseDigest}.json`, historical.object],
      [`releases/sha256/${current.run.releaseDigest}.json`, current.object],
    ])
    const packages = {
      get: vi.fn(async (key: string) => objects.get(key) as unknown as R2ObjectBody | null),
    }

    const historicalDefinition = await readDashboardDefinition(packages, historical.run)
    const currentDefinition = await readDashboardDefinition(packages, current.run)
    const taskIds = (definition: typeof historicalDefinition) => definition.stages
      .flatMap(stage => stage.waves).flatMap(wave => wave.tasks).map(task => task.id)
    expect(taskIds(historicalDefinition)).toContain('historical-extra-lane')
    expect(taskIds(currentDefinition)).not.toContain('historical-extra-lane')
    expect(packages.get).toHaveBeenNthCalledWith(1, `releases/sha256/${historical.run.releaseDigest}.json`)
    expect(packages.get).toHaveBeenNthCalledWith(2, `releases/sha256/${current.run.releaseDigest}.json`)
  })

  it('exposes the selected release configuration, preserving historical limits and image', async () => {
    const test = await fixture(body => {
      body.environment = { image: 'registry.example/evm@sha256:' + 'a'.repeat(64) }
      body.definition.forceSearch = { enabled: true, promptSet: 'native-exa-v1' }
      body.definition.forceSearchStages = ['discovery', 'negative-review']
      body.definition.discoverySafetyCeiling = 37
      body.definition.limits.maxWallTimeMs = 123456
    })
    const result = await readDashboardDefinition(test.packages, test.run)
    expect(result.configuration).toMatchObject({ maxDiscoveryWaves: 37,
      forceSearch: true, forceSearchStages: ['discovery', 'negative-review'],
      limits: { maxWallTimeMs: 123456 }, environment: test.body.environment,
      target: test.body.definition.target, pools: test.body.definition.pools })
    expect(result.configuration).not.toHaveProperty('prompts')
    const stages = result.configuration!.stages as any[]
    for (const [index, stage] of test.body.definition.stages.entries()) {
      expect(stages[index].waves).toHaveLength(stage.waves.length)
      for (const [waveIndex, wave] of stage.waves.entries()) {
        expect(stages[index].waves[waveIndex]).toMatchObject({ id: wave.id,
          minSuccessfulTasks: wave.minSuccessfulTasks, minDistinctActors: wave.minDistinctActors,
          tasks: wave.tasks.map(task => ({ id: task.id, model: task.model,
            role: task.promptKind, required: !task.optional })),
        })
      }
    }
    expect(stages.flatMap(stage => stage.waves).length).toBeGreaterThan(1)
  })

  it('rejects invalid bindings before storage and handles missing releases', async () => {
    const test = await fixture()
    await expect(readDashboardDefinition(test.packages, { ...test.run, releaseDigest: '../bad' }))
      .rejects.toThrow('invalid monitoring release binding')
    await expect(readDashboardDefinition(test.packages, { ...test.run, definitionDigest: 'bad' }))
      .rejects.toThrow('invalid monitoring release binding')
    expect(test.packages.get).not.toHaveBeenCalled()
    test.packages.get.mockResolvedValueOnce(null)
    await expect(readDashboardDefinition(test.packages, test.run)).rejects.toThrow('not found')
  })

  it('requires both metadata digests and the stored R2 byte checksum', async () => {
    for (const corrupt of ['bodySha256', 'objectSha256', 'r2', 'content'] as const) {
      const test = await fixture()
      if (corrupt === 'r2') test.object.checksums.toJSON.mockReturnValueOnce({ sha256: '0'.repeat(64) })
      else if (corrupt === 'content') test.object.text.mockResolvedValueOnce(`${test.content} `)
      else test.object.customMetadata[corrupt] = '0'.repeat(64)
      await expect(readDashboardDefinition(test.packages, test.run)).rejects.toThrow('object integrity mismatch')
    }
  })

  it('rejects resealed object bytes whose envelope or body no longer matches the requested release', async () => {
    for (const corrupt of ['envelope', 'body'] as const) {
      const test = await fixture()
      const envelope = JSON.parse(test.content)
      if (corrupt === 'envelope') envelope.digest = '0'.repeat(64)
      else envelope.body.definition.id = 'different-experiment'
      const content = canonicalJson(envelope)
      const checksum = await sha256(content)
      test.object.text.mockResolvedValueOnce(content)
      test.object.customMetadata.objectSha256 = checksum
      test.object.checksums.toJSON.mockReturnValueOnce({ sha256: checksum })
      await expect(readDashboardDefinition(test.packages, test.run)).rejects.toThrow('body integrity mismatch')
    }
  })

  it('binds the definition and experiment to the requested run', async () => {
    const test = await fixture()
    await expect(readDashboardDefinition(test.packages, { ...test.run, definitionDigest: '0'.repeat(64) }))
      .rejects.toThrow('does not belong to this run')
    await expect(readDashboardDefinition(test.packages, { ...test.run, experimentId: 'different-experiment' }))
      .rejects.toThrow('does not belong to this run')
  })

  it('rejects unsupported projection structures even with correct immutable digests', async () => {
    const test = await fixture(body => {
      Object.assign(body.definition.stages[0]!, { waves: null })
    })
    await expect(readDashboardDefinition(test.packages, test.run)).rejects.toThrow('unsupported monitoring stage structure')
  })
})
