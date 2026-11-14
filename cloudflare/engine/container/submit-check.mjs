// `ack3-submit` (run by the agent) and the runner's final check (run as root)
// share this module. The checks themselves come from the Worker's code in
// submission-check.bundle.mjs; this file only reads files, safely.
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { collectAgentOutputFiles } from './output-files.mjs'
import { SEARCH_RECORD_MAX_BYTES, SEARCH_RECORD_PATH, parseSearchRecord } from './search-record.mjs'
import {
  SUBMIT_CHECK_CONTEXT_PATH, SUBMIT_CHECK_DONE_PATH, SUBMIT_CHECK_OK, canonicalJson, checkSubmissionFiles,
  parseSubmitCheckContext, submitCheckReport,
} from './submission-check.bundle.mjs'

const LINE_COUNT_MAX_BYTES = 16 * 1024 * 1024
const SOURCE_ENTRY_MAX = 200_000
const MARKER_MAX_BYTES = 1024 * 1024
const defaults = { contextPath: SUBMIT_CHECK_CONTEXT_PATH, resultsRoot: '/workspace/results', sourceRoot: '/workspace/source',
  searchRecordPath: SEARCH_RECORD_PATH, agentUid: 10001 }
const digest = value => createHash('sha256').update(value).digest('hex')
const safeRelative = path => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\0')
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')

// The agent may still own processes that swap path components for symlinks, so
// trust only the opened descriptor: never follow the last link, then check where it is.
// With `agentUid`, for a file the agent writes (the done marker), it must also be that user's
// own file with no second name (T5). Source files and root's search record are not the agent's outputs.
async function readContained(absolute, maxBytes, agentUid) {
  let handle
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : null
  }
  try {
    const stat = await handle.stat()
    if (stat.isDirectory()) return 'missing'
    if (!stat.isFile()) return null
    if (agentUid !== undefined && (stat.uid !== agentUid || stat.nlink !== 1)) return null
    const opened = await readlink(`/proc/self/fd/${handle.fd}`).catch(() => realpath(absolute))
    if (opened !== absolute || stat.size > maxBytes) return null
    const buffer = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > maxBytes ? null : buffer.subarray(0, length)
  } finally { await handle.close() }
}

function lines(buffer) {
  let count = 0
  for (let index = buffer.indexOf(10); index !== -1; index = buffer.indexOf(10, index + 1)) count += 1
  return buffer.length > 0 && buffer[buffer.length - 1] !== 10 ? count + 1 : count
}

// Names only, from a walk that never enters a symlinked folder; null when too large or unreadable.
async function listSource(root) {
  try {
    if (!(await lstat(root)).isDirectory() || await realpath(root) !== root) return null
  } catch { return null }
  const byName = new Map()
  const folders = ['']
  let seen = 0
  while (folders.length > 0) {
    const folder = folders.pop()
    let entries
    try { entries = await readdir(folder === '' ? root : `${root}/${folder}`, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      if (++seen > SOURCE_ENTRY_MAX) return null
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`
      if (entry.isDirectory()) { if (entry.name !== '.git') folders.push(path) } else if (entry.isFile() || entry.isSymbolicLink()) {
        byName.set(entry.name, [...byName.get(entry.name) ?? [], path])
      }
    }
  }
  return byName
}

/** The checks' read-only view of the source tree (see SourceTree in src/submission-check.ts). */
export function sourceTree(root = defaults.sourceRoot) {
  const counts = new Map()
  let listing
  return {
    lineCount(path) {
      if (!safeRelative(path)) return Promise.resolve(null)
      if (!counts.has(path)) {
        counts.set(path, readContained(`${root}/${path}`, LINE_COUNT_MAX_BYTES)
          .then(read => read === 'missing' || read === null ? read : lines(read)))
      }
      return counts.get(path)
    },
    async named(name) {
      listing ??= listSource(root)
      const byName = await listing
      return byName === null ? null : byName.get(name) ?? []
    },
    // lstat never follows a link: a link at the top counts as an entry, its target is not read.
    async topLevel(name) {
      if (!safeRelative(name) || name.includes('/')) return null
      try { await lstat(`${root}/${name}`); return true } catch (error) { return error?.code === 'ENOENT' ? false : null }
    },
  }
}

/** The done marker binds the check context and every checked output file. */
export function doneMarker(contextText, files) {
  return canonicalJson({
    context: digest(contextText),
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, digest(content)])),
    schemaVersion: 1,
  })
}

/** The runner's record of this session's searches; undefined without one (an older image) or when it is incomplete. */
async function readSearchRecord(path) {
  const read = await readContained(path, SEARCH_RECORD_MAX_BYTES)
  return Buffer.isBuffer(read) ? parseSearchRecord(read.toString('utf8')) ?? undefined : undefined
}

async function check(options) {
  const { contextPath, resultsRoot, sourceRoot, searchRecordPath, agentUid } = { ...defaults, ...options }
  let contextText
  try { contextText = await readFile(contextPath, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`this task has no submission check (${contextPath} is missing)`)
    throw error
  }
  const context = parseSubmitCheckContext(contextText)
  const files = options.files ?? await collectAgentOutputFiles(context.outputFiles, resultsRoot, { agentUid })
  // The runner's final check leaves search citations to the Worker, which checks them on the receipt.
  const search = options.searchCitations === false || context.searchRequirement === undefined
    ? undefined : await readSearchRecord(searchRecordPath)
  const issues = await checkSubmissionFiles(context, files, sourceTree(sourceRoot), search)
  return { context, contextText, files, issues, searchChecked: search !== undefined, markerPath: `${resultsRoot}/${SUBMIT_CHECK_DONE_PATH}`,
    agentUid }
}

/** `ack3-submit`: check the results; write the done marker only when every check passes. */
export async function runSubmitCheck(options = {}) {
  const { context, contextText, files, issues, searchChecked, markerPath } = await check(options)
  if (issues.length > 0) {
    await rm(markerPath, { force: true })
  } else {
    await mkdir(dirname(markerPath), { recursive: true })
    const temporary = `${markerPath}.${process.pid}.tmp`
    await writeFile(temporary, doneMarker(contextText, files))
    await rename(temporary, markerPath)
  }
  return { issues, searchCheckedLater: context.searchCheckedLater && !searchChecked }
}

export function formatSubmitCheck({ issues, searchCheckedLater }) {
  const note = searchCheckedLater
    ? ['Note: search citations (researchQueries) need this session\'s search records, so Swarm checks them after you stop.'] : []
  if (issues.length === 0) return [SUBMIT_CHECK_OK, ...note].join('\n')
  return [`ack3-submit found ${issues.length} problem${issues.length === 1 ? '' : 's'}. Fix each one:`,
    ...issues.map((issue, index) => `${index + 1}. ${issue}`),
    'Then run ack3-submit again. It prints "OK: submission accepted" when the submission is ready.', ...note].join('\n')
}

/**
 * The runner's authoritative check after the model run, on the exact files it
 * reports: done means a done marker for these files and context, and no problems.
 */
export async function runnerSubmitCheck(files, taskId, options = {}) {
  try {
    const { context, contextText, issues, markerPath, agentUid } = await check({ ...options, files, searchCitations: false })
    if (context.task.id !== taskId) throw new Error('the check context belongs to another task')
    const marker = await readContained(markerPath, MARKER_MAX_BYTES, agentUid)
    let fresh = false
    if (Buffer.isBuffer(marker)) {
      try { fresh = canonicalJson(JSON.parse(marker.toString('utf8'))) === doneMarker(contextText, files) } catch {}
    }
    return submitCheckReport(fresh, issues)
  } catch (error) {
    return submitCheckReport(false, [`ack3-submit could not run: ${error instanceof Error ? error.message : String(error)}`])
  }
}
