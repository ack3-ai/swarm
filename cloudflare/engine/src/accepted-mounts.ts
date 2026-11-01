import type { AgentRequest, ArtifactRecord, ExperimentDefinition, TaskDefinition } from './contracts.js'
import { canonicalJson } from './canonical.js'
import { assertResearchLeadCustody, createNegativeReviewInput, negativeReviewReadingView } from './protocol-transforms.js'
import { configuredResearchTaskPoolId, researchTaskPoolId } from './research-scheduler.js'
import { PermanentRunFailure } from './run-errors.js'
import { SUBMISSION_PATH } from './submission.js'

export type AcceptedMountMode =
  | 'none'
  | 'research-frontier'
  | 'negative-review-packet-only'
  | 'full-frontier'

export function acceptedMountMode(task: Pick<TaskDefinition, 'promptKind'>): AcceptedMountMode {
  switch (task.promptKind) {
    case 'research':
      return 'research-frontier'
    case 'negative-review':
      return 'negative-review-packet-only'
    case 'synthesis':
    case 'verification':
    case 'reporting':
      return 'full-frontier'
    default:
      return 'none'
  }
}

export const researchIndexPath = '/workspace/accepted/research-index.md'

export function acceptedEvidencePath(artifact: Pick<ArtifactRecord, 'taskId'>, path: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(artifact.taskId)) {
    throw new PermanentRunFailure(`unsafe accepted task id: ${artifact.taskId}`, 'integrity-failed')
  }
  return `/workspace/accepted/by-task/${artifact.taskId.toLowerCase()}/${path}`
}

export function acceptedResearch(artifacts: readonly ArtifactRecord[]): readonly ArtifactRecord[] {
  return artifacts.filter(artifact => artifact.status === 'accepted' && artifact.protocol.research !== undefined)
}

export function researchEvidencePaths(artifact: ArtifactRecord): { documents: readonly string[], observations: string } {
  const documents = artifact.files.filter(path => path !== SUBMISSION_PATH)
  if (documents.length === 0 || !artifact.files.includes(SUBMISSION_PATH)) {
    throw new PermanentRunFailure(`accepted research evidence is incomplete: ${artifact.taskId}`, 'integrity-failed')
  }
  return {
    documents: documents.map(path => acceptedEvidencePath(artifact, path)),
    observations: acceptedEvidencePath(artifact, SUBMISSION_PATH),
  }
}

/** Resolve the admission's selected lineage, never a newer or different-pool peer. */
export function researchPredecessor(
  definition: ExperimentDefinition,
  task: TaskDefinition,
  artifacts: readonly ArtifactRecord[],
): ArtifactRecord | undefined {
  const assignment = task.research
  if (assignment === undefined || assignment.buildsOn === 'none') return undefined
  const selected = assignment.buildsOn.match(/^wave-(\d+)\/research-(\d+)$/)
  const poolId = configuredResearchTaskPoolId(task)
  const discovery = definition.stages.find(stage => stage.kind === 'discovery')
  const peer = selected === null ? undefined : discovery?.waves.flatMap(wave => wave.tasks).find(candidate => (
    candidate.promptKind === 'research' && configuredResearchTaskPoolId(candidate) === poolId
    && candidate.research?.wave === Number(selected[1]) && candidate.research.researcher === Number(selected[2])
  ))
  const matches = acceptedResearch(artifacts).filter(artifact => (
    artifact.stageId === discovery?.id && artifact.taskId === peer?.id
  ))
  if (matches.length !== 1) {
    throw new PermanentRunFailure(
      `assigned research predecessor is missing or ambiguous: ${task.id} -> ${assignment.buildsOn} (${poolId})`,
      'integrity-failed',
    )
  }
  return matches[0]!
}

function researchIndex(artifacts: readonly ArtifactRecord[]): string {
  const entries = acceptedResearch(artifacts).map(artifact => {
    assertResearchLeadCustody(artifact)
    const paths = researchEvidencePaths(artifact)
    return [
      `## ${artifact.stageId}/${artifact.waveId}/${artifact.taskId} | ${artifact.provider}`,
      `sha256:${artifact.contentDigest}`,
      ...paths.documents.map(path => `Evidence: [${path}](${path})`),
      `Observations: [${paths.observations}](${paths.observations})`,
      ...artifact.protocol.research!.observations.map(observation => `- ${observation.id} | ${observation.statement}`),
      ...(artifact.protocol.research!.leadChecks ?? []).map(check =>
        `- Lead check ${check.observationId} | ${check.conclusion} | ${check.evidenceMethod} | untested: ${check.remainingUntestedConditions.join('; ') || 'none'} | ${check.evidence}`),
    ].join('\n')
  })
  return `# Immutable accepted research index\n\n${entries.join('\n\n')}\n`
}

interface AcceptedWorkspace {
  exec(command: string, options: { timeout: number }): Promise<unknown>
  mkdir(path: string, options: { recursive: boolean }): Promise<unknown>
  writeFile(path: string, content: string): Promise<unknown>
}

interface AcceptedArtifactReader {
  read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>>
}

export async function writeAccepted(
  sandbox: AcceptedWorkspace,
  request: Pick<AgentRequest, 'task' | 'visibleArtifacts'>,
  store: AcceptedArtifactReader,
): Promise<void> {
  await sandbox.exec('/usr/local/bin/ack3-reset-accepted', { timeout: 10_000 })
  const mode = acceptedMountMode(request.task)
  if (mode === 'none') return
  if (mode === 'negative-review-packet-only') {
    const input = await createNegativeReviewInput(request.visibleArtifacts)
    const packet = canonicalJson(input)
    const view = request.task.output.schema === 'ack3.negative-review.policy-v3'
      ? negativeReviewReadingView(input) : undefined
    await sandbox.writeFile('/workspace/accepted/negative-disposition-review-input.json', packet)
    if (view !== undefined) await sandbox.writeFile('/workspace/accepted/negative-disposition-review-view.json', view)
    if (request.task.providerClass === 'additive') {
      await sandbox.mkdir('/input', { recursive: true })
      await sandbox.writeFile('/input/negative-disposition-review-input.json', packet)
      if (view !== undefined) await sandbox.writeFile('/input/negative-disposition-review-view.json', view)
    } else {
      await sandbox.writeFile('/workspace/results/negative-disposition-review-input.json', packet)
      if (view !== undefined) await sandbox.writeFile('/workspace/results/negative-disposition-review-view.json', view)
    }
    return
  }
  const artifacts = mode === 'research-frontier' ? acceptedResearch(request.visibleArtifacts) : request.visibleArtifacts
  // Keep only one hash-verified artifact's file bodies resident while mounting
  // the frontier. Verification and reporting can consume many large artifacts.
  for (const record of artifacts) {
    const files = await store.read(record)
    if (mode === 'research-frontier') {
      researchEvidencePaths(record)
      if (record.files.some(path => typeof files[path] !== 'string')) {
        throw new PermanentRunFailure(`accepted research file is missing: ${record.taskId}`, 'integrity-failed')
      }
    }
    for (const [path, content] of Object.entries(files)) {
      const destination = acceptedEvidencePath(record, path)
      await sandbox.mkdir(destination.slice(0, destination.lastIndexOf('/')), { recursive: true })
      await sandbox.writeFile(destination, content)
      if (mode === 'research-frontier' || path === SUBMISSION_PATH) continue
      const researchPath = discoveryResearchPromptPath(record, path)
      const promptPath = researchPath !== path
        ? researchPath
        : record.stageId === 'coverage' && record.taskId.startsWith('challenge-')
            && record.taskId !== 'coverage-union'
          ? `coverage-challenges/${record.taskId}.md`
          : path
      const promptDestination = `/workspace/results/${promptPath}`
      await sandbox.mkdir(promptDestination.slice(0, promptDestination.lastIndexOf('/')), { recursive: true })
      await sandbox.writeFile(promptDestination, content)
    }
  }
  await sandbox.writeFile(researchIndexPath, researchIndex(artifacts))
  if (mode === 'research-frontier') return
  await sandbox.writeFile('/workspace/accepted/accepted-artifacts.json', canonicalJson(request.visibleArtifacts))
  await sandbox.writeFile('/workspace/results/research-index.md', researchIndex(request.visibleArtifacts))
  await sandbox.writeFile('/workspace/results/accepted-artifacts.json', canonicalJson(request.visibleArtifacts))
}

export function discoveryResearchPromptPath(
  artifact: Pick<ArtifactRecord, 'stageId' | 'taskId' | 'provider'>,
  path: string,
): string {
  if (artifact.stageId !== 'discovery') return path
  const poolId = researchTaskPoolId(
    artifact.taskId,
    artifact.taskId.startsWith('additive-') ? 'additive' : 'core',
  )
  return poolId === 'luna' ? path : path.replace(/^waves\//, `${poolId.toLowerCase()}-waves/`)
}
