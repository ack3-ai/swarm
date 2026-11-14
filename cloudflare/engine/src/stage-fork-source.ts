import { resolveUsageEvidence } from './usage-evidence.js'
import { copyState } from './state-copy.js'
import { canonicalJson, sha256 } from './canonical.js'
import type { ArtifactRecord, ArtifactReference, RunState, SealedCheckpoint } from './contracts.js'
import { assertCurrentExecutionFormat, type SavedStateReference } from './run-state-pointer.js'
import type { SourceFence } from './source-fence.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import type { ReleaseLoader } from './execution-releases.js'
import { RunMachine } from './machine.js'
import { executionConfiguration } from './artifact-execution.js'
import { importAvailabilityContext } from './execution-availability.js'
import { discoveryWaits } from './discovery-clock.js'
import { amendDiscoveryProgress, assertAmendmentFrontier } from './manifest-amendment.js'
import { assertSavedStateReference, forkBoundary, RunCommandRejected, type ForkBoundary } from './run-commands.js'
import { validateReleasePackage } from './validation.js'

export type StageForkSourceInput = ForkBoundary & {
  source: SavedStateReference
  sourceFence?: SourceFence
  releaseDigest: string
  read: { stateAt: ExecutionSourceLoader; checkpoint: (digest: string) => Promise<SealedCheckpoint>; release: ReleaseLoader }
  readArtifact: (record: ArtifactRecord) => Promise<string>
  readInputs: (digest: string) => Promise<readonly ArtifactReference[]>
}

/** This runs in the source version. It interprets only that version's selected
 * state and seals. Older source records belong to their own app/exporter. */
export async function resolveStageForkSource(input: Omit<StageForkSourceInput, 'readArtifact' | 'readInputs' | 'stageId' | 'checkpointDigest' | 'sourceFrontier'> & ForkBoundary) {
  assertSavedStateReference(input.source)
  const source = copyState(await input.read.stateAt(input.source.runId, input.source.state))
  if (source.runId !== input.source.runId || source.stateGeneration !== input.source.state.generation
    || await sha256(source) !== input.source.state.digest) throw new Error('source state differs')
  assertCurrentExecutionFormat(source)
  if (source.executionAuthority === undefined) {
    throw new Error('source format belongs to its historical app version')
  }
  if (!['completed', 'failed', 'stopped'].includes(source.status)
    || (source.inFlightAgentAttempts?.length ?? 0) > 0) throw new RunCommandRejected('fork-source-unsettled', 'source requires quiescence')
  if (source.status !== 'completed' && (input.sourceFence === undefined
    || canonicalJson(input.sourceFence.authority) !== canonicalJson(source.executionAuthority))) {
    throw new RunCommandRejected('fork-source-unsettled', 'non-completed source requires its verified native retirement')
  }
  const release = async (digest: string) => {
    const value = await input.read.release(digest)
    validateReleasePackage(value.body)
    if (value.digest !== digest || await sha256(value.body) !== digest) throw new Error('source release bytes differ')
    return value
  }
  const previous = await release(source.releaseDigest), next = await release(input.releaseDigest)
  if (input.sourceFrontier === true && canonicalJson(previous.body.environment) !== canonicalJson(next.body.environment)) {
    throw new RunCommandRejected('fork-manifest-incompatible', 'saved-frontier fork changes the retained runtime environment')
  }
  const machine = await RunMachine.fromState(previous.body.definition, source, release, input.read.stateAt)
  const requestedStage = input.stageId === undefined ? undefined : previous.body.definition.stages.findIndex(stage => stage.id === input.stageId)
  if (requestedStage !== undefined && requestedStage < 1) throw new RunCommandRejected('fork-stage-unavailable', 'stage fork requires a boundary after preflight')
  const checkpoint = input.sourceFrontier === true ? source.checkpoints.at(-1) : source.checkpoints.find(value => input.checkpointDigest === undefined
    ? value.body.cursor.stageIndex === requestedStage && value.body.cursor.waveIndex === 0 : value.digest === input.checkpointDigest)
  if (checkpoint === undefined && input.sourceFrontier !== true) throw new RunCommandRejected('fork-frontier-unavailable', 'boundary is not owned by this source version; select its original source')
  if (checkpoint !== undefined) {
    const archived = await input.read.checkpoint(checkpoint.digest)
    if (canonicalJson(archived) !== canonicalJson(checkpoint)) throw new Error('source checkpoint bytes differ')
    await machine.verifyCheckpoint(checkpoint)
  }
  const body = checkpoint?.body, frontier = input.sourceFrontier === true ? source : body!
  const { stageIndex, waveIndex } = frontier.cursor, stage = previous.body.definition.stages[stageIndex]
  if (stage === undefined || stage.waves[waveIndex] === undefined
    || input.sourceFrontier !== true && (stageIndex < 1 || (body!.discoveryScheduler?.admissions.length ?? 0) > 0
      || stage.kind === 'discovery' && waveIndex !== 0)) throw new RunCommandRejected('fork-frontier-unavailable', 'source boundary is not settled')
  const artifacts = input.sourceFrontier === true ? source.artifacts : body!.acceptedArtifacts
  const waveReceipts = frontier.waveReceipts, stageEndReceipts = frontier.stageEndReceipts
  if (canonicalJson(source.artifacts.slice(0, artifacts.length)) !== canonicalJson(artifacts)
    || canonicalJson(source.waveReceipts.slice(0, waveReceipts.length)) !== canonicalJson(waveReceipts)
    || canonicalJson(source.stageEndReceipts.slice(0, stageEndReceipts.length)) !== canonicalJson(stageEndReceipts)) throw new Error('source changed its sealed prefix')
  assertAmendmentFrontier(previous.body.definition, next.body.definition, frontier.cursor)
  const discoveryScheduler = stage.kind === 'discovery' && frontier.discoveryScheduler?.stageId === stage.id
    ? amendDiscoveryProgress(previous.body.definition, next.body.definition, frontier.discoveryScheduler) : undefined
  const selected = { artifacts, rejectedAttempts: frontier.rejectedAttempts, availabilityBoundaries: frontier.availabilityBoundaries }
  const initial = { releaseDigest: next.digest, definitionDigest: await sha256(next.body.definition) }
  const availability = await importAvailabilityContext(selected, executionConfiguration(source), previous.body.definition, initial, machine.importedAvailability)
  return copyState({ source, sourceReference: input.source, sourceFence: input.sourceFence,
    release: next, checkpoint, checkpointOwner: input.source, boundary: forkBoundary(input), stageIndex, waveIndex,
    artifacts, rejectedAttempts: source.rejectedAttempts, waveReceipts, stageEndReceipts, availabilityBoundaries: frontier.availabilityBoundaries, availability,
    discoveryWaits: [...machine.importedDiscoveryWaits, ...discoveryWaits(previous.body.definition, selected)],
    discoveryScheduler, waveAdmission: input.sourceFrontier === true ? source.waveAdmission ?? undefined : undefined,
    accounting: await resolveUsageEvidence(source, input.read.stateAt) })
}

/** Selected source snapshots already contain the producer's acceptance decision.
 * Export verifies custody, without running accepted output through a second validator. */
export async function prepareStageForkSource(input: StageForkSourceInput) {
  const prepared = await resolveStageForkSource(input)
  for (const record of prepared.artifacts) {
    const content = await input.readArtifact(record)
    if (await sha256(content) !== record.contentDigest) throw new Error('fork retained artifact bytes differ')
    if (record.execution !== undefined) {
      const inputs = await input.readInputs(record.execution.inputDigest)
      if (inputs.length !== record.execution.inputCount || await sha256(inputs) !== record.execution.inputDigest
        || inputs.some(ref => !prepared.artifacts.some(candidate => candidate.id === ref.id && candidate.contentDigest === ref.contentDigest))) {
        throw new Error('fork retained artifact input evidence differs')
      }

    }
  }
  return prepared
}
