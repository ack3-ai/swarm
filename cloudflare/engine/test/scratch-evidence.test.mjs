import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readScratchRetained, scratchEvidenceBundle, validateScratchCapture } from '../container/scratch-evidence.mjs'
import { mountPocTests } from '../container/mount-tests.mjs'

const directory = '/workspace/source/test/swarm/lane-1'
const limits = { maxFileBytes: 64, maxTaskBytes: 100, maxFiles: 3 }
const capture = { directory, bundlePath: 'waves/wave-2/research-1.tests.json', limits }
const digest = text => createHash('sha256').update(text).digest('hex')
// The test's own files stand for the agent's: in the container the agent user is 10001.
const agentUid = process.getuid()

async function lane(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-scratch-')))
  try {
    const base = join(root, directory)
    await mkdir(base, { recursive: true })
    await callback(root, base)
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('the runner keeps only new, safe text files from the lane scratch path', async () => {
  await lane(async (root, base) => {
    await mkdir(join(base, 'sub'), { recursive: true })
    await mkdir(join(base, 'out'), { recursive: true })
    await mkdir(join(base, 'typechain-types'), { recursive: true })
    await writeFile(join(base, 'A.t.sol'), '// OBS A1\ncontract A {}\n')
    await writeFile(join(base, 'sub', 'B.t.sol'), '// OBS A2\n')
    await writeFile(join(base, 'out', 'A.json'), '{}')
    await writeFile(join(base, 'typechain-types', 'x.ts'), 'x')
    await writeFile(join(base, 'blob.bin'), Buffer.from([1, 0, 2]))
    await writeFile(join(base, 'latin.txt'), Buffer.from([0xff, 0xfe]))
    await writeFile(join(base, 'bell.txt'), 'ring\u0007')
    await writeFile(join(base, 'bad name.txt'), 'space')
    await writeFile(join(base, '.env'), 'PRIVATE_KEY=1')
    await writeFile(join(base, 'leak.txt'), 'token: synthetic-secret-value')
    await writeFile(join(base, 'big.txt'), 'x'.repeat(65))
    await writeFile(join(root, 'outside.txt'), 'outside')
    await symlink(join(root, 'outside.txt'), join(base, 'link.txt'))
    const bundle = await scratchEvidenceBundle(capture, { root, agentUid, credentials: ['synthetic-secret-value', 'short'] })
    assert.equal(bundle, await scratchEvidenceBundle(capture, { root, agentUid, credentials: ['synthetic-secret-value'] }))
    const parsed = JSON.parse(bundle)
    assert.deepEqual(Object.keys(parsed), ['directory', 'files', 'omitted', 'schemaVersion'])
    assert.equal(parsed.directory, directory)
    assert.deepEqual(parsed.files.map(file => file.path), ['A.t.sol', 'sub/B.t.sol'])
    assert.deepEqual(parsed.files[0], { bytes: 24, content: '// OBS A1\ncontract A {}\n',
      path: 'A.t.sol', sha256: digest('// OBS A1\ncontract A {}\n') })
    assert.deepEqual(parsed.omitted.map(file => [file.path, file.reason]), [
      ['.env', 'credential'], ['bad name.txt', 'path'], ['bell.txt', 'binary'], ['big.txt', 'file-size'],
      ['blob.bin', 'binary'], ['latin.txt', 'binary'], ['leak.txt', 'credential'], ['link.txt', 'symlink'],
      ['out', 'build-folder'], ['typechain-types', 'build-folder'],
    ])
    assert.ok(!bundle.includes('synthetic-secret-value') && !bundle.includes('outside'))
  })
})

test('the runner keeps a lane file only when the agent user owns it and no other name links to it (T5)', async () => {
  await lane(async (root, base) => {
    await writeFile(join(base, 'own.t.sol'), '// OBS A1\n')
    // With fs.protected_hardlinks = 0 the agent can hard-link a root-only file into its lane.
    await mkdir(join(root, 'private'))
    await writeFile(join(root, 'private', 'secret.txt'), 'root-only value')
    await link(join(root, 'private', 'secret.txt'), join(base, 'linked.txt'))
    const parsed = JSON.parse(await scratchEvidenceBundle(capture, { root, agentUid }))
    assert.deepEqual(parsed.files.map(file => file.path), ['own.t.sol'])
    // Refused like a symlink: listed with an existing reason, so the Worker's bundle check is unchanged.
    assert.deepEqual(parsed.omitted, [{ bytes: 0, path: 'linked.txt', reason: 'not-regular' }])
    // A file another user owns is never read either.
    const foreign = JSON.parse(await scratchEvidenceBundle(capture, { root, agentUid: agentUid + 1 }))
    assert.deepEqual(foreign.files, [])
    assert.deepEqual(foreign.omitted.map(file => [file.path, file.reason]), [['linked.txt', 'not-regular'], ['own.t.sol', 'not-regular']])
    // The default owner is the agent user.
    assert.equal(JSON.parse(await scratchEvidenceBundle(capture, { root })).files.length, agentUid === 10001 ? 1 : 0)
  })
})

test('the runner enforces the file and task limits in path order', async () => {
  await lane(async (root, base) => {
    for (const name of ['a', 'b', 'c', 'd']) await writeFile(join(base, `${name}.txt`), name.repeat(40))
    const parsed = JSON.parse(await scratchEvidenceBundle(capture, { root, agentUid }))
    assert.deepEqual(parsed.files.map(file => file.path), ['a.txt', 'b.txt'])
    assert.deepEqual(parsed.omitted.map(file => [file.path, file.reason]), [['c.txt', 'task-limit'], ['d.txt', 'task-limit']])
    const counted = JSON.parse(await scratchEvidenceBundle({ ...capture, limits: { ...limits, maxTaskBytes: 1_000 } }, { root, agentUid }))
    assert.deepEqual(counted.files.map(file => file.path), ['a.txt', 'b.txt', 'c.txt'])
    assert.deepEqual(counted.omitted, [{ bytes: 40, path: 'd.txt', reason: 'file-limit' }])
  })
})

test('the runner adds only files that earlier accepted bundles from the lane do not keep', async () => {
  await lane(async (root, base) => {
    await writeFile(join(base, 'kept.t.sol'), 'kept')
    await writeFile(join(base, 'changed.t.sol'), 'changed')
    const retainedPath = join(root, 'retained.json')
    assert.deepEqual(await readScratchRetained(directory, retainedPath), [])
    await writeFile(retainedPath, JSON.stringify({ schemaVersion: 1, directory, files: [
      { path: 'kept.t.sol', sha256: digest('kept') }, { path: 'changed.t.sol', sha256: digest('before') },
    ] }))
    const retained = await readScratchRetained(directory, retainedPath)
    const parsed = JSON.parse(await scratchEvidenceBundle(capture, { root, agentUid, retained }))
    assert.deepEqual(parsed.files.map(file => file.path), ['changed.t.sol'])
    await assert.rejects(readScratchRetained('/workspace/source/test/swarm/lane-2', retainedPath), /invalid retained/)
    await writeFile(retainedPath, JSON.stringify({ schemaVersion: 1, directory, files: [{ path: '../x', sha256: digest('x') }] }))
    await assert.rejects(readScratchRetained(directory, retainedPath), /invalid retained/)
  })
})

test('the runner refuses a redirected lane and invalid capture contracts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-scratch-')))
  try {
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'secret.txt'), 'secret')
    await mkdir(join(root, '/workspace/source/test/swarm'), { recursive: true })
    await symlink(join(root, 'elsewhere'), join(root, directory))
    assert.deepEqual(JSON.parse(await scratchEvidenceBundle(capture, { root, agentUid })).files, [])
    assert.deepEqual(JSON.parse(await scratchEvidenceBundle({ ...capture, directory: '/workspace/source/test/swarm/lane-1' },
      { root: join(root, 'missing'), agentUid })).files, [])
  } finally { await rm(root, { recursive: true, force: true }) }
  for (const invalid of [
    { ...capture, directory: '/workspace/private' },
    { ...capture, directory: '/workspace/source/test/swarm/lane-1/..' },
    { ...capture, bundlePath: 'waves/wave-2/research-2.tests.json' },
    { ...capture, bundlePath: '../research-1.tests.json' },
    { ...capture, limits: { ...limits, maxFiles: 0 } },
    { ...capture, extra: true },
  ]) assert.throws(() => validateScratchCapture(invalid), /invalid scratch capture/)
})

async function bundles(root, tasks) {
  const folder = join(root, 'bundles')
  await mkdir(folder, { recursive: true })
  for (const { task, files } of tasks) {
    await writeFile(join(folder, task.bundle), JSON.stringify({ directory: `/workspace/source/test/swarm/lane-${task.lane}`,
      files: files.map(([path, content]) => ({ bytes: content.length, content, path, sha256: digest(content) })),
      omitted: [{ bytes: 3, path: 'x.bin', reason: 'binary' }], schemaVersion: 1 }))
  }
  await writeFile(join(folder, 'manifest.json'), JSON.stringify({ schemaVersion: 1, tasks: tasks.map(entry => entry.task) }))
  return { bundles: folder, output: join(root, 'tests'), index: join(root, 'tests-index.md') }
}

const task = (wave, lane = 1, pool = 'luna') => ({ bundle: `t-${pool}-${wave}-${lane}.json`, lane,
  observations: [`OBS-LUNA-W${wave}-R${lane}-A1`], pool, taskId: `core-wave-${wave}-research-${lane}`, wave })

test('the verifier extractor merges lanes in wave order and writes an index', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-pocs-')))
  try {
    const paths = await bundles(root, [
      { task: task(2), files: [['A.t.sol', 'wave two'], ['dir', 'file then folder']] },
      { task: task(0), files: [['A.t.sol', 'wave zero'], ['B.t.sol', 'only zero'], ['dir/C.t.sol', 'folder first']] },
      { task: task(1, 2, 'kimi'), files: [] },
    ])
    assert.deepEqual(await mountPocTests(paths), { tasks: 3, files: 3 })
    assert.equal(await readFile(join(paths.output, 'luna/lane-1/A.t.sol'), 'utf8'), 'wave two')
    assert.equal(await readFile(join(paths.output, 'luna/lane-1/B.t.sol'), 'utf8'), 'only zero')
    assert.equal(await readFile(join(paths.output, 'luna/lane-1/dir'), 'utf8'), 'file then folder')
    const index = await readFile(paths.index, 'utf8')
    assert.ok(index.indexOf('## kimi lane 2, wave 1') < index.indexOf('## luna lane 1, wave 0'))
    assert.ok(index.indexOf('## luna lane 1, wave 0') < index.indexOf('## luna lane 1, wave 2'))
    assert.match(index, /Observations: OBS-LUNA-W0-R1-A1\n/)
    assert.ok(index.includes(`- ${paths.output}/luna/lane-1/A.t.sol (replaced by wave 2)`))
    assert.ok(index.includes(`- ${paths.output}/luna/lane-1/dir/C.t.sol (replaced by wave 2)`))
    assert.ok(index.includes('- x.bin (binary, 3 bytes)'))
    await assert.rejects(mountPocTests(paths), /EEXIST/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the verifier extractor refuses traversal and malformed manifests', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-pocs-')))
  try {
    for (const files of [[['../escape.txt', 'x']], [['/etc/passwd', 'x']], [['a/../../escape', 'x']]]) {
      await rm(join(root, 'bundles'), { recursive: true, force: true })
      await assert.rejects(mountPocTests(await bundles(root, [{ task: task(0), files }])), /invalid PoC bundle/)
    }
    for (const invalid of [{ ...task(0), bundle: '../x.json' }, { ...task(0), pool: '../x' }, { ...task(0), lane: 0 }]) {
      await rm(join(root, 'bundles'), { recursive: true, force: true })
      await assert.rejects(mountPocTests(await bundles(root, [{ task: invalid, files: [] }])), /invalid PoC bundle manifest/)
    }
    await assert.rejects(readFile(join(root, 'escape.txt')))
  } finally { await rm(root, { recursive: true, force: true }) }
})
