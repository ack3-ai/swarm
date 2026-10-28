import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const script = new URL('../container/prepare-source.sh', import.meta.url).pathname
const run = (command: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`).toBe(0)
  return String(result.stdout).trim()
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('source package v2', () => {
  it('materializes submodule contents while verifying their root Gitlink identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'ack3-source-package-'))
    roots.push(root)
    const staging = join(root, 'staging')
    const workspace = join(root, 'workspace')
    const privateDirectory = join(workspace, 'private')
    const gitDirectory = join(root, 'tree.git')
    const index = join(root, 'tree.index')
    mkdirSync(join(staging, 'lib/example'), { recursive: true })
    mkdirSync(privateDirectory, { recursive: true })
    writeFileSync(join(staging, 'README.md'), 'root\n')
    writeFileSync(join(staging, 'lib/example/dependency.sol'), 'dependency\n')
    run('git', ['init', '--bare', '--quiet', gitDirectory])
    const gitEnvironment = { ...process.env, GIT_DIR: gitDirectory, GIT_WORK_TREE: staging, GIT_INDEX_FILE: index }
    run('git', ['add', '--all', '--force'], { env: gitEnvironment })
    run('git', ['rm', '-r', '--cached', '-f', '--quiet', '--', 'lib/example'], { env: gitEnvironment })
    const submoduleCommit = 'c'.repeat(40)
    run('git', ['update-index', '--add', '--cacheinfo', '160000', submoduleCommit, 'lib/example'], { env: gitEnvironment })
    const tree = run('git', ['write-tree'], { env: gitEnvironment })
    const commit = 'a'.repeat(40)
    writeFileSync(join(staging, '.ack3-source-package.json'), `${JSON.stringify({
      schemaVersion: 2, commit, tree,
      gitlinks: [{ commit: submoduleCommit, path: 'lib/example' }],
    })}\n`)
    const tar = spawnSync('tar', ['-cf', '-', '-C', staging, '.'], { encoding: null })
    expect(tar.status).toBe(0)
    const compressed = spawnSync('zstd', ['-q', '-o', join(privateDirectory, 'source.tar.zst')], {
      input: tar.stdout, encoding: 'utf8',
    })
    expect(compressed.status, compressed.stderr).toBe(0)
    const prepared = spawnSync('/bin/sh', [script], {
      encoding: 'utf8',
      env: {
        ...process.env, ACK3_EXPECTED_COMMIT: commit, ACK3_EXPECTED_TREE: tree, ACK3_WORKSPACE_ROOT: workspace,
        ACK3_SOURCE_OWNER: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      },
    })
    expect(prepared.status, `${prepared.stderr}\n${prepared.stdout}`).toBe(0)
    expect(readFileSync(join(workspace, 'source/lib/example/dependency.sol'), 'utf8')).toBe('dependency\n')
    expect(readFileSync(join(privateDirectory, 'source-package.json'), 'utf8')).toContain(submoduleCommit)
  })
})
