import { publishImmutableObject } from './immutable-object.js'
import { parseStateJson } from './state-copy.js'
import { assertBudgetShape } from './execution-budget.js'
import { assertRuntimeRelease } from './runtime-release.js'
import { assertSavedStateReference } from './run-commands.js'
import { canonicalJson, sha256 } from './canonical.js'
import type { ArtifactRecord, AvailabilityBoundary, DiscoverySchedulerState, ReleasePackage, RejectedAttempt, RuntimeRelease, StageEndReceipt, WaveAdmission, WaveReceipt } from './contracts.js'
import type { ImportedAvailabilityContext } from './execution-availability.js'
import type { DiscoveryWaits } from './discovery-clock.js'
import type { SavedStateReference } from './run-state-pointer.js'
import type { SourceFence } from './source-fence.js'
import type { ForkBoundary } from './run-commands.js'
import type { prepareStageForkSource } from './stage-fork-source.js'

/** Evidence emitted by the source version. It contains no executable history or
 * alternative configuration: the destination still uses its ordinary release. */
export interface SavedWork {
  schemaVersion: 2
  producer: RuntimeRelease
  accounting: { interruptions: readonly string[]; historyComplete: boolean; costAccountingComplete: boolean; cacheAccountingComplete: boolean }
  sourceReference: SavedStateReference
  source: {
    runId: string
    rootRunId: string
    experimentId: string
    executionAuthority?: import('./execution-authority.js').ExecutionAuthority
    runtimeRelease?: RuntimeRelease
    status: 'created' | 'running' | 'completed' | 'failed' | 'stopped'
    updatedAt: string
    rootCreatedAt: string
    modelStartedAt: string | null
    budget: { modelCalls: number; inputTokens: number; outputTokens: number; costUsd: number }
    releaseDigest: string
  }
  releaseDigest: string
  boundary: ForkBoundary
  checkpoint?: { digest: string; owner: SavedStateReference }
  sourceFence?: SourceFence | undefined
  stageIndex: number
  waveIndex: number
  artifacts: readonly ArtifactRecord[]
  rejectedAttempts: readonly RejectedAttempt[]
  waveReceipts: readonly WaveReceipt[]
  stageEndReceipts: readonly StageEndReceipt[]
  availabilityBoundaries: readonly AvailabilityBoundary[]
  availability: ImportedAvailabilityContext
  discoveryWaits: DiscoveryWaits
  discoveryScheduler?: DiscoverySchedulerState | undefined
  waveAdmission?: WaveAdmission | undefined
}
export type SavedWorkSeed = Omit<SavedWork, 'schemaVersion' | 'releaseDigest'> & { release: ReleasePackage; savedWorkDigest: string }

/** Only the source-owned preparation path may produce this projection. */
export function savedWork(prepared: Awaited<ReturnType<typeof prepareStageForkSource>>): SavedWork {
  const { runId, rootRunId, experimentId, executionAuthority, runtimeRelease, status, updatedAt,
    rootCreatedAt, modelStartedAt, budget, releaseDigest } = prepared.source
  if (runtimeRelease === undefined) throw new Error('saved work requires its source runtime identity')
  return { schemaVersion: 2, producer: runtimeRelease, accounting: prepared.accounting, sourceReference: prepared.sourceReference,
    source: { runId, rootRunId, experimentId, ...(executionAuthority === undefined ? {} : { executionAuthority }),
      ...(runtimeRelease === undefined ? {} : { runtimeRelease }), status, updatedAt,
      rootCreatedAt, modelStartedAt, budget, releaseDigest }, releaseDigest: prepared.release.digest,
    boundary: prepared.boundary, ...(prepared.checkpoint === undefined ? {} : { checkpoint: { digest: prepared.checkpoint.digest, owner: prepared.checkpointOwner } }),
    sourceFence: prepared.sourceFence, stageIndex: prepared.stageIndex, waveIndex: prepared.waveIndex,
    artifacts: prepared.artifacts, rejectedAttempts: prepared.rejectedAttempts, waveReceipts: prepared.waveReceipts, stageEndReceipts: prepared.stageEndReceipts,
    availabilityBoundaries: prepared.availabilityBoundaries, availability: prepared.availability,
    discoveryWaits: prepared.discoveryWaits, discoveryScheduler: prepared.discoveryScheduler, waveAdmission: prepared.waveAdmission }
}

/** V2 accepts only its declared envelope; changing it requires a new protocol
 * version. The receiver separately validates current task contracts and bytes. */
function assertSavedWork(value: SavedWork): void {
  const fields = ['schemaVersion', 'producer', 'accounting', 'sourceReference', 'source', 'releaseDigest', 'boundary', 'checkpoint',
    'sourceFence', 'stageIndex', 'waveIndex', 'artifacts', 'rejectedAttempts', 'waveReceipts', 'stageEndReceipts', 'availabilityBoundaries',
    'availability', 'discoveryWaits', 'discoveryScheduler', 'waveAdmission']
  if (value === null || typeof value !== 'object' || value.schemaVersion !== 2
    || Object.keys(value).some(key => !fields.includes(key))) throw new Error('saved-work schema is invalid')
  assertSavedStateReference(value.sourceReference)
  if (value.checkpoint !== undefined) assertSavedStateReference(value.checkpoint.owner)
  assertRuntimeRelease(value.producer)
  if (value.source?.runId !== value.sourceReference.runId
    || canonicalJson(value.source.runtimeRelease) !== canonicalJson(value.producer)
    || !['completed', 'failed', 'stopped'].includes(value.source.status)
    || !Number.isFinite(Date.parse(value.source.rootCreatedAt)) || !Number.isFinite(Date.parse(value.source.updatedAt))
    || value.source.modelStartedAt !== null && !Number.isFinite(Date.parse(value.source.modelStartedAt))
    || !Number.isSafeInteger(value.stageIndex) || value.stageIndex < 0
    || value.boundary?.sourceFrontier !== true && (value.stageIndex < 1 || value.checkpoint === undefined)
    || !Number.isSafeInteger(value.waveIndex) || value.waveIndex < 0
    || !/^[a-f0-9]{64}$/.test(value.releaseDigest) || value.checkpoint !== undefined && !/^[a-f0-9]{64}$/.test(value.checkpoint.digest)
    || ![value.artifacts, value.rejectedAttempts, value.waveReceipts, value.stageEndReceipts, value.availabilityBoundaries, value.discoveryWaits].every(Array.isArray)
    || !Array.isArray(value.accounting?.interruptions) || value.accounting.interruptions.some(item => typeof item !== 'string')
    || !['historyComplete', 'costAccountingComplete', 'cacheAccountingComplete'].every(key => typeof value.accounting[key as keyof typeof value.accounting] === 'boolean')) {
    throw new Error('saved-work export identity or frontier is invalid')
  }
  if ((value.source.status !== 'completed' || value.checkpoint === undefined) && value.sourceFence === undefined) {
    throw new Error('unsettled or checkpointless export requires native source retirement')
  }
  assertBudgetShape(value.source.budget)
  if (value.sourceFence !== undefined && (canonicalJson(value.sourceFence.authority) !== canonicalJson(value.source.executionAuthority)
    || !/^[a-f0-9]{64}$/.test(value.sourceFence.commandDigest)
    || !/^[a-f0-9]{64}$/.test(value.sourceFence.proofDigest))) throw new Error('saved-work source fence differs')
}

const key = (digest: string) => {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('saved-work digest is invalid')
  return `saved-work/sha256/${digest}.json`
}
type SavedWorkSelection = Pick<SavedWork, 'producer' | 'sourceReference' | 'boundary' | 'releaseDigest'>
const selectionKey = async (value: SavedWorkSelection) => `saved-work/selections/${await sha256({
  producer: value.producer, sourceReference: value.sourceReference, boundary: value.boundary, releaseDigest: value.releaseDigest,
})}.json`

/** Reuse the source version's immutable export without reexecuting its preparation. */
export async function readSavedWorkDigest(bucket: R2Bucket, selection: SavedWorkSelection): Promise<string | null> {
  const object = await bucket.get(await selectionKey(selection))
  if (object === null) return null
  const content = await object.text(), checksum = await sha256(content)
  if (object.checksums.toJSON().sha256 !== checksum || object.customMetadata?.sha256 !== checksum) {
    throw new Error('saved-work selection changed')
  }
  const value = JSON.parse(content) as { digest: string }
  if (value === null || typeof value !== 'object' || Object.keys(value).length !== 1
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
    || canonicalJson(value) !== content) throw new Error('saved-work selection is invalid')
  return value.digest
}
export async function putSavedWork(bucket: R2Bucket, value: SavedWork): Promise<string> {
  assertSavedWork(value)
  const content = canonicalJson(value), digest = await sha256(content)
  await publishImmutableObject(bucket, key(digest), content, digest, { sha256: digest })
  const selection = canonicalJson({ digest }), selectionDigest = await sha256(selection)
  await publishImmutableObject(bucket, await selectionKey(value), selection, selectionDigest, { sha256: selectionDigest })
  return digest
}
export async function readSavedWork(bucket: R2Bucket, digest: string): Promise<SavedWork> {
  const object = await bucket.get(key(digest)), content = object === null ? null : await object.text()
  if (content === null || await sha256(content) !== digest || object!.checksums.toJSON().sha256 !== digest
    || object!.customMetadata?.sha256 !== digest) throw new Error('saved-work archive is missing or changed')
  const value = parseStateJson<SavedWork>(content)
  assertSavedWork(value)
  return value
}
