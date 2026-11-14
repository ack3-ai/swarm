import {
  SCRATCH_BUNDLE_PATTERN, SCRATCH_DIRECTORY_PATTERN, SCRATCH_OMIT_REASONS, SCRATCH_OMITTED_MAX, SCRATCH_OMITTED_PATH_PATTERN,
  SCRATCH_RETAINED_PATH, safeScratchPath, scratchText,
} from '../container/scratch-rules.mjs'
import type { ArtifactRecord, ResearchAssignment, ScratchCaptureLimits, TaskDefinition } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { researchTaskPoolId } from './research-scheduler.js'
import { PermanentRunFailure } from './run-errors.js'

// keepPocs: each research task's runner adds a bundle of its new scratch-path text
// files beside its research document; the verifier receives them as leads.

export interface ScratchBundle {
  schemaVersion: 1
  directory: string
  files: readonly { path: string; sha256: string; bytes: number; content: string }[]
  omitted: readonly { path: string; bytes: number; reason: string }[]
}

export const pocBundleDirectory = '/workspace/private/poc-bundles'
export const pocTestsIndexPath = '/workspace/accepted/tests-index.md'
export { SCRATCH_RETAINED_PATH as scratchRetainedPath }

export function scratchBundlePath(assignment: Pick<ResearchAssignment, 'wave' | 'researcher'>): string {
  return `waves/wave-${assignment.wave}/research-${assignment.researcher}.tests.json`
}

/** Bundle paths in accepted discovery artifacts; no research task declares an output of this shape. */
export function isScratchBundlePath(path: string): boolean {
  return SCRATCH_BUNDLE_PATTERN.test(path)
}

/** The bundle a task's runner must add, when its release keeps PoC tests. */
export function capturedBundlePath(task: Pick<TaskDefinition, 'research'>): string | undefined {
  return task.research?.scratchCapture === undefined ? undefined : scratchBundlePath(task.research)
}

/** Native request field, present only for capture-enabled research so other request digests stay unchanged. */
export function scratchCaptureRequest(task: Pick<TaskDefinition, 'research'>):
  { directory: string; bundlePath: string; limits: ScratchCaptureLimits } | undefined {
  const research = task.research
  if (research?.scratchCapture === undefined) return undefined
  return { directory: research.laneScratchPath, bundlePath: scratchBundlePath(research), limits: { ...research.scratchCapture } }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, keys: string) => Object.keys(value).toSorted().join() === keys
const encoder = new TextEncoder()

/** Integrity issues of a runner bundle against its sealed assignment; empty when valid. */
export async function scratchBundleIssues(assignment: ResearchAssignment, content: string | undefined): Promise<string[]> {
  const limits = assignment.scratchCapture
  const issue = (message: string) => [`scratch test bundle ${message}`]
  if (limits === undefined) return issue('has no capture contract')
  if (content === undefined) return issue('is missing')
  let bundle: unknown
  try { bundle = JSON.parse(content) } catch { return issue('is not JSON') }
  if (canonicalJson(bundle) !== content) return issue('is not canonical JSON')
  if (!record(bundle) || !exactKeys(bundle, 'directory,files,omitted,schemaVersion') || bundle.schemaVersion !== 1) {
    return issue('has an invalid shape')
  }
  if (bundle.directory !== assignment.laneScratchPath) return issue('names another directory')
  if (!Array.isArray(bundle.files) || bundle.files.length > limits.maxFiles) return issue('has too many files')
  let total = 0
  let previous: string | undefined
  for (const file of bundle.files as unknown[]) {
    if (!record(file) || !exactKeys(file, 'bytes,content,path,sha256') || !safeScratchPath(file.path)
      || (previous !== undefined && previous >= file.path) || !scratchText(file.content)) {
      return issue('has an invalid, unsorted or non-text file entry')
    }
    previous = file.path
    const bytes = encoder.encode(file.content).byteLength
    if (file.bytes !== bytes || bytes > limits.maxFileBytes) return issue(`has a wrong or oversized byte count: ${file.path}`)
    if (file.sha256 !== await sha256(file.content)) return issue(`has a wrong digest: ${file.path}`)
    total += bytes
  }
  if (total > limits.maxTaskBytes) return issue('exceeds the task byte limit')
  if (!Array.isArray(bundle.omitted) || bundle.omitted.length > SCRATCH_OMITTED_MAX
    || !(bundle.omitted as unknown[]).every(file => record(file) && exactKeys(file, 'bytes,path,reason')
      && Number.isSafeInteger(file.bytes) && (file.bytes as number) >= 0
      && typeof file.path === 'string' && SCRATCH_OMITTED_PATH_PATTERN.test(file.path)
      && SCRATCH_OMIT_REASONS.includes(file.reason as string))) {
    return issue('has an invalid omitted list')
  }
  return []
}

/** The bundle of an accepted discovery artifact, if it has one. */
export function acceptedScratchBundle(artifact: ArtifactRecord, files: Readonly<Record<string, string>>):
  { path: string; bundle: ScratchBundle } | undefined {
  const path = artifact.files.find(isScratchBundlePath)
  if (path === undefined || artifact.protocol.research === undefined) return undefined
  let bundle: unknown
  try { bundle = JSON.parse(files[path] ?? '') } catch {}
  if (!record(bundle) || bundle.schemaVersion !== 1 || typeof bundle.directory !== 'string'
    || !SCRATCH_DIRECTORY_PATTERN.test(bundle.directory) || !Array.isArray(bundle.files) || !Array.isArray(bundle.omitted)) {
    throw new PermanentRunFailure(`accepted scratch test bundle is invalid: ${artifact.taskId}`, 'integrity-failed')
  }
  return { path, bundle: bundle as unknown as ScratchBundle }
}

const researchLane = (taskId: string) => taskId.replace(/-wave-\d+-research-\d+$/, '')

/** Same pool and lane, so the same persistent lane workspace. */
export function sameScratchLane(task: Pick<TaskDefinition, 'id' | 'research'>, artifact: ArtifactRecord, bundle: ScratchBundle): boolean {
  return researchLane(artifact.taskId) === researchLane(task.id) && bundle.directory === task.research?.laneScratchPath
}

/** The retained list for a capture-enabled research task: files its lane's accepted bundles already keep. */
export function scratchRetained(directory: string, files: readonly { path: string; sha256: string }[]): string {
  return canonicalJson({ schemaVersion: 1, directory,
    files: files.map(file => ({ path: file.path, sha256: file.sha256 })).toSorted((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1
        : left.sha256 < right.sha256 ? -1 : left.sha256 > right.sha256 ? 1 : 0) })
}

/** One manifest entry for the verifier's PoC test extractor. */
export function pocManifestTask(artifact: ArtifactRecord, path: string) {
  const [, wave, lane] = SCRATCH_BUNDLE_PATTERN.exec(path)!
  return {
    bundle: `${artifact.taskId}.json`,
    lane: Number(lane),
    observations: artifact.protocol.research!.observations.map(observation => observation.id),
    pool: researchTaskPoolId(artifact.taskId, artifact.taskId.startsWith('additive-') ? 'additive' : 'core'),
    taskId: artifact.taskId,
    wave: Number(wave),
  }
}
