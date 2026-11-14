import { publishImmutableObject } from './immutable-object.js'
import { recordExecutionBootstrap, executionBootstrapped } from './execution-bootstrap.js'
import { assertExecutionPublication } from './prepared-execution.js'
import { assertStateSelected } from './state-selection.js'
import { sourceFenceWitness } from './source-fence.js'
import { putSavedWork, readSavedWork, readSavedWorkDigest, savedWork, type SavedWork } from './saved-work.js'
import { copyState, parseStateJson } from './state-copy.js'
import { readFixtureCheckpoint } from './runtime-fixture-checkpoint.js'
import { NativeCommandEvidence } from './native-command-evidence.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import type { SourceFence } from './source-fence.js'
import { RunCommandJournal } from './run-command-journal.js'
import { RunMachine } from './machine.js'
import { forkBoundary } from './run-commands.js'
import { prepareStageForkSource } from './stage-fork-source.js'
import { assertForkDiscoveryWindow, loadAdmittedStageFork, stageForkAuthority } from './stage-fork-command.js'
import { parseRunCommand, RunCommandConflict } from './run-commands.js'
import { assertAuditCancellation, type AuditCancellationEffect } from './run-control-state.js'
import { assertCurrentExecutionFormat, runStateKey as stateKey, type RunStatePointer } from './run-state-pointer.js'
export type { RunStatePointer } from './run-state-pointer.js'
import type { AgentRequest, RunStateWriteOptions } from './contracts.js'
import { R2AgentDispatchStore } from './agent-dispatch.js'
import type {
  ArtifactRecord, ArtifactReference, ArtifactStore, ReleasePackage, ReleasePackageBody,
  RunState, RuntimeRelease, SealedCheckpoint,
} from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { artifactReferences } from './artifact-execution.js'
import { assertExecutionAuthority, ExecutionAuthorityStore } from './execution-authority.js'
import { canonicalJsonBytes } from './canonical-bytes.js'
import { sealReleasePackage } from './release.js'
import { validateNewSearchAdmission, validateReleasePackage } from './validation.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'
import { TransientRunFailure, PermanentRunFailure } from './run-errors.js'
import {
  assertTerminalFixtureRetirementProof, type TerminalFixtureRetirementProof,
} from './terminal-fixture-retirement.js'
import { ROUTING_SCHEMA_SQL } from './routing-schema.js'
import { selectedTaskExecutionIds } from './task-occurrences.js'

const releaseKey = (digest: string) => `releases/sha256/${digest}.json`
const checkpointKey = (digest: string) => `checkpoints/sha256/${digest}.json`
const completedCleanupKey = (runId: string, generation: number) =>
  `runs/${runId}/terminal-cleanup/${String(generation).padStart(12, '0')}.json`
const routingSchemaReady = new WeakMap<D1Database, Promise<void>>()

/** One writer belongs to one computation, never to a shared store/read cache. */
export async function stateWriter(store: Pick<CloudflareRunStore, 'putState'>, predecessor: RunState | null) {
  let expected = predecessor === null ? null : { generation: predecessor.stateGeneration, digest: await sha256(predecessor) }
  return async (state: RunState, options?: RunStateWriteOptions): Promise<void> => {
    const predecessor = expected
    expected = await store.putState(state, predecessor, options)
  }
}

export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putExecutionInputs(inputs: readonly ArtifactReference[]): Promise<string> {
    const content = canonicalJson(artifactReferences(inputs))
    const digest = await sha256(content)
    await publishImmutableObject(this.bucket, `execution-inputs/sha256/${digest}.json`, content, digest, { sha256: digest })
    return digest
  }

  async readExecutionInputs(digest: string): Promise<readonly ArtifactReference[]> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('execution input digest is invalid')
    const object = await this.bucket.get(`execution-inputs/sha256/${digest}.json`)
    if (object === null) throw new Error('execution input manifest is missing')
    const content = await object.text()
    if (await sha256(content) !== digest || object.customMetadata?.sha256 !== digest
      || object.checksums.toJSON().sha256 !== digest) throw new Error('execution input manifest digest mismatch')
    const refs: unknown = JSON.parse(content)
    if (!Array.isArray(refs) || refs.some(ref => ref === null || typeof ref !== 'object'
      || typeof ref.id !== 'string' || typeof ref.contentDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(ref.contentDigest))
      || canonicalJson(artifactReferences(refs)) !== content) throw new Error('execution input manifest is invalid')
    return refs as ArtifactReference[]
  }

  async put(record: Omit<ArtifactRecord, 'uri'>, content: string): Promise<ArtifactRecord> {
    if (await sha256(content) !== record.contentDigest) throw new Error(`artifact submission digest mismatch: ${record.id}`)
    const key = `artifacts/${record.id}.json`
    await publishImmutableObject(this.bucket, key, content, record.contentDigest, { task: record.taskId, sha256: record.contentDigest })
    return { ...record, uri: `r2://ARTIFACTS/${key}` }
  }

  async readContent(record: ArtifactRecord): Promise<string> {
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
    return content
  }

  async read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>> {
    const content = await this.readContent(record)
    const value = JSON.parse(content) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`artifact content is invalid: ${record.id}`)
    return value as Readonly<Record<string, string>>
  }

  async putRejected(record: { id: string, taskId: string, contentDigest: string }, content: string): Promise<string> {
    if (await sha256(content) !== record.contentDigest) throw new Error(`rejected artifact digest mismatch: ${record.id}`)
    const key = `quarantine/${record.id}.json`
    await publishImmutableObject(this.bucket, key, content, record.contentDigest, { task: record.taskId, disposition: 'rejected', sha256: record.contentDigest })
    return `r2://ARTIFACTS/${key}`
  }

  async readRejected(uri: string, contentDigest: string, taskId: string): Promise<Readonly<Record<string, string>>> {
    const prefix = 'r2://ARTIFACTS/quarantine/'
    if (!uri.startsWith(prefix)) throw new Error('quarantined output is outside quarantine')
    const object = await this.bucket.get(uri.slice('r2://ARTIFACTS/'.length))
    if (object === null) throw new Error('quarantined output is missing')
    const content = await object.text()
    if (await sha256(content) !== contentDigest
      || object.customMetadata?.sha256 !== contentDigest
      || object.customMetadata?.task !== taskId
      || object.customMetadata?.disposition !== 'rejected'
      || object.checksums.toJSON().sha256 !== contentDigest) {
      throw new Error('quarantined output provenance mismatch')
    }
    const value = JSON.parse(content) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(item => typeof item !== 'string')) {
      throw new Error('quarantined output content is invalid')
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

  async putAgentDispatch(request: AgentRequest, nativeRequestDigest: string): Promise<void> {
    await new R2AgentDispatchStore(this.artifacts).put(request, nativeRequestDigest)
  }

  async getAgentDispatch(runId: string, dispatchDigest: string) {
    return new R2AgentDispatchStore(this.artifacts).get(runId, dispatchDigest)
  }

  async activateRootExecution(runId: string, runtimeRelease: RuntimeRelease | undefined, dispatch: unknown) {
    await this.ensureRoutingSchema()
    const authority = { auditId: runId, executionId: runId, epoch: 0,
      runtimeDigest: await sha256(runtimeRelease ?? null) }
    await new ExecutionAuthorityStore(this.index).activate(authority, await sha256(dispatch))
    return authority
  }

  async putRelease(body: ReleasePackageBody): Promise<ReleasePackage> {
    const sealed = await sealReleasePackage(body)
    validateNewSearchAdmission(sealed.body.definition)
    const content = canonicalJson(sealed)
    const objectSha256 = await sha256(content)
    await publishImmutableObject(this.packages, releaseKey(sealed.digest), content, objectSha256,
      { bodySha256: sealed.digest, objectSha256, experiment: body.definition.id })
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
      || object.checksums.toJSON().sha256 !== objectSha256) throw new PermanentRunFailure('release package object digest mismatch', 'integrity-failed')
    try {
      const value = JSON.parse(content) as ReleasePackage
      // The same checks as sealReleasePackage, without its copy of the body.
      validateReleasePackage(value.body)
      if (value.digest !== digest || await sha256(value.body) !== digest) throw new Error('release package digest mismatch')
      return value
    } catch (error) {
      throw new PermanentRunFailure('release package content is invalid', 'integrity-failed', { cause: error })
    }
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

  /** Keep the source export and native retirement valid through startup. */
  async assertForkDisposition(state: RunState): Promise<void> {
    const origin = state.forkOrigin
    if (origin?.sourceFence === undefined) return
    const exported = await readSavedWork(this.artifacts, origin.savedWorkDigest)
    if (canonicalJson(exported.sourceFence) !== canonicalJson(origin.sourceFence)
      || canonicalJson(exported.sourceReference) !== canonicalJson(origin.source)) throw new Error('fork source export changed')
    const fence = sourceFenceWitness(exported.sourceFence, 1)
    if (await this.index.prepare(`SELECT 1 WHERE ${fence.sql}`).bind(...fence.values).first() === null) {
      throw new Error('fork source native retirement is unsettled')
    }
  }

  /** Check destination byte custody before opening native admission. Historical
   * source records are deliberately not inputs to this verification. */
  async assertSavedWorkCustody(state: RunState): Promise<void> {
    if (state.forkOrigin === undefined) return
    const exported = await readSavedWork(this.artifacts, state.forkOrigin.savedWorkDigest)
    const reader = new R2ArtifactStore(this.artifacts)
    for (const record of exported.artifacts) {
      await reader.readContent(record)
      if (record.execution === undefined) continue
      const inputs = await reader.readExecutionInputs(record.execution.inputDigest)
      if (inputs.length !== record.execution.inputCount
        || inputs.some(ref => !exported.artifacts.some(candidate => candidate.id === ref.id && candidate.contentDigest === ref.contentDigest))) {
        throw new Error('fork retained artifact input evidence differs')
      }
    }
  }

  private async readSourceFence(source: RunState): Promise<SourceFence> {
    const authority = source.executionAuthority
    if (authority === undefined) throw new Error('source format belongs to its historical app version')
    const row = await this.index.prepare(`SELECT fence_command_digest, retirement_digest FROM audit_execution_authority
      WHERE authority_json = ?1 AND status = 'retired'`).bind(canonicalJson(authority))
      .first<{ fence_command_digest: string; retirement_digest: string }>()
    if (row === null) throw new Error('source requires verified native retirement')
    const command = await this.index.prepare(`SELECT command_id FROM audit_run_commands
      WHERE audit_id = ?1 AND json_extract(operation_json, '$.commandDigest') = ?2`)
      .bind(authority.auditId, row.fence_command_digest).first<{ command_id: string }>()
    if (command === null) throw new Error('source retirement command is missing')
    await new ExecutionAuthorityStore(this.index).assertRetired(authority, row.fence_command_digest, row.retirement_digest)
    const proof = await new NativeCommandEvidence({ runs: this, artifacts: this.artifacts, index: this.index })
      .stop(authority.auditId, command.command_id, row.retirement_digest)
    if (!proof.physicalZeroVerified || !proof.claimsSettled) throw new Error('source native retirement is unsettled')
    return { authority, commandDigest: row.fence_command_digest, proofDigest: row.retirement_digest }
  }

  /** Source runtime owns interpretation of its state format and export bytes. */
  async exportStageFork(value: unknown, producer: RuntimeRelease): Promise<string> {
    const command = parseRunCommand(value)
    if (command.action !== 'fork') throw new TypeError('fork command is required')
    const readState = this.executionSources(), source = await readState(command.source.runId, command.source.state)
    if (canonicalJson(source.runtimeRelease) !== canonicalJson(producer)) throw new Error('saved-work producer does not own source version')
    const loadState: ExecutionSourceLoader = Object.assign((id: string, pointer: import('./run-state-pointer.js').RunStatePointer) =>
      id === source.runId && canonicalJson(pointer) === canonicalJson(command.source.state)
        ? Promise.resolve(copyState(source)) : readState(id, pointer), readState)
    const sourceFence = ['failed', 'stopped'].includes(source.status) ? await this.readSourceFence(source) : undefined
    const artifacts = new R2ArtifactStore(this.artifacts)
    const prepared = await prepareStageForkSource({ source: command.source, ...forkBoundary(command),
      ...(sourceFence === undefined ? {} : { sourceFence }), releaseDigest: command.releaseDigest,
      read: { stateAt: loadState, checkpoint: digest => this.getCheckpoint(digest), release: digest => this.getRelease(digest) },
      readArtifact: record => artifacts.readContent(record), readInputs: digest => artifacts.readExecutionInputs(digest) })
    return putSavedWork(this.artifacts, savedWork(prepared))
  }

  /** The receiving app admits a source-version export, never a historical RunState. */
  async admitStageFork(auditId: string, value: unknown, now = new Date().toISOString(), beforeAdmission?: () => Promise<void>,
    assertSource?: (source: SavedWork['source']) => void, exportSource?: (command: import('./run-commands.js').StageForkCommand) => Promise<string>) {
    const command = parseRunCommand(value)
    if (command.action !== 'fork') throw new TypeError('fork command is required')
    await this.ensureRoutingSchema()
    const journal = new RunCommandJournal(this.index, auditId), commandDigest = await sha256(command)
    const loadRelease = (digest: string) => this.getRelease(digest), loadState = this.executionSources()
    const existing = await journal.get(command.id)
    if (existing !== null) {
      if (existing.commandDigest !== commandDigest) throw new RunCommandConflict('idempotency-conflict', 'command id is already bound to a different request')
      await this.assertForkDisposition(await loadAdmittedStageFork(existing, loadState))
      await beforeAdmission?.()
      return existing
    }
    if (exportSource === undefined) throw new Error('source-version saved-work exporter is required')
    const producer = await this.runRuntime(command.source.runId)
    if (producer === null) throw new Error('source runtime is missing')
    const savedWorkDigest = await readSavedWorkDigest(this.artifacts, { producer, sourceReference: command.source,
      boundary: forkBoundary(command), releaseDigest: command.releaseDigest }) ?? await exportSource(command)
    const exported = await readSavedWork(this.artifacts, savedWorkDigest)
    if (canonicalJson(exported.sourceReference) !== canonicalJson(command.source)
      || canonicalJson(exported.boundary) !== canonicalJson(forkBoundary(command))
      || exported.releaseDigest !== command.releaseDigest
      || canonicalJson(exported.producer) !== canonicalJson(producer)) throw new Error('saved-work export differs from requested source or selection')
    assertSource?.(exported.source)
    const authority = await stageForkAuthority(auditId, commandDigest, command.runtimeRelease)
    const release = await loadRelease(exported.releaseDigest)
    const machine = await RunMachine.fork({ ...exported, release, savedWorkDigest }, authority.executionId, command.runtimeRelease, loadRelease, loadState, now)
    await machine.start(now)
    const state = machine.view()
    assertForkDiscoveryWindow(command, release.body.definition, state, machine.importedDiscoveryWaits, now)
    await this.assertForkDisposition(state)
    await this.assertSavedWorkCustody(state)
    await this.archiveState(state)
    await beforeAdmission?.()
    return journal.admitStageFork(command, exported, state, loadRelease, loadState, now)
  }

  async activatePreparedExecution(auditId: string, commandId: string, observedRuntime?: RuntimeRelease) {
    await this.ensureRoutingSchema()
    const journal = new RunCommandJournal(this.index, auditId), operation = await journal.get(commandId)
    if (operation === null) throw new Error('execution command is missing')
    const loadState = this.executionSources()
    if (operation.fork !== undefined) {
      const state = await loadAdmittedStageFork(operation, loadState)
      await this.assertForkDisposition(state)
      // Checkpoint metadata alone does not authorize execution.
      for (const checkpoint of state.checkpoints) await this.putCheckpoint(checkpoint)
    }
    return journal.activatePreparedExecution(commandId, loadState, observedRuntime)
  }

  private async archiveState(state: RunState): Promise<{ key: string; digest: string }> {
    RunMachine.assertProducedState(state)
    const { bytes: content, digest: objectSha256 } = canonicalJsonBytes(state)
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
    return { key, digest: objectSha256 }
  }

  /** Read immutable execution snapshots and source-owned saved work without replay. */
  executionSources(): ExecutionSourceLoader {
    const load: ExecutionSourceLoader = (executionId, pointer) => this.getStateAt(executionId, pointer)
    load.assertSelected = async state => { await assertStateSelected(this.index, state) }
    load.readSavedWork = digest => readSavedWork(this.artifacts, digest)
    return load
  }

  async recordExecutionBootstrap(state: RunState): Promise<void> {
    await recordExecutionBootstrap(this.index, state)
  }

  async executionBootstrapped(state: RunState): Promise<boolean> {
    return executionBootstrapped(this.index, state)
  }

  async assertExecutionPublication(state: RunState): Promise<void> {
    await assertExecutionPublication(this.index, state)
  }

  async putState(state: RunState, expected?: RunStatePointer | null, options?: RunStateWriteOptions): Promise<RunStatePointer> {
    return this.persistState(state, expected, options)
  }

  private async persistState(state: RunState, expected?: RunStatePointer | null, options?: RunStateWriteOptions): Promise<RunStatePointer> {
    RunMachine.assertProducedState(state)
    assertCurrentExecutionFormat(state)
    expected = expected == null ? expected : structuredClone(expected)
    options = options === undefined ? undefined : structuredClone(options)
    await this.ensureRoutingSchema()
    const authority = state.executionAuthority
    if (authority === undefined) throw new Error('current state write requires execution authority')
    assertExecutionAuthority(authority)
    if (expected === undefined || authority.executionId !== state.runId || authority.auditId !== state.rootRunId
        || authority.runtimeDigest !== await sha256(state.runtimeRelease ?? null)
        || (expected !== null && (!Number.isSafeInteger(expected.generation) || expected.generation < 1
          || !/^[a-f0-9]{64}$/.test(expected.digest)))) throw new Error('controlled state write requires its exact predecessor and authority')
    const previous = expected != null ? await this.getStateAt(state.runId, expected) : null
    if (previous !== null && (previous.journal.length > state.journal.length
      || canonicalJson(state.journal.slice(0, previous.journal.length)) !== canonicalJson(previous.journal))) {
      throw new Error('controlled state write changed its exact predecessor history')
    }
    const cancellation = state.journal.at(-2)?.type === 'run.cancelled'
      ? state.journal.at(-2)!.payload as AuditCancellationEffect : undefined
    if (cancellation !== undefined) {
      await assertAuditCancellation(state)
      const predecessor = state.controls!.lastReceipt.previousStateDigest
      if (!(expected != null && expected.generation === state.stateGeneration - 2 && expected.digest === predecessor)
        && !(expected != null && expected.generation === state.stateGeneration && expected.digest === await sha256(state))) {
        throw new Error('audit cancellation requires its exact predecessor')
      }
    }
    let failedRejection = false
    if (state.status === 'failed' && state.journal.at(-1)?.type === 'run.control-settled') {
      // The frozen producer view already validated this transition. Storage
      // binds its receipt to the selected predecessor instead of replaying it.
      const receipt = state.controls?.lastReceipt
      if (receipt?.outcome.status !== 'rejected') throw new Error('failed control settlement must reject the decision')
      const predecessor = receipt.previousStateDigest
      failedRejection = expected != null && expected.generation === state.stateGeneration - 1 && expected.digest === predecessor
      if (!failedRejection && !(expected != null && expected.generation === state.stateGeneration && expected.digest === await sha256(state))) {
        throw new Error('failed control settlement requires its exact predecessor')
      }
    }
    const selectedTasks = canonicalJson(selectedTaskExecutionIds(state))
    if (state.runtimeRelease !== undefined) {
      await this.ensureRoutingSchema()
      await this.bindRunRoute(state.runId, state.experimentId, state.runtimeRelease)
    }
    const { key, digest: objectSha256 } = await this.archiveState(state)
    const checkpoint = state.checkpoints.at(-1)?.digest ?? null
    await this.index.prepare(`
      INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, checkpoint_digest, updated_at, terminal_reason)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
      WHERE EXISTS (SELECT 1 FROM audit_execution_authority
        WHERE execution_id = ?1 AND authority_json = ?9 AND status = 'active')
        AND (?12 = 0 OR (SELECT COALESCE(MAX(revision), 0) FROM audit_run_commands WHERE audit_id = ?13) = ?14)
        AND (?3 NOT IN ('failed', 'stopped', 'completed') OR NOT EXISTS (
          SELECT 1 FROM audit_run_commands effect WHERE effect.audit_id = ?13
            AND effect.version = (SELECT MAX(version) FROM audit_run_commands latest
              WHERE latest.audit_id = effect.audit_id AND latest.command_id = effect.command_id)
            AND json_extract(effect.operation_json, '$.status') = 'applying'
            AND json_extract(effect.operation_json, '$.source.authority') = ?9
            AND json_extract(effect.operation_json, '$.nativeEffect.kind') = 'revoke-admission'
            AND (?16 IS NULL OR json_extract(effect.operation_json, '$.commandDigest') <> ?16
              OR json_extract(effect.operation_json, '$.nativeEffect.inventoryDigest') <> ?17
              OR json_extract(effect.operation_json, '$.source') <> ?18)))
        AND (?16 IS NULL OR EXISTS (SELECT 1 FROM audit_run_commands cancellation
          WHERE cancellation.audit_id = ?13 AND cancellation.revision = ?14
            AND cancellation.version = (SELECT MAX(latest.version) FROM audit_run_commands latest
              WHERE latest.audit_id = cancellation.audit_id AND latest.command_id = cancellation.command_id)
            AND json_extract(cancellation.operation_json, '$.status') = 'applying'
            AND json_extract(cancellation.operation_json, '$.command.action') = 'cancel'
            AND json_extract(cancellation.operation_json, '$.command.scope.kind') = 'audit'
            AND json_extract(cancellation.operation_json, '$.commandDigest') = ?16
            AND json_extract(cancellation.operation_json, '$.source') = ?18
            AND json_extract(cancellation.operation_json, '$.nativeEffect.kind') = 'revoke-admission'
            AND json_extract(cancellation.operation_json, '$.nativeEffect.inventoryDigest') = ?17))
        AND (?10 IS NULL OR EXISTS (SELECT 1 FROM experiment_runs
          WHERE run_id = ?1 AND state_key = ?10 AND state_generation = ?11))
        AND (?21 = 0 OR NOT EXISTS (SELECT 1 FROM execution_bootstrap WHERE run_id = ?1))
        AND NOT EXISTS (SELECT 1 FROM audit_execution_launches claim
          WHERE claim.audit_id = ?13 AND claim.receipt_digest IS NULL
            AND NOT EXISTS (SELECT 1 FROM json_each(?15) selected
              WHERE selected.value = claim.task_execution_id))
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status, state_key = excluded.state_key, state_generation = excluded.state_generation,
        checkpoint_digest = excluded.checkpoint_digest, updated_at = excluded.updated_at,
        terminal_reason = excluded.terminal_reason
      WHERE experiment_runs.state_key = ?10 AND experiment_runs.state_generation = ?11
        AND excluded.state_generation > experiment_runs.state_generation
        AND (experiment_runs.status IN ('created', 'running')
          OR (experiment_runs.status = 'failed' AND excluded.status = 'stopped' AND ?16 IS NOT NULL)
          OR (experiment_runs.status = 'failed' AND excluded.status = 'failed' AND ?19 = 1
            AND EXISTS (SELECT 1 FROM audit_run_commands decision
              WHERE decision.audit_id = ?13 AND decision.revision = ?14
                AND decision.version = (SELECT MAX(latest.version) FROM audit_run_commands latest
                  WHERE latest.audit_id = decision.audit_id AND latest.command_id = decision.command_id)
                AND json_extract(decision.operation_json, '$.status') = 'applying'
                AND json_extract(decision.operation_json, '$.nativeEffect') IS NULL
                AND json_extract(decision.operation_json, '$.commandDigest') = ?20)))
    `).bind(state.runId, state.experimentId, state.status, key, state.stateGeneration, checkpoint,
      state.updatedAt, state.terminalReason, canonicalJson(authority),
      expected === null ? null : stateKey(state.runId, expected!.generation, expected!.digest),
      expected?.generation ?? null, options?.admission === true || state.status === 'completed' ? 1 : 0,
      state.rootRunId, state.controls?.revision ?? 0, selectedTasks,
      cancellation === undefined ? null : state.controls!.lastReceipt.commandDigest,
      cancellation?.inventoryDigest ?? null, cancellation === undefined ? null : canonicalJson(cancellation.source),
      failedRejection ? 1 : 0, failedRejection ? state.controls!.lastReceipt.commandDigest : null,
      options?.unlessBootstrapped === true ? 1 : 0).run()
    await new ExecutionAuthorityStore(this.index).assertActive(authority)
    const pointer = await this.index.prepare('SELECT state_key, state_generation FROM experiment_runs WHERE run_id = ?1')
      .bind(state.runId).first<{ state_key: string, state_generation: number }>()
    if (pointer?.state_key !== key || pointer.state_generation !== state.stateGeneration) {
      // Diagnostic only: the atomic write above is the fence. Even a reservation
      // whose owner has not started/registered a process must settle before its
      // occurrence leaves the selected admissions. Unchanged peers may progress.
      if (await this.index.prepare(`SELECT 1 FROM audit_execution_launches claim
        WHERE claim.audit_id = ?1 AND claim.receipt_digest IS NULL
          AND NOT EXISTS (SELECT 1 FROM json_each(?2) selected WHERE selected.value = claim.task_execution_id)
        LIMIT 1`).bind(state.rootRunId, selectedTasks).first() !== null) {
        throw new TransientRunFailure('task selection still has unsettled native work; retain the current admission')
      }
      if (options?.admission === true || state.status === 'completed') throw new TransientRunFailure('admission state or command revision changed; reload before dispatch')
      // A claim may settle between the denied CAS and the diagnostic read.
      // Reload the authoritative state rather than making that race terminal.
      throw new TransientRunFailure(`stale run-state generation rejected; reload: ${state.runId}/${state.stateGeneration}`)
    }
    const selected = { generation: state.stateGeneration, digest: objectSha256 }
    return selected
  }

  async getState(runId: string): Promise<RunState> {
    const state = await this.getStateIfPresent(runId)
    if (state === null) throw new Error(`run state is missing: ${runId}`)
    return state
  }

  async getStateIfPresent(runId: string): Promise<RunState | null> {
    await this.ensureRoutingSchema()
    const pointer = await this.index.prepare('SELECT state_key, state_generation FROM experiment_runs WHERE run_id = ?1')
      .bind(runId).first<{ state_key: string, state_generation: number }>()
    if (pointer === null) return null
    return this.readStateObject(runId, pointer)
  }

  /** Reads exact historical bytes. Only a journal-bound reference proves that
   * this object was selected; writing an orphan R2 state grants no authority. */
  async getStateAt(runId: string, pointer: RunStatePointer): Promise<RunState> {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId) || !Number.isSafeInteger(pointer.generation)
      || pointer.generation < 1 || !/^[a-f0-9]{64}$/.test(pointer.digest)) throw new TypeError('state pointer is invalid')
    return this.readStateObject(runId, {
      state_key: stateKey(runId, pointer.generation, pointer.digest), state_generation: pointer.generation,
    }, pointer.digest)
  }

  private async readStateObject(runId: string, pointer: { state_key: string, state_generation: number },
    expectedDigest?: string): Promise<RunState> {
    const object = await this.artifacts.get(pointer.state_key)
    if (object === null) throw new Error(`run state is missing: ${runId}`)
    const content = await object.text()
    const objectSha256 = await sha256(content)
    if (object.customMetadata?.objectSha256 !== objectSha256
      || object.checksums.toJSON().sha256 !== objectSha256
      || (expectedDigest !== undefined && objectSha256 !== expectedDigest)) {
      throw new PermanentRunFailure(`run state object digest mismatch: ${runId}`, 'integrity-failed')
    }
    let state: RunState
    try { state = parseStateJson<RunState>(content) }
    catch (cause) { throw new PermanentRunFailure(`run state content is invalid: ${runId}`, 'integrity-failed', { cause }) }
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new PermanentRunFailure(`run state content is invalid: ${runId}`, 'integrity-failed')
    }
    if (state.stateGeneration !== pointer.state_generation || object.customMetadata?.generation !== String(pointer.state_generation)) {
      throw new PermanentRunFailure(`run state generation mismatch: ${runId}`, 'integrity-failed')
    }
    if (state.runId !== runId) throw new PermanentRunFailure(`run state identity mismatch: ${runId}`, 'integrity-failed')
    if (pointer.state_key !== stateKey(runId, pointer.state_generation, objectSha256)) {
      throw new PermanentRunFailure(`run state pointer digest mismatch: ${runId}`, 'integrity-failed')
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
    await publishImmutableObject(this.artifacts, key, content, digest, { objectSha256: digest, run: state.runId })
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

  async putCheckpoint(checkpoint: SealedCheckpoint): Promise<void> {
    const { bytes: content, digest: objectSha256 } = canonicalJsonBytes(checkpoint)
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
        throw new RunCommandConflict('idempotency-conflict', `run already exists with different routing: ${runId}`)
      }
      return
    }
    const existingRun = await this.index.prepare('SELECT run_id FROM experiment_runs WHERE run_id = ?1')
      .bind(runId).first<{ run_id: string }>()
    if (existingRun !== null) throw new RunCommandConflict('idempotency-conflict', `run already exists: ${runId}`)
    // Lease and route are one admission. Pool activation cannot leave a
    // pre-activation lease stranded between two independently committed writes.
    const serialized = canonicalJson(runtimeRelease), now = new Date().toISOString()
    await this.index.batch([
      this.index.prepare(`INSERT INTO runtime_slot_run_leases
        (run_id, experiment_id, slot_id, runtime_release_json, admitted_at, admission_pool_enabled)
        SELECT ?1, ?2, ?3, ?4, ?5, COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0)
        WHERE NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM run_runtime_routes WHERE run_id = ?1)
          AND (COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0) = 0
            OR EXISTS (SELECT 1 FROM runtime_slots WHERE slot_id = ?3 AND runtime_release_json = ?4
              AND NOT EXISTS (SELECT 1 FROM runtime_slot_control WHERE singleton = 1 AND rotating_slot_id = ?3)))
        ON CONFLICT(run_id) DO NOTHING`).bind(runId, experimentId, runtimeRelease.id, serialized, now),
      this.index.prepare(`INSERT INTO run_runtime_routes (run_id, experiment_id, runtime_release_json, reserved_at)
        SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (SELECT 1 FROM experiment_runs WHERE run_id = ?1)
          AND EXISTS (SELECT 1 FROM runtime_slot_run_leases
          WHERE run_id = ?1 AND experiment_id = ?2 AND runtime_release_json = ?3 AND slot_id = ?5 AND released_at IS NULL
            AND admission_pool_enabled = COALESCE((SELECT enabled FROM runtime_slot_control WHERE singleton = 1), 0))
        ON CONFLICT(run_id) DO NOTHING`).bind(runId, experimentId, serialized, now, runtimeRelease.id),
    ])
    const storedRoute = await this.index.prepare(
      'SELECT experiment_id, runtime_release_json FROM run_runtime_routes WHERE run_id = ?1',
    ).bind(runId).first<{ experiment_id: string, runtime_release_json: string }>()
    if (storedRoute !== null) {
      if (storedRoute.experiment_id !== experimentId || storedRoute.runtime_release_json !== serialized) {
        throw new RunCommandConflict('idempotency-conflict', `run already exists with different routing: ${runId}`)
      }
      return
    }
    if (await this.index.prepare('SELECT 1 FROM experiment_runs WHERE run_id = ?1').bind(runId).first() !== null) {
      throw new RunCommandConflict('idempotency-conflict', `run already exists: ${runId}`)
    }
    const lease = await this.index.prepare('SELECT experiment_id, slot_id, runtime_release_json FROM runtime_slot_run_leases WHERE run_id = ?1')
      .bind(runId).first<{ experiment_id: string; slot_id: string; runtime_release_json: string }>()
    if (lease !== null) throw new RunCommandConflict('idempotency-conflict', `run lease belongs to another admission: ${runId}`)
    const slot = await this.index.prepare('SELECT runtime_release_json FROM runtime_slots WHERE slot_id = ?1')
      .bind(runtimeRelease.id).first<{ runtime_release_json: string }>()
    if (slot !== null && slot.runtime_release_json !== serialized) {
      throw new RunCommandConflict('idempotency-conflict', `runtime slot release changed: ${runtimeRelease.id}`)
    }
    throw new Error(`runtime slot admission is temporarily unavailable: ${runtimeRelease.id}`)
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
  /** Archive a terminal fixture without a run state before releasing only its exact slot lease.
   * A catalog-only install never seeds runtime_slot_control; a missing row is a disabled pool. */
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
        slot.runtime_release_json AS slot_release, COALESCE(control.enabled, 0) AS pool_enabled, control.rotating_slot_id
      FROM run_runtime_routes route
      JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      LEFT JOIN runtime_slot_control control ON control.singleton = 1
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
    if (proof.postRetention !== undefined) {
      const checkpoint = await readFixtureCheckpoint(this.artifacts, proof.postRetention.checkpointDigest)
      const checkpointRoute = await this.index.prepare(`
        SELECT experiment_id, runtime_release_json FROM checkpoint_runtime_routes WHERE checkpoint_digest = ?1
      `).bind(proof.postRetention.checkpointDigest).first<{
        experiment_id: string, runtime_release_json: string
      }>()
      if (checkpoint.fixtureId !== proof.runId || !sameRuntimeRelease(checkpoint.runtimeRelease, proof.runtimeRelease)
        || checkpointRoute?.experiment_id !== 'runtime-isolation'
        || checkpointRoute.runtime_release_json !== serialized
        || !Number.isFinite(Date.parse(checkpoint.finishedAt))
        || Date.parse(proof.observedAt) - Date.parse(checkpoint.finishedAt) < 86_400_000
        || await sha256(proof.postRetention.inventory) !== proof.containerInventoryDigest) {
        throw new Error('expired fixture checkpoint, route, retention or inventory differs')
      }
    }
    const content = canonicalJson(proof)
    const proofDigest = await sha256(content)
    const key = `runtime-retirements/sha256/${proofDigest}.json`
    await publishImmutableObject(this.artifacts, key, content, proofDigest, { run: proof.runId, objectSha256: proofDigest })
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_unmaterialized_routes
        (run_id, runtime_release_json, audit_workflow_status,
          isolation_workflow_status, proof_digest, retired_at)
      SELECT route.run_id, route.runtime_release_json, ?2, ?3, ?4, ?5
      FROM run_runtime_routes route JOIN runtime_slot_run_leases lease ON lease.run_id = route.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      LEFT JOIN runtime_slot_control control ON control.singleton = 1
      LEFT JOIN experiment_runs state ON state.run_id = route.run_id
      WHERE route.run_id = ?1 AND route.experiment_id = 'runtime-isolation'
        AND route.runtime_release_json = ?6 AND lease.runtime_release_json = ?6
        AND lease.slot_id = ?7 AND state.run_id IS NULL
        AND (lease.released_at IS NOT NULL OR
          ((slot.runtime_release_json = ?6 OR (lease.admission_pool_enabled = 0
            AND COALESCE(control.enabled, 0) = 0 AND slot.slot_id IS NULL)) AND control.rotating_slot_id IS NULL))
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
            AND NOT EXISTS (SELECT 1 FROM runtime_slot_control
              WHERE singleton = 1 AND (enabled <> 0 OR rotating_slot_id IS NOT NULL))))
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

  /** Archive first, then release the exact lease; retrying repairs partial D1 completion. */
  async archiveCompletedRunAndReleaseLease(runId: string, workflow: unknown): Promise<void> {
    if ((workflow as { status?: string } | null)?.status !== 'complete') {
      throw new Error(`native Workflow is not complete: ${runId}`)
    }
    const state = await this.getState(runId)
    const cleanupProofDigest = await this.verifyCompletedCleanupProof(state)
    const runtimeRelease = state.runtimeRelease
    if (runtimeRelease === undefined) throw new Error(`completed runtime binding is missing: ${runId}`)
    await this.archiveTerminal({ ...state, runtimeRelease, workflow: workflow as Record<string, unknown>,
      stateKey: stateKey(runId, state.stateGeneration, await sha256(state)) }, cleanupProofDigest, 'completed')
  }

  /** The durable cancellation command owns this cleanup; never abandon an ordinary failure. */
  async archiveCancelledRunAndReleaseLease(runId: string, workflow: unknown): Promise<void> {
    if (!['complete', 'errored', 'terminated'].includes((workflow as { status?: string } | null)?.status ?? '')) {
      throw new Error('cancelled Workflow is not terminal')
    }
    const state = await this.getState(runId)
    await this.executionSources().assertSelected!(state)
    if (state.status !== 'stopped' || state.journal.at(-2)?.type !== 'run.cancelled') {
      throw new Error('terminal state is not a command cancellation')
    }
    await assertAuditCancellation(state)
    const fence = await this.readSourceFence(state)
    if (state.runtimeRelease === undefined || state.controls?.lastReceipt.commandDigest !== fence.commandDigest) {
      throw new Error('cancelled retirement command differs')
    }
    await this.archiveTerminal({ ...state, runtimeRelease: state.runtimeRelease,
      workflow: workflow as Record<string, unknown>,
      stateKey: stateKey(runId, state.stateGeneration, await sha256(state)) }, fence.proofDigest, 'stopped')
  }

  /** One archive/lease CAS for already verified terminal custody. No control or proof interpretation.
   * A catalog-only install never seeds runtime_slot_control; a missing row is a disabled pool. */
  private async archiveTerminal(proof: { runId: string; experimentId: string; runtimeRelease: RuntimeRelease;
      stateKey: string; stateGeneration: number; workflow: Readonly<Record<string, unknown>> },
    proofDigest: string, status: 'stopped' | 'completed'): Promise<void> {
    await this.ensureRoutingSchema()
    const serialized = canonicalJson(proof.runtimeRelease)
    const retiredAt = new Date().toISOString()
    await this.index.prepare(`
      INSERT INTO retired_runtime_runs
        (run_id, runtime_release_json, state_key, state_generation, workflow_json,
          disposition, fence_proof_digest, cleanup_proof_digest, retired_at)
      SELECT current.run_id, route.runtime_release_json, current.state_key,
        current.state_generation, ?2, 'terminal', NULL, ?3, ?4
      FROM experiment_runs current
      JOIN run_runtime_routes route ON route.run_id = current.run_id
      JOIN runtime_slot_run_leases lease ON lease.run_id = current.run_id
      LEFT JOIN runtime_slots slot ON slot.slot_id = lease.slot_id
      LEFT JOIN runtime_slot_control control ON control.singleton = 1
      WHERE current.run_id = ?1 AND current.status = ?10
        AND current.state_key = ?5 AND current.state_generation = ?6
        AND route.experiment_id = ?7 AND route.runtime_release_json = ?8
        AND lease.experiment_id = ?7 AND lease.slot_id = ?9
        AND lease.runtime_release_json = ?8
        AND (slot.runtime_release_json = ?8 OR (lease.admission_pool_enabled = 0
          AND COALESCE(control.enabled, 0) = 0 AND slot.slot_id IS NULL))
        AND control.rotating_slot_id IS NULL
      ON CONFLICT(run_id) DO NOTHING
    `).bind(proof.runId, canonicalJson(proof.workflow), proofDigest, retiredAt,
      proof.stateKey, proof.stateGeneration,
      proof.experimentId, serialized, proof.runtimeRelease.id, status).run()
    const archived = await this.retiredRunWorkflow(proof.runId)
    if (archived?.disposition !== 'terminal' || archived.cleanupProofDigest !== proofDigest
      || canonicalJson(archived.workflow) !== canonicalJson(proof.workflow)) {
      throw new Error('terminal run archive differs')
    }
    await this.index.prepare(`
      UPDATE runtime_slot_run_leases
      SET released_at = COALESCE(released_at, ?2), terminal_workflow_status = ?9
      WHERE run_id = ?1 AND experiment_id = ?3 AND slot_id = ?4
        AND runtime_release_json = ?5
        AND EXISTS (SELECT 1 FROM run_runtime_routes route
          WHERE route.run_id = ?1 AND route.experiment_id = ?3 AND route.runtime_release_json = ?5)
        AND EXISTS (SELECT 1 FROM experiment_runs current
          WHERE current.run_id = ?1 AND current.status = ?10
            AND current.state_key = ?6 AND current.state_generation = ?7)
        AND EXISTS (SELECT 1 FROM retired_runtime_runs retired
          WHERE retired.run_id = ?1 AND retired.runtime_release_json = ?5
            AND retired.state_key = ?6 AND retired.state_generation = ?7
            AND retired.disposition = 'terminal' AND retired.cleanup_proof_digest = ?8)
        AND (released_at IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_slots slot
          JOIN runtime_slot_control control ON control.singleton = 1
          WHERE slot.slot_id = ?4 AND slot.runtime_release_json = ?5
            AND control.rotating_slot_id IS NULL)
          OR (admission_pool_enabled = 0
            AND NOT EXISTS (SELECT 1 FROM runtime_slots WHERE slot_id = ?4)
            AND NOT EXISTS (SELECT 1 FROM runtime_slot_control
              WHERE singleton = 1 AND (enabled <> 0 OR rotating_slot_id IS NOT NULL))))
    `).bind(proof.runId, retiredAt, proof.experimentId, proof.runtimeRelease.id,
      serialized, proof.stateKey, proof.stateGeneration,
      proofDigest, proof.workflow.status, status).run()
    const lease = await this.index.prepare(`
      SELECT released_at, terminal_workflow_status FROM runtime_slot_run_leases
      WHERE run_id = ?1 AND slot_id = ?2 AND runtime_release_json = ?3
    `).bind(proof.runId, proof.runtimeRelease.id, serialized).first<{
      released_at: string | null, terminal_workflow_status: string | null
    }>()
    if (!lease?.released_at || lease.terminal_workflow_status !== proof.workflow.status) {
      throw new Error('terminal run lease was not released')
    }
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
    await this.index.batch(this.routingSchemaStatements())
  }

  private routingSchemaStatements(): D1PreparedStatement[] {
    return ROUTING_SCHEMA_SQL.map(sql => this.index.prepare(sql))
  }

  async ensureRoutingSchema(): Promise<void> {
    let ready = routingSchemaReady.get(this.index)
    if (ready === undefined) {
      ready = this.index.batch(this.routingSchemaStatements()).then(() => {})
      routingSchemaReady.set(this.index, ready)
      ready.catch(() => routingSchemaReady.delete(this.index))
    }
    await ready
  }
}
