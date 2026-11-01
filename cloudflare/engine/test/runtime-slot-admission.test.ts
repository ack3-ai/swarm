import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { canonicalJson } from '../src/canonical.js'
import { sha256 } from '../src/canonical.js'
import type { RunState, RuntimeRelease } from '../src/contracts.js'
import { retireTerminalFixture, type TerminalFixtureRetirementProof } from '../src/terminal-fixture-retirement.js'
import { retireStoppedRun, type StoppedRunRetirementProof } from '../src/stopped-run-retirement.js'
import { retireFailedRun, type FailedRunRetirementProof } from '../src/failed-run-retirement.js'
import type { UnmaterializedRecoveryRetirementProof } from '../src/unmaterialized-recovery-retirement.js'

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
      for (const statement of statements) await statement.run()
      return []
    },
  } as unknown as D1Database
  return { d1, sqlite: db, beforeRouteInsert: callback => { beforeRouteInsert = callback },
    beforeLeaseUpdate: callback => { beforeLeaseUpdate = callback },
    beforeArchiveInsert: callback => { beforeArchiveInsert = callback } }
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
  await store.putState(state)
  await bucketStore.put(`runs/${runId}/stop-request.json`, '{}')
  const stateKey = (sqlite.prepare('SELECT state_key FROM experiment_runs WHERE run_id = ?')
    .get(runId) as { state_key: string }).state_key
  const workflow = options.directStop ? { status: 'terminated' }
    : { status: 'complete', output: { status: 'stopped' } }
  const proof: StoppedRunRetirementProof = {
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

  it.each([false, true])('archives only an exact terminal fixture lease (static=%s)', async staticAdmission => {
    const { d1, sqlite, beforeArchiveInsert, beforeLeaseUpdate } = index()
    const artifacts = bucket()
    const store = new CloudflareRunStore(artifacts, artifacts, d1)
    await store.ensureSchema()
    const runtimeRelease = release('11111111-1111-4111-8111-111111111111')
    if (!staticAdmission) await d1.prepare(`INSERT INTO runtime_slots
      (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?1, ?2, 1, ?3)`).bind(runtimeRelease.id, canonicalJson(runtimeRelease),
      '2026-10-01T00:00:00Z').run()
    await d1.prepare(`INSERT INTO runtime_slot_control
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
      sha256: partialDigest, customMetadata: { run: partialProof.runId },
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

  it('archives a refused recovery and releases only its exact current-slot lease', async () => {
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
    await store.reserveRunRoute('refused-child', 'audit-test', runtimeRelease)
    await store.reserveRunRoute('other-child', 'audit-test', runtimeRelease)
    const exact = sqlite.prepare(`SELECT route.reserved_at, lease.admitted_at
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      WHERE route.run_id = ?`).get('refused-child') as { reserved_at: string, admitted_at: string }
    const proof: UnmaterializedRecoveryRetirementProof = {
      schemaVersion: 1, kind: 'retired-unmaterialized-route',
      runId: 'refused-child', experimentId: 'audit-test', runtimeRelease,
      sourceRunId: 'failed-source', sourceStateDigest: 'c'.repeat(64),
      checkpointDigest: 'd'.repeat(64), reservationRequestDigest: 'e'.repeat(64),
      routeReservedAt: exact.reserved_at, leaseAdmittedAt: exact.admitted_at,
      auditWorkflowStatus: 'instance-not-found', isolationWorkflowStatus: 'instance-not-found',
      auditWorkflowReceiptDigest: 'f'.repeat(64), isolationWorkflowReceiptDigest: '1'.repeat(64),
      containerInventoryDigest: '2'.repeat(64), containerInstanceCount: 0,
      containerInventoryComplete: true, observedAt: '2026-10-06T00:00:00Z',
    }
    await expect(store.archiveUnmaterializedRecoveryAndReleaseLease({ ...proof,
      containerInstanceCount: 1 as 0 })).rejects.toThrow('proof is invalid')
    const digest = await store.archiveUnmaterializedRecoveryAndReleaseLease(proof)
    expect(await store.archiveUnmaterializedRecoveryAndReleaseLease(proof)).toBe(digest)
    expect(await store.retiredUnmaterializedRoute(proof.runId)).toMatchObject({
      experimentId: 'audit-test', runtimeRelease, proofDigest: digest,
    })
    expect(sqlite.prepare(`SELECT released_at, terminal_workflow_status
      FROM runtime_slot_run_leases WHERE run_id = ?`).get(proof.runId))
      .toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'instance-not-found' })
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?`)
      .get('other-child')).toMatchObject({ released_at: null })
    await expect(store.archiveUnmaterializedRecoveryAndReleaseLease({ ...proof,
      auditWorkflowReceiptDigest: '3'.repeat(64) })).rejects.toThrow('proof changed')

    await store.reserveRunRoute('stateful-child', 'audit-test', runtimeRelease)
    sqlite.prepare(`INSERT INTO experiment_runs
      (run_id, experiment_id, status, state_key, state_generation, updated_at)
      VALUES (?, ?, 'running', 'fake', 1, ?)`).run('stateful-child', 'audit-test',
        '2026-10-06T00:00:00Z')
    const stateful = sqlite.prepare(`SELECT route.reserved_at, lease.admitted_at
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      WHERE route.run_id = ?`).get('stateful-child') as { reserved_at: string, admitted_at: string }
    await expect(store.archiveUnmaterializedRecoveryAndReleaseLease({ ...proof,
      runId: 'stateful-child', routeReservedAt: stateful.reserved_at,
      leaseAdmittedAt: stateful.admitted_at })).rejects.toThrow('route, lease, or proof changed')

    await store.reserveRunRoute('rotating-child', 'audit-test', runtimeRelease)
    const rotating = sqlite.prepare(`SELECT route.reserved_at, lease.admitted_at
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      WHERE route.run_id = ?`).get('rotating-child') as { reserved_at: string, admitted_at: string }
    sqlite.prepare(`UPDATE runtime_slot_control SET rotating_slot_id = ?`).run(runtimeRelease.id)
    await expect(store.archiveUnmaterializedRecoveryAndReleaseLease({ ...proof,
      runId: 'rotating-child', routeReservedAt: rotating.reserved_at,
      leaseAdmittedAt: rotating.admitted_at })).rejects.toThrow('slot changed or is rotating')
    sqlite.prepare(`UPDATE runtime_slot_control SET rotating_slot_id = NULL`).run()

    await store.reserveRunRoute('partial-child', 'audit-test', runtimeRelease)
    const partial = sqlite.prepare(`SELECT route.reserved_at, lease.admitted_at
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      WHERE route.run_id = ?`).get('partial-child') as { reserved_at: string, admitted_at: string }
    const partialProof = { ...proof, runId: 'partial-child',
      routeReservedAt: partial.reserved_at, leaseAdmittedAt: partial.admitted_at }
    const partialContent = canonicalJson(partialProof), partialDigest = await sha256(partialContent)
    await artifacts.put(`runtime-retirements/sha256/${partialDigest}.json`, partialContent, {
      sha256: partialDigest, customMetadata: { run: partialProof.runId },
    })
    sqlite.prepare(`INSERT INTO retired_unmaterialized_routes
      (run_id, runtime_release_json, audit_workflow_status,
        isolation_workflow_status, proof_digest, retired_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(partialProof.runId, canonicalJson(runtimeRelease),
        partialProof.auditWorkflowStatus, partialProof.isolationWorkflowStatus,
        partialDigest, '2026-10-06T00:00:00Z')
    expect(await store.archiveUnmaterializedRecoveryAndReleaseLease(partialProof)).toBe(partialDigest)
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?`)
      .get('partial-child')).toMatchObject({ released_at: expect.any(String) })
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
      terminalReason: null, checkpoints: [] } as unknown as RunState
    await store.reserveRunRoute(state.runId, state.experimentId, runtimeRelease)
    await store.putState(state)
    const workflow = { status: 'complete', output: { status: 'completed' } }
    expect(await store.hasCompletedCleanupProof(state)).toBe(false)
    await expect(store.archiveCompletedRunAndReleaseLease(state.runId, workflow))
      .rejects.toThrow('cleanup proof is missing')
    expect(sqlite.prepare(`SELECT released_at FROM runtime_slot_run_leases
      WHERE run_id = ?`).get(state.runId)).toMatchObject({ released_at: null })
    await expect(store.putCompletedCleanupProof(state, { mode: 'provider-attempted',
      activeWorkspaceKeys: [], retainedWorkspaceKeys: ['native-work'], deferred: [] }))
      .rejects.toThrow('not terminal and empty')
    await store.putCompletedCleanupProof(state, { mode: 'provider-attempted',
      activeWorkspaceKeys: [], retainedWorkspaceKeys: [], deferred: [] })
    expect(await store.hasCompletedCleanupProof(state)).toBe(true)
    await store.archiveCompletedRunAndReleaseLease(state.runId, workflow)
    await store.archiveCompletedRunAndReleaseLease(state.runId, workflow)
    expect(sqlite.prepare(`SELECT terminal_workflow_status, released_at
      FROM runtime_slot_run_leases WHERE run_id = ?`).get(state.runId))
      .toMatchObject({ terminal_workflow_status: 'complete', released_at: expect.any(String) })
    expect(await store.retiredRunWorkflow(state.runId)).toMatchObject({
      workflow, disposition: 'terminal', cleanupProofDigest: expect.any(String),
    })
  })

  it('archives only a drained sealed stop and retries an interrupted exact lease release', async () => {
    const { store, sqlite, state, proof, workflow, liveRun, beforeLeaseUpdate } = await stoppedRunFixture()
    await expect(retireStoppedRun({ runId: proof.runId, proof: { ...proof, activePhysicalCount: 1 },
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('proof is invalid')
    await expect(retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 120_001, store, liveRun })).rejects.toThrow('stale')
    await expect(retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store,
      liveRun: async () => ({ state, workflow: { status: 'running' } }) })).rejects.toThrow('differs')
    beforeLeaseUpdate(() => { throw new Error('lease update interrupted') })
    await expect(retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('interrupted')
    expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: null })
    beforeLeaseUpdate(null)
    const retired = await retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 600_000, store, liveRun })
    expect(retired.retired).toBe(true)
    expect(await store.retiredRunWorkflow(proof.runId)).toMatchObject({
      disposition: 'retired-fenced', workflow, fenceProofDigest: retired.proofDigest,
    })
    expect(sqlite.prepare('SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'complete' })
    expect((await store.getState(proof.runId)).status).toBe('stopped')
    expect(await store.runRuntime(proof.runId)).toEqual(proof.runtimeRelease)
    await expect(retireStoppedRun({ runId: proof.runId,
      proof: { ...proof, stateDigest: 'f'.repeat(64) },
      now: Date.parse(proof.observedAt) + 600_000, store, liveRun })).rejects.toThrow('different proof')
  })

  it('retires an exact immediate stop with a terminated Workflow and no checkpoint', async () => {
    const { store, sqlite, state, proof, workflow, liveRun, beforeLeaseUpdate } =
      await stoppedRunFixture({ directStop: true })
    expect(proof).toMatchObject({ kind: 'terminal-stopped-custody', checkpointDigest: null })
    expect(state.waveAdmission).toMatchObject({ stageId: 'preflight', waveId: 'identity-tools-baseline' })
    await expect(retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store,
      liveRun: async () => ({ state, workflow: { status: 'complete' } }) }))
      .rejects.toThrow('differs')
    await expect(retireStoppedRun({ runId: proof.runId,
      proof: { ...proof, activePhysicalCount: 1 },
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('proof is invalid')
    await expect(retireStoppedRun({ runId: proof.runId,
      proof: { ...proof, checkpointDigest: 'f'.repeat(64) },
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('immediate operator stop')
    beforeLeaseUpdate(() => { throw new Error('lease update interrupted') })
    await expect(retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('interrupted')
    expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: null })
    beforeLeaseUpdate(null)
    const retired = await retireStoppedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 600_000, store, liveRun })
    expect(retired.retired).toBe(true)
    expect(await store.retiredRunWorkflow(proof.runId)).toMatchObject({
      disposition: 'retired-fenced', workflow, fenceProofDigest: retired.proofDigest,
    })
    expect(sqlite.prepare('SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'terminated' })
    expect((await store.getState(proof.runId)).status).toBe('stopped')
    const active = await stoppedRunFixture({ directStop: true, activeWork: true })
    await expect(retireStoppedRun({ runId: active.proof.runId, proof: active.proof,
      now: Date.parse(active.proof.observedAt), store: active.store, liveRun: active.liveRun }))
      .resolves.toMatchObject({ retired: true })
    const changed = await stoppedRunFixture({ directStop: true })
    changed.beforeArchiveInsert(() => {
      changed.sqlite.prepare('UPDATE experiment_runs SET checkpoint_digest = ? WHERE run_id = ?')
        .run('f'.repeat(64), changed.proof.runId)
    })
    await expect(changed.store.archiveStoppedRunAndReleaseLease(changed.proof))
      .rejects.toThrow('archive differs')
    expect(changed.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(changed.proof.runId)).toMatchObject({ released_at: null })
  })

  it('archives interrupted immediate-stop custody unchanged before releasing its exact lease', async () => {
    const { store, sqlite, bucketStore, state: sealed, proof: prior } = await stoppedRunFixture({ status: 'running' })
    const state = { ...sealed, stateGeneration: sealed.stateGeneration + 1, status: 'stopped', phase: 'stopped',
      terminalReason: 'operator-requested-immediate-stop',
      inFlightAgentAttempts: [{ stageId: 'discovery', waveId: 'wave-1', taskId: 'research-2',
        attempt: 1, promptDigest: 'a'.repeat(64), freshContext: true, continuationMode: 'new',
        sessionId: null, admittedAt: '2026-10-01T01:00:01Z' }],
      discoveryScheduler: { admissions: [{ stageId: 'discovery', waveId: 'wave-1', taskIds: ['research-2'] }] },
      journal: [...sealed.journal.slice(0, -1), { ...sealed.journal.at(-1)!, payload: {
        reason: 'operator-requested-immediate-stop', checkpointDigest: prior.checkpointDigest,
      } }],
    } as unknown as RunState
    await store.putState(state)
    const row = sqlite.prepare('SELECT state_key FROM experiment_runs WHERE run_id = ?')
      .get(state.runId) as { state_key: string }
    const workflow = { status: 'terminated' }
    const proof: StoppedRunRetirementProof = { ...prior, kind: 'terminal-stopped-custody',
      stateKey: row.state_key, stateGeneration: state.stateGeneration, stateDigest: await sha256(state), workflow }
    const bytes = await (await bucketStore.get(row.state_key))!.text()
    const liveRun = async () => ({ state, workflow })
    await expect(retireStoppedRun({ runId: state.runId, proof,
      now: Date.parse(proof.observedAt) + 120_001, store, liveRun })).rejects.toThrow('stale')
    await expect(retireStoppedRun({ runId: state.runId, proof: { ...proof, assignedPhysicalCount: 1 },
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('proof is invalid')
    await expect(retireStoppedRun({ runId: state.runId, proof,
      now: Date.parse(proof.observedAt), store, liveRun: async () => ({ state, workflow: { status: 'running' } }) }))
      .rejects.toThrow('differs')
    await expect(retireStoppedRun({ runId: state.runId, proof: { ...proof, stateDigest: 'f'.repeat(64) },
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('differs')
    await retireStoppedRun({ runId: state.runId, proof, now: Date.parse(proof.observedAt), store, liveRun })
    expect(await (await bucketStore.get(row.state_key))!.text()).toBe(bytes)
    expect(canonicalJson(await store.getState(state.runId))).toBe(canonicalJson(state))
    expect(sqlite.prepare('SELECT state_key, state_generation FROM retired_runtime_runs WHERE run_id = ?')
      .get(state.runId)).toEqual({ state_key: row.state_key, state_generation: state.stateGeneration })
    expect(sqlite.prepare('SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(state.runId)).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'terminated' })
  })

  it.each([false, true])('retires static-catalog stopped custody without a slot row (direct=%s)', async directStop => {
    const f = await stoppedRunFixture({ staticAdmission: true, directStop })
    const { store, sqlite, proof, state, workflow, liveRun, beforeArchiveInsert, beforeLeaseUpdate } = f
    const archive = () => store.archiveStoppedRunAndReleaseLease(proof)
    sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run()
    await expect(archive()).rejects.toThrow('route, lease, state, checkpoint, or slot changed')
    sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
    sqlite.prepare('UPDATE runtime_slot_run_leases SET admission_pool_enabled = 1').run()
    await expect(archive()).rejects.toThrow('route, lease, state, checkpoint, or slot changed')
    sqlite.prepare('UPDATE runtime_slot_run_leases SET admission_pool_enabled = 0').run()
    sqlite.prepare(`INSERT INTO runtime_slots (slot_id, runtime_release_json, generation, deployed_at)
      VALUES (?, ?, 1, ?)`).run(proof.runtimeRelease.id, canonicalJson(release('33333333-3333-4333-8333-333333333333')), proof.observedAt)
    await expect(archive()).rejects.toThrow('route, lease, state, checkpoint, or slot changed')
    sqlite.prepare('DELETE FROM runtime_slots').run()
    beforeArchiveInsert(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
    await expect(archive()).rejects.toThrow('archive differs')
    beforeArchiveInsert(null)
    sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
    beforeLeaseUpdate(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
    await expect(archive()).rejects.toThrow('lease was not released')
    beforeLeaseUpdate(null)
    expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases').get()).toMatchObject({ released_at: null })
    sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
    await expect(retireStoppedRun({ runId: proof.runId, proof, now: Date.parse(proof.observedAt) + 600_000,
      store, liveRun })).resolves.toMatchObject({ retired: true })
    expect(sqlite.prepare('SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases').get())
      .toMatchObject({ released_at: expect.any(String), terminal_workflow_status: workflow.status })
    expect(await store.getState(state.runId)).toEqual(state)
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM runtime_slots').get()).toEqual({ n: 0 })
  })

  it.each([false, true])('retires exact failed custody with zero work (static=%s)', async staticAdmission => {
    const { store, sqlite, state, proof: stopped, beforeLeaseUpdate, beforeArchiveInsert } =
      await stoppedRunFixture({ status: 'running', staticAdmission })
    const failed = { ...state, stateGeneration: state.stateGeneration + 1,
      status: 'failed', phase: 'discovery', terminalReason: 'provider boot failed',
      inFlightAgentAttempts: [] } as RunState
    await store.putState(failed)
    const row = sqlite.prepare('SELECT state_key FROM experiment_runs WHERE run_id = ?')
      .get(failed.runId) as { state_key: string }
    const workflow = { status: 'errored', error: { name: 'Error', message: 'provider boot failed' } }
    const proof: FailedRunRetirementProof = {
      schemaVersion: 1, kind: 'terminal-failed-custody', runId: failed.runId,
      experimentId: failed.experimentId, runtimeRelease: stopped.runtimeRelease,
      stateKey: row.state_key, stateGeneration: failed.stateGeneration,
      stateDigest: await sha256(failed), workflow,
      terminalReasonDigest: await sha256(failed.terminalReason!),
      acceptedArtifactManifestDigest: await sha256(failed.artifacts.filter(a => a.status === 'accepted')
        .map(a => ({ id: a.id, contentDigest: a.contentDigest }))),
      sandboxNamespaceId: stopped.sandboxNamespaceId,
      containerApplicationId: stopped.containerApplicationId,
      containerInventoryDigest: stopped.containerInventoryDigest,
      activePhysicalCount: 0, assignedPhysicalCount: 0, startingPhysicalCount: 0,
      inactiveActorCount: stopped.inactiveActorCount, inventoryComplete: true,
      ephemeralWorkspaceStatus: 'unavailable', observedAt: stopped.observedAt,
    }
    const liveRun = async () => ({ state: failed, workflow })
    await expect(retireFailedRun({ runId: proof.runId,
      proof: { ...proof, activePhysicalCount: 1 }, now: Date.parse(proof.observedAt),
      store, liveRun })).rejects.toThrow('proof is invalid')
    await expect(retireFailedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 120_001, store, liveRun })).rejects.toThrow('stale')
    if (staticAdmission) {
      expect(sqlite.prepare('SELECT admission_pool_enabled FROM runtime_slot_run_leases WHERE run_id = ?')
        .get(proof.runId)).toMatchObject({ admission_pool_enabled: 0 })
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run()
      await expect(store.archiveTerminalFailedRunAndReleaseLease(proof)).rejects.toThrow('route, lease, state, or slot changed')
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
      beforeArchiveInsert(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
      await expect(store.archiveTerminalFailedRunAndReleaseLease(proof)).rejects.toThrow('archive differs')
      beforeArchiveInsert(null)
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
      beforeLeaseUpdate(() => { sqlite.prepare('UPDATE runtime_slot_control SET enabled = 1').run() })
      await expect(store.archiveTerminalFailedRunAndReleaseLease(proof)).rejects.toThrow('lease was not released')
      beforeLeaseUpdate(null)
      expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
        .get(proof.runId)).toMatchObject({ released_at: null })
      sqlite.prepare('UPDATE runtime_slot_control SET enabled = 0').run()
    }
    beforeLeaseUpdate(() => { throw new Error('lease update interrupted') })
    await expect(retireFailedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt), store, liveRun })).rejects.toThrow('interrupted')
    expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: null })
    beforeLeaseUpdate(null)
    const result = await retireFailedRun({ runId: proof.runId, proof,
      now: Date.parse(proof.observedAt) + 600_000, store, liveRun })
    expect(result.retired).toBe(true)
    expect(sqlite.prepare('SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(proof.runId)).toMatchObject({ released_at: expect.any(String), terminal_workflow_status: 'errored' })
    expect((await store.getState(proof.runId)).status).toBe('failed')
    await expect(retireFailedRun({ runId: proof.runId,
      proof: { ...proof, stateDigest: 'e'.repeat(64) },
      now: Date.parse(proof.observedAt) + 600_000, store, liveRun })).rejects.toThrow('different proof')
  })

  it('keeps stopped, running, missing-custody, and moved-slot work leased', async () => {
    for (const [name, options] of [
      ['running', { status: 'running' as const }],
      ['failed', { status: 'failed' as const }],
      ['active-work', { activeWork: true }],
      ['changed-failed-wave-recovery', { recoveryMismatch: 'failedWaveRecovery' as const }],
      ['changed-promoted-proofs', { recoveryMismatch: 'promotedExecutionProofs' as const }],
      ['changed-terminal-recovery', { recoveryMismatch: 'terminalCompletionRecovery' as const }],
      ['missing-artifact', { artifact: false }],
      ['missing-checkpoint', { checkpoint: false }],
    ] as const) {
      const { store, sqlite, proof, liveRun } = await stoppedRunFixture(options)
      await expect(retireStoppedRun({ runId: proof.runId, proof,
        now: Date.parse(proof.observedAt), store, liveRun }), name).rejects.toThrow()
      expect(sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
        .get(proof.runId)).toMatchObject({ released_at: null })
    }
    const changed = await stoppedRunFixture()
    changed.sqlite.prepare('UPDATE runtime_slot_control SET rotating_slot_id = ?')
      .run(changed.proof.runtimeRelease.id)
    await expect(changed.store.archiveStoppedRunAndReleaseLease(changed.proof))
      .rejects.toThrow('slot changed')
    expect(changed.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(changed.proof.runId)).toMatchObject({ released_at: null })
    const moved = await stoppedRunFixture()
    moved.beforeArchiveInsert(() => {
      moved.sqlite.prepare('UPDATE experiment_runs SET state_key = ? WHERE run_id = ?')
        .run('runs/moved/states/elsewhere', moved.proof.runId)
    })
    await expect(moved.store.archiveStoppedRunAndReleaseLease(moved.proof))
      .rejects.toThrow('archive differs')
    expect(moved.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(moved.proof.runId)).toMatchObject({ released_at: null })
  })

  it('requires the exact stopped frontier', async () => {
    const foreign = await stoppedRunFixture()
    await expect(foreign.store.archiveStoppedRunAndReleaseLease({ ...foreign.proof,
      checkpointDigest: 'f'.repeat(64) })).rejects.toThrow('sealed')
    await expect(foreign.store.archiveStoppedRunAndReleaseLease({ ...foreign.proof,
      runtimeRelease: release('22222222-2222-4222-8222-222222222222') }))
      .rejects.toThrow('sealed')
    expect(foreign.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get(foreign.proof.runId)).toMatchObject({ released_at: null })
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
      .rejects.toThrow('runtime slot is rotating or its release changed')
    expect(await store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit))
      .toMatchObject({ slotId: old.id, generation: 2, runtimeRelease: next })
    expect(await store.activateRotatedRuntimeSlot(intent, 1, old, next, old.frameworkCommit))
      .toMatchObject({ slotId: old.id, generation: 2, runtimeRelease: next })
    await expect(store.reserveRunRoute('stale-version', 'experiment', old))
      .rejects.toThrow('runtime slot is rotating or its release changed')
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
      .rejects.toThrow('runtime slot is rotating or its release changed')
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
      .rejects.toThrow('run routing was fenced by runtime pool activation')
    const route = sqlite.prepare('SELECT run_id FROM run_runtime_routes WHERE run_id = ?')
      .get('racing-start')
    const lease = sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
      .get('racing-start')
    expect(route).toBeUndefined()
    expect(lease).toMatchObject({ released_at: null })
  })
})
