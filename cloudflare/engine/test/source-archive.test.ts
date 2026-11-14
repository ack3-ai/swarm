import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error The operator tool is intentionally plain Node.js.
import { commitZipSource, sourceEntries } from '../tools/source-archive.mjs'

const roots: string[] = []
const temporary = (prefix: string) => { const path = mkdtempSync(join(tmpdir(), prefix)); roots.push(path); return path }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_AUTHOR_DATE: '2026-09-23T00:00:00Z', GIT_COMMITTER_DATE: '2026-09-23T00:00:00Z' } })
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
  return result.stdout.trim()
}

interface Entry { name: string, data?: string | Buffer, mode?: number, method?: number, flags?: number, crc?: number }

/** A minimal ZIP writer for hostile and ZIP64 archives that common tools refuse to create. */
function zip(entries: readonly Entry[], zip64 = false): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8'), data = Buffer.from(entry.data ?? '')
    const method = entry.method ?? 8, stored = method === 8 ? deflateRawSync(data) : data
    const crc = entry.crc ?? (crc32(data) >>> 0), flags = (entry.flags ?? 0) | 0x800
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(zip64 ? 45 : 20, 4); local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(zip64 ? 0xffffffff : stored.length, 18); local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0)
    if (zip64) {
      extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(stored.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20)
    }
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 45, 4); central.writeUInt16LE(zip64 ? 45 : 20, 6)
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(zip64 ? 0xffffffff : stored.length, 20); central.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38)
    central.writeUInt32LE(zip64 ? 0xffffffff : offset, 42)
    locals.push(local, name, stored)
    centrals.push(central, name, extra)
    offset += local.length + name.length + stored.length
  }
  const directory = Buffer.concat(centrals), tail: Buffer[] = []
  if (zip64) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14)
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32)
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16)
    tail.push(record, locator)
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10)
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16)
  return Buffer.concat([...locals, directory, ...tail, end])
}

async function commit(archive: Buffer) {
  const directory = temporary('ack3-zip-test-')
  writeFileSync(join(directory, 'source.zip'), archive)
  const gitDirectory = join(directory, 'repository.git')
  return { ...await commitZipSource(join(directory, 'source.zip'), gitDirectory), gitDirectory }
}

function sourceRepository() {
  const repository = temporary('ack3-zip-origin-')
  git(repository, ['init', '--quiet'])
  git(repository, ['config', 'user.name', 'ACK3 Test'])
  git(repository, ['config', 'user.email', 'test@invalid'])
  git(repository, ['config', 'core.autocrlf', 'false'])
  mkdirSync(join(repository, 'src', 'nested dir'), { recursive: true })
  mkdirSync(join(repository, 'scripts'))
  writeFileSync(join(repository, 'README.md'), 'Vault\n')
  writeFileSync(join(repository, 'src', 'Vault.sol'), 'contract Vault {}\n')
  writeFileSync(join(repository, 'src', 'nested dir', 'ü "quoted".txt'), 'unicode name\n')
  writeFileSync(join(repository, '.gitattributes'), '* text=auto\n')
  writeFileSync(join(repository, 'data.bin'), Buffer.from([0, 1, 2, 255]))
  writeFileSync(join(repository, 'scripts', 'run.sh'), '#!/bin/sh\necho run\n')
  chmodSync(join(repository, 'scripts', 'run.sh'), 0o755)
  symlinkSync('../README.md', join(repository, 'src', 'README.md'))
  git(repository, ['-c', 'core.autocrlf=false', 'add', '--all'])
  git(repository, ['commit', '--quiet', '-m', 'fixture'])
  return repository
}

describe('ZIP source packaging', () => {
  it('reproduces the exact Git tree of a zipped repository, with or without a top-level folder', async () => {
    const repository = sourceRepository()
    const tree = git(repository, ['rev-parse', 'HEAD^{tree}'])
    for (const prefix of ['vault-main/', '']) {
      const output = join(temporary('ack3-zip-out-'), 'source.zip')
      git(repository, ['archive', '--format=zip', `--prefix=${prefix}`, '-o', output, 'HEAD'])
      const first = await commit(readFileSync(output))
      const second = await commit(readFileSync(output))
      expect(first.tree).toBe(tree)
      expect(first.files).toBe(7)
      expect(first.strippedFolder).toBe(prefix === '' ? null : 'vault-main')
      expect(second.commit).toBe(first.commit)
    }
  })

  it('reads stored, deflated and ZIP64 entries and keeps symlinks and executable bits', async () => {
    const entries: Entry[] = [
      { name: 'a.txt', data: 'stored', method: 0 },
      { name: 'bin/tool', data: '#!/bin/sh\n', mode: 0o100755 },
      { name: 'link', data: '/etc/passwd', mode: 0o120777 },
    ]
    for (const archive of [zip(entries), zip(entries, true)]) {
      const result = await commit(archive)
      expect(git(tmpdir(), ['--git-dir', result.gitDirectory, 'ls-tree', '-r', '--format=%(objectmode) %(path)', result.commit]).split('\n'))
        .toEqual(['100644 a.txt', '100755 bin/tool', '120000 link'])
      expect(git(tmpdir(), ['--git-dir', result.gitDirectory, 'cat-file', 'blob', `${result.commit}:link`])).toBe('/etc/passwd')
    }
    const { files } = sourceEntries(zip(entries, true))
    expect(files.map((file: any) => [file.path, file.symlink, file.executable])).toEqual([
      ['a.txt', false, false], ['bin/tool', false, true], ['link', true, false]])
  })

  it('commits file bytes exactly, without running Git attributes or filters', async () => {
    const result = await commit(zip([
      { name: '.gitattributes', data: '* text=auto eol=lf\n*.txt filter=missing\n' },
      { name: 'crlf.txt', data: 'a\r\nb\r\n' },
    ]))
    const blob = spawnSync('git', ['--git-dir', result.gitDirectory, 'cat-file', 'blob', `${result.commit}:crlf.txt`], { encoding: 'utf8' })
    expect(blob.stdout).toBe('a\r\nb\r\n')
  })

  it.each([
    [[{ name: '../evil', data: 'x' }], 'unsafe path'],
    [[{ name: 'a/../../evil', data: 'x' }], 'unsafe path'],
    [[{ name: '/etc/passwd', data: 'x' }], 'absolute path'],
    [[{ name: 'C:/evil', data: 'x' }], 'absolute path'],
    [[{ name: 'a\\b', data: 'x' }], 'unsupported character'],
    [[{ name: 'a\nb', data: 'x' }], 'unsupported character'],
    [[{ name: 'repo/.git/config', data: 'x' }], 'Git metadata'],
    [[{ name: 'a', data: 'x' }, { name: 'a', data: 'y' }], 'duplicate path'],
    [[{ name: 'Readme', data: 'x' }, { name: 'README', data: 'y' }], 'duplicate path'],
    [[{ name: 'Link', data: '/tmp', mode: 0o120777 }, { name: 'link/x', data: 'y' }], 'both a file and a folder'],
    [[{ name: 'x', data: 'x' }, { name: 'x/y', data: 'y' }], 'both a file and a folder'],
    [[{ name: 'secret', data: 'x', flags: 1 }], 'encrypted entry'],
    [[{ name: 'packed', data: 'x', method: 12 }], 'unsupported compression'],
    [[{ name: 'damaged', data: 'x', crc: 1 }], 'checksum mismatch'],
    [[{ name: 'only/' }], 'no files'],
    [[{ name: '__MACOSX/._a', data: 'x' }, { name: '.DS_Store', data: 'x' }], 'no files'],
    [[{ name: '.ack3-source-package.json', data: '/home/operator/.ssh/authorized_keys', mode: 0o120777 }], 'reserved for the source package manifest'],
    [[{ name: 'proj/.ACK3-Source-Package.JSON', data: 'x' }, { name: 'proj/a', data: 'y' }], 'reserved for the source package manifest'],
    [[{ name: '.ack3-source-package.json/x', data: 'x' }, { name: 'README.md', data: 'y' }], 'reserved for the source package manifest'],
  ] as const)('refuses an unsafe or damaged archive (%#)', async (entries, message) => {
    await expect(commit(zip(entries))).rejects.toThrow(message)
  })

  it('drops macOS metadata before it removes the single top-level folder (E20)', () => {
    const result = sourceEntries(zip([
      { name: 'proj/' }, { name: 'proj/README.md', data: 'vault\n' }, { name: 'proj/src/Vault.sol', data: 'contract Vault {}\n' },
      { name: 'proj/.DS_Store', data: 'x' }, { name: 'proj/src/.DS_Store', data: 'x' },
      { name: '__MACOSX/' }, { name: '__MACOSX/proj/' }, { name: '__MACOSX/proj/._README.md', data: 'x' },
      { name: '__MACOSX/proj/src/._Vault.sol', data: 'x' },
    ]))
    expect(result.files.map((file: any) => file.path)).toEqual(['README.md', 'src/Vault.sol'])
    expect(result.strippedFolder).toBe('proj')
    expect(result.dropped).toBe(4)
    expect(result.topLevel).toEqual(['README.md', 'src/'])
    const unwrapped = sourceEntries(zip([{ name: 'a.txt', data: 'a' }, { name: 'lib/b.txt', data: 'b' }]))
    expect([unwrapped.strippedFolder, unwrapped.dropped, unwrapped.topLevel]).toEqual([null, 0, ['a.txt', 'lib/']])
  })

  it('refuses data that is not a ZIP archive', async () => {
    await expect(commit(Buffer.from('plain text'))).rejects.toThrow('not a ZIP archive')
  })
})

describe('source publisher with a ZIP archive', () => {
  const publisher = new URL('../tools/publish-source.mjs', import.meta.url).pathname
  function publish(args: string[], endpoint: string) {
    return new Promise<{ code: number | null, stdout: string, stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [publisher, ...args], {
        env: { ...process.env, ACK3_ENGINE_URL: endpoint, CONTROL_API_TOKEN: 'test-token' }, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      child.stdout.on('data', chunk => stdout.push(chunk))
      child.stderr.on('data', chunk => stderr.push(chunk))
      child.on('error', reject)
      child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))
    })
  }

  it('uploads the packaged commit and prints the commit and tree for the manifest', async () => {
    const repository = sourceRepository()
    const output = join(temporary('ack3-zip-publish-'), 'Vault.ZIP')
    git(repository, ['archive', '--format=zip', '--prefix=vault/', '-o', output, 'HEAD'])
    const uploads: Array<{ url: string, commit: string }> = []
    const server = createServer((request, response) => {
      request.resume()
      request.on('end', () => {
        uploads.push({ url: request.url!, commit: String(request.headers['x-ack3-git-commit']) })
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ stored: true }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
      const endpoint = `http://127.0.0.1:${address.port}`
      const result = await publish([output], endpoint)
      expect(result.code, result.stderr).toBe(0)
      const printed = JSON.parse(result.stdout)
      expect(printed.tree).toBe(git(repository, ['rev-parse', 'HEAD^{tree}']))
      expect(uploads).toEqual([{ url: `/v1/sources/${printed.tree}`, commit: printed.commit }])
      expect(result.stderr).toContain('without its top-level folder vault/')
      expect(result.stderr).toContain('Top level: .gitattributes, README.md, data.bin, scripts/, src/.')
      expect(result.stderr).not.toContain('macOS metadata')
      const withRef = await publish([output, 'HEAD'], endpoint)
      expect(withRef.code).not.toBe(0)
      expect(withRef.stderr).toContain('a ZIP source takes no REF')
      const mac = join(temporary('ack3-zip-publish-'), 'mac.zip')
      writeFileSync(mac, zip([{ name: 'proj/README.md', data: 'vault\n' }, { name: 'proj/.DS_Store', data: 'x' },
        { name: '__MACOSX/proj/._README.md', data: 'x' }]))
      const fromMac = await publish([mac], endpoint)
      expect(fromMac.code, fromMac.stderr).toBe(0)
      expect(fromMac.stderr).toContain('without its top-level folder proj/; dropped 2 macOS metadata files')
      expect(fromMac.stderr).toContain('Top level: README.md.')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
