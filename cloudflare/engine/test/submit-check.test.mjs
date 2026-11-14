import { test } from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doneMarker, formatSubmitCheck, runnerSubmitCheck, runSubmitCheck, sourceTree } from '../container/submit-check.mjs'
import { collectAgentOutputFiles } from '../container/output-files.mjs'

const taskId = 'core-wave-0-research-1'
const documentPath = 'waves/wave-0/research-1.md'
const context = {
  schemaVersion: 1, searchCheckedLater: true, visibleArtifacts: [],
  outputFiles: [documentPath, '.swarm/submission.json'],
  task: { id: taskId, providerClass: 'core', promptKind: 'research', modelPool: 'core',
    output: { schema: 'ack3.research-delta.policy-v3', requiredFiles: [documentPath, '.swarm/submission.json'], requiredSections: [] },
    research: { wave: 0, researcher: 1, role: 'baseline', buildsOn: 'none', laneScratchPath: '/workspace/source/test/swarm/lane-1' } },
}
const submission = evidence => JSON.stringify({ complete: true, materialHighCriticalDelta: false, nextExperiment: 'none', leadChecks: [],
  observations: [{ id: 'A1', statement: 'withdraw skips the share check', conditions: [], consequence: 'loss', evidence: [evidence] }] })

async function workspace(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-submit-')))
  // The test's own files stand for the agent's: in the container the agent user is 10001.
  const paths = { contextPath: join(root, 'control.json'), resultsRoot: join(root, 'results'), sourceRoot: join(root, 'source'),
    agentUid: process.getuid() }
  try {
    await mkdir(join(paths.resultsRoot, 'waves/wave-0'), { recursive: true })
    await mkdir(join(paths.resultsRoot, '.swarm'), { recursive: true })
    await mkdir(join(paths.sourceRoot, 'src'), { recursive: true })
    await writeFile(paths.contextPath, JSON.stringify(context))
    await writeFile(join(paths.sourceRoot, 'src/Vault.sol'), 'line\n'.repeat(19) + 'last line without newline')
    await writeFile(join(paths.resultsRoot, documentPath), '# Research\n\n## A1 Withdraw skips the share check\n')
    await writeFile(join(paths.resultsRoot, '.swarm/submission.json'), submission('src/Vault.sol:12-20'))
    await callback(root, paths)
  } finally { await rm(root, { recursive: true, force: true }) }
}
const collect = paths => collectAgentOutputFiles(context.outputFiles, paths.resultsRoot, { agentUid: paths.agentUid })
const marker = paths => join(paths.resultsRoot, '.swarm/done.json')

test('a passing check prints OK, writes the done marker, and the runner reports done', async () => {
  await workspace(async (_root, paths) => {
    const result = await runSubmitCheck(paths)
    assert.deepEqual(result, { issues: [], searchCheckedLater: true })
    assert.match(formatSubmitCheck(result), /^OK: submission accepted\nNote: search citations/)
    const files = await collect(paths)
    assert.equal(await readFile(marker(paths), 'utf8'), doneMarker(JSON.stringify(context), files))
    assert.deepEqual(await runnerSubmitCheck(files, taskId, paths), { done: true, issues: [] })
    assert.deepEqual((await runnerSubmitCheck(files, 'other-task', paths)).done, false)
  })
})

test('a failing check lists numbered problems and removes a stale marker', async () => {
  await workspace(async (_root, paths) => {
    await runSubmitCheck(paths)
    await writeFile(join(paths.resultsRoot, '.swarm/submission.json'), submission('src/Vault.sol:21'))
    const result = await runSubmitCheck(paths)
    assert.deepEqual(result.issues, ['observation A1 cites src/Vault.sol:21, but src/Vault.sol has only 20 lines; fix the line number'])
    assert.match(formatSubmitCheck(result), /^ack3-submit found 1 problem\. Fix each one:\n1\. observation A1 cites/)
    await assert.rejects(stat(marker(paths)), { code: 'ENOENT' })
    assert.deepEqual(await runnerSubmitCheck(await collect(paths), taskId, paths), { done: false, issues: result.issues })
  })
})

test('the runner reports not done when the files changed after the marker was written', async () => {
  await workspace(async (_root, paths) => {
    await runSubmitCheck(paths)
    await writeFile(join(paths.resultsRoot, documentPath), '# Research\n\nA1: withdraw skips the share check, see above.\n')
    assert.deepEqual(await runnerSubmitCheck(await collect(paths), taskId, paths), { done: false, issues: [] })
    await rm(paths.contextPath)
    const missing = await runnerSubmitCheck(await collect(paths), taskId, paths)
    assert.equal(missing.done, false)
    assert.match(missing.issues[0], /^ack3-submit could not run: this task has no submission check/)
  })
})

test('the runner never follows symlinks for the marker or the source tree', async () => {
  await workspace(async (root, paths) => {
    await runSubmitCheck(paths)
    const files = await collect(paths)
    // A marker reached through a symlink does not count.
    await writeFile(join(root, 'marker.json'), await readFile(marker(paths)))
    await rm(marker(paths))
    await symlink(join(root, 'marker.json'), marker(paths))
    assert.equal((await runnerSubmitCheck(files, taskId, paths)).done, false)
    // Source files and folders behind symlinks are never read, so their line numbers are not checked.
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside/Secret.sol'), 'one line\n')
    await symlink(join(root, 'outside/Secret.sol'), join(paths.sourceRoot, 'src/Link.sol'))
    await symlink(join(root, 'outside'), join(paths.sourceRoot, 'linked'))
    const source = sourceTree(paths.sourceRoot)
    assert.equal(await source.lineCount('src/Link.sol'), null)
    assert.equal(await source.lineCount('linked/Secret.sol'), null)
    assert.equal(await source.lineCount('src/Vault.sol'), 20)
    assert.equal(await source.lineCount('src/Gone.sol'), 'missing')
    assert.equal(await source.lineCount('../outside/Secret.sol'), null)
    assert.deepEqual(await source.named('Secret.sol'), [])
    assert.deepEqual(await source.named('Link.sol'), ['src/Link.sol'])
    // Only one name at the top of the tree is looked up, and a link there is never followed.
    assert.equal(await source.topLevel('src'), true)
    assert.equal(await source.topLevel('linked'), true)
    assert.equal(await source.topLevel('USDC'), false)
    for (const name of ['src/Vault.sol', '..', '.', '']) assert.equal(await source.topLevel(name), null)
  })
})

test('the runner counts only a done marker the agent user owns with no other link; source files and the root\'s search record keep their rules (T5)', async () => {
  await workspace(async (root, paths) => {
    await runSubmitCheck(paths)
    const files = await collect(paths)
    assert.deepEqual(await runnerSubmitCheck(files, taskId, paths), { done: true, issues: [] })
    // A marker owned by another user does not count; the checks themselves still run on the source tree.
    assert.deepEqual(await runnerSubmitCheck(files, taskId, { ...paths, agentUid: paths.agentUid + 1 }), { done: false, issues: [] })
    // A marker with a second name (a hard link) does not count either.
    await link(marker(paths), join(root, 'marker-copy.json'))
    assert.deepEqual(await runnerSubmitCheck(files, taskId, paths), { done: false, issues: [] })
    await rm(join(root, 'marker-copy.json'))
    assert.deepEqual(await runnerSubmitCheck(files, taskId, paths), { done: true, issues: [] })
    // Source files may be hard links (a pnpm store) and owned by anyone: their lines are still counted.
    await link(join(paths.sourceRoot, 'src/Vault.sol'), join(paths.sourceRoot, 'src/Linked.sol'))
    const source = sourceTree(paths.sourceRoot)
    assert.equal(await source.lineCount('src/Linked.sol'), 20)
    // The search record is root's file, not the agent's: an owner other than the agent user is read.
    const searchRecordPath = join(root, 'search-record.jsonl')
    await writeFile(paths.contextPath, JSON.stringify({ ...context, searchRequirement: 'leads' }))
    await writeFile(searchRecordPath, '{"failed":true}\n')
    const leadCheck = { observationId: 'A1', claimConditions: ['the share check is missing'], examinedConditions: ['the share check is missing'],
      remainingUntestedConditions: [], evidenceMethod: 'source-inspection', conclusion: 'refuted', evidence: 'the owner check guards withdraw' }
    const searched = { ...files, '.swarm/submission.json': JSON.stringify({ ...JSON.parse(submission('src/Vault.sol:12')), leadChecks: [leadCheck] }) }
    const none = await runSubmitCheck({ ...paths, agentUid: paths.agentUid + 1, files: searched, searchRecordPath })
    assert.match(none.issues[0], /^No web search has succeeded in this session yet/)
  })
})

test('a token pair or a fork with a number in evidence is not a file citation (E7)', async () => {
  await workspace(async (_root, paths) => {
    await writeFile(join(paths.resultsRoot, '.swarm/submission.json'),
      submission('src/Vault.sol:12 prices USDC/WETH:500 on anvil-fork/mainnet:18000000'))
    assert.deepEqual((await runSubmitCheck(paths)).issues, [])
    await writeFile(join(paths.resultsRoot, '.swarm/submission.json'), submission('src/Vault.sol:12 and src/Vault:12'))
    assert.match((await runSubmitCheck(paths)).issues[0], /cites src\/Vault:12, but no file src\/Vault exists/)
  })
})

test('ack3-submit checks search citations against the runner\'s record of this session (S26)', async () => {
  await workspace(async (root, paths) => {
    const searchRecordPath = join(root, 'search-record.jsonl')
    const options = { ...paths, searchRecordPath }
    await writeFile(paths.contextPath, JSON.stringify({ ...context, searchRequirement: 'leads' }))
    const leadCheck = researchQueries => ({ observationId: 'A1', claimConditions: ['the share check is missing'], examinedConditions: ['the share check is missing'],
      remainingUntestedConditions: [], evidenceMethod: 'source-inspection', conclusion: 'refuted', evidence: 'the owner check guards withdraw',
      ...(researchQueries === undefined ? {} : { researchQueries }) })
    const submit = async researchQueries => writeFile(join(paths.resultsRoot, '.swarm/submission.json'),
      JSON.stringify({ ...JSON.parse(submission('src/Vault.sol:12')), leadChecks: [leadCheck(researchQueries)] }))
    await submit(undefined)
    // No record (an older image): the check is left to the Worker, as before.
    assert.deepEqual(await runSubmitCheck(options), { issues: [], searchCheckedLater: true })
    // Search required, none succeeded: say so plainly, and keep the done marker away.
    await writeFile(searchRecordPath, '{"failed":true}\n')
    const none = await runSubmitCheck(options)
    assert.equal(none.searchCheckedLater, false)
    assert.match(none.issues[0], /^No web search has succeeded in this session yet/)
    assert.match(none.issues[1], /^A1: missing native search evidence: no successful native search queries recorded in this session/)
    const printed = formatSubmitCheck(none)
    assert.match(printed, /^ack3-submit found 2 problems\. Fix each one:\n1\. No web search has succeeded/)
    assert.doesNotMatch(printed, /checks them after you stop/)
    await assert.rejects(stat(marker(paths)), { code: 'ENOENT' })
    // The runner's final check leaves search to the Worker: not done, but no search issue of its own.
    assert.deepEqual(await runnerSubmitCheck(await collect(paths), taskId, options), { done: false, issues: [] })
    // A citation of a recorded search, retyped with other case, quotes and a full stop, passes.
    await writeFile(searchRecordPath, '{"query":"\\"ERC4626 share check\\"  bypass"}\n{"session":"s"}\n')
    await submit(['erc4626 share check bypass.'])
    assert.deepEqual(await runSubmitCheck(options), { issues: [], searchCheckedLater: false })
    assert.deepEqual(await runnerSubmitCheck(await collect(paths), taskId, options), { done: true, issues: [] })
    await submit(['another query'])
    assert.match((await runSubmitCheck(options)).issues[0], /^A1: native search citation mismatch/)
    // An incomplete record leaves the check to the Worker again.
    await writeFile(searchRecordPath, '{"partial":true}\n')
    assert.deepEqual(await runSubmitCheck(options), { issues: [], searchCheckedLater: true })
  })
})
