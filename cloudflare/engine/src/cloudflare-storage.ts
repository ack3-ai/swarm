import type {
  ArtifactRecord, ArtifactStore, ReleasePackage, ReleasePackageBody, RetainedNativeRecoveryEvidence,
  RunState, RuntimeRelease, SealedCheckpoint, UnobservableNativeRecoveryEvidence,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { sealReleasePackage } from './release.js'
import { validateNewSearchAdmission } from './validation.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { TransientRunFailure } from './run-errors.js'
import {
  assertTerminalFixtureRetirementProof, type TerminalFixtureRetirementProof,
} from './terminal-fixture-retirement.js'
import {
  assertUnmaterializedRecoveryRetirementProof, type UnmaterializedRecoveryRetirementProof,
} from './unmaterialized-recovery-retirement.js'
import {
  assertStoppedRunRetirementProof, type StoppedRunRetirementProof,
} from './stopped-run-retirement.js'
import {
  assertFailedRunRetirementProof, type FailedRunRetirementProof,
} from './failed-run-retirement.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { R2AgentExecutionLogStore } from './agent-execution-log.js'
import { R2AgentObservationHealthStore } from './agent-observation-health.js'
import { exactUnobservableAttempt } from './unobservable-native-recovery.js'
import { ROUTING_SCHEMA_SQL } from './routing-schema.js'

const releaseKey = (digest: string) => `releases/sha256/${digest}.json`
const stateKey = (runId: string, generation: number, objectSha256: string) =>
  `runs/${runId}/states/${String(generation).padStart(12, '0')}-${objectSha256}.json`
const checkpointKey = (digest: string) => `checkpoints/sha256/${digest}.json`
const stopKey = (runId: string) => `runs/${runId}/stop-request.json`
const completedCleanupKey = (runId: string, generation: number) =>
  `runs/${runId}/terminal-cleanup/${String(generation).padStart(12, '0')}.json`
const routingSchemaReady = new WeakMap<D1Database, Promise<void>>()

export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(record: Omit<ArtifactRecord, 'uri'>, content: string): Promise<ArtifactRecord> {
    const key = `artifacts/${record.id}.json`
    await this.bucket.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { sha256: record.contentDigest, task: record.taskId },
      sha256: record.contentDigest,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    return { ...record, uri: `r2://ARTIFACTS/${key}` }
  }

  async read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>> {
    const prefix = 'r2://ARTIFACTS/'
    if (!record.uri.startsWith(prefix)) throw new Error(`artifact URI is outside ARTIFACTS: ${record.id}`)
    const object = await this.bucket.get(record.uri.slice(prefix.length))
    if (object === null) throw new Error(`artifact content is missing: ${record.id}`)
    const content = await object.text()
    if (await sha256(content) !== record.contentDigest
      || object.customMetadata?.sha256 !== record.contentDigest
      || object.checksums.toJSON().sha256 !== record.contentDigest) {
      throw new Error(`artifact content digest mismatch: ${record.id}`)
    }
    const value = JSON.parse(content) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`artifact content is invalid: ${record.id}`)
    return value as Readonly<Record<string, string>>
  }

  async putRejected(record: { id: string, taskId: string, contentDigest: string }, content: string): Promise<string> {
    if (await sha256(content) !== record.contentDigest) throw new Error(`rejected artifact digest mismatch: ${record.id}`)
    const key = `quarantine/${record.id}.json`
    try {
      await this.bucket.put(key, content, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { sha256: record.contentDigest, task: record.taskId, disposition: 'rejected' },
        sha256: record.contentDigest,
        onlyIf: { etagDoesNotMatch: '*' },
      })
    } catch (error) {
      throw new TransientRunFailure('quarantine artifact storage is temporarily unavailable', { cause: error })
    }
    return `r2://ARTIFACTS/${key}`
  }

  async readRejected(uri: string, contentDigest: string, taskId: string): Promise<Readonly<Record<string, string>>> {
    const prefix = 'r2://ARTIFACTS/quarantine/'
    if (!uri.startsWith(prefix)) throw new Error('revalidation artifact is outside quarantine')
    const object = await this.bucket.get(uri.slice('r2://ARTIFACTS/'.length))
    if (object === null) throw new Error('revalidation artifact is missing')
    const content = await object.text()
    if (await sha256(content) !== contentDigest
      || object.customMetadata?.sha256 !== contentDigest
      || object.customMetadata?.task !== taskId
      || object.customMetadata?.disposition !== 'rejected'
      || object.checksums.toJSON().sha256 !== contentDigest) {
      throw new Error('revalidation artifact provenance mismatch')
    }
    const value = JSON.parse(content) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(item => typeof item !== 'string')) {
      throw new Error('revalidation artifact content is invalid')
    }
    return value as Readonly<Record<string, string>>
  }
}

export class CloudflareRunStore {
  constructor(
    private readonly packages: R2Bucket,
    private readonly artifacts: R2Bucket,
    private readonly index: D1Database,
  ) {}

  async putRelease(body: ReleasePackageBody): Promise<ReleasePackage> {
    const sealed = await sealReleasePackage(body)
    validateNewSearchAdmission(sealed.body.definition)
    const content = canonicalJson(sealed)
    const objectSha256 = await sha256(content)
    await this.packages.put(releaseKey(sealed.digest), content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { bodySha256: sealed.digest, objectSha256, experiment: body.definition.id },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    return sealed
  }

  async getRelease(digest: string): Promise<ReleasePackage> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('release digest is invalid')
    const object = await this.packages.get(releaseKey(digest))
    if (object === null) throw new Error(`release package is missing: ${digest}`)
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.bodySha256 !== digest
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) throw new Error('release package object digest mismatch')
    const value = JSON.parse(content) as ReleasePackage
    const expected = await sealReleasePackage(value.body)
    if (value.digest !== digest || expected.digest !== digest) throw new Error('release package digest mismatch')
    return value
  }

  async releaseExists(digest: string): Promise<boolean> {
    return (await this.packages.head(releaseKey(digest))) !== null
  }

  async getSource(tree: string, commit: string, sourcePackageVersion: 2): Promise<R2ObjectBody> {
    if (!/^[0-9a-f]{40}$/.test(tree)) throw new TypeError('source tree is invalid')
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new TypeError('source commit is invalid')
    if (sourcePackageVersion !== 2) throw new TypeError('source package version is invalid')
    const object = await this.packages.get(`sources/v2/git-tree/${tree}.tar.zst`)
    if (object === null) throw new Error(`source archive is missing for tree ${tree}`)
    const metadata = object.customMetadata ?? {}
    const checksum = object.checksums.toJSON().sha256
    if (metadata.gitTree !== tree || metadata.gitCommit !== commit || metadata.sourcePackageVersion !== '2'
      || metadata.archiveSha256 !== checksum
      || !/^[0-9a-f]{64}$/.test(checksum ?? '')) throw new Error(`source provenance mismatch for tree ${tree}`)
    return object
  }

  async putState(state: RunState): Promise<void> {
    if (state.runtimeRelease !== undefined) {
      await this.ensureRoutingSchema()
      await this.bindRunRoute(state.runId, state.experimentId, state.runtimeRelease)
    }
    const content = canonicalJson(state)
    const objectSha256 = await sha256(content)
    // R2 can commit before the D1 pointer update. A Workflow retry may then
    // reconstruct a different valid branch at the same generation. Bind the
    // immutable object key to its bytes so that orphaned writes cannot block
    // the retry; D1's generation CAS still chooses the single current branch.
    const key = stateKey(state.runId, state.stateGeneration, objectSha256)
    const verifyExisting = (existing: R2Object | null): void => {
      if (existing === null || existing.customMetadata?.objectSha256 !== objectSha256
        || existing.checksums.toJSON().sha256 !== objectSha256) {
        throw new Error(`run-state generation already exists with different bytes: ${state.runId}/${state.stateGeneration}`)
      }
    }
    // Reattaching to an admitted agent may persist the exact same snapshot.
    // Its immutable checksum is sufficient to reuse the object without sending
    // the whole state through another conditional upload. D1 still decides
    // whether this generation is authoritative, including orphaned R2 writes.
    const existing = await this.artifacts.head(key)
    if (existing !== null) {
      verifyExisting(existing)
    } else {
      const stored = await this.artifacts.put(key, content, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { status: state.status, experiment: state.experimentId, objectSha256, generation: String(state.stateGeneration) },
        sha256: objectSha256,
        onlyIf: { etagDoesNotMatch: '*' },
      })
      if (stored === null) verifyExisting(await this.artifacts.head(key))
    }
    const checkpoint = state.checkpoints.at(-1)?.digest ?? null
    await this.index.prepare(`
      INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, checkpoint_digest, updated_at, terminal_reason)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        state_key = excluded.state_key,
        state_generation = excluded.state_generation,
        checkpoint_digest = excluded.checkpoint_digest,
        updated_at = excluded.updated_at,
        terminal_reason = excluded.terminal_reason
      WHERE excluded.state_generation > experiment_runs.state_generation
        AND experiment_runs.status = 'running'
    `).bind(state.runId, state.experimentId, state.status, key, state.stateGeneration, checkpoint, state.updatedAt, state.terminalReason).run()
    const pointer = await this.index.prepare('SELECT state_key, state_generation FROM experiment_runs WHERE run_id = ?1')
      .bind(state.runId).first<{ state_key: string, state_generation: number }>()
    if (pointer?.state_key !== key || pointer.state_generation !== state.stateGeneration) {
      throw new Error(`stale run-state generation rejected: ${state.runId}/${state.stateGeneration}`)
    }
  }

  async getState(runId: string): Promise<RunState> {
    const state = await this.getStateIfPresent(runId)
    if (state === null) throw new Error(`run state is missing: ${runId}`)
    return state
  }

  async getStateIfPresent(runId: string): Promise<RunState | null> {
    const pointer = await this.index.prepare('SELECT state_key, state_generation FROM experiment_runs WHERE run_id = ?1')
      .bind(runId).first<{ state_key: string, state_generation: number }>()
    if (pointer === null) return null
    const object = await this.artifacts.get(pointer.state_key)
    if (object === null) throw new Error(`run state is missing: ${runId}`)
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) throw new Error(`run state object digest mismatch: ${runId}`)
    const state = JSON.parse(content) as RunState
    if (state.stateGeneration !== pointer.state_generation || object.customMetadata?.generation !== String(pointer.state_generation)) {
      throw new Error(`run state generation mismatch: ${runId}`)
    }
    return state
  }

  async putCompletedCleanupProof(state: RunState, cleanup: {
    mode: string, activeWorkspaceKeys: readonly string[],
    retainedWorkspaceKeys: readonly string[], deferred?: readonly string[],
  }): Promise<void> {
    if (state.status !== 'completed' || state.runtimeRelease === undefined
      || (state.inFlightAgentAttempts?.length ?? 0) !== 0
      || cleanup.mode !== 'provider-attempted'
      || cleanup.activeWorkspaceKeys.length !== 0
      || cleanup.retainedWorkspaceKeys.length !== 0
      || (cleanup.deferred?.length ?? 0) !== 0) {
      throw new Error('completed workspace cleanup is not terminal and empty')
    }
    const content = canonicalJson({ schemaVersion: 1, runId: state.runId,
      stateGeneration: state.stateGeneration, runtimeRelease: state.runtimeRelease,
      mode: cleanup.mode, activeWorkspaceKeys: [], retainedWorkspaceKeys: [], deferred: [] })
    const digest = await sha256(content)
    const key = completedCleanupKey(state.runId, state.stateGeneration)
    await this.artifacts.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { objectSha256: digest, run: state.runId },
      sha256: digest, onlyIf: { etagDoesNotMatch: '*' },
    })
    const object = await this.artifacts.get(key)
    if (object === null || await object.text() !== content
      || object.customMetadata?.objectSha256 !== digest
      || object.checksums.toJSON().sha256 !== digest) {
      throw new Error(`completed workspace cleanup proof differs: ${state.runId}`)
    }
  }

  async verifyCompletedCleanupProof(state: RunState): Promise<string> {
    if (state.status !== 'completed' || state.runtimeRelease === undefined
      || (state.inFlightAgentAttempts?.length ?? 0) !== 0) {
      throw new Error(`completed run still has active work: ${state.runId}`)
    }
    const key = completedCleanupKey(state.runId, state.stateGeneration)
    const object = await this.artifacts.get(key)
    if (object === null) throw new Error(`completed workspace cleanup proof is missing: ${state.runId}`)
    const content = await object.text()
    const digest = await sha256(content)
    const expected = canonicalJson({ schemaVersion: 1, runId: state.runId,
      stateGeneration: state.stateGeneration, runtimeRelease: state.runtimeRelease,
      mode: 'provider-attempted', activeWorkspaceKeys: [], retainedWorkspaceKeys: [], deferred: [] })
    if (content !== expected || object.customMetadata?.objectSha256 !== digest
      || object.checksums.toJSON().sha256 !== digest) {
      throw new Error(`completed workspace cleanup proof is invalid: ${state.runId}`)
    }
    return digest
  }

  /** Runs completed without this proof remain readable but keep their slot lease. */
  async hasCompletedCleanupProof(state: RunState): Promise<boolean> {
    return (await this.artifacts.head(completedCleanupKey(state.runId, state.stateGeneration))) !== null
  }

  async putCheckpoint(checkpoint: SealedCheckpoint): Promise<void> {
    const content = canonicalJson(checkpoint)
    const objectSha256 = await sha256(content)
    await this.artifacts.put(checkpointKey(checkpoint.digest), content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { bodySha256: checkpoint.digest, objectSha256, run: checkpoint.body.runId },
      sha256: objectSha256,
      onlyIf: { etagDoesNotMatch: '*' },
    })
    if (checkpoint.body.runtimeRelease !== undefined) {
      await this.reserveCheckpointRoute(
        checkpoint.digest,
        checkpoint.body.experimentId,
        checkpoint.body.runtimeRelease,
      )
    }
  }

  async reserveCheckpointRoute(
    digest: string,
    experimentId: string,
    runtimeRelease: RuntimeRelease,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('checkpoint digest is invalid')
    assertRuntimeRelease(runtimeRelease)
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(runtimeRelease)
    await this.index.prepare(`
      INSERT INTO checkpoint_runtime_routes (checkpoint_digest, experiment_id, runtime_release_json, created_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(checkpoint_digest) DO NOTHING
    `).bind(digest, experimentId, serialized, new Date().toISOString()).run()
    const route = await this.checkpointRuntime(digest)
    if (route === null || !sameRuntimeRelease(route, runtimeRelease)) {
      throw new Error(`checkpoint runtime route differs from sealed checkpoint: ${digest}`)
    }
  }

  async reserveRunRoute(runId: string, experimentId: string, runtimeRelease: RuntimeRelease): Promise<void> {
    assertRuntimeRelease(runtimeRelease)
    await this.ensureRoutingSchema()
    const existingRoute = await this.index.prepare(
      'SELECT experiment_id, runtime_release_json FROM run_runtime_routes WHERE run_id = ?1',
    ).bind(runId).first<{ experiment_id: string, runtime_release_json: string }>()
    if (existingRoute !== null) {
      const existingRuntime = this.parseRuntimeRoute(existingRoute.runtime_release_json, `run ${runId}`)
      if (existingRoute.experiment_id !== experimentId || !sameRuntimeRelease(existingRuntime, runtimeRelease)) {
        throw new Error(`run already exists with different routing: ${runId}`)
      }
      return
    }
    const existingRun = await this.index.prepare('SELECT run_id FROM experiment_runs WHERE run_id = ?1')
      .bind(runId).first<{ run_id: string }>()
    if (existingRun !== null) throw new Error(`run already exists: ${runId}`)
    // This single write races atomically with the rotation lock's conditional
    // update. An already-resolved release cannot start after its slot changes.
    const rotatingPool = await this.reserveSlotRunLease(runId, experimentId, runtimeRelease)
    await this.index.prepare(`
      INSERT INTO run_runtime_routes (run_id, experiment_id, runtime_release_json, reserved_at)
      SELECT ?1, ?2, ?3, ?4
      WHERE COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0) = ?5
      ON CONFLICT(run_id) DO NOTHING
    `).bind(runId, experimentId, canonicalJson(runtimeRelease), new Date().toISOString(),
      rotatingPool ? 1 : 0).run()
    const storedRoute = await this.index.prepare(
      'SELECT experiment_id, runtime_release_json FROM run_runtime_routes WHERE run_id = ?1',
    ).bind(runId).first<{ experiment_id: string, runtime_release_json: string }>()
    if (storedRoute === null) {
      throw new Error(`run routing was fenced by runtime pool activation: ${runId}`)
    }
    if (storedRoute.experiment_id !== experimentId
      || !sameRuntimeRelease(this.parseRuntimeRoute(storedRoute.runtime_release_json, `run ${runId}`), runtimeRelease)) {
      throw new Error(`run already exists with different routing: ${runId}`)
    }
  }

  private async reserveSlotRunLease(runId: string, experimentId: string, runtimeRelease: RuntimeRelease): Promise<boolean> {
    const serialized = canonicalJson(runtimeRelease)
    await this.index.prepare(`
      INSERT INTO runtime_slot_run_leases
        (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled)
      SELECT ?1, ?2, ?3, ?4, ?5,
        COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0)
      WHERE COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0) = 0
        OR EXISTS (
          SELECT 1 FROM runtime_slots WHERE slot_id = ?3
            AND runtime_release_json = ?4
            AND NOT EXISTS (
              SELECT 1 FROM runtime_slot_control
              WHERE singleton = 1 AND rotating_slot_id = ?3
            )
        )
      ON CONFLICT(run_id) DO NOTHING
    `).bind(runId, experimentId, runtimeRelease.id, serialized, new Date().toISOString()).run()
    const lease = await this.index.prepare(`
      SELECT experiment_id, slot_id, runtime_release_json, admission_pool_enabled
      FROM runtime_slot_run_leases WHERE run_id = ?1
    `).bind(runId).first<{
      experiment_id: string, slot_id: string, runtime_release_json: string,
      admission_pool_enabled: number
    }>()
    if (lease?.experiment_id !== experimentId || lease?.slot_id !== runtimeRelease.id
      || lease.runtime_release_json !== serialized) {
      throw new Error(`runtime slot is rotating or its release changed: ${runtimeRelease.id}`)
    }
    return lease.admission_pool_enabled === 1
  }

  async lockOldestIdleRuntimeSlot(intent: string): Promise<{
    slotId: string, generation: number, deployedAt: string, runtimeRelease: RuntimeRelease
  }> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(intent)) {
      throw new TypeError('rotation intent must be a UUID')
    }
    await this.ensureRoutingSchema()
    const locked = await this.index.prepare(`
      WITH candidate AS (
        SELECT slot_id FROM runtime_slots AS slot
        WHERE NOT EXISTS (
          SELECT 1 FROM runtime_slot_run_leases AS lease
          WHERE lease.slot_id = slot.slot_id AND lease.released_at IS NULL
        )
        ORDER BY deployed_at ASC, slot_id ASC LIMIT 1
      )
      UPDATE runtime_slot_control
      SET rotating_slot_id = (SELECT slot_id FROM candidate),
        rotation_intent = ?1, updated_at = ?2
      WHERE singleton = 1 AND enabled = 1 AND rotation_intent IS NULL
        AND EXISTS (SELECT 1 FROM candidate)
      RETURNING rotating_slot_id
    `).bind(intent, new Date().toISOString()).first<{ rotating_slot_id: string }>()
    if (locked === null) throw new Error('all runtime slots are busy or another rotation is unresolved')
    const row = await this.index.prepare(`
      SELECT runtime_release_json, generation, deployed_at
      FROM runtime_slots WHERE slot_id = ?1
    `).bind(locked.rotating_slot_id).first<{
      runtime_release_json: string, generation: number, deployed_at: string
    }>()
    if (row === null) throw new Error('locked runtime slot is missing')
    const runtimeRelease: unknown = JSON.parse(row.runtime_release_json)
    assertRuntimeRelease(runtimeRelease)
    return { slotId: locked.rotating_slot_id, generation: row.generation,
      deployedAt: row.deployed_at, runtimeRelease }
  }

  async inspectRuntimeSlotRotation(intent: string): Promise<{
    slotId: string, generation: number, runtimeRelease: RuntimeRelease,
    lockHeld: boolean, latest: boolean
  } | null> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(intent)) {
      throw new TypeError('rotation intent must be a UUID')
    }
    await this.ensureRoutingSchema()
    const row = await this.index.prepare(`
      SELECT slot.slot_id, slot.runtime_release_json, slot.generation,
        control.latest_slot_id, control.rotation_intent,
        control.rotating_slot_id
      FROM runtime_slots AS slot CROSS JOIN runtime_slot_control AS control
      WHERE control.singleton = 1 AND control.enabled = 1
        AND (control.rotation_intent = ?1 AND control.rotating_slot_id = slot.slot_id
          OR slot.last_rotation_intent = ?1)
      LIMIT 1
    `).bind(intent).first<{
      slot_id: string, runtime_release_json: string, generation: number,
      latest_slot_id: string | null, rotation_intent: string | null,
      rotating_slot_id: string | null
    }>()
    if (row === null) return null
    const runtimeRelease: unknown = JSON.parse(row.runtime_release_json)
    assertRuntimeRelease(runtimeRelease)
    return { slotId: row.slot_id, generation: row.generation, runtimeRelease,
      lockHeld: row.rotation_intent === intent && row.rotating_slot_id === row.slot_id,
      latest: row.latest_slot_id === row.slot_id }
  }

  /** Called only when the owner-only intent proves no upload was attempted. */
  async cancelUnpublishedRuntimeSlot(
    intent: string, expectedGeneration: number, prior: RuntimeRelease,
    observed: RuntimeRelease,
  ): Promise<{ slotId: string, cancelled: true }> {
    assertRuntimeRelease(prior)
    assertRuntimeRelease(observed)
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(intent)
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
      || !sameRuntimeRelease(prior, observed)) {
      throw new Error('unpublished rotation identity is invalid')
    }
    await this.ensureRoutingSchema()
    const result = await this.index.prepare(`
      UPDATE runtime_slot_control
      SET rotating_slot_id = NULL, rotation_intent = NULL, updated_at = ?1
      WHERE singleton = 1 AND enabled = 1 AND rotating_slot_id = ?2
        AND rotation_intent = ?3
        AND EXISTS (
          SELECT 1 FROM runtime_slots WHERE slot_id = ?2
            AND generation = ?4 AND runtime_release_json = ?5
        )
        AND NOT EXISTS (
          SELECT 1 FROM runtime_slot_run_leases
          WHERE slot_id = ?2 AND released_at IS NULL
        )
    `).bind(new Date().toISOString(), prior.id, intent,
      expectedGeneration, canonicalJson(prior)).run()
    if (result.meta.changes !== 1) {
      throw new Error('unpublished rotation lock changed; keep the intent for inspection')
    }
    return { slotId: prior.id, cancelled: true }
  }

  /** Finalize only a natively observed new version; keep the lock on ambiguity. */
  async activateRotatedRuntimeSlot(
    intent: string, expectedGeneration: number, prior: RuntimeRelease,
    observed: RuntimeRelease, expectedCommit: string,
    expectedImage = prior.containerImageDigest,
  ): Promise<{ slotId: string, generation: number, runtimeRelease: RuntimeRelease }> {
    assertRuntimeRelease(prior)
    assertRuntimeRelease(observed)
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(intent)
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
      || !/^[0-9a-f]{40}$/.test(expectedCommit)
      || !/^sha256:[0-9a-f]{64}$/.test(expectedImage)
      || prior.id !== observed.id || prior.workerService !== observed.workerService
      || prior.workflowName !== observed.workflowName
      || expectedImage !== observed.containerImageDigest
      || prior.workerVersionId === observed.workerVersionId
      || observed.frameworkCommit !== expectedCommit) {
      throw new Error('observed runtime release does not match the locked rotation')
    }
    await this.ensureRoutingSchema()
    const control = await this.index.prepare(`
      SELECT rotating_slot_id, rotation_intent, latest_slot_id
      FROM runtime_slot_control WHERE singleton = 1 AND enabled = 1
    `).first<{
      rotating_slot_id: string | null, rotation_intent: string | null,
      latest_slot_id: string | null
    }>()
    const newSerialized = canonicalJson(observed)
    const oldSerialized = canonicalJson(prior)
    const current = await this.index.prepare(`
      SELECT runtime_release_json, generation, last_rotation_intent
      FROM runtime_slots WHERE slot_id = ?1
    `).bind(prior.id).first<{
      runtime_release_json: string, generation: number, last_rotation_intent: string | null
    }>()
    if (control?.rotation_intent !== intent || control.rotating_slot_id !== prior.id
      || current === null) {
      if (control?.rotation_intent === null && control?.rotating_slot_id === null
        && control.latest_slot_id === prior.id
        && current?.runtime_release_json === newSerialized
        && current.generation === expectedGeneration + 1
        && current.last_rotation_intent === intent) {
        return { slotId: prior.id, generation: current.generation, runtimeRelease: observed }
      }
      throw new Error('rotation intent or slot no longer matches')
    }
    if (current.runtime_release_json === oldSerialized) {
      if (current.generation !== expectedGeneration) {
        throw new Error('locked runtime slot generation changed')
      }
      const result = await this.index.prepare(`
        UPDATE runtime_slots
        SET runtime_release_json = ?1, generation = generation + 1,
          deployed_at = ?2, last_rotation_intent = ?3
        WHERE slot_id = ?4 AND runtime_release_json = ?5 AND generation = ?6
          AND EXISTS (
            SELECT 1 FROM runtime_slot_control
            WHERE singleton = 1 AND rotating_slot_id = ?4 AND rotation_intent = ?3
          )
          AND NOT EXISTS (
            SELECT 1 FROM runtime_slot_run_leases
            WHERE slot_id = ?4 AND released_at IS NULL
          )
      `).bind(newSerialized, new Date().toISOString(), intent, prior.id,
        oldSerialized, expectedGeneration).run()
      if (result.meta.changes !== 1) throw new Error('rotation slot update was not accepted')
    } else if (current.runtime_release_json !== newSerialized
      || current.last_rotation_intent !== intent
      || current.generation !== expectedGeneration + 1) {
      throw new Error('slot release changed outside this rotation')
    }
    const selected = await this.index.prepare(`
      UPDATE runtime_slot_control
      SET latest_slot_id = ?1, rotating_slot_id = NULL,
        rotation_intent = NULL, updated_at = ?2
      WHERE singleton = 1 AND enabled = 1 AND rotating_slot_id = ?1
        AND rotation_intent = ?3 AND EXISTS (
          SELECT 1 FROM runtime_slots
          WHERE slot_id = ?1 AND runtime_release_json = ?4
            AND last_rotation_intent = ?3
        )
    `).bind(prior.id, new Date().toISOString(), intent, newSerialized).run()
    if (selected.meta.changes !== 1) {
      throw new Error('rotated slot is published but latest selection is unresolved')
    }
    const updated = await this.index.prepare(`
      SELECT generation FROM runtime_slots WHERE slot_id = ?1
    `).bind(prior.id).first<{ generation: number }>()
    if (updated === null) throw new Error('activated slot generation is missing')
    return { slotId: prior.id, generation: updated.generation, runtimeRelease: observed }
  }

  async runRuntime(runId: string): Promise<RuntimeRelease | null> {
    await this.ensureRoutingSchema()
    const row = await this.index.prepare('SELECT runtime_release_json FROM run_runtime_routes WHERE run_id = ?1')
      .bind(runId).first<{ runtime_release_json: string }>()
    return row === null ? null : this.parseRuntimeRoute(row.runtime_release_json, `run ${runId}`)
  }

  /** Distinguish a completed lease release from an interrupted fixture archive. */
  /** Archive a terminal fixture without a run state before releasing only its exact slot lease. */
  async archiveTerminalFixtureAndReleaseLease(
    proof: TerminalFixtureRetirementProof,
  ): Promise<string> {
    assertTerminalFixtureRetirementProof(proof)
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(proof.runtimeRelease)
    const route = await this.index.prepare(`
      SELECT route.experiment_id, route.runtime_release_json,
        lease.experiment_id AS lease_experiment_id, lease.slot_id, lease.runtime_release_json AS lease_release,
        lease.released_at, lease.admission_pool_enabled, state.run_id AS state_run_id,
        slot.runtime_release_json AS slot_release, control.enabled AS pool_enabled, control.rotating_slot_id
      FROM run_runtime_routes route
      JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      LEFT JOIN experiment_runs state ON state.run_id = route.run_id
      WHERE route.run_id = ?1
    `).bind(proof.runId).first<{
      experiment_id: string, runtime_release_json: string, lease_experiment_id: string,
      slot_id: string, lease_release: string, released_at: string | null,
      state_run_id: string | null, slot_release: string | null, rotating_slot_id: string | null,
      admission_pool_enabled: number, pool_enabled: number
    }>()
    if (route === null || route.experiment_id !== 'runtime-isolation'
      || route.lease_experiment_id !== 'runtime-isolation'
      || route.runtime_release_json !== serialized || route.lease_release !== serialized
      || route.slot_id !== proof.runtimeRelease.id || route.state_run_id !== null
      || (route.released_at === null && (route.rotating_slot_id !== null
        || route.slot_release !== serialized && !(route.admission_pool_enabled === 0
          && route.pool_enabled === 0 && route.slot_release === null)))) {
      throw new Error('terminal fixture route, lease, or slot changed')
    }
    const content = canonicalJson(proof)
    const proofDigest = await sha256(content)
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    const stored = await this.artifacts.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { run: proof.runId, objectSha256: proofDigest },
      sha256: proofDigest, onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored === null) {
      const prior = await this.artifacts.get(key)
      if (prior === null || await sha256(await prior.text()) !== proofDigest
        || prior.checksums.toJSON().sha256 !== proofDigest
        || prior.customMetadata?.run !== proof.runId) throw new Error('terminal fixture proof differs')
    }
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_unmaterialized_routes
        (run_id, runtime_release_json, audit_workflow_status,
          isolation_workflow_status, proof_digest, retired_at)
      SELECT route.run_id, route.runtime_release_json, ?2, ?3, ?4, ?5
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      LEFT JOIN experiment_runs state ON state.run_id = route.run_id
      WHERE route.run_id = ?1 AND route.experiment_id = 'runtime-isolation'
        AND route.runtime_release_json = ?6 AND lease.runtime_release_json = ?6
        AND lease.slot_id = ?7 AND state.run_id IS NULL
        AND (lease.released_at IS NOT NULL OR
          ((slot.runtime_release_json = ?6 OR (lease.admission_pool_enabled = 0
            AND control.enabled = 0 AND slot.slot_id IS NULL)) AND control.rotating_slot_id IS NULL))
      ON CONFLICT(run_id) DO NOTHING
    `).bind(proof.runId, proof.auditWorkflowStatus, proof.isolationWorkflowStatus,
      proofDigest, retiredAt, serialized, proof.runtimeRelease.id).run()
    const retired = await this.retiredUnmaterializedRoute(proof.runId)
    if (retired?.proofDigest !== proofDigest) throw new Error('terminal fixture archive differs')
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = ?3
      WHERE run_id = ?1 AND experiment_id = 'runtime-isolation'
        AND slot_id = ?4 AND runtime_release_json = ?5
        AND NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?1)
        AND EXISTS (SELECT 1 FROM retired_unmaterialized_routes
          WHERE run_id = ?1 AND runtime_release_json = ?5 AND proof_digest = ?6)
        AND (released_at IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_slots slot
          JOIN runtime_slot_control control ON control.singleton = 1
          WHERE slot.slot_id = ?4 AND slot.runtime_release_json = ?5
            AND control.rotating_slot_id IS NULL)
          OR (admission_pool_enabled = 0
            AND NOT EXISTS (SELECT 1 FROM runtime_slots WHERE slot_id = ?4)
            AND EXISTS (SELECT 1 FROM runtime_slot_control
              WHERE singleton = 1 AND enabled = 0 AND rotating_slot_id IS NULL)))
    `).bind(proof.runId, retiredAt, proof.isolationWorkflowStatus,
      proof.runtimeRelease.id, serialized, proofDigest).run()
    const lease = await this.index.prepare(`
      SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
      WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
    `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
      released_at: string | null, terminal_workflow_status: string | null
    }>()
    if (!lease?.released_at || lease.terminal_workflow_status !== proof.isolationWorkflowStatus) {
      throw new Error('terminal fixture lease was not released')
    }
    return proofDigest
  }

  /** Preserve a refused recovery identity before releasing only its unstarted slot lease. */
  async archiveUnmaterializedRecoveryAndReleaseLease(
    proof: UnmaterializedRecoveryRetirementProof,
  ): Promise<string> {
    assertUnmaterializedRecoveryRetirementProof(proof)
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(proof.runtimeRelease)
    const content = canonicalJson(proof)
    const proofDigest = await sha256(content)
    const route = await this.index.prepare(`
      SELECT route.experiment_id, route.runtime_release_json, route.reserved_at,
        lease.experiment_id AS lease_experiment_id, lease.slot_id,
        lease.runtime_release_json AS lease_release, lease.admitted_at,
        lease.released_at, lease.terminal_workflow_status,
        state.run_id AS state_run_id, slot.runtime_release_json AS slot_release,
        control.rotating_slot_id
      FROM run_runtime_routes route
      JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      LEFT JOIN experiment_runs state ON state.run_id = route.run_id
      WHERE route.run_id = ?1
    `).bind(proof.runId).first<{
      experiment_id: string, runtime_release_json: string, reserved_at: string,
      lease_experiment_id: string, slot_id: string, lease_release: string,
      admitted_at: string, released_at: string | null,
      terminal_workflow_status: string | null, state_run_id: string | null,
      slot_release: string, rotating_slot_id: string | null
    }>()
    const prior = await this.retiredUnmaterializedRoute(proof.runId)
    if (route === null || route.experiment_id !== proof.experimentId
      || route.lease_experiment_id !== proof.experimentId
      || route.runtime_release_json !== serialized || route.lease_release !== serialized
      || route.slot_id !== proof.runtimeRelease.id
      || route.reserved_at !== proof.routeReservedAt
      || route.admitted_at !== proof.leaseAdmittedAt
      || route.state_run_id !== null
      || (prior !== null && prior.proofDigest !== proofDigest)) {
      throw new Error('unmaterialized recovery route, lease, or proof changed')
    }
    if (route.released_at !== null) {
      if (prior?.proofDigest !== proofDigest
        || route.terminal_workflow_status !== proof.auditWorkflowStatus) {
        throw new Error('unmaterialized recovery lease was released differently')
      }
      return proofDigest
    }
    if (route.slot_release !== serialized || route.rotating_slot_id !== null) {
      throw new Error('unmaterialized recovery slot changed or is rotating')
    }
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    const stored = await this.artifacts.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { run: proof.runId, objectSha256: proofDigest },
      sha256: proofDigest, onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored === null) {
      const existing = await this.artifacts.get(key)
      if (existing === null || await sha256(await existing.text()) !== proofDigest
        || existing.checksums.toJSON().sha256 !== proofDigest
        || existing.customMetadata?.run !== proof.runId) {
        throw new Error('unmaterialized recovery proof differs')
      }
    }
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_unmaterialized_routes
        (run_id, runtime_release_json, audit_workflow_status,
          isolation_workflow_status, proof_digest, retired_at)
      SELECT route.run_id, route.runtime_release_json, ?2, ?3, ?4, ?5
      FROM run_runtime_routes route
      JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      LEFT JOIN experiment_runs state ON state.run_id = route.run_id
      WHERE route.run_id = ?1 AND route.experiment_id = ?6
        AND route.runtime_release_json = ?7 AND route.reserved_at = ?8
        AND lease.experiment_id = ?6 AND lease.slot_id = ?9
        AND lease.runtime_release_json = ?7 AND lease.admitted_at = ?10
        AND lease.released_at IS NULL AND state.run_id IS NULL
        AND slot.runtime_release_json = ?7 AND control.rotating_slot_id IS NULL
      ON CONFLICT(run_id) DO NOTHING
    `).bind(proof.runId, proof.auditWorkflowStatus, proof.isolationWorkflowStatus,
      proofDigest, retiredAt, proof.experimentId, serialized, proof.routeReservedAt,
      proof.runtimeRelease.id, proof.leaseAdmittedAt).run()
    const archived = await this.retiredUnmaterializedRoute(proof.runId)
    if (archived?.proofDigest !== proofDigest) throw new Error('unmaterialized recovery archive differs')
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = ?3
      WHERE run_id = ?1 AND experiment_id = ?4 AND slot_id = ?5
        AND runtime_release_json = ?6 AND admitted_at = ?7
        AND EXISTS (SELECT 1 FROM retired_unmaterialized_routes
          WHERE run_id = ?1 AND runtime_release_json = ?6 AND proof_digest = ?8)
        AND NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?1)
    `).bind(proof.runId, retiredAt, proof.auditWorkflowStatus, proof.experimentId,
      proof.runtimeRelease.id, serialized, proof.leaseAdmittedAt, proofDigest).run()
    const lease = await this.index.prepare(`
      SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
      WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
    `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
      released_at: string | null, terminal_workflow_status: string | null
    }>()
    if (!lease?.released_at || lease.terminal_workflow_status !== proof.auditWorkflowStatus) {
      throw new Error('unmaterialized recovery lease was not released')
    }
    return proofDigest
  }

  /** A verified terminal or explicitly fenced historical run survives slot reuse. */
  async retiredRunWorkflow(runId: string): Promise<{
    workflow: unknown, disposition: 'terminal' | 'retired-fenced',
    fenceProofDigest: string | null, cleanupProofDigest: string | null, retiredAt: string
  } | null> {
    await this.ensureRoutingSchema()
    const row = await this.index.prepare(`
      SELECT retired.runtime_release_json, retired.state_key,
        retired.state_generation, retired.workflow_json, retired.disposition,
        retired.fence_proof_digest, retired.cleanup_proof_digest, retired.retired_at,
        current.state_key AS current_state_key,
        current.state_generation AS current_generation,
        route.runtime_release_json AS route_runtime_json
      FROM retired_runtime_runs AS retired
      JOIN experiment_runs AS current ON current.run_id = retired.run_id
      JOIN run_runtime_routes AS route ON route.run_id = retired.run_id
      WHERE retired.run_id = ?1
    `).bind(runId).first<{
      runtime_release_json: string, state_key: string, state_generation: number,
      workflow_json: string, disposition: string, fence_proof_digest: string | null,
      cleanup_proof_digest: string | null,
      retired_at: string, current_state_key: string, current_generation: number,
      route_runtime_json: string
    }>()
    if (row === null) return null
    if (row.state_key !== row.current_state_key
      || row.state_generation !== row.current_generation
      || row.runtime_release_json !== row.route_runtime_json) {
      throw new Error(`retired run changed after its terminal seal: ${runId}`)
    }
    const workflow: unknown = JSON.parse(row.workflow_json)
    const workflowStatus = (workflow as { status?: string } | null)?.status
    const terminal = row.disposition === 'terminal'
      && ['complete', 'errored', 'terminated'].includes(workflowStatus ?? '')
    const fenced = row.disposition === 'retired-fenced'
      && ['paused', 'terminated', 'errored', 'complete'].includes(workflowStatus ?? '')
      && /^[0-9a-f]{64}$/.test(row.fence_proof_digest ?? '')
    if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)
      || !(terminal || fenced)) {
      throw new Error(`retired run Workflow receipt is invalid: ${runId}`)
    }
    if (fenced) {
      const digest = row.fence_proof_digest!
      const proof = await this.artifacts.get(`runtime-retirements/sha256/${digest}.json`)
      if (proof === null) throw new Error(`retired run fence proof is missing: ${runId}`)
      const content = await proof.text()
      if (await sha256(content) !== digest
        || proof.checksums.toJSON().sha256 !== digest
        || proof.customMetadata?.run !== runId) {
        throw new Error(`retired run fence proof digest differs: ${runId}`)
      }
    }
    return { workflow, disposition: row.disposition as 'terminal' | 'retired-fenced',
      fenceProofDigest: row.fence_proof_digest, cleanupProofDigest: row.cleanup_proof_digest,
      retiredAt: row.retired_at }
  }

  /** Rebind a lost admitted task only through its immutable terminal fence. */
  async fencedUnobservableNativeEvidence(source: RunState): Promise<UnobservableNativeRecoveryEvidence | undefined> {
    if ((source.inFlightAgentAttempts ?? []).length === 0) return undefined
    const retired = await this.retiredRunWorkflow(source.runId)
    const fenceDigest = retired?.fenceProofDigest
    if (retired?.disposition !== 'retired-fenced' || fenceDigest === null || fenceDigest === undefined
      || (retired.workflow as { status?: unknown } | null)?.status !== 'errored') {
      throw new Error('unobservable source has no exact terminal retirement fence')
    }
    const object = await this.artifacts.get(`runtime-retirements/sha256/${fenceDigest}.json`)
    const content = object === null ? null : await object.text()
    if (content === null || await sha256(content) !== fenceDigest
      || object!.checksums.toJSON().sha256 !== fenceDigest
      || object!.customMetadata?.run !== source.runId) {
      throw new Error('unobservable source retirement proof is missing or differs')
    }
    const proof: unknown = JSON.parse(content)
    assertFailedRunRetirementProof(proof)
    if (proof.runId !== source.runId || proof.stateGeneration !== source.stateGeneration
      || proof.stateDigest !== await sha256(source) || proof.unobservableNative === undefined
      || canonicalJson(proof.workflow) !== canonicalJson(retired.workflow)
      || !exactUnobservableAttempt(source, proof.unobservableNative)) {
      throw new Error('unobservable source retirement differs from current state')
    }
    const { inventory: _inventory, ...lost } = proof.unobservableNative
    if (await new R2AgentExecutionReceiptStore(this.artifacts)
      .get(source.runId, lost.requestDigest) !== null) {
      throw new Error('unobservable source acquired a terminal execution receipt')
    }
    return { ...lost, fenceProofDigest: fenceDigest }
  }

  /** A route that never acquired a state row has no audit result to reconstruct. */
  async retiredUnmaterializedRoute(runId: string): Promise<{
    experimentId: string, runtimeRelease: RuntimeRelease, auditWorkflowStatus: string,
    isolationWorkflowStatus: string, proofDigest: string, retiredAt: string
  } | null> {
    await this.ensureRoutingSchema()
    const row = await this.index.prepare(`
      SELECT retired.runtime_release_json, retired.audit_workflow_status,
        retired.isolation_workflow_status, retired.proof_digest, retired.retired_at,
        route.runtime_release_json AS route_runtime_json,
        route.experiment_id AS experiment_id,
        state.run_id AS state_run_id
      FROM retired_unmaterialized_routes AS retired
      JOIN run_runtime_routes AS route ON route.run_id = retired.run_id
      LEFT JOIN experiment_runs AS state ON state.run_id = retired.run_id
      WHERE retired.run_id = ?1
    `).bind(runId).first<{
      runtime_release_json: string, audit_workflow_status: string,
      isolation_workflow_status: string, proof_digest: string, retired_at: string,
      route_runtime_json: string, experiment_id: string, state_run_id: string | null
    }>()
    if (row === null) return null
    if (row.state_run_id !== null || row.runtime_release_json !== row.route_runtime_json
      || !/^[0-9a-f]{64}$/.test(row.proof_digest)
      || !['instance-not-found', 'definition-not-found'].includes(row.audit_workflow_status)
      || !['instance-not-found', 'definition-not-found', 'complete', 'errored', 'terminated']
        .includes(row.isolation_workflow_status)) {
      throw new Error(`retired unmaterialized route changed: ${runId}`)
    }
    const proof = await this.artifacts.get(`runtime-retirements/sha256/${row.proof_digest}.json`)
    if (proof === null) throw new Error(`retired route proof is missing: ${runId}`)
    const content = await proof.text()
    if (await sha256(content) !== row.proof_digest
      || proof.checksums.toJSON().sha256 !== row.proof_digest
      || proof.customMetadata?.run !== runId) {
      throw new Error(`retired route proof digest differs: ${runId}`)
    }
    const runtimeRelease: unknown = JSON.parse(row.runtime_release_json)
    assertRuntimeRelease(runtimeRelease)
    const evidence = JSON.parse(content) as Record<string, unknown>
    if (evidence.schemaVersion !== 1 || evidence.runId !== runId
      || evidence.experimentId !== row.experiment_id
      || evidence.auditWorkflowStatus !== row.audit_workflow_status
      || evidence.isolationWorkflowStatus !== row.isolation_workflow_status
      || canonicalJson(evidence.runtimeRelease) !== row.runtime_release_json) {
      throw new Error(`retired route proof does not bind the route: ${runId}`)
    }
    if (evidence.kind === 'retired-terminal-fixture') assertTerminalFixtureRetirementProof(evidence)
    else if (evidence.kind !== 'retired-unmaterialized-route'
      || !['instance-not-found', 'definition-not-found'].includes(row.isolation_workflow_status)) {
      throw new Error(`retired route proof has invalid disposition: ${runId}`)
    }
    return { experimentId: row.experiment_id, runtimeRelease,
      auditWorkflowStatus: row.audit_workflow_status,
      isolationWorkflowStatus: row.isolation_workflow_status,
      proofDigest: row.proof_digest, retiredAt: row.retired_at }
  }

  /** Fence one failed Workflow while retaining its native Sandbox for exactly one child. */
  async archiveFailedNativeRunAndReleaseLease(input: {
    experimentId: string
    sourceRunId: string
    childRunId: string
    sourceStateGeneration: number
    sourceStateDigest: string
    checkpointDigest: string
    retainedNative: RetainedNativeRecoveryEvidence
    workflow: unknown
  }): Promise<string> {
    const source = await this.getState(input.sourceRunId)
    const workflowStatus = (input.workflow as { status?: unknown } | null)?.status
    const retained = input.retainedNative
    const latest = source.rejectedAttempts.filter(rejection => rejection.stageId === retained.stageId
      && rejection.waveId === retained.waveId && rejection.taskId === retained.taskId
      && (rejection.repairScopeRunId ?? source.runId) === source.runId)
      .toSorted((left, right) => left.attempt - right.attempt).at(-1)
    if (source.experimentId !== input.experimentId || source.status !== 'failed'
      || workflowStatus !== 'errored' || (source.inFlightAgentAttempts ?? []).length !== 0
      || source.stateGeneration !== input.sourceStateGeneration
      || await sha256(source) !== input.sourceStateDigest
      || source.runtimeRelease === undefined
      || !source.checkpoints.some(checkpoint => checkpoint.digest === input.checkpointDigest)
        && source.parentCheckpointDigest !== input.checkpointDigest
      || retained.workspaceAllocationRunId !== input.sourceRunId
      || latest?.attempt !== 2 || latest.outputDigest !== null || latest.quarantineUri !== null
      || canonicalJson(latest.nativeTransport) !== canonicalJson(retained.nativeTransport)
      || source.artifacts.some(artifact => artifact.taskId === retained.taskId
        && artifact.stageId === retained.stageId && artifact.waveId === retained.waveId)) {
      throw new Error('failed native workspace source or Workflow is not an exact terminal recovery')
    }
    const runtimeRelease = source.runtimeRelease
    const serialized = canonicalJson(runtimeRelease)
    const proof = canonicalJson({ schemaVersion: 1, kind: 'retained-native-failed-run',
      experimentId: input.experimentId, sourceRunId: input.sourceRunId,
      childRunId: input.childRunId, sourceStateGeneration: source.stateGeneration,
      sourceStateDigest: input.sourceStateDigest, checkpointDigest: input.checkpointDigest,
      runtimeRelease, retainedNative: retained, workflow: input.workflow })
    const proofDigest = await sha256(proof)
    await this.ensureRoutingSchema()
    const row = await this.index.prepare(`
      SELECT current.state_key, current.state_generation, route.runtime_release_json,
        lease.released_at
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      WHERE current.run_id = ?1 AND current.experiment_id = ?2
    `).bind(input.sourceRunId, input.experimentId).first<{
      state_key: string, state_generation: number, runtime_release_json: string, released_at: string | null
    }>()
    if (row === null || row.state_generation !== source.stateGeneration
      || row.runtime_release_json !== serialized) throw new Error('failed native source route changed')
    await this.index.prepare(`
      INSERT INTO retained_native_workspace_claims
        (source_run_id, workspace_key, child_run_id, source_state_digest,
          snapshot_digest, sandbox_object_id, claimed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(source_run_id, workspace_key) DO NOTHING
    `).bind(input.sourceRunId, retained.workspaceKey, input.childRunId,
      input.sourceStateDigest, retained.nativeTransport.snapshotDigest,
      retained.sandboxObjectId, new Date().toISOString()).run()
    const claim = await this.index.prepare(`
      SELECT child_run_id, source_state_digest, snapshot_digest, sandbox_object_id
      FROM retained_native_workspace_claims
      WHERE source_run_id = ?1 AND workspace_key = ?2
    `).bind(input.sourceRunId, retained.workspaceKey).first<{
      child_run_id: string, source_state_digest: string, snapshot_digest: string, sandbox_object_id: string
    }>()
    if (claim?.child_run_id !== input.childRunId
      || claim.source_state_digest !== input.sourceStateDigest
      || claim.snapshot_digest !== retained.nativeTransport.snapshotDigest
      || claim.sandbox_object_id !== retained.sandboxObjectId) {
      throw new Error('failed native workspace belongs to another recovery')
    }
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    const stored = await this.artifacts.put(key, proof, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { run: input.sourceRunId, objectSha256: proofDigest },
      sha256: proofDigest, onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored === null) {
      const existing = await this.artifacts.get(key)
      if (existing === null || await sha256(await existing.text()) !== proofDigest
        || existing.checksums.toJSON().sha256 !== proofDigest
        || existing.customMetadata?.run !== input.sourceRunId) {
        throw new Error('failed native retirement proof differs')
      }
    }
    await this.index.prepare(`
      INSERT INTO retired_runtime_runs
        (run_id, runtime_release_json, state_key, state_generation, workflow_json,
          disposition, fence_proof_digest, cleanup_proof_digest, retired_at)
      SELECT current.run_id, route.runtime_release_json, current.state_key,
        current.state_generation, ?2, 'retired-fenced', ?3, NULL, ?4
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      WHERE current.run_id = ?1 AND current.experiment_id = ?5
        AND current.status = 'failed' AND current.state_key = ?6
        AND current.state_generation = ?7 AND route.runtime_release_json = ?8
        AND lease.released_at IS NULL
      ON CONFLICT(run_id) DO NOTHING
    `).bind(input.sourceRunId, canonicalJson(input.workflow), proofDigest,
      new Date().toISOString(), input.experimentId, row.state_key,
      source.stateGeneration, serialized).run()
    const archived = await this.index.prepare(`
      SELECT state_key, state_generation, runtime_release_json, workflow_json,
        disposition, fence_proof_digest FROM retired_runtime_runs WHERE run_id = ?1
    `).bind(input.sourceRunId).first<{
      state_key: string, state_generation: number, runtime_release_json: string,
      workflow_json: string, disposition: string, fence_proof_digest: string | null
    }>()
    if (archived?.state_key !== row.state_key || archived.state_generation !== source.stateGeneration
      || archived.runtime_release_json !== serialized
      || archived.workflow_json !== canonicalJson(input.workflow)
      || archived.disposition !== 'retired-fenced' || archived.fence_proof_digest !== proofDigest) {
      throw new Error('failed native run was archived differently')
    }
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = 'errored'
      WHERE run_id = ?1 AND runtime_release_json = ?3
        AND EXISTS (SELECT 1 FROM retired_runtime_runs
          WHERE run_id = ?1 AND runtime_release_json = ?3
            AND state_key = ?4 AND state_generation = ?5 AND fence_proof_digest = ?6)
    `).bind(input.sourceRunId, new Date().toISOString(), serialized,
      row.state_key, source.stateGeneration, proofDigest).run()
    return proofDigest
  }

  async retainedNativeWorkspaceClaim(sourceRunId: string, workspaceKey: string): Promise<{
    childRunId: string, sourceStateDigest: string, snapshotDigest: string, sandboxObjectId: string
  } | null> {
    await this.ensureRoutingSchema()
    const claim = await this.index.prepare(`
      SELECT child_run_id, source_state_digest, snapshot_digest, sandbox_object_id
      FROM retained_native_workspace_claims
      WHERE source_run_id = ?1 AND workspace_key = ?2
    `).bind(sourceRunId, workspaceKey).first<{
      child_run_id: string, source_state_digest: string, snapshot_digest: string, sandbox_object_id: string
    }>()
    return claim === null ? null : {
      childRunId: claim.child_run_id, sourceStateDigest: claim.source_state_digest,
      snapshotDigest: claim.snapshot_digest, sandboxObjectId: claim.sandbox_object_id,
    }
  }

  /** Archive first, then release the exact lease; retrying repairs partial D1 completion. */
  async archiveCompletedRunAndReleaseLease(runId: string, workflow: unknown): Promise<void> {
    if ((workflow as { status?: string } | null)?.status !== 'complete') {
      throw new Error(`native Workflow is not complete: ${runId}`)
    }
    const state = await this.getState(runId)
    const cleanupProofDigest = await this.verifyCompletedCleanupProof(state)
    const runtimeRelease = state.runtimeRelease
    if (runtimeRelease === undefined) throw new Error(`completed runtime binding is missing: ${runId}`)
    const serializedRelease = canonicalJson(runtimeRelease)
    const workflowJson = canonicalJson(workflow)
    await this.ensureRoutingSchema()
    const route = await this.runRuntime(runId)
    if (route === null || !sameRuntimeRelease(route, runtimeRelease)) {
      throw new Error(`completed run route differs: ${runId}`)
    }
    await this.index.prepare(`
      INSERT INTO retired_runtime_runs
        (run_id, runtime_release_json, state_key, state_generation, workflow_json,
          disposition, fence_proof_digest, cleanup_proof_digest, retired_at)
      SELECT current.run_id, route.runtime_release_json, current.state_key,
        current.state_generation, ?2, 'terminal', NULL, ?3, ?4
      FROM experiment_runs AS current
      JOIN run_runtime_routes AS route ON route.run_id = current.run_id
      WHERE current.run_id = ?1 AND current.status = 'completed'
        AND current.state_generation = ?5 AND route.runtime_release_json = ?6
      ON CONFLICT(run_id) DO NOTHING
    `).bind(runId, workflowJson, cleanupProofDigest, new Date().toISOString(),
      state.stateGeneration, serializedRelease).run()
    const archived = await this.index.prepare(`
      SELECT runtime_release_json, state_generation, workflow_json,
        disposition, cleanup_proof_digest
      FROM retired_runtime_runs WHERE run_id = ?1
    `).bind(runId).first<{
      runtime_release_json: string, state_generation: number, workflow_json: string,
      disposition: string, cleanup_proof_digest: string | null
    }>()
    if (archived?.runtime_release_json !== serializedRelease
      || archived.state_generation !== state.stateGeneration
      || archived.workflow_json !== workflowJson || archived.disposition !== 'terminal'
      || archived.cleanup_proof_digest !== cleanupProofDigest) {
      throw new Error(`completed run archive differs: ${runId}`)
    }
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = 'complete'
      WHERE run_id = ?1 AND runtime_release_json = ?3
        AND EXISTS (
          SELECT 1 FROM retired_runtime_runs
          WHERE run_id = ?1 AND runtime_release_json = ?3
            AND state_generation = ?4 AND cleanup_proof_digest = ?5
        )
    `).bind(runId, new Date().toISOString(), serializedRelease,
      state.stateGeneration, cleanupProofDigest).run()
  }

  async archiveTerminalFailedRunAndReleaseLease(proof: FailedRunRetirementProof): Promise<string> {
    assertFailedRunRetirementProof(proof)
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(proof.runtimeRelease)
    const content = canonicalJson(proof)
    const proofDigest = await sha256(content)
    const state = await this.getState(proof.runId)
    if (state.runId !== proof.runId || state.experimentId !== proof.experimentId
      || state.status !== 'failed' || typeof state.terminalReason !== 'string'
      || state.terminalReason.length === 0
      || state.stateGeneration !== proof.stateGeneration || await sha256(state) !== proof.stateDigest
      || (proof.unobservableNative === undefined
        ? (state.inFlightAgentAttempts?.length ?? 0) !== 0
        : !exactUnobservableAttempt(state, proof.unobservableNative))
      || state.failedWaveRecovery?.retainedNative !== undefined
      || state.runtimeRelease === undefined || !sameRuntimeRelease(state.runtimeRelease, proof.runtimeRelease)) {
      throw new Error('terminal failed state changed or has active work')
    }
    if (await sha256(state.terminalReason) !== proof.terminalReasonDigest) {
      throw new Error('failed terminal reason changed')
    }
    const lost = proof.unobservableNative
    if (lost !== undefined) {
      const prior = await this.retiredRunWorkflow(proof.runId)
      if (prior !== null) {
        if (prior.disposition !== 'retired-fenced' || prior.fenceProofDigest !== proofDigest
          || canonicalJson(prior.workflow) !== canonicalJson(proof.workflow)) {
          throw new Error('unobservable run was fenced with different custody')
        }
        const lease = await this.index.prepare(`
          SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
          WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
        `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
          released_at: string | null, terminal_workflow_status: string | null
        }>()
        if (lease?.released_at && lease.terminal_workflow_status === 'errored') return proofDigest
      }
    }
    const verifyLost = async () => {
      if (lost === undefined) return
      if (await sha256(lost.inventory) !== proof.containerInventoryDigest
        || Date.parse(proof.observedAt) < Date.parse(state.updatedAt)
        || Date.now() - Date.parse(proof.observedAt) > 120_000) {
        throw new Error('unobservable native inventory is stale or differs')
      }
      const request = await new R2AgentExecutionLogStore(this.artifacts)
        .getRequest(state.runId, lost.taskId, lost.requestDigest)
      const receipts = new R2AgentExecutionReceiptStore(this.artifacts)
      const claim = await receipts.getStart(state.runId, lost.requestDigest)
      const health = await new R2AgentObservationHealthStore(this.artifacts).get({
        runId: state.runId, stageId: lost.stageId, waveId: lost.waveId,
        taskId: lost.taskId, attempt: lost.attempt, promptDigest: lost.promptDigest,
      })
      if (request?.stageId !== lost.stageId || request.waveId !== lost.waveId
        || request.attempt !== lost.attempt || request.promptDigest !== lost.promptDigest
        || request.startedAt !== claim?.claimedAt || claim === null
        || health?.requestDigest !== lost.requestDigest || health.incidentSince === null
        || health.consecutiveFailures < 3 || await receipts.get(state.runId, lost.requestDigest) !== null) {
        throw new Error('unobservable native request, admission, health or terminal receipt differs')
      }
    }
    await verifyLost()
    const release = await this.getRelease(state.releaseDigest)
    if (release.body.definition.id !== state.experimentId
      || await sha256(release.body.definition) !== state.definitionDigest) {
      throw new Error('failed run definition differs')
    }
    const accepted = state.artifacts.filter(artifact => artifact.status === 'accepted')
    const manifest = accepted.map(artifact => ({ id: artifact.id, contentDigest: artifact.contentDigest }))
    if (await sha256(manifest) !== proof.acceptedArtifactManifestDigest) {
      throw new Error('failed accepted artifact manifest changed')
    }
    const reader = new R2ArtifactStore(this.artifacts)
    for (const artifact of accepted) {
      const files = await reader.read(artifact)
      if (artifact.files.some(path => typeof files[path] !== 'string')) {
        throw new Error(`failed accepted file is missing: ${artifact.id}`)
      }
    }
    for (const rejected of state.rejectedAttempts) {
      if ((rejected.quarantineUri === null) !== (rejected.outputDigest === null)) {
        throw new Error('failed rejection custody is inconsistent')
      }
      if (rejected.quarantineUri !== null && rejected.outputDigest !== null) {
        await reader.readRejected(rejected.quarantineUri, rejected.outputDigest, rejected.taskId)
      }
    }
    for (const checkpoint of state.checkpoints) {
      const stored = await this.getCheckpoint(checkpoint.digest)
      const route = await this.checkpointRuntime(checkpoint.digest)
      if (canonicalJson(stored) !== canonicalJson(checkpoint)
        || checkpoint.body.runtimeRelease === undefined || route === null
        || !sameRuntimeRelease(route, checkpoint.body.runtimeRelease)) {
        throw new Error('failed checkpoint differs from sealed state')
      }
    }
    const row = await this.index.prepare(`
      SELECT current.state_key, current.state_generation, current.status,
        route.experiment_id, route.runtime_release_json,
        lease.experiment_id AS lease_experiment_id, lease.slot_id,
        lease.runtime_release_json AS lease_release, lease.released_at, lease.admission_pool_enabled,
        slot.runtime_release_json AS slot_release, control.enabled AS pool_enabled, control.rotating_slot_id
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      WHERE current.run_id = ?1
    `).bind(proof.runId).first<{
      state_key: string, state_generation: number, status: string, experiment_id: string,
      runtime_release_json: string, lease_experiment_id: string, slot_id: string,
      lease_release: string, released_at: string | null, slot_release: string | null,
      rotating_slot_id: string | null, admission_pool_enabled: number, pool_enabled: number
    }>()
    if (row === null || row.state_key !== proof.stateKey || row.state_generation !== proof.stateGeneration
      || row.status !== 'failed' || row.experiment_id !== proof.experimentId
      || row.lease_experiment_id !== proof.experimentId
      || row.runtime_release_json !== serialized || row.lease_release !== serialized
      || row.slot_id !== proof.runtimeRelease.id
      || (row.released_at === null && (row.rotating_slot_id !== null
        || row.slot_release !== serialized && !(row.admission_pool_enabled === 0
          && row.pool_enabled === 0 && row.slot_release === null)))) {
      throw new Error('failed route, lease, state, or slot changed')
    }
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    await verifyLost()
    const stored = await this.artifacts.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { run: proof.runId, objectSha256: proofDigest },
      sha256: proofDigest, onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored === null) {
      const prior = await this.artifacts.get(key)
      if (prior === null || await sha256(await prior.text()) !== proofDigest
        || prior.checksums.toJSON().sha256 !== proofDigest
        || prior.customMetadata?.run !== proof.runId) throw new Error('failed custody proof differs')
    }
    if (lost !== undefined) {
      const beforeFence = await this.getState(proof.runId)
      if (beforeFence.stateGeneration !== proof.stateGeneration
        || await sha256(beforeFence) !== proof.stateDigest
        || !exactUnobservableAttempt(beforeFence, lost)) {
        throw new Error('unobservable source changed before retirement fence')
      }
      await verifyLost()
    }
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_runtime_runs
        (run_id, runtime_release_json, state_key, state_generation, workflow_json,
          disposition, fence_proof_digest, cleanup_proof_digest, retired_at)
      SELECT current.run_id, route.runtime_release_json, current.state_key,
        current.state_generation, ?2, 'retired-fenced', ?3, NULL, ?4
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      WHERE current.run_id = ?1 AND current.status = 'failed'
        AND current.state_key = ?5 AND current.state_generation = ?6
        AND route.experiment_id = ?7 AND route.runtime_release_json = ?8
        AND lease.experiment_id = ?7 AND lease.slot_id = ?9
        AND lease.runtime_release_json = ?8
        AND (slot.runtime_release_json = ?8 OR (lease.admission_pool_enabled = 0
          AND control.enabled = 0 AND slot.slot_id IS NULL))
        AND control.rotating_slot_id IS NULL
      ON CONFLICT(run_id) DO NOTHING
    `).bind(proof.runId, canonicalJson(proof.workflow), proofDigest, retiredAt,
      proof.stateKey, proof.stateGeneration, proof.experimentId, serialized,
      proof.runtimeRelease.id).run()
    const archived = await this.retiredRunWorkflow(proof.runId)
    if (archived?.disposition !== 'retired-fenced'
      || archived.fenceProofDigest !== proofDigest
      || canonicalJson(archived.workflow) !== canonicalJson(proof.workflow)) {
      throw new Error('terminal failed archive differs')
    }
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = 'errored'
      WHERE run_id = ?1 AND experiment_id = ?3 AND slot_id = ?4
        AND runtime_release_json = ?5
        AND EXISTS (SELECT 1 FROM experiment_runs current
          WHERE current.run_id = ?1 AND current.status = 'failed'
            AND current.state_key = ?6 AND current.state_generation = ?7)
        AND EXISTS (SELECT 1 FROM retired_runtime_runs retired
          WHERE retired.run_id = ?1 AND retired.runtime_release_json = ?5
            AND retired.state_key = ?6 AND retired.state_generation = ?7
            AND retired.disposition = 'retired-fenced' AND retired.fence_proof_digest = ?8)
        AND (released_at IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_slots slot
          JOIN runtime_slot_control control ON control.singleton = 1
          WHERE slot.slot_id = ?4 AND slot.runtime_release_json = ?5
            AND control.rotating_slot_id IS NULL)
          OR (admission_pool_enabled = 0
            AND NOT EXISTS (SELECT 1 FROM runtime_slots WHERE slot_id = ?4)
            AND EXISTS (SELECT 1 FROM runtime_slot_control
              WHERE singleton = 1 AND enabled = 0 AND rotating_slot_id IS NULL)))
    `).bind(proof.runId, retiredAt, proof.experimentId, proof.runtimeRelease.id,
      serialized, proof.stateKey, proof.stateGeneration, proofDigest).run()
    const lease = await this.index.prepare(`
      SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
      WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
    `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
      released_at: string | null, terminal_workflow_status: string | null
    }>()
    if (!lease?.released_at || lease.terminal_workflow_status !== 'errored') {
      throw new Error('terminal failed lease was not released')
    }
    return proofDigest
  }

  /** Preserve the terminal state and native receipt before freeing a stopped run's exact slot. */
  async archiveStoppedRunAndReleaseLease(proof: StoppedRunRetirementProof): Promise<string> {
    assertStoppedRunRetirementProof(proof)
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(proof.runtimeRelease)
    const content = canonicalJson(proof)
    const proofDigest = await sha256(content)
    const state = await this.getState(proof.runId)
    const checkpoint = state.checkpoints.at(-1)
    const sealed = proof.kind === 'sealed-stopped-custody'
    const terminalReason = sealed
      ? 'operator-requested-stop-at-sealed-wave-boundary' : 'operator-requested-immediate-stop'
    if (state.runId !== proof.runId || state.experimentId !== proof.experimentId
      || state.status !== 'stopped' || state.phase !== 'stopped'
      || state.terminalReason !== terminalReason
      || state.stateGeneration !== proof.stateGeneration || await sha256(state) !== proof.stateDigest
      || state.runtimeRelease === undefined || !sameRuntimeRelease(state.runtimeRelease, proof.runtimeRelease)
      || (sealed && (state.inFlightAgentAttempts?.length ?? 0) !== 0)
      || (sealed && state.waveAdmission != null)
      || (sealed && (state.discoveryScheduler?.admissions.length ?? 0) !== 0)
      || state.failedWaveRecovery?.retainedNative !== undefined
      || (checkpoint?.digest ?? null) !== proof.checkpointDigest
      || (sealed && (checkpoint === undefined
        || state.stateGeneration <= checkpoint.body.stateGeneration))
      || state.journal.at(-1)?.type !== 'run.stopped'
      || (state.journal.at(-1)?.payload as { reason?: unknown } | null)?.reason !== state.terminalReason
      || (state.journal.at(-1)?.payload as { checkpointDigest?: unknown } | null)?.checkpointDigest !== proof.checkpointDigest
      || (sealed && (state.journal.at(-2)?.type !== 'checkpoint.sealed'
        || (state.journal.at(-2)?.payload as { digest?: unknown } | null)?.digest !== proof.checkpointDigest
        || state.journal.at(-3)?.digest !== checkpoint?.body.journalHead))
      || !await this.stopRequested(proof.runId)) {
      throw new Error(sealed ? 'stopped run is not a sealed, drained operator stop'
        : 'stopped run is not an exact immediate operator stop')
    }
    const release = await this.getRelease(state.releaseDigest)
    if (release.body.definition.id !== state.experimentId
      || await sha256(release.body.definition) !== state.definitionDigest) {
      throw new Error('stopped run definition differs')
    }
    if (sealed) {
      if (checkpoint === undefined) throw new Error('sealed stop lacks checkpoint')
      const frontier = checkpoint.body
      const pairs = [
        [state.cursor, frontier.cursor], [state.artifacts, frontier.acceptedArtifacts],
        [state.rejectedAttempts, frontier.rejectedAttempts], [state.budget, frontier.budget],
        [state.waveReceipts, frontier.waveReceipts], [state.stageEndReceipts, frontier.stageEndReceipts],
        [state.availabilityBoundaries, frontier.availabilityBoundaries],
        [state.discoveryScheduler ?? null, frontier.discoveryScheduler ?? null],
        [state.runtimeTransition ?? null, frontier.runtimeTransition ?? null],
        [state.failedWaveRecovery ?? null, frontier.failedWaveRecovery ?? null],
        [state.promotedExecutionProofs ?? [], frontier.promotedExecutionProofs ?? []],
        [state.terminalCompletionRecovery ?? null, frontier.terminalCompletionRecovery ?? null],
        [state.rootCreatedAt, frontier.rootCreatedAt], [state.modelStartedAt, frontier.modelStartedAt],
        [state.rootRunId, frontier.rootRunId], [state.recoveryEpoch, frontier.recoveryEpoch],
        [state.parentCheckpointDigest, frontier.parentCheckpointDigest],
        [state.releaseDigest, frontier.releaseDigest], [state.definitionDigest, frontier.definitionDigest],
        [state.runtimeRelease, frontier.runtimeRelease],
      ]
      if (frontier.runId !== state.runId || frontier.experimentId !== state.experimentId
        || pairs.some(([left, right]) => canonicalJson(left) !== canonicalJson(right))) {
        throw new Error('stopped state differs from its last sealed frontier')
      }
    }
    const accepted = state.artifacts.filter(artifact => artifact.status === 'accepted')
    const manifest = accepted.map(artifact => ({ id: artifact.id,
      contentDigest: artifact.contentDigest, files: artifact.files }))
    if (await sha256(manifest) !== proof.acceptedArtifactManifestDigest) {
      throw new Error('stopped accepted artifact manifest changed')
    }
    const reader = new R2ArtifactStore(this.artifacts)
    for (const artifact of accepted) {
      const files = await reader.read(artifact)
      if (artifact.files.some(path => typeof files[path] !== 'string')) {
        throw new Error(`stopped accepted file is missing: ${artifact.id}`)
      }
    }
    for (const sealed of state.checkpoints) {
      const stored = await this.getCheckpoint(sealed.digest)
      const route = await this.checkpointRuntime(sealed.digest)
      if (canonicalJson(stored) !== canonicalJson(sealed)
        || sealed.body.runtimeRelease === undefined || route === null
        || !sameRuntimeRelease(route, sealed.body.runtimeRelease)) {
        throw new Error('stopped checkpoint or route differs from sealed state')
      }
    }
    const row = await this.index.prepare(`
      SELECT current.state_key, current.state_generation, current.status, current.checkpoint_digest,
        route.experiment_id, route.runtime_release_json,
        lease.experiment_id AS lease_experiment_id, lease.slot_id,
        lease.runtime_release_json AS lease_release, lease.released_at,
        slot.runtime_release_json AS slot_release, control.rotating_slot_id
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      WHERE current.run_id = ?1
    `).bind(proof.runId).first<{
      state_key: string, state_generation: number, status: string, checkpoint_digest: string | null,
      experiment_id: string, runtime_release_json: string, lease_experiment_id: string,
      slot_id: string, lease_release: string, released_at: string | null,
      slot_release: string, rotating_slot_id: string | null
    }>()
    if (row === null || row.state_key !== proof.stateKey || row.state_generation !== proof.stateGeneration
      || row.status !== 'stopped' || row.checkpoint_digest !== proof.checkpointDigest
      || row.experiment_id !== proof.experimentId || row.lease_experiment_id !== proof.experimentId
      || row.runtime_release_json !== serialized || row.lease_release !== serialized
      || row.slot_id !== proof.runtimeRelease.id
      || (row.released_at === null && (row.slot_release !== serialized || row.rotating_slot_id !== null))) {
      throw new Error('stopped route, lease, state, checkpoint, or slot changed')
    }
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    const stored = await this.artifacts.put(key, content, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { run: proof.runId, objectSha256: proofDigest },
      sha256: proofDigest, onlyIf: { etagDoesNotMatch: '*' },
    })
    if (stored === null) {
      const prior = await this.artifacts.get(key)
      if (prior === null || await sha256(await prior.text()) !== proofDigest
        || prior.checksums.toJSON().sha256 !== proofDigest
        || prior.customMetadata?.run !== proof.runId) throw new Error('stopped custody proof differs')
    }
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_runtime_runs
        (run_id, runtime_release_json, state_key, state_generation, workflow_json,
          disposition, fence_proof_digest, cleanup_proof_digest, retired_at)
      SELECT current.run_id, route.runtime_release_json, current.state_key,
        current.state_generation, ?2, 'retired-fenced', ?3, NULL, ?4
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      JOIN runtime_slot_control control ON control.singleton = 1
      WHERE current.run_id = ?1 AND current.status = 'stopped'
        AND current.state_key = ?5 AND current.state_generation = ?6
        AND current.checkpoint_digest IS ?7
        AND route.experiment_id = ?8 AND route.runtime_release_json = ?9
        AND lease.experiment_id = ?8 AND lease.slot_id = ?10
        AND lease.runtime_release_json = ?9 AND slot.runtime_release_json = ?9
        AND control.rotating_slot_id IS NULL
      ON CONFLICT(run_id) DO NOTHING
    `).bind(proof.runId, canonicalJson(proof.workflow), proofDigest, retiredAt,
      proof.stateKey, proof.stateGeneration, proof.checkpointDigest,
      proof.experimentId, serialized, proof.runtimeRelease.id).run()
    const archived = await this.retiredRunWorkflow(proof.runId)
    if (archived?.disposition !== 'retired-fenced'
      || archived.fenceProofDigest !== proofDigest
      || canonicalJson(archived.workflow) !== canonicalJson(proof.workflow)) {
      throw new Error('stopped run archive differs')
    }
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = ?10
      WHERE run_id = ?1 AND experiment_id = ?3 AND slot_id = ?4
        AND runtime_release_json = ?5
        AND EXISTS (SELECT 1 FROM experiment_runs current
          WHERE current.run_id = ?1 AND current.status = 'stopped'
            AND current.state_key = ?6 AND current.state_generation = ?7
            AND current.checkpoint_digest IS ?8)
        AND EXISTS (SELECT 1 FROM retired_runtime_runs retired
          WHERE retired.run_id = ?1 AND retired.runtime_release_json = ?5
            AND retired.state_key = ?6 AND retired.state_generation = ?7
            AND retired.disposition = 'retired-fenced' AND retired.fence_proof_digest = ?9)
        AND (released_at IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_slots slot
          JOIN runtime_slot_control control ON control.singleton = 1
          WHERE slot.slot_id = ?4 AND slot.runtime_release_json = ?5
            AND control.rotating_slot_id IS NULL))
    `).bind(proof.runId, retiredAt, proof.experimentId, proof.runtimeRelease.id,
      serialized, proof.stateKey, proof.stateGeneration, proof.checkpointDigest,
      proofDigest, proof.workflow.status).run()
    const lease = await this.index.prepare(`
      SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
      WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
    `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
      released_at: string | null, terminal_workflow_status: string | null
    }>()
    if (!lease?.released_at || lease.terminal_workflow_status !== proof.workflow.status) {
      throw new Error('stopped run lease was not released')
    }
    return proofDigest
  }

  async checkpointRuntime(digest: string): Promise<RuntimeRelease | null> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('checkpoint digest is invalid')
    await this.ensureRoutingSchema()
    const row = await this.index.prepare(
      'SELECT runtime_release_json FROM checkpoint_runtime_routes WHERE checkpoint_digest = ?1',
    ).bind(digest).first<{ runtime_release_json: string }>()
    return row === null ? null : this.parseRuntimeRoute(row.runtime_release_json, `checkpoint ${digest}`)
  }

  private parseRuntimeRoute(serialized: string, label: string): RuntimeRelease {
    const value: unknown = JSON.parse(serialized)
    assertRuntimeRelease(value, `${label} runtime release`)
    return value
  }

  private async bindRunRoute(runId: string, experimentId: string, runtimeRelease: RuntimeRelease): Promise<void> {
    const serialized = canonicalJson(runtimeRelease)
    await this.index.prepare(`
      INSERT INTO run_runtime_routes (run_id, experiment_id, runtime_release_json, reserved_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(run_id) DO NOTHING
    `).bind(runId, experimentId, serialized, new Date().toISOString()).run()
    const route = await this.runRuntime(runId)
    if (route === null || !sameRuntimeRelease(route, runtimeRelease)) {
      throw new Error(`run runtime route differs from run state: ${runId}`)
    }
  }

  async requestStop(runId: string): Promise<void> {
    await this.artifacts.put(stopKey(runId), canonicalJson({ requestedAt: new Date().toISOString() }), {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagDoesNotMatch: '*' },
    })
  }

  async stopRequested(runId: string): Promise<boolean> {
    return (await this.artifacts.head(stopKey(runId))) !== null
  }

  async getCheckpoint(digest: string): Promise<SealedCheckpoint> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('checkpoint digest is invalid')
    const object = await this.artifacts.get(checkpointKey(digest))
    if (object === null) throw new Error(`checkpoint is missing: ${digest}`)
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.bodySha256 !== digest
      || object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256) throw new Error('checkpoint object digest mismatch')
    const checkpoint = JSON.parse(content) as SealedCheckpoint
    if (checkpoint.digest !== digest || await sha256(checkpoint.body) !== digest) throw new Error('checkpoint body digest mismatch')
    return checkpoint
  }

  async ensureSchema(): Promise<void> {
    await this.index.batch([
      this.index.prepare(`
        CREATE TABLE IF NOT EXISTS experiment_runs (
          run_id TEXT PRIMARY KEY,
          experiment_id TEXT NOT NULL,
          status TEXT NOT NULL,
          state_key TEXT NOT NULL,
          state_generation INTEGER NOT NULL,
          checkpoint_digest TEXT,
          updated_at TEXT NOT NULL,
          terminal_reason TEXT
        )
      `),
      this.index.prepare(`
        CREATE INDEX IF NOT EXISTS experiment_runs_by_experiment_updated
          ON experiment_runs(experiment_id, updated_at DESC)
      `),
      ...this.routingSchemaStatements(),
    ])
  }

  private routingSchemaStatements(): D1PreparedStatement[] {
    return ROUTING_SCHEMA_SQL.map(sql => this.index.prepare(sql))
  }

  private async ensureRoutingSchema(): Promise<void> {
    let ready = routingSchemaReady.get(this.index)
    if (ready === undefined) {
      ready = this.index.batch(this.routingSchemaStatements()).then(() => {})
      routingSchemaReady.set(this.index, ready)
      ready.catch(() => routingSchemaReady.delete(this.index))
    }
    await ready
  }
}
