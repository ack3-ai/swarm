import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const publisher = new URL('../tools/publish-source.mjs', import.meta.url).pathname
const prepareSource = new URL('../container/prepare-source.sh', import.meta.url).pathname
const temporary = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); roots.push(path); return path }

function git(repository: string, args: string[], input?: string): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-23T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-23T00:00:00Z',
    },
  })
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
  return result.stdout.trim()
}

function publish(repository: string, endpoint: string, environment: Record<string, string> = {}) {
  return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [publisher, repository, 'HEAD'], {
      env: { ...process.env, ACK3_ENGINE_URL: endpoint, CONTROL_API_TOKEN: 'test-token', ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => resolve({
      code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
  })
}

interface Upload { body: Buffer, headers: IncomingHttpHeaders }

/** A local stand-in for `PUT /v1/sources/:tree`; `answer` writes the response for each upload. */
async function serve(answer: (upload: Upload, response: ServerResponse, count: number) => void) {
  const uploads: Upload[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      const upload = { body: Buffer.concat(chunks), headers: request.headers }
      uploads.push(upload)
      answer(upload, response, uploads.length)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    uploads,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error))),
  }
}

function storeOnce(upload: Upload, response: ServerResponse) {
  const archiveSha256 = createHash('sha256').update(upload.body).digest('hex')
  response.writeHead(201, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ archiveSha256, stored: true }))
}

/** A repository with LF line endings in its own config, whatever the machine's Git settings are. */
function repository(files: Record<string, string>): string {
  const path = temporary('ack3-source-publisher-')
  git(path, ['init', '--quiet'])
  git(path, ['config', 'user.name', 'ACK3 Test'])
  git(path, ['config', 'user.email', 'test@invalid'])
  git(path, ['config', 'core.autocrlf', 'false'])
  commitFiles(path, files)
  return path
}

function commitFiles(path: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(path, name)), { recursive: true })
    writeFileSync(join(path, name), content)
  }
  git(path, ['add', '--all'])
  git(path, ['commit', '--quiet', '-m', 'fixture'])
}

/** Runs the container's own unpack and tree check on an uploaded package. */
function prepare(body: Buffer, commit: string, tree: string) {
  const workspace = temporary('ack3-source-prepared-')
  mkdirSync(join(workspace, 'private'))
  writeFileSync(join(workspace, 'private', 'source.tar.zst'), body)
  const result = spawnSync('/bin/sh', [prepareSource], {
    encoding: 'utf8',
    env: {
      ...process.env, ACK3_EXPECTED_COMMIT: commit, ACK3_EXPECTED_TREE: tree, ACK3_WORKSPACE_ROOT: workspace,
      ACK3_SOURCE_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    },
  })
  return { ...result, source: join(workspace, 'source') }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source publisher', () => {
  it('reuses identical archive bytes when the same commit is published later', async () => {
    const path = repository({ 'README.md': 'stable source\n' })
    let archiveSha256: string | null = null
    const server = await serve((upload, response, count) => {
      const digest = createHash('sha256').update(upload.body).digest('hex')
      const matchesHeader = upload.headers['x-ack3-archive-sha256'] === digest
      const unchanged = archiveSha256 === null || archiveSha256 === digest
      if (archiveSha256 === null) archiveSha256 = digest
      response.writeHead(matchesHeader && unchanged ? (count === 1 ? 201 : 200) : 409, {
        'content-type': 'application/json',
      })
      response.end(JSON.stringify(matchesHeader && unchanged
        ? { archiveSha256: digest, stored: count === 1 }
        : { error: 'immutable source key already exists with different provenance' }))
    })
    try {
      const first = await publish(path, server.endpoint)
      expect(first.code, first.stderr).toBe(0)
      await delay(1_100)
      const second = await publish(path, server.endpoint)
      expect(second.code, second.stderr).toBe(0)
      expect(JSON.parse(second.stdout).stored).toBe(false)
      expect(second.stderr).not.toContain('Warning')
      expect(server.uploads).toHaveLength(2)
      expect(archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await server.close()
    }
  })

  it('warns when the server keeps an older, different package for the same tree', async () => {
    const path = repository({ 'README.md': 'source\n' })
    const kept = 'f'.repeat(64)
    const server = await serve((_upload, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ archiveSha256: kept, stored: false }))
    })
    try {
      const result = await publish(path, server.endpoint)
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain('Warning: the server already has an older package for this tree')
      expect(result.stderr).toContain(kept)
      expect(result.stderr).toContain(server.uploads[0]!.headers['x-ack3-archive-sha256'] as string)
    } finally {
      await server.close()
    }
  })

  // E19: each repository below once gave a package whose tree differed from the commit's tree.
  it.each([
    ['an export-ignore rule', () => repository({
      '.gitattributes': '/test export-ignore\n', 'README.md': 'vault\n', 'test/Vault.t.sol': 'contract VaultTest {}\n',
    }), {}, 'test/Vault.t.sol', 'contract VaultTest {}\n'],
    ['text=auto with a file committed with CRLF', () => {
      const path = repository({ 'crlf.txt': 'a\r\nb\r\n' })
      commitFiles(path, { '.gitattributes': '* text=auto\n' })
      return path
    }, {}, 'crlf.txt', 'a\r\nb\r\n'],
    ['an export-subst file', () => repository({
      '.gitattributes': 'version.txt export-subst\n', 'version.txt': '$Format:%H$\n',
    }), {}, 'version.txt', '$Format:%H$\n'],
    ['core.autocrlf=true on the operator side', () => repository({ 'lf.txt': 'a\nb\n' }),
      { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.autocrlf', GIT_CONFIG_VALUE_0: 'true' }, 'lf.txt', 'a\nb\n'],
    ['eol=crlf with LF blobs', () => repository({ '.gitattributes': '* text eol=crlf\n', 'lf.txt': 'a\nb\n' }),
      {}, 'lf.txt', 'a\nb\n'],
  ] as const)('packages a repository with %s so that the container finds the same tree', async (
    _name, build, environment, file, content,
  ) => {
    const path = build()
    const server = await serve(storeOnce)
    try {
      const result = await publish(path, server.endpoint, environment)
      expect(result.code, result.stderr).toBe(0)
      const printed = JSON.parse(result.stdout)
      expect(printed.tree).toBe(git(path, ['rev-parse', 'HEAD^{tree}']))
      expect(server.uploads).toHaveLength(1)
      const prepared = prepare(server.uploads[0]!.body, printed.commit, printed.tree)
      expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0)
      expect(readFileSync(join(prepared.source, file), 'utf8')).toBe(content)
    } finally {
      await server.close()
    }
  })

  it('keeps export-ignored files inside a submodule, where the container check cannot see them', async () => {
    const dependency = repository({ '.gitattributes': '/test export-ignore\n', 'src/Lib.sol': 'library Lib {}\n',
      'test/Lib.t.sol': 'contract LibTest {}\n' })
    const path = repository({ 'README.md': 'vault\n' })
    git(path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', dependency, 'lib/dependency'])
    git(path, ['commit', '--quiet', '-m', 'dependency'])
    const server = await serve(storeOnce)
    try {
      const result = await publish(path, server.endpoint)
      expect(result.code, result.stderr).toBe(0)
      const printed = JSON.parse(result.stdout)
      const prepared = prepare(server.uploads[0]!.body, printed.commit, printed.tree)
      expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0)
      expect(readFileSync(join(prepared.source, 'lib/dependency/test/Lib.t.sol'), 'utf8')).toBe('contract LibTest {}\n')
    } finally {
      await server.close()
    }
  })

  /** Moves HEAD to a commit whose tree has an empty folder, which no export can reproduce. */
  function commitEmptyFolder(path: string): string {
    const blob = git(path, ['rev-parse', 'HEAD:README.md'])
    const empty = git(path, ['hash-object', '-t', 'tree', '-w', '--stdin'], '')
    const tree = git(path, ['mktree'], `100644 blob ${blob}\tREADME.md\n040000 tree ${empty}\tempty\n`)
    git(path, ['update-ref', 'HEAD', git(path, ['commit-tree', tree, '-m', 'empty folder'])])
    return tree
  }

  it('stops before the upload when the export cannot reproduce the tree, and lists what differs', async () => {
    const path = repository({ 'README.md': 'vault\n' })
    const tree = commitEmptyFolder(path)
    const server = await serve(storeOnce)
    try {
      const result = await publish(path, server.endpoint)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(`source export does not reproduce Git tree ${tree}`)
      expect(result.stderr).toContain('missing from the export: empty/')
      expect(result.stderr).toContain('Nothing was uploaded')
      expect(server.uploads).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  it('checks each submodule export against its own tree as well', async () => {
    const dependency = repository({ 'README.md': 'dependency\n' })
    const tree = commitEmptyFolder(dependency)
    const path = repository({ 'README.md': 'vault\n' })
    git(path, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', dependency, 'lib/dependency'])
    git(path, ['commit', '--quiet', '-m', 'dependency'])
    const server = await serve(storeOnce)
    try {
      const result = await publish(path, server.endpoint)
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain(`source export of submodule lib/dependency does not reproduce Git tree ${tree}`)
      expect(server.uploads).toHaveLength(0)
    } finally {
      await server.close()
    }
  })

  // A4: the manifest name is reserved; the tool must never write through a planted link.
  it.each(['.ack3-source-package.json', '.ACK3-Source-Package.JSON'])(
    'refuses a source whose root has an entry named %s, without touching its link target', async name => {
      const path = repository({ 'README.md': 'vault\n' })
      const victim = join(temporary('ack3-source-victim-'), 'authorized_keys')
      writeFileSync(victim, 'keep me\n')
      symlinkSync(victim, join(path, name))
      git(path, ['add', '--all'])
      git(path, ['commit', '--quiet', '-m', 'planted link'])
      const server = await serve(storeOnce)
      try {
        const result = await publish(path, server.endpoint)
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain('is reserved for the source package manifest')
        expect(readFileSync(victim, 'utf8')).toBe('keep me\n')
        expect(server.uploads).toHaveLength(0)
      } finally {
        await server.close()
      }
    })
})
