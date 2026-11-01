import { describe, expect, it } from 'vitest'
import { CloudflareRunStore, RunMachine, canonicalJson, sealReleasePackage, sha256 } from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'

interface StoredObject {
  content: string
  customMetadata: Record<string, string>
  checksum: string
}

class FakeR2Bucket {
  readonly objects = new Map<string, StoredObject>()

  async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}): Promise<unknown> {
    if (options.onlyIf !== undefined && this.objects.has(key)) return null
    const content = typeof value === 'string' ? value : new TextDecoder().decode(value)
    const checksum = typeof options.sha256 === 'string' ? options.sha256 : await sha256(content)
    this.objects.set(key, { content, customMetadata: options.customMetadata ?? {}, checksum })
    return {}
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    return {
      customMetadata: stored.customMetadata,
      checksums: { toJSON: () => ({ sha256: stored.checksum }) },
      text: async () => stored.content,
    } as unknown as R2ObjectBody
  }

  async head(key: string): Promise<R2Object | null> {
    const stored = this.objects.get(key)
    if (stored === undefined) return null
    return {
      customMetadata: stored.customMetadata,
      checksums: { toJSON: () => ({ sha256: stored.checksum }) },
    } as unknown as R2Object
  }
}

class FakeD1 {
  readonly states = new Map<string, { state_key: string, state_generation: number, status: string }>()
  readonly runRoutes = new Map<string, { experiment_id: string, runtime_release_json: string }>()
  readonly checkpointRoutes = new Map<string, { runtime_release_json: string }>()
  readonly slotLeases = new Map<string, {
    experiment_id: string, slot_id: string, runtime_release_json: string,
    admission_pool_enabled: number
  }>()

  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (sql.includes('INSERT INTO experiment_runs')) {
            const runId = String(values[0])
            const stateKey = String(values[3])
            const generation = Number(values[4])
            const current = this.states.get(runId)
            if (current === undefined || current.status === 'running' && generation > current.state_generation) {
              this.states.set(runId, { state_key: stateKey, state_generation: generation, status: String(values[2]) })
            }
          } else if (sql.includes('INSERT INTO runtime_slot_run_leases')) {
            const runId = String(values[0])
            if (!this.slotLeases.has(runId)) this.slotLeases.set(runId, {
              experiment_id: String(values[1]), slot_id: String(values[2]),
              runtime_release_json: String(values[3]), admission_pool_enabled: 0,
            })
          } else if (sql.includes('INSERT INTO run_runtime_routes')) {
            const runId = String(values[0])
            if (this.runRoutes.has(runId) && !sql.includes('DO NOTHING')) throw new Error(`duplicate route: ${runId}`)
            if (!this.runRoutes.has(runId)) this.runRoutes.set(runId, {
              experiment_id: String(values[1]), runtime_release_json: String(values[2]),
            })
          } else if (sql.includes('INSERT INTO checkpoint_runtime_routes')) {
            const digest = String(values[0])
            if (!this.checkpointRoutes.has(digest)) {
              this.checkpointRoutes.set(digest, { runtime_release_json: String(values[2]) })
            }
          }
          return { success: true }
        },
        first: async () => {
          const key = String(values[0])
          if (sql.includes('FROM run_runtime_routes')) return this.runRoutes.get(key) ?? null
          if (sql.includes('FROM runtime_slot_run_leases')) return this.slotLeases.get(key) ?? null
          if (sql.includes('FROM checkpoint_runtime_routes')) return this.checkpointRoutes.get(key) ?? null
          if (sql.includes('SELECT run_id FROM experiment_runs')) {
            return this.states.has(key) ? { run_id: key } : null
          }
          return this.states.get(key) ?? null
        },
      }),
    }
  }

  async batch(statements: unknown[]) {
    return statements.map(() => ({ success: true }))
  }
}

describe('Cloudflare content-addressed checkpoint storage', () => {
  it('rejects retired search settings for new releases', async () => {
    const bucket = new FakeR2Bucket()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      new FakeD1() as unknown as D1Database,
    )
    const delegated = { ...audit0PackageBody, definition: { ...audit0Definition,
      pools: audit0Definition.pools.map((pool, index) => index === 0
        ? { ...pool, searchAgent: pool.id } : pool),
    } }
    await expect(store.putRelease(delegated as never)).rejects.toThrow('has unknown keys: searchAgent')

    const legacyConnection = { baseUrl: 'https://example.com/v1', apiKeyEnv: 'SEARCH_API_KEY',
      model: 'search-model' }
    const chatSearch = { ...audit0PackageBody, definition: { ...audit0Definition,
      nativeSearch: { enabled: true, searchConnection: legacyConnection },
    } }
    await expect(store.putRelease(chatSearch)).rejects.toThrow('chat-completions search is retired')
    await expect(store.putRelease({ ...audit0PackageBody, definition: { ...audit0Definition,
      forceSearch: { enabled: false, promptSet: 'unknown-set' },
    } })).rejects.toThrow('forceSearch.promptSet must be native-exa-v1')
    await expect(store.putRelease(audit0PackageBody)).resolves.toBeDefined()
  })

  it('initializes D1 with complete prepared statements instead of line-split exec SQL', async () => {
    const bucket = new FakeR2Bucket()
    const prepared: string[] = []
    const index = {
      exec: async () => { throw new Error('D1 exec must not be used for multiline schema SQL') },
      prepare: (sql: string) => {
        prepared.push(sql)
        return { sql }
      },
      batch: async (statements: unknown[]) => statements.map(() => ({ success: true })),
    }
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      index as unknown as D1Database,
    )

    await store.ensureSchema()

    expect(prepared).toHaveLength(11)
    expect(prepared[0]).toContain('CREATE TABLE IF NOT EXISTS experiment_runs')
    expect(prepared[0]).toContain('terminal_reason TEXT\n  )')
    expect(prepared[1]).toContain('CREATE INDEX IF NOT EXISTS experiment_runs_by_experiment_updated')
    expect(prepared[2]).toContain('CREATE TABLE IF NOT EXISTS run_runtime_routes')
    expect(prepared[3]).toContain('CREATE TABLE IF NOT EXISTS checkpoint_runtime_routes')
    expect(prepared[4]).toContain('CREATE TABLE IF NOT EXISTS runtime_slots')
    expect(prepared[5]).toContain('CREATE TABLE IF NOT EXISTS runtime_slot_control')
    expect(prepared[6]).toContain('CREATE TABLE IF NOT EXISTS runtime_slot_run_leases')
    expect(prepared[8]).toContain('CREATE TABLE IF NOT EXISTS retired_runtime_runs')
    expect(prepared[9]).toContain('CREATE TABLE IF NOT EXISTS retired_unmaterialized_routes')
    expect(prepared[10]).toContain('CREATE TABLE IF NOT EXISTS retained_native_workspace_claims')
    expect(prepared[10]).toContain('PRIMARY KEY(source_run_id, workspace_key)')
  })

  it('persists small run and checkpoint routing envelopes independently of full state parsing', async () => {
    const bucket = new FakeR2Bucket()
    const index = new FakeD1()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      index as unknown as D1Database,
    )
    const runtimeRelease = {
      schemaVersion: 1 as const,
      id: 'runtime-a',
      frameworkCommit: 'a'.repeat(40),
      workerService: 'swarm-runtime-a',
      workerVersionId: '11111111-1111-4111-8111-111111111111',
      workflowName: 'ack3-audit-workflow-a',
      containerImageDigest: `sha256:${'b'.repeat(64)}`,
    }
    await store.reserveRunRoute('runtime-route-run', audit0Definition.id, runtimeRelease)
    expect(await store.runRuntime('runtime-route-run')).toEqual(runtimeRelease)
    await expect(store.reserveRunRoute('runtime-route-run', audit0Definition.id, runtimeRelease)).resolves.toBeUndefined()
    await expect(store.reserveRunRoute('runtime-route-run', 'different-experiment', runtimeRelease))
      .rejects.toThrow('run already exists with different routing')

    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(
      audit0Definition, release.digest, 'runtime-route-run', new Date().toISOString(), runtimeRelease,
    )
    await machine.start()
    const checkpoint = await machine.seal()
    await store.putCheckpoint(checkpoint)
    expect(await store.checkpointRuntime(checkpoint.digest)).toEqual(runtimeRelease)
  })

  it('verifies object bytes, metadata, the body digest, and the requested immutable key', async () => {
    const bucket = new FakeR2Bucket()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      new FakeD1() as unknown as D1Database,
    )
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'storage-parent')
    await machine.start()
    const checkpoint = await machine.seal()
    await store.putCheckpoint(checkpoint)
    expect(await store.getCheckpoint(checkpoint.digest)).toEqual(checkpoint)

    const key = `checkpoints/sha256/${checkpoint.digest}.json`
    const stored = bucket.objects.get(key)!
    stored.content = stored.content.replace('storage-parent', 'storage-tamper')
    await expect(store.getCheckpoint(checkpoint.digest)).rejects.toThrow('checkpoint object digest mismatch')

    const changed = JSON.parse(canonicalJson(checkpoint)) as typeof checkpoint
    changed.body.runId = 'storage-rehashed'
    changed.digest = await sha256(changed.body)
    stored.content = canonicalJson(changed)
    stored.checksum = await sha256(stored.content)
    stored.customMetadata = {
      bodySha256: changed.digest,
      objectSha256: stored.checksum,
      run: changed.body.runId,
    }
    await expect(store.getCheckpoint(checkpoint.digest)).rejects.toThrow('checkpoint object digest mismatch')
  })

  it('applies the same byte checks to immutable releases and mutable run state', async () => {
    const bucket = new FakeR2Bucket()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      new FakeD1() as unknown as D1Database,
    )
    const release = await store.putRelease(audit0PackageBody)
    expect(await store.getRelease(release.digest)).toEqual(release)
    const releaseKey = `releases/sha256/${release.digest}.json`
    const storedRelease = bucket.objects.get(releaseKey)!
    storedRelease.content = `${storedRelease.content} `
    await expect(store.getRelease(release.digest)).rejects.toThrow('release package object digest mismatch')

    const machine = await RunMachine.create(audit0Definition, release.digest, 'stored-state')
    await machine.start()
    const state = machine.snapshot()
    expect(await store.getStateIfPresent(state.runId)).toBeNull()
    await store.putState(state)
    expect(await store.getState(state.runId)).toEqual(state)
    expect(await store.getStateIfPresent(state.runId)).toEqual(state)
    const storedState = [...bucket.objects.entries()].find(([key]) => key.startsWith(`runs/${state.runId}/states/`))![1]
    storedState.content = storedState.content.replace('"status":"running"', '"status":"completed"')
    await expect(store.getState(state.runId)).rejects.toThrow(`run state object digest mismatch: ${state.runId}`)
  })

  it('reuses an identical persisted state when another body upload would fail', async () => {
    let uploads = 0
    const bucket = new class extends FakeR2Bucket {
      override async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}) {
        uploads += 1
        if (this.objects.has(key)) throw new Error('Network connection lost.')
        return super.put(key, value, options)
      }
    }()
    const index = new FakeD1()
    const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket, index as unknown as D1Database)
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'identical-state-replay')
    await machine.start()
    const state = machine.snapshot()
    await store.putState(state)
    const pointer = structuredClone(index.states.get(state.runId))

    await store.putState(structuredClone(state))

    expect(uploads).toBe(1)
    expect(bucket.objects.size).toBe(1)
    expect(index.states.get(state.runId)).toEqual(pointer)
    expect(await store.getState(state.runId)).toEqual(state)
  })

  it('rejects differing bytes at the same committed generation', async () => {
    const bucket = new FakeR2Bucket()
    const index = new FakeD1()
    const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket, index as unknown as D1Database)
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'same-generation-conflict')
    await machine.start()
    const state = machine.snapshot()
    await store.putState(state)
    const pointer = structuredClone(index.states.get(state.runId))
    const changed = { ...state, updatedAt: new Date(Date.parse(state.updatedAt) + 1).toISOString() }

    await expect(store.putState(changed)).rejects.toThrow('stale run-state generation rejected')

    expect(index.states.get(state.runId)).toEqual(pointer)
    expect(await store.getState(state.runId)).toEqual(state)
  })

  it.each(['metadata', 'checksum'])('rejects an existing state with invalid %s before updating D1', async kind => {
    const bucket = new FakeR2Bucket()
    const index = new FakeD1()
    const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket, index as unknown as D1Database)
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, `state-head-${kind}`)
    await machine.start()
    const state = machine.snapshot()
    await store.putState(state)
    const pointer = structuredClone(index.states.get(state.runId))
    const object = [...bucket.objects.values()][0]!
    if (kind === 'metadata') object.customMetadata.objectSha256 = 'f'.repeat(64)
    else object.checksum = 'f'.repeat(64)

    await expect(store.putState(state)).rejects.toThrow('run-state generation already exists with different bytes')

    expect(index.states.get(state.runId)).toEqual(pointer)
  })

  it('recovers an R2 commit whose acknowledgement was lost without repeating the upload', async () => {
    let uploads = 0
    const bucket = new class extends FakeR2Bucket {
      override async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}) {
        uploads += 1
        await super.put(key, value, options)
        throw new Error('Network connection lost.')
      }
    }()
    const index = new FakeD1()
    const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket, index as unknown as D1Database)
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'r2-lost-acknowledgement')
    await machine.start()
    const state = machine.snapshot()

    await expect(store.putState(state)).rejects.toThrow('Network connection lost.')
    expect(index.states.has(state.runId)).toBe(false)
    await store.putState(state)

    expect(uploads).toBe(1)
    expect(await store.getState(state.runId)).toEqual(state)
  })

  it.each([true, false])('verifies a raced conditional-write collision before D1 publication (valid checksum: %s)', async valid => {
    const bucket = new class extends FakeR2Bucket {
      override async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}) {
        await super.put(key, value, options)
        if (!valid) this.objects.get(key)!.checksum = 'f'.repeat(64)
        return null
      }
    }()
    const index = new FakeD1()
    const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket, index as unknown as D1Database)
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, `raced-state-${valid}`)
    await machine.start()
    const state = machine.snapshot()

    if (valid) {
      await store.putState(state)
      expect(await store.getState(state.runId)).toEqual(state)
    } else {
      await expect(store.putState(state)).rejects.toThrow('run-state generation already exists with different bytes')
      expect(index.states.has(state.runId)).toBe(false)
    }
  })

  it('rejects a stale state generation instead of moving the run pointer backwards', async () => {
    const bucket = new FakeR2Bucket()
    const index = new FakeD1()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      index as unknown as D1Database,
    )
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'generation-cas')
    await machine.start()
    const older = machine.snapshot()
    await machine.stop('sealed-boundary-stop')
    const newer = machine.snapshot()
    await store.putState(newer)
    await expect(store.putState(older)).rejects.toThrow('stale run-state generation rejected')
    expect(await store.getState(newer.runId)).toEqual(newer)
  })

  it('rejects a late higher-generation running write after an immediate terminal fence', async () => {
    const bucket = new FakeR2Bucket()
    const store = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      new FakeD1() as unknown as D1Database,
    )
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'late-stop-write')
    await machine.start()
    const running = machine.snapshot()
    await store.putState(running)
    await machine.stop('operator-requested-immediate-stop')
    const stopped = machine.snapshot()
    await store.putState(stopped)
    const late = { ...running, stateGeneration: stopped.stateGeneration + 1 }
    await expect(store.putState(late)).rejects.toThrow('stale run-state generation rejected')
    expect(await store.getState(stopped.runId)).toEqual(stopped)
  })

  it('recovers when R2 commits but the D1 state pointer fails before update', async () => {
    const bucket = new FakeR2Bucket()
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'orphaned-generation')
    await machine.start()
    const firstBranch = machine.snapshot()
    const failedIndex = {
      prepare: () => ({ bind: () => ({
        run: async () => { throw new Error('simulated Durable Object reset') },
        first: async () => null,
      }) }),
    }
    const interrupted = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      failedIndex as unknown as D1Database,
    )
    await expect(interrupted.putState(firstBranch)).rejects.toThrow('simulated Durable Object reset')

    const retryBranch = structuredClone(firstBranch)
    retryBranch.updatedAt = new Date(Date.parse(firstBranch.updatedAt) + 1).toISOString()
    const recovered = new CloudflareRunStore(
      bucket as unknown as R2Bucket,
      bucket as unknown as R2Bucket,
      new FakeD1() as unknown as D1Database,
    )
    await recovered.putState(retryBranch)

    expect(await recovered.getState(retryBranch.runId)).toEqual(retryBranch)
    expect([...bucket.objects.keys()].filter(key => key.startsWith(`runs/${retryBranch.runId}/states/`))).toHaveLength(2)
  })
})
