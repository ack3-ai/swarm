import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const publisher = new URL('../tools/publish-source.mjs', import.meta.url).pathname

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '2026-09-23T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-09-23T00:00:00Z',
    },
  })
  expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
  return result.stdout.trim()
}

function publish(repository: string, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [publisher, repository, 'HEAD'], {
      env: { ...process.env, ACK3_ENGINE_URL: endpoint, CONTROL_API_TOKEN: 'test-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stderr: Buffer[] = []
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', code => code === 0
      ? resolve()
      : reject(new Error(Buffer.concat(stderr).toString('utf8'))))
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source publisher', () => {
  it('reuses identical archive bytes when the same commit is published later', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'ack3-source-publisher-'))
    roots.push(repository)
    git(repository, ['init', '--quiet'])
    git(repository, ['config', 'user.name', 'ACK3 Test'])
    git(repository, ['config', 'user.email', 'test@invalid'])
    writeFileSync(join(repository, 'README.md'), 'stable source\n')
    git(repository, ['add', 'README.md'])
    git(repository, ['commit', '--quiet', '-m', 'fixture'])

    let archiveSha256: string | null = null
    let uploads = 0
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk))
      request.on('end', () => {
        uploads += 1
        const body = Buffer.concat(chunks)
        const digest = createHash('sha256').update(body).digest('hex')
        const matchesHeader = request.headers['x-ack3-archive-sha256'] === digest
        const unchanged = archiveSha256 === null || archiveSha256 === digest
        if (archiveSha256 === null) archiveSha256 = digest
        response.writeHead(matchesHeader && unchanged ? (uploads === 1 ? 201 : 200) : 409, {
          'content-type': 'application/json',
        })
        response.end(JSON.stringify(matchesHeader && unchanged
          ? { archiveSha256: digest, stored: uploads === 1 }
          : { error: 'immutable source key already exists with different provenance' }))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('test server did not bind TCP')
      const endpoint = `http://127.0.0.1:${address.port}`
      await publish(repository, endpoint)
      await delay(1_100)
      await publish(repository, endpoint)
      expect(uploads).toBe(2)
      expect(archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
