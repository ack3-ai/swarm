// Output checks shared by the Worker and the in-container `ack3-submit` command.
// container/submission-check.bundle.mjs is this module bundled by
// tools/build-submission-check.mjs; a test fails when the two differ.
import type { ArtifactRecord, ObservationRecord, ProtocolMetadata, TaskDefinition } from './contracts.js'
import { SEARCH_REQUIREMENTS, searchCitationIssues, type SearchRequirement } from './native-research.js'
import { OUTPUT_FILE_MAX_BYTES } from './output-limits.js'
import { reconFileIssues } from './recon.js'
import { readSubmission, SUBMISSION_PATH, type SubmissionRead } from './submission.js'

/** Written by the Worker for each submitCheck task; readable by the agent. */
export const SUBMIT_CHECK_CONTEXT_PATH = '/control/submission-check.json'
/** Written by `ack3-submit` under /workspace/results when every check passes. */
export const SUBMIT_CHECK_DONE_PATH = '.swarm/done.json'
export const SUBMIT_CHECK_OK = 'OK: submission accepted'
export const SUBMIT_CHECK_MAX_ISSUES = 40
export const SUBMIT_CHECK_ISSUE_MAX_CHARS = 1_000
export const SUBMIT_CHECK_ISSUE_PREFIX = 'ack3-submit: '
export const SUBMIT_CHECK_UNFINISHED = 'You stopped before `ack3-submit` passed. Continue the task; when you are finished, '
  + 'run `ack3-submit` and fix what it reports.'
const SOURCE_ROOT = '/workspace/source'
// The done marker is canonical JSON, like every other Swarm record.
export { canonicalJson } from './canonical.js'

/** The runner's final check: done means a fresh done marker and no problems. */
export interface SubmitCheckReport { done: boolean, issues: readonly string[] }

type CheckTask = Pick<TaskDefinition, 'id' | 'providerClass' | 'promptKind' | 'output'>
  & Partial<Pick<TaskDefinition, 'modelPool' | 'research' | 'observationPrefix' | 'perspective'>>

export interface SubmitCheckContext {
  schemaVersion: 1
  /** Only the task fields the checks read. */
  task: CheckTask
  /** Required and optional output files, relative to /workspace/results. */
  outputFiles: readonly string[]
  /** For stages whose checks read accepted inputs: the records in /workspace/accepted/accepted-artifacts.json. */
  visibleArtifacts: readonly ArtifactRecord[]
  /** True when records need search citations; images without the search record only say the Worker checks them later. */
  searchCheckedLater: boolean
  /** Which records need a search citation, when any do: `ack3-submit` checks them against the runner's search record. */
  searchRequirement?: SearchRequirement
}

const artifactKinds = new Set<TaskDefinition['promptKind']>(['synthesis', 'negative-review', 'verification', 'reporting'])

export function submitCheckContext(
  task: TaskDefinition, outputFiles: readonly string[], visibleArtifacts: readonly ArtifactRecord[],
  searchRequirement: SearchRequirement | undefined,
): SubmitCheckContext {
  return {
    schemaVersion: 1,
    task: {
      id: task.id, providerClass: task.providerClass, promptKind: task.promptKind, output: task.output,
      ...(task.modelPool === undefined ? {} : { modelPool: task.modelPool }),
      ...(task.research === undefined ? {} : { research: task.research }),
      ...(task.observationPrefix === undefined ? {} : { observationPrefix: task.observationPrefix }),
      ...(task.perspective === undefined ? {} : { perspective: task.perspective }),
    },
    outputFiles: [...outputFiles],
    visibleArtifacts: artifactKinds.has(task.promptKind) ? visibleArtifacts : [],
    searchCheckedLater: searchRequirement !== undefined,
    ...(searchRequirement === undefined ? {} : { searchRequirement }),
  }
}

const safeOutputPath = (path: unknown) => typeof path === 'string' && /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/.test(path) && !path.includes('..')

export function parseSubmitCheckContext(text: string): SubmitCheckContext {
  const value = JSON.parse(text) as Partial<SubmitCheckContext> | null
  const task = value?.task
  if (value?.schemaVersion !== 1 || task === null || typeof task !== 'object' || typeof task.id !== 'string'
    || typeof task.promptKind !== 'string' || !Array.isArray(task.output?.requiredFiles)
    || !Array.isArray(value.outputFiles) || !value.outputFiles.every(safeOutputPath)
    || !Array.isArray(value.visibleArtifacts) || typeof value.searchCheckedLater !== 'boolean'
    || (value.searchRequirement !== undefined
      && (!SEARCH_REQUIREMENTS.includes(value.searchRequirement) || value.searchCheckedLater !== true))) {
    throw new TypeError('invalid submission check context')
  }
  return value as SubmitCheckContext
}

/** The searches the root runner saw in this session so far (container/search-record.mjs). */
export interface SessionSearchRecord { queries: readonly string[], failed: number }

export const SEARCH_NOT_YET = 'No web search has succeeded in this session yet, but this submission needs search evidence (see below). '
  + 'Search now with your web search tool, put each exact query you rely on in that record\'s researchQueries, then run ack3-submit again.'

/** The Worker's search citation check, run in the session on the runner's record of its searches. */
export function sessionSearchIssues(
  context: SubmitCheckContext, protocol: ProtocolMetadata, search: SessionSearchRecord,
): string[] {
  if (context.searchRequirement === undefined) return []
  const issues = searchCitationIssues(protocol, search.queries, search.failed > 0, context.searchRequirement)
  return issues.length > 0 && search.queries.length === 0 ? [SEARCH_NOT_YET, ...issues] : issues
}

export function validSubmitCheckReport(value: unknown): value is SubmitCheckReport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const report = value as Record<string, unknown>
  return Object.keys(report).toSorted().join() === 'done,issues' && typeof report.done === 'boolean'
    && Array.isArray(report.issues) && report.issues.length <= SUBMIT_CHECK_MAX_ISSUES
    && report.issues.every(issue => typeof issue === 'string' && issue.trim() !== '' && issue.length <= SUBMIT_CHECK_ISSUE_MAX_CHARS)
    && (report.done === false || report.issues.length === 0)
}

/** The bounded report the runner returns. */
export function submitCheckReport(done: boolean, issues: readonly string[]): SubmitCheckReport {
  const bounded = issues.slice(0, SUBMIT_CHECK_MAX_ISSUES).map(issue => issue.length <= SUBMIT_CHECK_ISSUE_MAX_CHARS
    ? issue : `${issue.slice(0, SUBMIT_CHECK_ISSUE_MAX_CHARS - 3)}...`)
  return { done: done && bounded.length === 0, issues: bounded }
}

export function missingOutputIssues(task: Pick<TaskDefinition, 'output'>, files: Readonly<Record<string, string>>): string[] {
  return task.output.requiredFiles.filter(path => (files[path] ?? '').trim() === '')
    .map(path => `missing required output file: ${path}`)
}

export function outputSizeIssue(path: string, content: string, maxBytes = OUTPUT_FILE_MAX_BYTES): string | undefined {
  return new TextEncoder().encode(content).byteLength > maxBytes ? `output file is too large: ${path}` : undefined
}

/** The structured submission and the output-content checks of a model result, in the Worker's order. */
export async function submissionContentChecks(
  task: TaskDefinition, files: Readonly<Record<string, string>>, visibleArtifacts: readonly ArtifactRecord[],
): Promise<{ submission: SubmissionRead, outputIssues: string[] }> {
  const submission = await readSubmission(task, files, visibleArtifacts)
  const outputIssues: string[] = []
  if (task.promptKind === 'coverage-challenge') {
    const primaryPath = task.output.requiredFiles.find(path => path !== SUBMISSION_PATH)
    const primary = primaryPath === undefined ? '' : files[primaryPath] ?? ''
    const headings = new Set(primary.split(/\r?\n/).filter(line => line.startsWith('### ')))
    for (const reference of new Set((submission.protocol.challengeObservations ?? [])
      .filter(observation => observation.disposition !== 'refuted').map(observation => observation.reference))) {
      if (!headings.has(`### ${reference}`)) outputIssues.push(`coverage challenge lacks evidence heading for ${reference}`)
    }
  }
  if (task.promptKind === 'recon') outputIssues.push(...reconFileIssues(files))
  return { submission, outputIssues }
}

/** Read access to /workspace/source; only the container has it. */
export interface SourceTree {
  /** Lines in a regular file; null when unknown (symlink, unreadable or very large); 'missing' when no such file. */
  lineCount(path: string): Promise<number | null | 'missing'>
  /** Paths of every file with this name; null when the tree is too large to list. */
  named(name: string): Promise<readonly string[] | null>
  /** Whether the top of the tree has a file or folder with this name; null when unknown. */
  topLevel(name: string): Promise<boolean | null>
}

export interface SourceReference { text: string, path: string, start?: number, end?: number }

const fileLike = /^[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/
const extension = /\.[A-Za-z][A-Za-z0-9_-]{0,15}$/

/**
 * File references in one evidence entry. A word is a reference when it has a
 * folder (`/`) or a file extension, optionally followed by `:LINE`, `:START-END`
 * or `#LSTART-LEND`. URLs and absolute paths outside /workspace/source are not.
 */
export function sourceReferences(evidence: string): SourceReference[] {
  const found: SourceReference[] = []
  for (const raw of evidence.split(/[\s`"'()[\]{}<>,;|*]+/)) {
    const text = raw.replace(/[.:,;!?]+$/, '')
    if (text === '' || text.includes('://') || text.startsWith('www.')) continue
    const match = /^([^:#]+)(?:(?::L?|#L)(\d+)(?:-L?(\d+))?)?/.exec(text)
    if (match === null) continue
    let path = match[1]!
    if (path.startsWith(`${SOURCE_ROOT}/`)) path = path.slice(SOURCE_ROOT.length + 1)
    else if (path.startsWith('/')) continue
    path = path.replace(/^(?:\.\/)+/, '').replace(/\/+$/, '')
    if (!fileLike.test(path) || path.split('/').some(part => part === '.' || part === '..')
      || !(path.includes('/') || extension.test(path))) continue
    found.push({ text, path,
      ...(match[2] === undefined ? {} : { start: Number(match[2]) }),
      ...(match[3] === undefined ? {} : { end: Number(match[3]) }) })
  }
  return found
}

/**
 * A reference matches a source file whose path equals it or ends with `/` plus
 * it, so `Vault.sol` and `contracts/Vault.sol` both match `src/contracts/Vault.sol`.
 * Returns the matches with their line counts, null when unknown, or [] when none.
 */
async function matches(path: string, source: SourceTree): Promise<{ path: string, lines: number | null }[] | null> {
  const direct = await source.lineCount(path)
  if (direct !== 'missing') return [{ path, lines: direct }]
  const named = await source.named(path.slice(path.lastIndexOf('/') + 1))
  // A tree too large to list, or a package import such as @scope/pkg/File.sol, may still be right.
  if (named === null) return null
  const candidates = named.filter(candidate => candidate.endsWith(`/${path}`)).toSorted().slice(0, 8)
  if (candidates.length === 0) return path.startsWith('@') ? null : []
  const result: { path: string, lines: number | null }[] = []
  for (const candidate of candidates) {
    const lines = await source.lineCount(candidate)
    if (lines !== 'missing') result.push({ path: candidate, lines })
  }
  return result
}

function mentions(document: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`, 'i').test(document)
}

/** Source-aware research checks the Worker cannot run: it has no source tree. */
export async function researchSourceIssues(
  task: Pick<TaskDefinition, 'output'>, files: Readonly<Record<string, string>>,
  observations: readonly ObservationRecord[], source: SourceTree,
): Promise<string[]> {
  const issues: string[] = []
  const documentPath = task.output.requiredFiles.find(path => path !== SUBMISSION_PATH)
  const document = documentPath === undefined ? '' : files[documentPath] ?? ''
  for (const observation of observations) {
    const label = `observation ${observation.id}`
    if (documentPath !== undefined && document.trim() !== '' && !mentions(document, observation.id)) {
      issues.push(`${label} is not in ${documentPath}; describe it there under its ID ${observation.id}, or remove it from ${SUBMISSION_PATH}`)
    }
    let named = false
    for (const reference of observation.evidence.flatMap(sourceReferences)) {
      const found = await matches(reference.path, source)
      if (found === null || found.length > 0) named = true
      if (reference.start === undefined || found === null) continue
      const end = reference.end ?? reference.start
      if (found.length === 0) {
        // `USDC/WETH:500` or `anvil-fork/mainnet:18000000` is a pair or a fork, not a file (E7): without a
        // file extension, a cited path counts only when its first folder is at the top of the source tree.
        if (!extension.test(reference.path) && await source.topLevel(reference.path.split('/')[0]!) !== true) continue
        issues.push(`${label} cites ${reference.text}, but no file ${reference.path} exists under ${SOURCE_ROOT}; `
          + 'give the file path relative to /workspace/source, for example src/Vault.sol:42')
      } else if (reference.start < 1 || end < reference.start) {
        issues.push(`${label} cites ${reference.text}, which is not a valid line or line range; write it as path:LINE or path:START-END`)
      } else if (found.every(match => match.lines !== null && end > match.lines)) {
        issues.push(`${label} cites ${reference.text}, but ${found[0]!.path} has only ${found[0]!.lines} lines; fix the line number`)
      }
    }
    if (!named) {
      issues.push(`${label}: its evidence names no file that exists under ${SOURCE_ROOT}; `
        + 'add the source file and line it relies on, for example src/Vault.sol:42')
    }
  }
  return issues
}

/**
 * Every check `ack3-submit` runs, in order: the Worker's output checks, the source-aware ones, then,
 * given the runner's record of this session's searches, the search citation check.
 */
export async function checkSubmissionFiles(
  context: SubmitCheckContext, files: Readonly<Record<string, string>>, source: SourceTree, search?: SessionSearchRecord,
): Promise<string[]> {
  // The context holds every task field these checks read.
  const task = context.task as TaskDefinition
  const issues = missingOutputIssues(task, files)
  for (const [path, content] of Object.entries(files)) {
    const issue = outputSizeIssue(path, content)
    if (issue !== undefined) issues.push(issue)
  }
  const { submission, outputIssues } = await submissionContentChecks(task, files, context.visibleArtifacts)
  issues.push(...submission.issues, ...outputIssues)
  const research = submission.protocol.research
  if (task.promptKind === 'research' && research !== undefined) {
    issues.push(...await researchSourceIssues(task, files, research.observations, source))
  }
  if (search !== undefined) issues.push(...sessionSearchIssues(context, submission.protocol, search))
  return issues
}
