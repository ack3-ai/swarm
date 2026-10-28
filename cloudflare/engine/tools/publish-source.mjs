import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

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

async function exportArchive(repository, commit, destination) {
  await mkdir(destination, { recursive: true })
  await pipe([
    ['git', ['archive', '--format=tar', commit], repository],
    ['tar', ['-xf', '-', '-C', destination], process.cwd()],
  ], { ...process.env, COPYFILE_DISABLE: '1' })
}

async function exportRepository(repository, commit, destination) {
  await exportArchive(repository, commit, destination)
  const links = await gitlinks(repository, commit)
  for (const link of links) {
    const checkout = join(repository, link.path)
    const actual = await capture('git', ['rev-parse', '--verify', 'HEAD^{commit}'], checkout).catch(() => null)
    if (actual !== link.commit) throw new Error(`submodule ${link.path} is not initialized at ${link.commit}`)
    await exportRepository(checkout, link.commit, join(destination, link.path))
  }
  return links
}

const [repository, ref = 'HEAD'] = process.argv.slice(2)
const endpoint = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
const token = process.env.CONTROL_API_TOKEN ?? ''
if (!repository || !endpoint || !token) {
  throw new Error('usage: ACK3_ENGINE_URL=... CONTROL_API_TOKEN=... pnpm source:publish REPOSITORY [REF]')
}
const commit = await capture('git', ['rev-parse', '--verify', `${ref}^{commit}`], repository)
const tree = await capture('git', ['rev-parse', '--verify', `${commit}^{tree}`], repository)
if (!/^[0-9a-f]{40}$/.test(commit) || !/^[0-9a-f]{40}$/.test(tree)) {
  throw new Error('source must resolve to pinned SHA-1 Git objects')
}
const staging = await mkdtemp(join(tmpdir(), `ack3-source-${tree}-`))
const output = join(tmpdir(), `ack3-source-${tree}-${process.pid}.tar.zst`)
const archiveGit = await mkdtemp(join(tmpdir(), `ack3-source-archive-${tree}-`))
try {
  const directGitlinks = await exportRepository(repository, commit, staging)
  await writeFile(join(staging, '.ack3-source-package.json'), `${JSON.stringify({
    schemaVersion: 2, commit, tree, gitlinks: directGitlinks,
  })}\n`, { mode: 0o600 })
  await capture('git', ['init', '--bare', '--quiet', archiveGit], process.cwd())
  const archiveEnvironment = {
    ...process.env,
    GIT_DIR: archiveGit,
    GIT_WORK_TREE: staging,
    GIT_INDEX_FILE: join(archiveGit, 'package.index'),
    GIT_AUTHOR_NAME: 'ACK3 Source Packager',
    GIT_AUTHOR_EMAIL: 'source-packager@invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'ACK3 Source Packager',
    GIT_COMMITTER_EMAIL: 'source-packager@invalid',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
  }
  await capture('git', ['add', '--all', '--force'], process.cwd(), archiveEnvironment)
  const archiveTree = await capture('git', ['write-tree'], process.cwd(), archiveEnvironment)
  const archiveCommit = await capture(
    'git', ['commit-tree', archiveTree, '-m', 'ACK3 source package v2'], process.cwd(), archiveEnvironment,
  )
  await pipe([
    ['git', ['archive', '--format=tar', archiveCommit], process.cwd()],
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
  console.log(JSON.stringify(result))
} finally {
  await Promise.all([
    rm(output, { force: true }),
    rm(staging, { recursive: true, force: true }),
    rm(archiveGit, { recursive: true, force: true }),
  ])
}
