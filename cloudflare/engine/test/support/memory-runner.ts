import { sha256 } from '../../src/canonical.js'
import type {
  AgentProvider, ArtifactRecord, ArtifactStore, ExperimentDefinition, RunOutcome, SealedCheckpoint,
} from '../../src/contracts.js'
import type { RunMachine } from '../../src/machine.js'
import { PermanentRunFailure } from '../../src/run-errors.js'
import { advanceExperimentOneWave, type RunPolicy } from '../../src/runner.js'

// In-memory artifact custody and a whole-run driver for deterministic tests.
export class MemoryArtifactStore implements ArtifactStore {
  readonly contents = new Map<string, string>()
  readonly rejectedMetadata = new Map<string, { contentDigest: string, taskId: string }>()

  async put(record: Omit<ArtifactRecord, 'uri'>, content: string): Promise<ArtifactRecord> {
    const uri = `memory://artifacts/${encodeURIComponent(record.id)}`
    this.contents.set(uri, content)
    return { ...record, uri }
  }

  async putRejected(record: { id: string, taskId: string, contentDigest: string }, content: string): Promise<string> {
    if (await sha256(content) !== record.contentDigest) throw new Error(`rejected artifact digest mismatch: ${record.id}`)
    const uri = `memory://quarantine/${encodeURIComponent(record.id)}`
    this.contents.set(uri, content)
    this.rejectedMetadata.set(uri, { contentDigest: record.contentDigest, taskId: record.taskId })
    return uri
  }

  async readRejected(uri: string, contentDigest: string, taskId: string): Promise<Readonly<Record<string, string>>> {
    const content = this.contents.get(uri)
    const metadata = this.rejectedMetadata.get(uri)
    if (content === undefined || metadata?.contentDigest !== contentDigest || metadata.taskId !== taskId
      || await sha256(content) !== contentDigest) {
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

export async function runExperiment(input: {
  definition: ExperimentDefinition
  machine: RunMachine
  provider: AgentProvider
  artifactStore: ArtifactStore
  policy?: RunPolicy
  onCheckpoint?: (checkpoint: SealedCheckpoint) => Promise<void>
}): Promise<RunOutcome> {
  const { definition, machine } = input
  await machine.start()

  try {
    while (machine.snapshot().cursor.stageIndex < definition.stages.length) {
      const advanced = await advanceExperimentOneWave(input)
      if (!advanced && (machine.snapshot().waveAdmission === null
        || machine.snapshot().waveAdmission === undefined)
        && (machine.snapshot().discoveryScheduler?.admissions.length ?? 0) === 0) break
    }
    const completionIssues = input.policy?.assessCompletion({ definition, state: machine.snapshot() }) ?? []
    if (completionIssues.length > 0) {
      throw new PermanentRunFailure(`completion contract failed: ${completionIssues.join('; ')}`, 'completion-contract-failed')
    }
    await machine.complete()
  } catch (error) {
    await machine.fail(error instanceof Error ? error.message : String(error))
    throw error
  }

  const state = machine.snapshot()
  return { state, checkpoints: state.checkpoints }
}
