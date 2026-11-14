import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, lstat, mkdtemp, mkdir, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAgentOutputFiles, OUTPUT_READ_MAX_BYTES, prepareOutputFolders, redactOutputCredentials } from '../container/output-files.mjs'
import { redactionCredentials } from '../container/agent-log-writer.mjs'

// The test's own files stand for the agent's: in the container the agent user is 10001.
const agentUid = process.getuid()

test('runner collects output only from its results directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    const source = join(root, 'source')
    const results = join(root, 'results')
    const path = '.swarm/submission.json'
    await mkdir(join(source, '.swarm'), { recursive: true })
    await mkdir(join(results, '.swarm'), { recursive: true })
    const content = JSON.stringify({ complete: true })
    await writeFile(join(source, path), content)
    assert.deepEqual(await collectAgentOutputFiles([path], results, { agentUid }), {})

    await writeFile(join(results, path), content)
    assert.deepEqual(await collectAgentOutputFiles([path], results, { agentUid }), { [path]: content })

  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner never follows a symlink out of the results directory, and never blocks on a FIFO', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    const results = join(root, 'results')
    await mkdir(join(results, 'waves'), { recursive: true })
    await mkdir(join(root, 'secret'))
    await writeFile(join(root, 'secret', 'token.txt'), 'root-only value')
    await symlink(join(root, 'secret', 'token.txt'), join(results, 'report.md'))
    await symlink(join(root, 'secret'), join(results, 'linked'))
    execFileSync('mkfifo', [join(results, 'pipe.md')])
    await writeFile(join(results, 'waves', 'ok.md'), 'kept')
    assert.deepEqual(await collectAgentOutputFiles(['report.md', 'linked/token.txt', 'pipe.md', 'waves', 'waves/ok.md'], results,
      { agentUid }), { 'waves/ok.md': 'kept' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner reads an output only when the agent user owns it and no other name links to it (T5)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    const results = join(root, 'results')
    await mkdir(join(results, 'waves'), { recursive: true })
    await mkdir(join(root, 'private'))
    await writeFile(join(root, 'private', 'token.txt'), 'root-only value')
    // With fs.protected_hardlinks = 0 the agent can hard-link a root-only file to a declared output.
    await link(join(root, 'private', 'token.txt'), join(results, 'report.md'))
    await writeFile(join(results, 'waves', 'ok.md'), 'kept')
    assert.deepEqual(await collectAgentOutputFiles(['report.md', 'waves/ok.md'], results, { agentUid }), { 'waves/ok.md': 'kept' })
    // A file another user owns is never read either.
    assert.deepEqual(await collectAgentOutputFiles(['waves/ok.md'], results, { agentUid: agentUid + 1 }), {})
    // The default owner is the agent user.
    assert.deepEqual(await collectAgentOutputFiles(['waves/ok.md'], results), agentUid === 10001 ? { 'waves/ok.md': 'kept' } : {})
    // Once the other name is gone the file is the agent's own again.
    await rm(join(root, 'private', 'token.txt'))
    assert.deepEqual(await collectAgentOutputFiles(['report.md'], results, { agentUid }), { 'report.md': 'root-only value' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner reads an oversized output only up to its cap, so the Worker still reports it as too large', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    await writeFile(join(root, 'big.md'), Buffer.alloc(OUTPUT_READ_MAX_BYTES + 1024, 97))
    const { 'big.md': content } = await collectAgentOutputFiles(['big.md'], root, { agentUid })
    assert.equal(content.length, OUTPUT_READ_MAX_BYTES + 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner creates output folders and gives the deepest one to the agent, never through a symlink (T1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    await mkdir(join(root, 'results', 'waves'), { recursive: true })
    await mkdir(join(root, 'outside'))
    const results = await realpath(join(root, 'results'))
    const outside = await realpath(join(root, 'outside'))
    const owned = []
    const chown = async (_handle, path) => { owned.push(path) }
    // The agent planted waves/wave-0 -> outside in an earlier turn.
    await symlink(outside, join(results, 'waves', 'wave-0'))
    await assert.rejects(prepareOutputFolders(['waves/wave-0/lane-1/research.md'], { root: results, chown }),
      /output folder waves\/wave-0 is a symbolic link/)
    // The deepest folder itself is a link.
    await symlink(outside, join(results, '.swarm'))
    await assert.rejects(prepareOutputFolders(['.swarm/submission.json'], { root: results, chown }),
      /output folder \.swarm is a symbolic link/)
    // A file where a folder must be.
    await writeFile(join(results, 'file'), 'x')
    await assert.rejects(prepareOutputFolders(['file/report.md'], { root: results, chown }), /output folder file is not a folder/)
    assert.deepEqual(owned, [])
    assert.deepEqual(await readdir(outside), [])

    // Normal paths: every missing folder is created, only the deepest is handed over, once each.
    await rm(join(results, '.swarm'))
    await prepareOutputFolders(['waves/wave-1/lane-2/research.md', 'waves/wave-1/lane-2/notes.md', '.swarm/submission.json',
      'top.md'], { root: results, chown })
    assert.deepEqual(owned, [`${results}/waves/wave-1/lane-2`, `${results}/.swarm`, results])
    assert.ok((await lstat(join(results, 'waves', 'wave-1', 'lane-2'))).isDirectory())
    // The real descriptor chown, to the test user (a non-root user may chown to itself).
    await prepareOutputFolders(['waves/wave-2/report.md'], { root: results, uid: process.getuid(), gid: process.getgid() })
    assert.equal((await stat(join(results, 'waves', 'wave-2'))).uid, process.getuid())
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runner refuses an output folder swapped for a symlink while it is prepared (T1)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    await mkdir(join(root, 'results', 'waves', 'wave-0'), { recursive: true })
    await mkdir(join(root, 'outside', 'lane-1'), { recursive: true })
    const results = await realpath(join(root, 'results'))
    const outside = await realpath(join(root, 'outside'))
    const owned = []
    // A background agent process swaps wave-0 for a link right after the last check.
    const racing = async path => {
      const value = await lstat(path)
      if (path === `${results}/waves/wave-0/lane-1`) {
        await rename(join(results, 'waves', 'wave-0'), join(results, 'waves', 'moved'))
        await symlink(outside, join(results, 'waves', 'wave-0'))
      }
      return value
    }
    await assert.rejects(prepareOutputFolders(['waves/wave-0/lane-1/research.md'],
      { root: results, chown: async (_handle, path) => { owned.push(path) }, lstat: racing }), /output folder waves\/wave-0\/lane-1 moved/)
    assert.deepEqual(owned, [])
    assert.deepEqual(await readdir(join(outside, 'lane-1')), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('collected outputs never carry a credential value: each is replaced as in the log and reported by file and name (T3)', () => {
  const credentials = redactionCredentials({ GH_TOKEN: 'ghp_synthetic_token_value', EXA_API_KEY: 'synthetic-exa-key',
    LONG_SECRET: 'synthetic-exa-key-with-suffix', SHORT_KEY: 'short', HARMLESS: 'synthetic-harmless-value' })
  const document = 'key synthetic-exa-key-with-suffix, synthetic-exa-key and ghp_synthetic_token_value twice ghp_synthetic_token_value'
  const submission = '{"complete":true,"note":"synthetic-harmless-value short"}'
  const scanned = redactOutputCredentials({ 'waves/wave-0/research-1.md': document, '.swarm/submission.json': submission }, credentials)
  assert.deepEqual(scanned, {
    files: {
      'waves/wave-0/research-1.md': 'key <redacted:LONG_SECRET>, <redacted:EXA_API_KEY> and <redacted:GH_TOKEN> twice <redacted:GH_TOKEN>',
      '.swarm/submission.json': submission,
    },
    hits: [{ path: 'waves/wave-0/research-1.md', name: 'LONG_SECRET' }, { path: 'waves/wave-0/research-1.md', name: 'GH_TOKEN' },
      { path: 'waves/wave-0/research-1.md', name: 'EXA_API_KEY' }],
  })
  for (const value of ['ghp_synthetic_token_value', 'synthetic-exa-key']) assert.ok(!JSON.stringify(scanned).includes(value))
  assert.deepEqual(redactOutputCredentials({ 'a.md': 'clean' }, credentials), { files: { 'a.md': 'clean' }, hits: [] })
})

test('the runner scans outputs right after it collects them, before the submit check and the scratch bundle, and reports hits (T3)', async () => {
  const runner = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
  const listAt = runner.indexOf('const credentials = redactionCredentials(')
  const scanAt = runner.indexOf('const { files, hits: outputCredentials } = redactOutputCredentials(await collectAgentOutputFiles(request.expectedFiles), credentials)')
  assert.ok(listAt > -1 && scanAt > listAt)
  assert.ok(runner.indexOf('runnerSubmitCheck(files, request.taskId)') > scanAt)
  assert.ok(runner.indexOf('scratchEvidenceBundle(scratchCapture') > scanAt)
  assert.equal(runner.split('collectAgentOutputFiles(').length, 2)
  // Only an attempt with a hit carries the field, so every other result is unchanged.
  assert.match(runner, /\n {2}\.\.\.\(outputCredentials\.length === 0 \? \{\} : \{ outputCredentials \}\),\n/)
})
