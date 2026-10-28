import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const engine = fileURLToPath(new URL('..', import.meta.url))
test('compiled release CLI exports a sealed release with its shared runtime modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-release-export-'))
  try {
    const build = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.release.json', '--outDir', dir],
      { cwd: engine, encoding: 'utf8' })
    assert.equal(build.status, 0, build.stdout + build.stderr)
    await writeFile(join(dir, 'package.json'), '{"type":"module"}')
    await symlink(join(engine, 'node_modules'), join(dir, 'node_modules'), 'dir')
    const output = join(dir, 'sealed.json')
    const exported = spawnSync(process.execPath, [join(dir, 'tools/export-release.js'),
      resolve(engine, '../../docs/examples/audit.json'), output], { encoding: 'utf8' })
    assert.equal(exported.status, 0, exported.stdout + exported.stderr)
    const sealed = JSON.parse(await readFile(output, 'utf8'))
    assert.match(sealed.digest, /^[0-9a-f]{64}$/)
    assert.ok(sealed.body.definition.stages.length > 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
