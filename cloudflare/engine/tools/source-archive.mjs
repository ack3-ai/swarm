// Turns a ZIP source delivery into a Git commit without unpacking it to disk: entries go
// straight into `git fast-import`, so no path or symlink in the archive can write outside
// a temporary repository, and file bytes are stored without Git filters or attributes.
// A fixed author and date make the same archive yield the same commit and tree.
import { spawn } from 'node:child_process'
import { open, stat } from 'node:fs/promises'
import { crc32, inflateRawSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 2 ** 31 - 1
const MAX_UNPACKED_BYTES = 8 * 1024 ** 3
const MAX_ENTRY_BYTES = 1024 ** 3
const MAX_ENTRIES = 500_000
const identity = 'ACK3 Source Packager <source-packager@invalid> 946684800 +0000'

function fail(message) { throw new Error(`ZIP source: ${message}`) }

function u16(buffer, offset) { return buffer.readUInt16LE(offset) }
function u32(buffer, offset) { return buffer.readUInt32LE(offset) }
function u64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail('a size or offset is too large')
  return Number(value)
}

function endOfCentralDirectory(archive) {
  const lowest = Math.max(0, archive.length - 22 - 0xffff)
  for (let offset = archive.length - 22; offset >= lowest; offset -= 1) {
    if (u32(archive, offset) !== 0x06054b50) continue
    let directory = { disk: u16(archive, offset + 4), entries: u16(archive, offset + 10),
      size: u32(archive, offset + 12), offset: u32(archive, offset + 16) }
    if (directory.entries === 0xffff || directory.size === 0xffffffff || directory.offset === 0xffffffff) {
      const locator = offset - 20
      if (locator < 0 || u32(archive, locator) !== 0x07064b50) fail('ZIP64 locator is missing')
      const record = u64(archive, locator + 8)
      if (record + 56 > archive.length || u32(archive, record) !== 0x06064b50) fail('ZIP64 directory is missing')
      directory = { disk: u32(archive, record + 16), entries: u64(archive, record + 32),
        size: u64(archive, record + 40), offset: u64(archive, record + 48) }
    }
    if (directory.disk !== 0) fail('multi-part archives are not supported')
    if (directory.offset + directory.size > archive.length) fail('central directory is truncated')
    return directory
  }
  return fail('not a ZIP archive')
}

function zip64Values(extra, wanted) {
  for (let offset = 0; offset + 4 <= extra.length;) {
    const id = u16(extra, offset), length = u16(extra, offset + 2)
    if (id === 0x0001) {
      const values = []
      for (let index = 0; index < wanted; index += 1) {
        if (offset + 4 + index * 8 + 8 > offset + 4 + length) fail('ZIP64 field is truncated')
        values.push(u64(extra, offset + 4 + index * 8))
      }
      return values
    }
    offset += 4 + length
  }
  return fail('ZIP64 field is missing')
}

/** Validated relative path segments; rejects anything Git or a reviewer could misread. */
function pathSegments(name) {
  if (name === '' || name.startsWith('/') || /^[A-Za-z]:/.test(name)) fail(`absolute path: ${JSON.stringify(name)}`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) fail(`unsupported character in path: ${JSON.stringify(name)}`)
  if (name.includes('�')) fail(`path is not valid UTF-8: ${JSON.stringify(name)}`)
  const segments = (name.endsWith('/') ? name.slice(0, -1) : name).split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) fail(`unsafe path: ${JSON.stringify(name)}`)
  if (segments.some(segment => segment.toLowerCase() === '.git')) {
    fail(`archive contains Git metadata (${JSON.stringify(name)}); publish that repository instead`)
  }
  return segments
}

function readEntries(archive) {
  const directory = endOfCentralDirectory(archive)
  if (directory.entries > MAX_ENTRIES) fail(`more than ${MAX_ENTRIES} entries`)
  const entries = []
  let offset = directory.offset, unpacked = 0
  for (let index = 0; index < directory.entries; index += 1) {
    if (offset + 46 > archive.length || u32(archive, offset) !== 0x02014b50) fail('central directory entry is damaged')
    const madeBy = u16(archive, offset + 4), flags = u16(archive, offset + 8), method = u16(archive, offset + 10)
    const nameLength = u16(archive, offset + 28), extraLength = u16(archive, offset + 30), commentLength = u16(archive, offset + 32)
    const nameBytes = archive.subarray(offset + 46, offset + 46 + nameLength)
    const extra = archive.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength)
    let compressed = u32(archive, offset + 20), size = u32(archive, offset + 24), local = u32(archive, offset + 42)
    const large = [size === 0xffffffff, compressed === 0xffffffff, local === 0xffffffff]
    if (large.some(Boolean)) {
      const values = zip64Values(extra, large.filter(Boolean).length)
      if (large[0]) size = values.shift()
      if (large[1]) compressed = values.shift()
      if (large[2]) local = values.shift()
    }
    const name = new TextDecoder('utf-8').decode(nameBytes)
    if ((flags & 0x1) !== 0) fail(`encrypted entry: ${JSON.stringify(name)}`)
    const external = u32(archive, offset + 38), unix = madeBy >> 8 === 3 ? external >>> 16 : 0
    const type = unix & 0o170000
    const directoryEntry = name.endsWith('/') || type === 0o040000 || (external & 0x10) !== 0
    if (!directoryEntry && method !== 0 && method !== 8) fail(`unsupported compression in ${JSON.stringify(name)}`)
    if (!directoryEntry && size > MAX_ENTRY_BYTES) fail(`entry is larger than ${MAX_ENTRY_BYTES} bytes: ${JSON.stringify(name)}`)
    unpacked += directoryEntry ? 0 : size
    if (unpacked > MAX_UNPACKED_BYTES) fail(`unpacked size exceeds ${MAX_UNPACKED_BYTES} bytes`)
    entries.push({ name, segments: pathSegments(name), directory: directoryEntry, symlink: type === 0o120000,
      executable: type !== 0o120000 && (unix & 0o111) !== 0, method, crc: u32(archive, offset + 16), compressed, size, local })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function entryBytes(archive, entry) {
  if (entry.local + 30 > archive.length || u32(archive, entry.local) !== 0x04034b50) fail(`local header is damaged for ${JSON.stringify(entry.name)}`)
  const start = entry.local + 30 + u16(archive, entry.local + 26) + u16(archive, entry.local + 28)
  if (start + entry.compressed > archive.length) fail(`data is truncated for ${JSON.stringify(entry.name)}`)
  const raw = archive.subarray(start, start + entry.compressed)
  let bytes
  try { bytes = entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.size) }) } catch {
    return fail(`cannot decompress ${JSON.stringify(entry.name)}`)
  }
  if (bytes.length !== entry.size || (crc32(bytes) >>> 0) !== entry.crc) fail(`checksum mismatch for ${JSON.stringify(entry.name)}`)
  return bytes
}

/** Finder adds `__MACOSX/` and `.DS_Store` to a ZIP; they are never part of the project. */
function macMetadata(entry) {
  return entry.segments[0] === '__MACOSX' || entry.segments.at(-1) === '.DS_Store'
}

const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0)

/**
 * Files and symlinks with their final paths. macOS metadata is dropped first, then a single
 * top-level folder is removed; `topLevel` lists the names left at the root (folders end in `/`).
 */
export function sourceEntries(archive) {
  const all = readEntries(archive)
  const entries = all.filter(entry => !macMetadata(entry))
  const dropped = all.filter(entry => !entry.directory && macMetadata(entry)).length
  const tops = new Set(entries.map(entry => entry.segments[0]))
  const wrapped = tops.size === 1 && entries.every(entry => entry.segments.length > 1 || entry.directory)
  const files = entries.filter(entry => !entry.directory)
    .map(entry => ({ ...entry, path: (wrapped ? entry.segments.slice(1) : entry.segments).join('/') }))
  if (files.length === 0) fail('archive contains no files')
  // Compare as case-insensitive, normalization-insensitive file systems do, so unpacking the
  // package later cannot write a file through a symlink or replace one entry with another.
  const key = path => path.normalize('NFC').toLowerCase()
  // The publisher writes its manifest at the root; no entry may take that name in any case.
  const reserved = files.find(file => key(file.path.split('/')[0]) === '.ack3-source-package.json')
  if (reserved !== undefined) fail(`${JSON.stringify(reserved.name)} is reserved for the source package manifest; remove it from the archive`)
  const paths = new Set()
  for (const file of files) {
    if (paths.has(key(file.path))) fail(`duplicate path: ${JSON.stringify(file.path)}`)
    paths.add(key(file.path))
  }
  for (const file of files) {
    const parts = file.path.split('/')
    for (let length = 1; length < parts.length; length += 1) {
      const parent = parts.slice(0, length).join('/')
      if (paths.has(key(parent))) fail(`path is both a file and a folder: ${JSON.stringify(parent)}`)
    }
  }
  const topLevel = [...new Set(files.map(file => file.path.includes('/') ? `${file.path.split('/')[0]}/` : file.path))]
  return { files: files.toSorted((left, right) => compareText(left.path, right.path)),
    strippedFolder: wrapped ? [...tops][0] : null, dropped, topLevel: topLevel.toSorted(compareText) }
}

function quote(path) {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function run(command, args, environment, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    const output = [], errors = []
    child.stdout.on('data', chunk => output.push(chunk))
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', reject)
    child.stdin?.on('error', () => {}) // a failed git reports through its exit code
    child.on('close', code => code === 0 ? resolve(Buffer.concat(output).toString('utf8').trim())
      : reject(new Error(`${command} ${args[0]} failed: ${Buffer.concat(errors).toString('utf8').trim()}`)))
    if (input !== undefined) input(child.stdin).then(() => child.stdin.end(), error => { child.kill(); reject(error) })
  })
}

async function write(stream, chunk) {
  if (!stream.write(chunk)) await new Promise((resolve, reject) => {
    stream.once('drain', resolve)
    stream.once('error', reject)
  })
}

/** Commits a ZIP's files into the bare repository `gitDirectory`; returns the commit and tree. */
export async function commitZipSource(zipPath, gitDirectory) {
  const { size } = await stat(zipPath)
  if (size > MAX_ARCHIVE_BYTES) fail(`archive is larger than ${MAX_ARCHIVE_BYTES} bytes`)
  const handle = await open(zipPath, 'r')
  let archive
  try { archive = await handle.readFile() } finally { await handle.close() }
  const { files, strippedFolder, dropped, topLevel } = sourceEntries(archive)
  const environment = { ...process.env, GIT_DIR: gitDirectory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
  await run('git', ['init', '--bare', '--quiet', gitDirectory], environment)
  await run('git', ['fast-import', '--quiet', '--done'], environment, async stdin => {
    for (const [index, file] of files.entries()) {
      const bytes = entryBytes(archive, file)
      await write(stdin, `blob\nmark :${index + 1}\ndata ${bytes.length}\n`)
      await write(stdin, bytes)
      await write(stdin, '\n')
    }
    const message = 'ACK3 source package from a ZIP archive\n'
    await write(stdin, `commit refs/heads/main\nauthor ${identity}\ncommitter ${identity}\ndata ${Buffer.byteLength(message)}\n${message}`)
    for (const [index, file] of files.entries()) {
      await write(stdin, `M ${file.symlink ? '120000' : file.executable ? '100755' : '100644'} :${index + 1} ${quote(file.path)}\n`)
    }
    await write(stdin, '\ndone\n')
  })
  const commit = await run('git', ['rev-parse', '--verify', 'refs/heads/main^{commit}'], environment)
  const tree = await run('git', ['rev-parse', '--verify', 'refs/heads/main^{tree}'], environment)
  return { commit, tree, files: files.length, strippedFolder, dropped, topLevel }
}
