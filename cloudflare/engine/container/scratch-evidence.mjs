import { constants } from 'node:fs'
import { lstat, open, readdir, readFile, readlink, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import {
  SCRATCH_BUNDLE_PATTERN, SCRATCH_DIRECTORY_PATTERN, SCRATCH_ENTRY_MAX, SCRATCH_OMITTED_MAX, SCRATCH_RETAINED_PATH,
  printableScratchPath, safeScratchPath, scratchSkippedDirectory, scratchText,
} from './scratch-rules.mjs'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1
  : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0

/** The request's runner-owned capture contract, checked before any model call. */
export function validateScratchCapture(capture) {
  const limits = capture?.limits
  const lane = capture?.directory?.slice?.(capture.directory.lastIndexOf('-') + 1)
  if (capture === null || typeof capture !== 'object' || Array.isArray(capture)
    || Object.keys(capture).toSorted().join() !== 'bundlePath,directory,limits'
    || !SCRATCH_DIRECTORY_PATTERN.test(capture.directory) || !SCRATCH_BUNDLE_PATTERN.test(capture.bundlePath)
    || SCRATCH_BUNDLE_PATTERN.exec(capture.bundlePath)[2] !== lane
    || limits === null || typeof limits !== 'object' || Array.isArray(limits)
    || Object.keys(limits).toSorted().join() !== 'maxFileBytes,maxFiles,maxTaskBytes'
    || !Object.values(limits).every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('invalid scratch capture contract')
  }
  return capture
}

/** Files already kept by accepted bundles from this lane, written by the Worker. Absent means none. */
export async function readScratchRetained(directory, path = SCRATCH_RETAINED_PATH) {
  let text
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const value = JSON.parse(text)
  if (value?.schemaVersion !== 1 || value.directory !== directory || !Array.isArray(value.files)
    || value.files.some(file => !safeScratchPath(file?.path) || !/^[0-9a-f]{64}$/.test(file?.sha256 ?? ''))) {
    throw new Error('invalid retained scratch list')
  }
  return value.files
}

async function openedPath(handle, path) {
  try { return await readlink(`/proc/self/fd/${handle.fd}`) } catch { return realpath(path) }
}

// The agent may still own processes that swap path components for symlinks, so
// trust only the opened descriptor: never follow the last link, then check where it is.
// A file the agent does not own, or one with a second name (a hard link), is not the agent's file (T5).
async function readContained(base, path, maxBytes, agentUid) {
  const absolute = `${base}/${path}`
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== agentUid || stat.nlink !== 1) return { reason: 'not-regular', bytes: 0 }
    if (await openedPath(handle, absolute) !== absolute) return { reason: 'symlink', bytes: 0 }
    if (stat.size > maxBytes) return { reason: 'file-size', bytes: stat.size }
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return length > maxBytes ? { reason: 'file-size', bytes: length } : { buffer: buffer.subarray(0, length) }
  } finally { await handle.close() }
}

async function scratchEntries(base, omit) {
  try {
    if (!(await lstat(base)).isDirectory() || await realpath(base) !== base) return []
  } catch { return [] }
  const found = []
  let seen = 0
  const walk = async relative => {
    let names
    try { names = (await readdir(relative === '' ? base : `${base}/${relative}`)).toSorted() } catch {
      omit(relative, 0, 'unreadable')
      return true
    }
    for (const name of names) {
      const path = relative === '' ? name : `${relative}/${name}`
      if (++seen > SCRATCH_ENTRY_MAX) {
        omit(path, 0, 'entry-limit')
        return false
      }
      let stat
      try { stat = await lstat(`${base}/${path}`) } catch { continue }
      if (stat.isSymbolicLink()) omit(path, 0, 'symlink')
      else if (stat.isDirectory()) {
        if (scratchSkippedDirectory(name)) omit(path, 0, 'build-folder')
        else if (!await walk(path)) return false
      } else if (!stat.isFile()) omit(path, 0, 'not-regular')
      else found.push({ path, size: stat.size })
    }
    return true
  }
  await walk('')
  return found.toSorted(byPath)
}

/**
 * Canonical JSON bundle of the lane's new text files: those not already kept with
 * the same content by an accepted bundle (`retained`), within the sealed limits,
 * and containing no credential value. `root` prefixes the directory in tests.
 */
export async function scratchEvidenceBundle(capture, { retained = [], credentials = [], root = '', agentUid = 10001 } = {}) {
  const { directory, limits } = validateScratchCapture(capture)
  const base = `${root}${directory}`
  const files = []
  const omitted = []
  const omit = (path, bytes, reason) => {
    if (omitted.length < SCRATCH_OMITTED_MAX) omitted.push({ bytes, path: printableScratchPath(path), reason })
  }
  const kept = new Set(retained.map(file => `${file.path}\n${file.sha256}`))
  const secrets = credentials.filter(value => typeof value === 'string' && value.length >= 8)
  let total = 0
  for (const { path, size } of await scratchEntries(base, omit)) {
    if (!safeScratchPath(path)) { omit(path, size, 'path'); continue }
    if (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(path)) { omit(path, size, 'credential'); continue }
    if (size > limits.maxFileBytes) { omit(path, size, 'file-size'); continue }
    let read
    try { read = await readContained(base, path, limits.maxFileBytes, agentUid) } catch { omit(path, size, 'unreadable'); continue }
    if (read.reason !== undefined) { omit(path, read.bytes, read.reason); continue }
    const bytes = read.buffer.length
    const sha256 = createHash('sha256').update(read.buffer).digest('hex')
    if (kept.has(`${path}\n${sha256}`)) continue
    let content
    try { content = decoder.decode(read.buffer) } catch { omit(path, bytes, 'binary'); continue }
    if (!scratchText(content)) { omit(path, bytes, 'binary'); continue }
    if (secrets.some(value => content.includes(value))) { omit(path, bytes, 'credential'); continue }
    if (files.length >= limits.maxFiles) { omit(path, bytes, 'file-limit'); continue }
    if (total + bytes > limits.maxTaskBytes) { omit(path, bytes, 'task-limit'); continue }
    files.push({ bytes, content, path, sha256 })
    total += bytes
  }
  // Keys in sorted order: this is the Worker's canonical JSON.
  return JSON.stringify({ directory, files, omitted: omitted.toSorted(byPath), schemaVersion: 1 })
}
