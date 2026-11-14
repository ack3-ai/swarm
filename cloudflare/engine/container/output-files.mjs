import { constants } from 'node:fs'
import { lstat as lstatPath, mkdir, open, readlink, realpath } from 'node:fs/promises'

// Above the Worker's 4 MB output limit, so an oversized file is still reported as too large.
export const OUTPUT_READ_MAX_BYTES = 16 * 1024 * 1024

// The runner reads as root while agent processes (UID 10001) may still run, so a declared
// output could be a symlink to a root-only file, or a path whose folder is swapped for one.
// Trust only the opened descriptor: never follow the last link, then check where it really is.
// It must also be the agent's own file with no other name, or it could be a hard link to a root-only file (T5).
async function readOutput(absolute, agentUid) {
  let handle
  try { handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return undefined }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.uid !== agentUid || stat.nlink !== 1) return undefined
    if (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => realpath(absolute)) !== absolute) return undefined
    const buffer = Buffer.alloc(Math.min(stat.size, OUTPUT_READ_MAX_BYTES) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    return buffer.subarray(0, length).toString('utf8')
  } finally { await handle.close() }
}

/**
 * Create the folder of each expected output and give the deepest one to the agent. Root does
 * this inside a tree the agent owns, so it never goes through a symlink: every part of the path
 * must be a real folder (lstat; a missing one is created), and the chown goes to an opened
 * descriptor whose real path is checked, so a link swapped in meanwhile is refused too.
 */
export async function prepareOutputFolders(expectedFiles, { root = '/workspace/results', uid = 10001, gid = 10001,
  chown = handle => handle.chown(uid, gid), lstat = lstatPath } = {}) {
  const folders = new Set(expectedFiles.map(path => path.split('/').filter(part => part !== '' && part !== '.')
    .slice(0, -1).join('/')))
  if (folders.size === 0) return
  const base = await realpath(root)
  for (const folder of folders) {
    const parts = folder === '' ? [] : folder.split('/')
    let absolute = base
    for (const [index, part] of parts.entries()) {
      const name = parts.slice(0, index + 1).join('/')
      if (part === '..') throw new Error(`output folder ${name} is unsafe`)
      absolute = `${absolute}/${part}`
      let stat = await lstat(absolute).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      if (stat === null) {
        await mkdir(absolute).catch(error => { if (error.code !== 'EEXIST') throw error })
        stat = await lstat(absolute)
      }
      if (stat.isSymbolicLink()) throw new Error(`output folder ${name} is a symbolic link; refusing to follow it`)
      if (!stat.isDirectory()) throw new Error(`output folder ${name} is not a folder`)
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      if (await readlink(`/proc/self/fd/${handle.fd}`).catch(() => realpath(absolute)) !== absolute) {
        throw new Error(`output folder ${folder || '.'} moved while it was prepared; refusing to follow it`)
      }
      await chown(handle, absolute)
    } finally { await handle.close() }
  }
}

// The Worker's bound on the report (src/protocol-validation.ts); every value is replaced either way.
export const OUTPUT_CREDENTIAL_HITS_MAX = 256

/**
 * A credential value in a collected output must not leave the container (T3): replace it with
 * `<redacted:NAME>`, as the log does, and report each file and credential name, never the value.
 * `credentials` is the log writer's list (redactionCredentials), longest value first.
 */
export function redactOutputCredentials(files, credentials) {
  const redacted = {}
  const hits = []
  for (const [path, content] of Object.entries(files)) {
    let text = content
    for (const { name, value } of credentials) {
      if (typeof value !== 'string' || value.length < 8 || !text.includes(value)) continue
      text = text.replaceAll(value, `<redacted:${name}>`)
      if (hits.length < OUTPUT_CREDENTIAL_HITS_MAX) hits.push({ path, name })
    }
    redacted[path] = text
  }
  return { files: redacted, hits }
}

/** Collect only request-declared outputs from the runner's results directory, each the agent user's own file. */
export async function collectAgentOutputFiles(expectedFiles, resultsRoot = '/workspace/results', { agentUid = 10001 } = {}) {
  const files = {}
  let root
  try { root = await realpath(resultsRoot) } catch { return files }
  for (const path of expectedFiles) {
    const content = await readOutput(`${root}/${path}`, agentUid).catch(() => undefined)
    if (content !== undefined) files[path] = content
  }
  return files
}
