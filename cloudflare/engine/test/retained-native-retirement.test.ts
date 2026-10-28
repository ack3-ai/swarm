import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { expect, it } from 'vitest'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { canonicalJson, sha256 } from '../src/canonical.js'

class SqlD1 {
  readonly db = new DatabaseSync(':memory:')
  prepare(sql: string) {
    // Node 22.19's experimental SQLite API cannot bind numbered ?N arguments.
    // D1 supports them, so map to named parameters in this in-memory adapter.
    const statement = sql.replace(/\?([1-9][0-9]*)/g, ':p$1')
    const parameters = (args: unknown[]) => Object.fromEntries(args.map((value, index) =>
      [`p${index + 1}`, value as SQLInputValue])) as Record<string, SQLInputValue>
    const bound = (args: unknown[]) => ({
      bind: (...values: unknown[]) => bound(values),
      run: async () => args.length === 0 ? this.db.prepare(statement).run()
        : this.db.prepare(statement).run(parameters(args)),
      first: async () => (args.length === 0 ? this.db.prepare(statement).get()
        : this.db.prepare(statement).get(parameters(args))) ?? null,
    })
    return bound([])
  }
  async batch(statements: { run(): Promise<unknown> }[]) {
    for (const statement of statements) await statement.run()
    return []
  }
}

class Bucket {
  readonly objects = new Map<string, { content: string, metadata: Record<string, string> }>()
  failNextPut = false
  async put(key: string, content: string, options: { customMetadata: Record<string, string> }) {
    if (this.failNextPut) { this.failNextPut = false; throw new Error('transient proof storage failure') }
    if (this.objects.has(key)) return null
    this.objects.set(key, { content, metadata: options.customMetadata })
    return { key }
  }
  async get(key: string) {
    const value = this.objects.get(key)
    if (value === undefined) return null
    return { text: async () => value.content, customMetadata: value.metadata,
      checksums: { toJSON: () => ({ sha256: value.metadata.objectSha256 }) } }
  }
}

it('archives one exact failed source and claims its retained workspace for only one child', async () => {
  const database = new SqlD1(), bucket = new Bucket()
  const store = new CloudflareRunStore(bucket as unknown as R2Bucket,
    bucket as unknown as R2Bucket, database as unknown as D1Database)
  await store.ensureSchema()
  const runtimeRelease = { schemaVersion: 1 as const, id: 'runtime-source',
    frameworkCommit: 'a'.repeat(40), workerService: 'runtime-source',
    workerVersionId: '11111111-1111-4111-8111-111111111111',
    workflowName: 'audit-source', containerImageDigest: `sha256:${'a'.repeat(64)}` }
  const nativeTransport = { code: 'SERVER' as const, sourceRunId: 'failed-source',
    requestDigest: 'b'.repeat(64), sessionId: 'session-11111111-1111-4111-8111-111111111111',
    snapshotDigest: 'c'.repeat(64), workState: 'present' as const }
  const retainedNative = { stageId: 'negative-review', waveId: 'review-wave',
    taskId: 'negative-review-replica', workspaceKey: 'negative-review-replica',
    workspaceAllocationRunId: 'failed-source', sandboxObjectId: 'd'.repeat(64), nativeTransport }
  const checkpointDigest = 'e'.repeat(64)
  const source = { experimentId: 'public-audit', runId: 'failed-source', status: 'failed',
    stateGeneration: 7, runtimeRelease, inFlightAgentAttempts: [],
    checkpoints: [{ digest: checkpointDigest }], parentCheckpointDigest: null,
    rejectedAttempts: [1, 2].map(attempt => ({
      stageId: retainedNative.stageId, waveId: retainedNative.waveId,
      taskId: retainedNative.taskId, attempt, outputDigest: null, quarantineUri: null,
      repairScopeRunId: 'failed-source', sessionId: nativeTransport.sessionId,
      nativeTransport: { ...nativeTransport, requestDigest: attempt === 2
        ? nativeTransport.requestDigest : '1'.repeat(64),
        snapshotDigest: attempt === 2 ? nativeTransport.snapshotDigest : 'f'.repeat(64) },
    })), artifacts: [] }
  ;(store as unknown as { getState: () => Promise<unknown> }).getState = async () => source
  const releaseJson = canonicalJson(runtimeRelease)
  database.db.prepare(`INSERT INTO experiment_runs
    (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run('failed-source', 'public-audit', 'failed', 'source-state-key', 7, '2026-10-06')
  database.db.prepare(`INSERT INTO run_runtime_routes
    (run_id, experiment_id, runtime_release_json, reserved_at) VALUES (?, ?, ?, ?)`)
    .run('failed-source', 'public-audit', releaseJson, '2026-10-06')
  database.db.prepare(`INSERT INTO runtime_slot_run_leases
    (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('failed-source', 'public-audit', runtimeRelease.id, releaseJson, '2026-10-06', 1)
  const input = { experimentId: 'public-audit', sourceRunId: 'failed-source', childRunId: 'one-child',
    sourceStateGeneration: 7, sourceStateDigest: await sha256(source), checkpointDigest,
    retainedNative, workflow: { status: 'errored' } }
  bucket.failNextPut = true
  await expect(store.archiveFailedNativeRunAndReleaseLease(input)).rejects.toThrow('transient proof storage')
  await expect(store.archiveFailedNativeRunAndReleaseLease({ ...input, childRunId: 'other-child' }))
    .rejects.toThrow('another recovery')
  const proofDigest = await store.archiveFailedNativeRunAndReleaseLease(input)
  expect(proofDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(await store.archiveFailedNativeRunAndReleaseLease(input)).toBe(proofDigest)
  expect(await store.retainedNativeWorkspaceClaim('failed-source', retainedNative.workspaceKey))
    .toMatchObject({ childRunId: 'one-child', sourceStateDigest: input.sourceStateDigest,
      snapshotDigest: nativeTransport.snapshotDigest, sandboxObjectId: retainedNative.sandboxObjectId })
  expect(await store.retiredRunWorkflow('failed-source')).toMatchObject({ disposition: 'retired-fenced' })
  expect(database.db.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
    .get('failed-source')?.released_at).toBeTruthy()
  await expect(store.archiveFailedNativeRunAndReleaseLease({ ...input, childRunId: 'other-child' }))
    .rejects.toThrow('another recovery')
  await expect(store.archiveFailedNativeRunAndReleaseLease({ ...input,
    retainedNative: { ...retainedNative, nativeTransport: { ...nativeTransport, snapshotDigest: '0'.repeat(64) } } }))
    .rejects.toThrow('terminal recovery')
})
