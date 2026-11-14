import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { commitZipSource } from './source-archive.mjs'

function capture(command, args, cwd, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve(Buffer.concat(chunks).toString('utf8').trim())
      : reject(new Error(`${command} exited ${code}`)))
  })
}

function pipe(commands, environment = process.env) {
  return new Promise((resolve, reject) => {
    const children = commands.map(([command, args, cwd], index) => spawn(command, args, {
      cwd, env: environment,
      stdio: [index === 0 ? 'ignore' : 'pipe', index === commands.length - 1 ? 'inherit' : 'pipe', 'inherit'],
    }))
    for (let index = 0; index < children.length - 1; index += 1) {
      children[index].stdout.pipe(children[index + 1].stdin)
    }
    const codes = Array.from({ length: children.length }, () => null)
    children.forEach((child, index) => {
      child.on('error', reject)
      child.on('close', code => {
        codes[index] = code
        if (codes.some(value => value === null)) return
        if (codes.every(value => value === 0)) resolve()
        else reject(new Error(`source packaging pipeline failed: ${codes.join(',')}`))
      })
    })
  })
}

async function gitlinks(repository, commit) {
  const output = await capture('git', ['ls-tree', '-r', commit], repository)
  return output.split('\n').filter(Boolean).flatMap(line => {
    const match = line.match(/^160000 commit ([0-9a-f]{40})\t(.+)$/)
    if (match === null) return []
    const path = match[2]
    if (path.startsWith('/') || path.split('/').includes('..') || /[\t\r\n]/.test(path)) {
      throw new Error(`unsupported submodule path: ${JSON.stringify(path)}`)
    }
    return [{ commit: match[1], path }]
  })
}

const MANIFEST = '.ack3-source-package.json'
// The package holds each blob's exact bytes. Git attributes (in the source, or the operator's
// `core.autocrlf`) must neither change bytes nor drop files, here or in container/prepare-source.sh.
const NO_ATTRIBUTES = '* -text -eol -filter -ident -working-tree-encoding -export-ignore -export-subst\n'

/** Environment for a temporary repository: no Git variable or setting of the operator applies. */
function isolatedGit(variables = {}) {
  const inherited = Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  return { ...Object.fromEntries(inherited), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...variables }
}

/** A bare repository that ignores Git attributes; `objects` lends it a source repository's objects. */
async function plainRepository(gitDirectory, objects) {
  await capture('git', ['init', '--bare', '--quiet', gitDirectory], process.cwd(), isolatedGit())
  await mkdir(join(gitDirectory, 'info'), { recursive: true })
  await writeFile(join(gitDirectory, 'info', 'attributes'), NO_ATTRIBUTES)
  if (objects !== undefined) await writeFile(join(gitDirectory, 'objects', 'info', 'alternates'), `${objects}\n`)
}

async function exportArchive(gitDirectory, commit, destination) {
  await mkdir(destination, { recursive: true })
  await pipe([
    ['git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', commit], process.cwd()],
    ['tar', ['-xf', '-', '-C', destination], process.cwd()],
  ], isolatedGit({ GIT_DIR: gitDirectory, COPYFILE_DISABLE: '1' }))
}

/** Paths that differ between two trees; a folder is listed only when nothing below it is. */
async function treeDifferences(environment, expected, actual) {
  const fields = (await capture('git', ['diff-tree', '-r', '-t', '-z', '--no-renames', expected, actual],
    process.cwd(), environment)).split('\0')
  const entries = []
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, , , status] = fields[index].slice(1).split(' ')
    entries.push({ status, path: fields[index + 1], folder: oldMode === '040000' || newMode === '040000' })
  }
  const parents = new Set(entries.flatMap(({ path }) => path.split('/').slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join('/'))))
  const what = { D: 'missing from the export', A: 'not in the source tree' }
  return entries.filter(entry => !entry.folder || !parents.has(entry.path))
    .map(entry => `${what[entry.status] ?? 'different in the export'}: ${entry.path}${entry.folder ? '/' : ''}`)
}

/**
 * Recomputes the tree of an export exactly as container/prepare-source.sh does (gitlinks replaced
 * by their commits) and stops before anything is uploaded when it is not the commit's tree.
 */
async function verifyExport(gitDirectory, directory, links, commit, label) {
  const environment = isolatedGit({
    GIT_DIR: gitDirectory, GIT_WORK_TREE: directory, GIT_INDEX_FILE: join(gitDirectory, 'check.index'),
  })
  await capture('git', ['-c', 'core.autocrlf=false', 'add', '--all', '--force'], process.cwd(), environment)
  for (const link of links) {
    await capture('git', ['rm', '-r', '--cached', '-f', '--quiet', '--', link.path], process.cwd(), environment)
    await capture('git', ['update-index', '--add', '--cacheinfo', '160000', link.commit, link.path], process.cwd(), environment)
  }
  const actual = await capture('git', ['write-tree'], process.cwd(), environment)
  const expected = await capture('git', ['rev-parse', '--verify', `${commit}^{tree}`], process.cwd(), environment)
  if (actual === expected) return
  const differences = await treeDifferences(environment, expected, actual)
  const shown = differences.length === 0
    ? ['no path differs: the tree has an entry Git cannot reproduce from files, such as a non-standard file mode']
    : [...differences.slice(0, 20), ...(differences.length > 20 ? [`and ${differences.length - 20} more`] : [])]
  throw new Error(`source export${label === '' ? '' : ` of submodule ${label}`} does not reproduce Git tree ${expected} `
    + `(the export gives ${actual}), so the audit container would refuse it. Nothing was uploaded.\n  ${shown.join('\n  ')}`)
}

async function exportRepository(repository, commit, destination, work, label = '') {
  const objects = await capture('git', ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], repository)
  const gitDirectory = await mkdtemp(join(work, 'export-'))
  await plainRepository(gitDirectory, objects)
  await exportArchive(gitDirectory, commit, destination)
  const links = await gitlinks(repository, commit)
  for (const link of links) {
    const checkout = join(repository, link.path)
    const actual = await capture('git', ['rev-parse', '--verify', 'HEAD^{commit}'], checkout).catch(() => null)
    if (actual !== link.commit) throw new Error(`submodule ${link.path} is not initialized at ${link.commit}`)
    await exportRepository(checkout, link.commit, join(destination, link.path), work,
      label === '' ? link.path : `${label}/${link.path}`)
  }
  await verifyExport(gitDirectory, destination, links, commit, label)
  return links
}

const [source, sourceRef] = process.argv.slice(2)
const endpoint = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
const token = process.env.CONTROL_API_TOKEN ?? ''
if (!source || !endpoint || !token) {
  throw new Error('usage: ACK3_ENGINE_URL=... CONTROL_API_TOKEN=... pnpm source:publish REPOSITORY [REF] | ARCHIVE.zip')
}
// A ZIP delivery becomes a commit in a temporary repository; a Git checkout is used as is.
const zip = /\.zip$/i.test(source) && (await stat(source).catch(() => null))?.isFile() === true
if (zip && sourceRef !== undefined) throw new Error('a ZIP source takes no REF')
const zipRepository = zip ? await mkdtemp(join(tmpdir(), 'ack3-source-zip-')) : undefined
process.on('exit', () => { if (zipRepository !== undefined) rmSync(zipRepository, { recursive: true, force: true }) })
let repository = source, ref = sourceRef ?? 'HEAD'
if (zipRepository !== undefined) {
  const packaged = await commitZipSource(source, zipRepository)
  repository = zipRepository
  ref = 'refs/heads/main'
  const topLevel = [...packaged.topLevel.slice(0, 20), ...(packaged.topLevel.length > 20 ? [`and ${packaged.topLevel.length - 20} more`] : [])]
  console.error(`Packaged ${packaged.files} files from ${source}${packaged.strippedFolder === null ? ''
    : ` without its top-level folder ${packaged.strippedFolder}/`}${packaged.dropped === 0 ? ''
    : `; dropped ${packaged.dropped} macOS metadata files (__MACOSX/, .DS_Store)`}. Top level: ${topLevel.join(', ')}. `
    + 'Set target.commit and target.tree to the values printed below.')
}
const commit = await capture('git', ['rev-parse', '--verify', `${ref}^{commit}`], repository)
const tree = await capture('git', ['rev-parse', '--verify', `${commit}^{tree}`], repository)
if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
  throw new Error('source must resolve to pinned SHA-1 Git objects')
}
// The manifest is written at the package root; a source entry with that name (in any case,
// as a case-insensitive file system sees it) could redirect the write outside the staging folder.
const reserved = (await capture('git', ['ls-tree', '--name-only', '-z', commit], repository)).split('\0')
  .find(name => name.normalize('NFC').toLowerCase() === MANIFEST)
if (reserved !== undefined) {
  throw new Error(`source root entry ${JSON.stringify(reserved)} is reserved for the source package manifest; remove it from the source`)
}
const staging = await mkdtemp(join(tmpdir(), `ack3-source-${tree}-`))
const output = join(tmpdir(), `ack3-source-${tree}-${process.pid}.tar.zst`)
const archiveGit = await mkdtemp(join(tmpdir(), `ack3-source-archive-${tree}-`))
const exportGit = await mkdtemp(join(tmpdir(), `ack3-source-export-${tree}-`))
try {
  const directGitlinks = await exportRepository(repository, commit, staging, exportGit)
  await writeFile(join(staging, MANIFEST), `${JSON.stringify({
    schemaVersion: 2, commit, tree, gitlinks: directGitlinks,
  })}\n`, { mode: 0o600, flag: 'wx' })
  await plainRepository(archiveGit)
  const archiveEnvironment = isolatedGit({
    GIT_DIR: archiveGit,
    GIT_WORK_TREE: staging,
    GIT_INDEX_FILE: join(archiveGit, 'package.index'),
    GIT_AUTHOR_NAME: 'ACK3 Source Packager',
    GIT_AUTHOR_EMAIL: 'source-packager@invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'ACK3 Source Packager',
    GIT_COMMITTER_EMAIL: 'source-packager@invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  })
  await capture('git', ['-c', 'core.autocrlf=false', 'add', '--all', '--force'], process.cwd(), archiveEnvironment)
  const archiveTree = await capture('git', ['write-tree'], process.cwd(), archiveEnvironment)
  const archiveCommit = await capture(
    'git', ['commit-tree', archiveTree, '-m', 'ACK3 source package v2'], process.cwd(), archiveEnvironment,
  )
  await pipe([
    ['git', ['-c', 'core.autocrlf=false', 'archive', '--format=tar', archiveCommit], process.cwd()],
    ['zstd', ['-q', '-T0', '-o', output], process.cwd()],
  ], archiveEnvironment)
  const body = await readFile(output)
  const archiveSha256 = createHash('sha256').update(body).digest('hex')
  const response = await fetch(`${endpoint}/v1/sources/${tree}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/zstd',
      'x-ack3-archive-sha256': archiveSha256,
      'x-ack3-git-commit': commit,
      'x-ack3-source-package-version': '2',
    },
    body,
  })
  const result = await response.json()
  if (!response.ok) throw new Error(`source upload failed: ${JSON.stringify(result)}`)
  // Source packages are write-once per tree: a different package is never stored over an older one.
  if (result.stored === false && typeof result.archiveSha256 === 'string' && result.archiveSha256 !== archiveSha256) {
    console.error(`Warning: the server already has an older package for this tree (archive ${result.archiveSha256}) `
      + `and keeps it; this package (archive ${archiveSha256}) was not stored. Audits of this tree use the older package.`)
  }
  console.log(JSON.stringify({ ...result, commit, tree }))
} finally {
  await Promise.all([
    rm(output, { force: true }),
    rm(staging, { recursive: true, force: true }),
    rm(archiveGit, { recursive: true, force: true }),
    rm(exportGit, { recursive: true, force: true }),
  ])
}
