import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { canonicalJson } from '../src/canonical.js'
import { sha256 } from '../src/canonical.js'
import type { RunState, RuntimeRelease } from '../src/contracts.js'
import { retireTerminalFixture, type TerminalFixtureRetirementProof } from '../src/terminal-fixture-retirement.js'

function bucket(): R2Bucket {
  const objects = new Map<string, { content: string, checksum: string,
    metadata: Record<string, string> }>()
  return {
    async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}) {
      if (options.onlyIf !== undefined && objects.has(key)) return null
      const content = typeof value === 'string' ? value : new TextDecoder().decode(value)
      objects.set(key, { content,
        checksum: typeof options.sha256 === 'string' ? options.sha256 : await sha256(content),
        metadata: options.customMetadata ?? {} })
      return {} as R2Object
    },
    async get(key: string) {
      const object = objects.get(key)
      return object === undefined ? null : {
        customMetadata: object.metadata,
        checksums: { toJSON: () => ({ sha256: object.checksum }) },
        text: async () => object.content,
      } as unknown as R2ObjectBody
    },
    async head(key: string) {
      const object = objects.get(key)
      return object === undefined ? null : {
        customMetadata: object.metadata,
        checksums: { toJSON: () => ({ sha256: object.checksum }) },
      } as unknown as R2Object
    },
  } as unknown as R2Bucket
}

function index(): { d1: D1Database, sqlite: DatabaseSync,
  beforeRouteInsert: (callback: (() => void) | null) => void,
  beforeLeaseUpdate: (callback: (() => void) | null) => void,
  beforeArchiveInsert: (callback: (() => void) | null) => void } {
  const db = new DatabaseSync(':memory:')
  let beforeRouteInsert: (() => void) | null = null
  let beforeLeaseUpdate: (() => void) | null = null
  let beforeArchiveInsert: (() => void) | null = null
  const d1 = {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          // Node 22 requires named bindings for SQLite's numbered parameters.
          const positional = values as SQLInputValue[]
          const named = /\?\d+/.test(query)
            ? Object.fromEntries(positional.map((value, i) => [`?${i + 1}`, value]))
            : null
          return {
            async first() {
              const statement = db.prepare(query)
              return (named === null ? statement.get(...positional) : statement.get(named)) ?? null
            },
            async run() {
              if (query.includes('INSERT INTO run_runtime_routes')) beforeRouteInsert?.()
              if (query.includes('UPDATE runtime_slot_run_leases')) beforeLeaseUpdate?.()
              if (query.includes('INSERT INTO retired_runtime_runs')
                || query.includes('INSERT INTO retired_unmaterialized_routes')) beforeArchiveInsert?.()
              const statement = db.prepare(query)
              const result = named === null ? statement.run(...positional) : statement.run(named)
              return { meta: { changes: result.changes } }
            },
          }
        },
        async first() { return db.prepare(query).get() ?? null },
        async run() { return { meta: { changes: db.prepare(query).run().changes } } },
      }
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      // A competing pool change happens before or after an atomic D1 batch,
      // never between its statements.
      const before = beforeRouteInsert; beforeRouteInsert = null; before?.()
      db.exec('BEGIN IMMEDIATE')
      try {
        for (const statement of statements) await statement.run()
        db.exec('COMMIT')
        return []
      } catch (error) { db.exec('ROLLBACK'); throw error }
    },
  } as unknown as D1Database
  return { d1, sqlite: db, beforeRouteInsert: callback => { beforeRouteInsert = callback },
    beforeLeaseUpdate: callback => { beforeLeaseUpdate = callback },
    beforeArchiveInsert: callback => { beforeArchiveInsert = callback } }
}

/** Existing historical bytes are fixture input, not newly produced current-app state. */
async function seedHistoricalState(bucket: R2Bucket, sqlite: DatabaseSync, state: RunState) {
  const content = canonicalJson(state), digest = await sha256(content)
  const key = `runs/${state.runId}/states/${String(state.stateGeneration).padStart(12, '0')}-${digest}.json`
  await bucket.put(key, content, { sha256: digest,
    customMetadata: { objectSha256: digest, generation: String(state.stateGeneration) } })
  sqlite.prepare(`INSERT INTO experiment_runs
    (run_id, experiment_id, status, state_key, state_generation, checkpoint_digest, updated_at, terminal_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, state_key=excluded.state_key,
      state_generation=excluded.state_generation, checkpoint_digest=excluded.checkpoint_digest,
      updated_at=excluded.updated_at, terminal_reason=excluded.terminal_reason`)
    .run(state.runId, state.experimentId, state.status, key, state.stateGeneration,
      state.checkpoints.at(-1)?.digest ?? null, state.updatedAt, state.terminalReason)
}

const release = (version: string): RuntimeRelease => ({
  schemaVersion: 1, id: 'runtime-slot-a', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-slot-a', workflowName: 'ack3-runtime-slot-a',
  workerVersionId: version, containerImageDigest: `sha256:${'b'.repeat(64)}`,
})

async function stoppedRunFixture(options: { artifact?: boolean, checkpoint?: boolean, staticAdmission?: boolean,
  status?: 'stopped' | 'running' | 'failed', activeWork?: boolean,
  directStop?: boolean,
  recoveryMismatch?: 'failedWaveRecovery' | 'promotedExecutionProofs' | 'terminalCompletionRecovery' } = {}) {
  const { d1, sqlite, beforeArchiveInsert, beforeLeaseUpdate } = index()
  const bucketStore = bucket()
  const store = new CloudflareRunStore(bucketStore, bucketStore, d1)
  await store.ensureSchema()
  const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
  if (!options.staticAdmission) {
    sqlite.prepare(`INSERT INTO runtime_slots (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?, ?, 1, ?)`).run(runtimeRelease.id, canonicalJson(runtimeRelease), '2026-10-01T00:00:00Z')
  }
  sqlite.prepare(`INSERT INTO runtime_slot_control (singleton, enabled, latest_slot_id, updated_at)
    VALUES (1, ?, ?, ?)`).run(options.staticAdmission ? 0 : 1, runtimeRelease.id, '2026-10-01T00:00:00Z')
  const runId = 'sealed-stopped', experimentId = 'experiment'
  await store.reserveRunRoute(runId, experimentId, runtimeRelease)
  const definition = { id: experimentId, stages: [] }
  const definitionDigest = await sha256(definition)
  vi.spyOn(store, 'getRelease').mockResolvedValue({ body: { definition } } as never)
  const files = { 'waves/wave-0/research-1.md': 'accepted evidence' }
  const content = canonicalJson(files), contentDigest = await sha256(content)
  const artifact = { id: 'discovery/research-1', stageId: 'discovery', waveId: 'wave-0',
    taskId: 'research-1', status: 'accepted', actorId: 'actor', model: 'model', provider: 'provider',
    promptDigest: 'a'.repeat(64), contentDigest,
    uri: 'r2://ARTIFACTS/artifacts/discovery/research-1.json', files: Object.keys(files),
    assertions: [], protocol: {}, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } }
  if (options.artifact !== false) await bucketStore.put('artifacts/discovery/research-1.json', content, {
    sha256: contentDigest, customMetadata: { sha256: contentDigest, task: artifact.taskId },
  })
  const frontier = {
    schemaVersion: 2, experimentId, runId, stateGeneration: 4, rootRunId: runId,
    rootCreatedAt: '2026-10-01T00:00:00Z', modelStartedAt: '2026-10-01T00:01:00Z',
    phase: 'discovery', recoveryEpoch: 0, parentCheckpointDigest: null,
    releaseDigest: 'a'.repeat(64), runtimeRelease, definitionDigest,
    cursor: { stageIndex: 1, waveIndex: 1 }, acceptedArtifacts: [artifact],
    rejectedAttempts: [], stageEndReceipts: [], waveReceipts: [], availabilityBoundaries: [],
    budget: { modelCalls: 1 }, journalHead: 'e'.repeat(64), sealedAt: '2026-10-01T01:00:00Z',
  }
  const checkpoint = { digest: await sha256(frontier), body: frontier }
  if (options.checkpoint !== false && !options.directStop) await store.putCheckpoint(checkpoint as never)
  const status = options.status ?? 'stopped'
  const stopReason = options.directStop ? 'operator-requested-immediate-stop'
    : 'operator-requested-stop-at-sealed-wave-boundary'
  const state = {
    ...frontier, stateGeneration: 6, status, phase: status === 'stopped' ? 'stopped' : 'discovery',
    terminalReason: status === 'stopped' ? stopReason : null,
    artifacts: options.directStop ? [] : [artifact],
    checkpoints: options.directStop ? [] : [checkpoint],
    ...(options.directStop ? { budget: { modelCalls: 0 }, modelStartedAt: null } : {}),
    inFlightAgentAttempts: options.activeWork ? [{ taskId: 'research-1' }] : [],
    ...(options.recoveryMismatch === undefined ? {} : { [options.recoveryMismatch]:
      options.recoveryMismatch === 'promotedExecutionProofs' ? [{ taskId: 'unexpected' }] : { sourceRunId: 'unexpected' } }),
    waveAdmission: options.directStop ? {
      admittedAt: '2026-10-01T00:10:00Z', cursor: { stageIndex: 0, waveIndex: 0 },
      stageId: 'preflight', waveId: 'identity-tools-baseline',
    } : null, journal: [
      ...(options.directStop ? [
        { type: 'run.created', digest: frontier.journalHead, payload: {} },
        { type: 'run.started', digest: 'b'.repeat(64),
          payload: { cursor: { stageIndex: 0, waveIndex: 0 } } },
        { type: 'wave.admitted', digest: 'c'.repeat(64), payload: {
          admittedAt: '2026-10-01T00:10:00Z', cursor: { stageIndex: 0, waveIndex: 0 },
          stageId: 'preflight', waveId: 'identity-tools-baseline',
        } },
      ] : [
        { type: 'discovery.cohort-completed', digest: frontier.journalHead, payload: {} },
        { type: 'checkpoint.sealed', digest: 'f'.repeat(64),
          payload: { digest: checkpoint.digest } },
      ]),
      { type: 'run.stopped', digest: '1'.repeat(64),
        payload: { reason: stopReason,
          checkpointDigest: options.directStop ? null : checkpoint.digest } },
    ], createdAt: frontier.rootCreatedAt, updatedAt: '2026-10-01T01:01:00Z',
  } as unknown as RunState
  await seedHistoricalState(bucketStore, sqlite, state)
  await bucketStore.put(`runs/${runId}/stop-request.json`, '{}')
  const stateKey = (sqlite.prepare('SELECT state_key FROM experiment_runs WHERE run_id = ?')
    .get(runId) as { state_key: string }).state_key
  const workflow = options.directStop ? { status: 'terminated' }
    : { status: 'complete', output: { status: 'stopped' } }
  const proof = {
    schemaVersion: 1,
    ...(options.directStop
      ? { kind: 'terminal-stopped-custody' as const, checkpointDigest: null }
      : { kind: 'sealed-stopped-custody' as const, checkpointDigest: checkpoint.digest }),
    runId, experimentId,
    runtimeRelease, stateKey, stateGeneration: state.stateGeneration,
    stateDigest: await sha256(state), workflow,
    acceptedArtifactManifestDigest: await sha256(options.directStop ? [] : [{
      id: artifact.id, contentDigest, files: artifact.files }]),
    sandboxNamespaceId: 'c'.repeat(32),
    containerApplicationId: '22222222-2222-4222-8222-222222222222',
    containerInventoryDigest: 'd'.repeat(64), activePhysicalCount: 0,
    assignedPhysicalCount: 0, startingPhysicalCount: 0, inactiveActorCount: 1,
    inventoryComplete: true, observedAt: '2026-10-08T00:00:00Z',
  }
  return { store, sqlite, bucketStore, state, proof, workflow, beforeArchiveInsert, beforeLeaseUpdate,
    liveRun: async () => ({ state, workflow }) }
}

describe('runtime slot admission and rotation', () => {
  it('retries a partial terminal-fixture archive without a fresh inventory or duplicate native call', async () => {
    const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
    const proof: TerminalFixtureRetirementProof = {
      schemaVersion: 1, kind: 'retired-terminal-fixture', runId: 'fixture-partial',
      experimentId: 'runtime-isolation', runtimeRelease,
      auditWorkflowStatus: 'instance-not-found', isolationWorkflowStatus: 'errored',
      isolationWorkflow: { status: 'errored' }, sandboxNamespaceId: 'c'.repeat(32),
      containerApplicationId: '22222222-2222-4222-8222-222222222222',
      containerInventoryDigest: 'd'.repeat(64), containerInstanceCount: 0,
      containerInventoryComplete: true, observedAt: '2026-10-06T00:00:00Z',
    }
    const proofDigest = await sha256(canonicalJson(proof))
    let archived = false, released = false, nativeCalls = 0
    const store = {
      async retiredUnmaterializedRoute() { return archived ? { proofDigest } : null },
      async runRuntime() { return runtimeRelease },
      async archiveTerminalFixtureAndReleaseLease() {
        if (!archived) { archived = true; throw new Error('lease update interrupted') }
        released = true
        return proofDigest
      },
    }
    const liveFixture = async () => { nativeCalls += 1; return { fixtureId: proof.runId,
      workflow: proof.isolationWorkflow } }
    await expect(retireTerminalFixture({ fixtureId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store, liveFixture })).rejects.toThrow('interrupted')
    expect(released).toBe(false)
    expect(await retireTerminalFixture({ fixtureId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 600_000, store, liveFixture })).toEqual({
      fixtureId: proof.runId, proofDigest, retired: true,
    })
    expect(released).toBe(true)
    expect(nativeCalls).toBe(1)
    await expect(retireTerminalFixture({ fixtureId: proof.runId,
      proof: { ...proof, containerInventoryDigest: 'e'.repeat(64) },
      now: Date.parse(proof.observedAt) + 600_000, store, liveFixture }))
      .rejects.toThrow('different proof')
  })

  it.each([[false, true], [true, true], [true, false]])('archives only an exact terminal fixture lease (static=%s, control row=%s)', async (staticAdmission, controlRow) => {
    const { d1, sqlite, beforeArchiveInsert, beforeLeaseUpdate } = index()
    const artifacts = bucket(), put = artifacts.put.bind(artifacts)
    vi.spyOn(artifacts, 'put').mockImplementationOnce(async (...args) => {
      await put(...args)
      throw new Error('lost fixture publication ACK')
    })
    const store = new CloudflareRunStore(artifacts, artifacts, d1)
    await store.ensureSchema()
    const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
    if (!staticAdmission) await d1.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(runtimeRelease.id, canonicalJson(runtimeRelease),
      '2026-10-01T00:00:00Z').run()
    // A catalog-only install never seeds the slot pool control row.
    if (controlRow) await d1.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, ?1, ?2, ?3)`).bind(staticAdmission ? 0 : 1, runtimeRelease.id, '2026-10-01T00:00:00Z').run()
    await store.reserveRunRoute('terminal-fixture', 'runtime-isolation', runtimeRelease)
    await store.reserveRunRoute('other-fixture', 'runtime-isolation', runtimeRelease)
    const proof: TerminalFixtureRetirementProof = {
      schemaVersion: 1, kind: 'retired-terminal-fixture', runId: 'terminal-fixture',
      experimentId: 'runtime-isolation', runtimeRelease,
      auditWorkflowStatus: 'instance-not-found', isolationWorkflowStatus: 'errored',
      isolationWorkflow: { status: 'errored', error: { name: 'Error', message: 'fixture failed' } },
      sandboxNamespaceId: 'c'.repeat(32),
      containerApplicationId: '22222222-2222-4222-8222-222222222222',
      containerInventoryDigest: 'd'.repeat(64), containerInstanceCount: 0,
      containerInventoryComplete: true, observedAt: '2026-10-06T00:00:00Z',
    }
    await expect(store.archiveTerminalFixtureAndReleaseLease({ ...proof, containerInstanceCount: 1 as 0 }))
      .rejects.toThrow('proof is invalid')
    if (staticAdmission) {
      expect(sqlite.prepare('SELECT admission_pool_enabled FROM runtime_slot_run_leases WHERE run_id = ?')
        .get(proof.runId)).toMatchObject({ admission_pool_enabled: 0 })
    }
    if (staticAdmission && controlRow) {
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run()
      await expect(store.archiveTerminalFixtureAndReleaseLease(proof)).rejects.toThrow('route, lease, or slot changed')
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
      beforeArchiveInsert(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
      await expect(store.archiveTerminalFixtureAndReleaseLease(proof)).rejects.toThrow('archive differs')
      beforeArchiveInsert(null)
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
      beforeLeaseUpdate(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
      await expect(store.archiveTerminalFixtureAndReleaseLease(proof)).rejects.toThrow('lease was not released')
      beforeLeaseUpdate(null)
      expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
        .get(proof.runId)).toMatchObject({ released_at: null })
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
    }
    const digest = await store.archiveTerminalFixtureAndReleaseLease(proof)
    expect(await store.archiveTerminalFixtureAndReleaseLease(proof)).toBe(digest)
    expect(await store.retiredUnmaterializedRoute(proof.runId)).toMatchObject({
      experimentId: 'runtime-isolation', runtimeRelease, proofDigest: digest,
      isolationWorkflowStatus: 'errored',
    })
    expect(sqlite.prepare(`SELECT run_id, terminal_workflow_status, released_at
      FROM runtime_slot_run_leases WHERE run_id = ?`).get(proof.runId))
      .toMatchObject({ terminal_workflow_status: 'errored', released_at: expect.any(String) })
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?`)
      .get('other-fixture')).toMatchObject({ released_at: null })
    const partialProof = { ...proof, runId: 'other-fixture' }
    const partialContent = canonicalJson(partialProof)
    const partialDigest = await sha256(partialContent)
    await artifacts.put(`runtime-retirements/sha256/${partialDigest}.json`, partialContent, {
      sha256: partialDigest, customMetadata: { run: partialProof.runId, objectSha256: partialDigest },
    })
    sqlite.prepare(`INSERT INTO retired_unmaterialized_routes
      (run_id, runtime_release_json, audit_workflow_status,
        isolation_workflow_status, proof_digest, retired_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(partialProof.runId, canonicalJson(runtimeRelease),
        partialProof.auditWorkflowStatus, partialProof.isolationWorkflowStatus,
        partialDigest, '2026-10-06T00:00:00Z')
    expect(await store.archiveTerminalFixtureAndReleaseLease(partialProof)).toBe(partialDigest)
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?`)
      .get('other-fixture')).toMatchObject({ released_at: expect.any(String) })
    await store.reserveRunRoute('stateful-fixture', 'runtime-isolation', runtimeRelease)
    sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, ?, 'running', 'fake', 1, ?)`).run('stateful-fixture', 'runtime-isolation',
        '2026-10-06T00:00:00Z')
    await expect(store.archiveTerminalFixtureAndReleaseLease({ ...proof, runId: 'stateful-fixture' }))
      .rejects.toThrow('route, lease, or slot changed')
    await expect(store.archiveTerminalFixtureAndReleaseLease({ ...proof,
      containerApplicationId: '33333333-3333-4333-8333-333333333333' }))
      .rejects.toThrow('archive differs')
    sqlite.prepare(`UPDATE runtime_slots SET runtime_release_json = ? WHERE slot_id = ?`)
      .run(canonicalJson(release('44444444-4444-4444-8444-444444444444')), runtimeRelease.id)
    expect(await store.archiveTerminalFixtureAndReleaseLease(proof)).toBe(digest)
    expect(await store.retiredUnmaterializedRoute(proof.runId)).toMatchObject({ proofDigest: digest })
  })

  it('reserves a route and reads run state on a fresh database before any Workflow runs', async () => {
    const { d1, sqlite } = index()
    const artifacts = bucket()
    const store = new CloudflareRunStore(artifacts, artifacts, d1)
    await store.reserveRunRoute('first-run', 'audit-test', release('11111111-1111-4111-8111-111111111111'))
    expect(await store.getStateIfPresent('first-run')).toBeNull()
    expect(sqlite.prepare('SELECT run_id FROM run_runtime_routes').all()).toEqual([{ run_id: 'first-run' }])
  })

  it('preserves a no-state route with an exact private native-absence proof', async () => {
    const { d1, sqlite } = index()
    const artifacts = bucket()
    const store = new CloudflareRunStore(artifacts, artifacts, d1)
    await store.ensureSchema()
    const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
    const runId = 'reserved-no-state'
    await store.reserveRunRoute(runId, 'runtime-isolation', runtimeRelease)
    const proof = canonicalJson({ schemaVersion: 1, kind: 'retired-unmaterialized-route',
      runId, experimentId: 'runtime-isolation', runtimeRelease,
      auditWorkflowStatus: 'instance-not-found',
      isolationWorkflowStatus: 'instance-not-found' })
    const digest = await sha256(proof)
    await artifacts.put(`runtime-retirements/sha256/${digest}.json`, proof, {
      sha256: digest, customMetadata: { run: runId },
    })
    sqlite.prepare(`INSERT INTO retired_unmaterialized_routes
      (run_id, runtime_release_json, audit_workflow_status,
        isolation_workflow_status, proof_digest, retired_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(runId, canonicalJson(runtimeRelease),
        'instance-not-found', 'instance-not-found', digest, '2026-10-06T00:00:00Z')
    expect(await store.retiredUnmaterializedRoute(runId)).toMatchObject({
      experimentId: 'runtime-isolation', runtimeRelease, proofDigest: digest,
    })
    sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, ?, 'running', 'fake', 1, ?)`).run(runId, 'runtime-isolation', '2026-10-06T00:00:00Z')
    await expect(store.retiredUnmaterializedRoute(runId)).rejects.toThrow('changed')
  })

  it('archives a completed native Workflow before releasing its exact slot lease', async () => {
    const { d1, sqlite } = index()
    const artifacts = bucket()
    const store = new CloudflareRunStore(artifacts, artifacts, d1)
    await store.ensureSchema()
    const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
    await d1.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(runtimeRelease.id, canonicalJson(runtimeRelease),
      '2026-10-01T00:00:00Z').run()
    await d1.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, 1, ?1, ?2)`).bind(runtimeRelease.id, '2026-10-01T00:00:00Z').run()
    const state = { runId: 'complete-run', experimentId: 'experiment', status: 'completed',
      stateGeneration: 2, releaseDigest: 'a'.repeat(64), runtimeRelease,
      inFlightAgentAttempts: [], updatedAt: '2026-10-01T01:00:00Z',
      terminalReason: null, checkpoints: [], journal: [] } as unknown as RunState
    await store.reserveRunRoute(state.runId, state.experimentId, runtimeRelease)
    await seedHistoricalState(artifacts, sqlite, state)
    const workflow = { status: 'complete', output: { status: 'completed' } }
    await expect(store.archiveCompletedRunAndReleaseLease(state.runId, workflow))
      .rejects.toThrow('cleanup proof is missing')
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases
      WHERE run_id = ?`).get(state.runId)).toMatchObject({ released_at: null })
    await expect(store.putCompletedCleanupProof(state, { mode: 'provider-attempted',
      activeWorkspaceKeys: [], retainedWorkspaceKeys: ['native-work'], deferred: [] }))
      .rejects.toThrow('not terminal and empty')
    await store.putCompletedCleanupProof(state, { mode: 'provider-attempted',
      activeWorkspaceKeys: [], retainedWorkspaceKeys: [], deferred: [] })
    await store.archiveCompletedRunAndReleaseLease(state.runId, workflow)
    await store.archiveCompletedRunAndReleaseLease(state.runId, workflow)
    expect(sqlite.prepare(`SELECT terminal_workflow_status, released_at
      FROM runtime_slot_run_leases WHERE run_id = ?`).get(state.runId))
      .toMatchObject({ terminal_workflow_status: 'complete', released_at: expect.any(String) })
    expect(await store.retiredRunWorkflow(state.runId)).toMatchObject({
      workflow, disposition: 'terminal', cleanupProofDigest: expect.any(String),
    })
  })

  it('cancels only a locked, unchanged, unused preupload slot', async () => {
    const { d1 } = index()
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
    await store.ensureSchema()
    const old = release('11111111-1111-4111-8111-111111111111')
    const next = release('22222222-2222-4222-8222-222222222222')
    await d1.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(old.id, canonicalJson(old), '2026-10-01T00:00:00Z').run()
    await d1.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, 1, ?1, ?2)`).bind(old.id, '2026-10-01T00:00:00Z').run()
    const intent = '44444444-4444-4444-8444-444444444444'
    await store.lockOldestIdleRuntimeSlot(intent)
    await expect(store.cancelUnpublishedRuntimeSlot(intent, 1, old, next))
      .rejects.toThrow('unpublished rotation identity is invalid')
    expect(await store.inspectRuntimeSlotRotation(intent)).toMatchObject({ lockHeld: true })
    expect(await store.cancelUnpublishedRuntimeSlot(intent, 1, old, old))
      .toEqual({ slotId: old.id, cancelled: true })
    expect(await store.inspectRuntimeSlotRotation(intent)).toBeNull()
    await store.reserveRunRoute('after-cancellation', 'experiment', old)
  })

  it('keeps a live run leased and rejects stale versions after a slot rotates', async () => {
    const { d1: db } = index()
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, db)
    await store.ensureSchema()
    // A pre-migration route creates the schema; a separate one-time migration
    // then seeds and activates the slot pool.
    await store.reserveRunRoute('pre-migration', 'experiment', release('11111111-1111-4111-8111-111111111111'))
    const old = release('11111111-1111-4111-8111-111111111111')
    const next = release('22222222-2222-4222-8222-222222222222')
    await db.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(old.id, canonicalJson(old), '2026-10-01T00:00:00Z').run()
    await db.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, 1, ?1, ?2)`).bind(old.id, '2026-10-01T00:00:00Z').run()
    await db.prepare(`UPDATE runtime_slot_run_leases SET released_at = ?1,
      terminal_workflow_status = 'complete' WHERE run_id = 'pre-migration'`)
      .bind('2026-10-01T00:00:00Z').run()
    await store.reserveRunRoute('first', 'experiment', old)
    const intent = '33333333-3333-4333-8333-333333333333'
    await expect(store.lockOldestIdleRuntimeSlot(intent)).rejects.toThrow('all runtime slots are busy')
    await db.prepare(`UPDATE runtime_slot_run_leases
      SET released_at = ?1, terminal_workflow_status = 'complete'
      WHERE run_id = 'first'`).bind('2026-10-01T01:00:00Z').run()
    expect(await store.lockOldestIdleRuntimeSlot(intent)).toMatchObject({
      slotId: old.id, generation: 1, runtimeRelease: old,
    })
    await expect(store.activateRotatedRuntimeSlot(intent, 1, old, old, old.frameworkCommit))
      .rejects.toThrow('observed runtime release does not match')
    expect(await store.inspectRuntimeSlotRotation(intent)).toMatchObject({ lockHeld: true })
    await expect(store.reserveRunRoute('during-rotation', 'experiment', old))
      .rejects.toThrow('runtime slot admission is temporarily unavailable')
    expect(await store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit))
      .toMatchObject({ slotId: old.id, generation: 2, runtimeRelease: next })
    expect(await store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit))
      .toMatchObject({ slotId: old.id, generation: 2, runtimeRelease: next })
    await expect(store.reserveRunRoute('stale-version', 'experiment', old))
      .rejects.toMatchObject({ name: 'RunCommandConflict', code: 'idempotency-conflict' })
    await store.reserveRunRoute('new-version', 'experiment', next)
  })

  it('requires an exact target image for a locked image rotation', async () => {
    const { d1 } = index()
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
    await store.ensureSchema()
    const old = release('11111111-1111-4111-8111-111111111111')
    const targetImage = `sha256:${'a'.repeat(64)}`
    const next = { ...release('22222222-2222-4222-8222-222222222222'),
      containerImageDigest: targetImage }
    await d1.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(old.id, canonicalJson(old), '2026-10-01T00:00:00Z').run()
    await d1.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, 1, ?1, ?2)`).bind(old.id, '2026-10-01T00:00:00Z').run()
    const intent = '55555555-5555-4555-8555-555555555555'
    await store.lockOldestIdleRuntimeSlot(intent)
    await expect(store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit))
      .rejects.toThrow('observed runtime release does not match')
    await expect(store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit,
      `sha256:${'b'.repeat(64)}`)).rejects.toThrow('observed runtime release does not match')
    expect(await store.inspectRuntimeSlotRotation(intent)).toMatchObject({ lockHeld: true })
    await expect(store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit,
      targetImage)).resolves.toMatchObject({ slotId: old.id, generation: 2,
      runtimeRelease: next })
    await expect(store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit,
      targetImage)).resolves.toMatchObject({ slotId: old.id, generation: 2,
      runtimeRelease: next })
    await expect(store.reserveRunRoute('stale-image', 'experiment', old))
      .rejects.toMatchObject({ name: 'RunCommandConflict', code: 'idempotency-conflict' })
  })

  it('does not admit a pre-activation request after the pool switches on', async () => {
    const { d1, sqlite, beforeRouteInsert } = index()
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
    await store.ensureSchema()
    const old = release('11111111-1111-4111-8111-111111111111')
    sqlite.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?, ?, 1, ?)`).run(old.id, canonicalJson(old), '2026-10-01T00:00:00Z')
    sqlite.prepare(`INSERT INTO runtime_slot_control
      (singleton, enabled, latest_slot_id, updated_at)
      VALUES (1, 0, ?, ?)`).run(old.id, '2026-10-01T00:00:00Z')
    beforeRouteInsert(() => {
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run()
      sqlite.prepare(`UPDATE runtime_slot_control SET rotating_slot_id = ?,
        rotation_intent = 'intent'`).run(old.id)
      beforeRouteInsert(null)
    })
    await expect(store.reserveRunRoute('racing-start', 'experiment', old))
      .rejects.toThrow('runtime slot admission is temporarily unavailable')
    const route = sqlite.prepare('SELECT run_id FROM run_runtime_routes WHERE run_id = ?')
      .get('racing-start')
    const lease = sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get('racing-start')
    expect(route).toBeUndefined()
    expect(lease).toBeUndefined()
  })
})

async function expiredFixture() {
  const { d1, sqlite, beforeLeaseUpdate } = index()
  const artifacts = bucket(), store = new CloudflareRunStore(artifacts, artifacts, d1)
  await store.ensureSchema()
  const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
  sqlite.prepare(`INSERT INTO runtime_slot_control (singleton, enabled, latest_slot_id, updated_at)
    VALUES (1, 0, ?, ?)`).run(runtimeRelease.id, '2026-10-01T00:00:00Z')
  await store.reserveRunRoute('expired-fixture', 'runtime-isolation', runtimeRelease)
  await store.reserveRunRoute('untouched-fixture', 'runtime-isolation', runtimeRelease)
  const body = { schemaVersion: 1, fixtureId: 'expired-fixture', runtimeRelease,
    parentCheckpointDigest: null, containerBuildFingerprint: 'e'.repeat(64), finishedAt: '2026-10-01T01:00:00Z' }
  const checkpointDigest = await sha256(body), content = canonicalJson({ digest: checkpointDigest, body })
  const key = `checkpoints/sha256/${checkpointDigest}.runtime-isolation.json`
  await artifacts.put(key, content, { sha256: await sha256(content), customMetadata: {
    bodySha256: checkpointDigest, objectSha256: await sha256(content), fixture: body.fixtureId,
  } })
  await store.reserveCheckpointRoute(checkpointDigest, 'runtime-isolation', runtimeRelease)
  const accountId = 'a'.repeat(32), appId = 'b'.repeat(32)
  const inventory = { application: { id: appId, name: `${runtimeRelease.workerService}-agent-sandbox`,
    durable_objects: { namespace_id: appId }, health: { instances: { active: 0, starting: 0 } } },
  pages: [{ pageToken: null, response: { success: true, result: { instances: [],
    durable_objects: [{ id: 'c'.repeat(64) }] }, result_info: { per_page: 100 } } }] }
  const receipt = (workflow: string) => ({ path: `/accounts/${accountId}/workflows/${workflow}/instances/${body.fixtureId}`,
    httpStatus: 404, body: { success: false, result: null, errors: [{ code: 10400 }] } })
  const proof: TerminalFixtureRetirementProof = {
    schemaVersion: 1, kind: 'retired-terminal-fixture', runId: body.fixtureId,
    experimentId: 'runtime-isolation', runtimeRelease,
    auditWorkflowStatus: 'instance-not-found', isolationWorkflowStatus: 'instance-not-found',
    isolationWorkflow: { status: 'instance-not-found' }, sandboxNamespaceId: appId, containerApplicationId: appId,
    containerInventoryDigest: await sha256(inventory), containerInstanceCount: 0,
    containerInventoryComplete: true, observedAt: '2026-10-03T00:00:00Z',
    postRetention: { accountId, checkpointDigest, audit: receipt(runtimeRelease.workflowName),
      isolation: receipt(`${runtimeRelease.workflowName}-isolation`), inventory },
  }
  const liveFixture = vi.fn(async () => { throw new Error('expired native Workflow must not be replayed') })
  const { checkpointDigest: _, ...native } = structuredClone(proof.postRetention!)
  const observeExpired = vi.fn(async () => native)
  const retire = () => retireTerminalFixture({ fixtureId: body.fixtureId, accountId, proof,
    now: Date.parse(proof.observedAt), store, liveFixture, observeExpired })
  return { proof, body, key, content, artifacts, store, sqlite, beforeLeaseUpdate, retire, liveFixture, observeExpired }
}

describe('fixture retirement after native retention', () => {
  it('archives the real missing-native disposition and releases only the exact fixture lease', async () => {
    const f = await expiredFixture()
    const result = await f.retire()
    expect(await f.retire()).toEqual(result)
    expect(f.liveFixture).not.toHaveBeenCalled()
    expect(await f.store.retiredUnmaterializedRoute(f.proof.runId)).toMatchObject({
      isolationWorkflowStatus: 'instance-not-found', proofDigest: result.proofDigest,
    })
    expect(f.sqlite.prepare('SELECT terminal_workflow_status, released_at FROM runtime_slot_run_leases WHERE run_id=?')
      .get(f.proof.runId)).toMatchObject({ terminal_workflow_status: 'instance-not-found', released_at: expect.any(String) })
    expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id=?')
      .get('untouched-fixture')).toMatchObject({ released_at: null })
    expect(await f.store.runRuntime(f.proof.runId)).toEqual(f.body.runtimeRelease)
  })
  it.each(['forged-checkpoint', 'wrong-checkpoint-route', 'within-retention', 'wrong-account',
    '403', 'wrong-native-id', 'active-instance', 'assigned-actor', 'more-pages', 'wrong-app', 'wrong-inventory-digest'])(
    'refuses %s without releasing the lease', async defect => {
      const f = await expiredFixture(), post = f.proof.postRetention!
      if (defect === 'forged-checkpoint') await f.artifacts.put(f.key, f.content + ' ', {})
      if (defect === 'wrong-checkpoint-route') f.sqlite.prepare('UPDATE checkpoint_runtime_routes SET experiment_id=?').run('other')
      if (defect === 'within-retention') f.proof.observedAt = '2026-10-01T02:00:00Z'
      if (defect === 'wrong-account') post.accountId = 'f'.repeat(32)
      if (defect === '403') post.isolation.httpStatus = 403
      if (defect === 'wrong-native-id') post.audit.path += '-other'
      const inv = post.inventory as any
      if (defect === 'active-instance') inv.pages[0].response.result.instances.push({ id: 'live' })
      if (defect === 'assigned-actor') inv.pages[0].response.result.durable_objects[0].deployment_id = 'live'
      if (defect === 'more-pages') inv.pages[0].response.result_info.next_page_token = 'next'
      if (defect === 'wrong-app') inv.application.id = 'f'.repeat(32)
      if (defect === 'wrong-inventory-digest') f.proof.containerInventoryDigest = 'f'.repeat(64)
      await expect(f.retire()).rejects.toThrow()
      expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id=?')
        .get(f.proof.runId)).toMatchObject({ released_at: null })
    })
  it('rejects well-formed forged zero-work receipts when authenticated native reads differ', async () => {
    const f = await expiredFixture()
    const { checkpointDigest: _, ...live } = structuredClone(f.proof.postRetention!)
    live.isolation = { ...live.isolation, httpStatus: 200, body: { success: true, result: { status: 'running' } } }
    f.observeExpired.mockResolvedValue(live)
    await expect(f.retire()).rejects.toThrow('authenticated observation')
    expect(f.observeExpired).toHaveBeenCalledOnce()
    expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id=?')
      .get(f.proof.runId)).toMatchObject({ released_at: null })
  })
  it('refuses native observation failures instead of trusting caller inventory', async () => {
    const f = await expiredFixture()
    f.observeExpired.mockRejectedValue(new Error('native HTTP 403'))
    await expect(f.retire()).rejects.toThrow('native HTTP 403')
    expect(await f.store.retiredUnmaterializedRoute(f.proof.runId)).toBeNull()
  })
  it('reconciles archive-before-lease partial failure without inventing completion', async () => {
    const f = await expiredFixture()
    f.beforeLeaseUpdate(() => { throw new Error('lost lease acknowledgement') })
    await expect(f.retire()).rejects.toThrow('lost lease acknowledgement')
    f.beforeLeaseUpdate(null)
    expect(await f.retire()).toMatchObject({ retired: true })
    expect(f.liveFixture).not.toHaveBeenCalled()
  })
})

it('reconciles a committed route-and-lease batch after its acknowledgement is lost', async () => {
  const { d1, sqlite } = index(), store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
  await store.ensureSchema()
  const runtime = release('11111111-1111-4111-8111-111111111111')
  const batch = d1.batch.bind(d1)
  vi.spyOn(d1, 'batch').mockImplementationOnce(async statements => {
    await batch(statements)
    throw new Error('batch acknowledgement lost')
  })
  await expect(store.reserveRunRoute('lost-admission', 'experiment', runtime)).rejects.toThrow('acknowledgement lost')
  await store.reserveRunRoute('lost-admission', 'experiment', runtime)
  expect(sqlite.prepare('SELECT count(*) AS n FROM runtime_slot_run_leases').get()).toEqual({ n: 1 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM run_runtime_routes').get()).toEqual({ n: 1 })
})

it.each(['state', 'route'] as const)('does not lease an identity claimed by %s between its initial read and atomic admission', async kind => {
  const { d1, sqlite, beforeRouteInsert } = index()
  const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
  await store.ensureSchema()
  beforeRouteInsert(() => {
    if (kind === 'state') sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES ('claimed-run', 'other', 'running', 'fake', 1, '2026-01-01T00:00:00Z')`).run()
    else sqlite.prepare(`INSERT INTO run_runtime_routes (run_id, experiment_id, runtime_release_json, reserved_at)
      VALUES ('claimed-run', 'other', ?, '2026-01-01T00:00:00Z')`)
      .run(canonicalJson(release('11111111-1111-4111-8111-111111111111')))
  })
  await expect(store.reserveRunRoute('claimed-run', 'experiment', release('11111111-1111-4111-8111-111111111111')))
    .rejects.toMatchObject({ name: 'RunCommandConflict', code: 'idempotency-conflict' })
  expect(sqlite.prepare('SELECT count(*) AS n FROM runtime_slot_run_leases').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('SELECT count(*) AS n FROM run_runtime_routes').get()).toEqual({ n: kind === 'route' ? 1 : 0 })
})

it('refuses a matching runtime JSON lease assigned to another slot without publishing a route', async () => {
  const { d1, sqlite } = index(), store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1)
  await store.ensureSchema()
  const runtime = release('11111111-1111-4111-8111-111111111111')
  sqlite.prepare(`INSERT INTO runtime_slot_run_leases
    (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled)
    VALUES ('wrong-slot', 'experiment', 'another-slot', ?, '2026-01-01T00:00:00Z', 0)`).run(canonicalJson(runtime))
  await expect(store.reserveRunRoute('wrong-slot', 'experiment', runtime))
    .rejects.toMatchObject({ name: 'RunCommandConflict', code: 'idempotency-conflict' })
  expect(sqlite.prepare('SELECT count(*) AS n FROM run_runtime_routes').get()).toEqual({ n: 0 })
  expect(sqlite.prepare('SELECT slot_id FROM runtime_slot_run_leases').get()).toEqual({ slot_id: 'another-slot' })
})
