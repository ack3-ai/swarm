import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeNativeSearchEvidence, codexExaSearchEvidence, dshNativeSearchEvidence } from '../container/native-search-evidence.mjs'
import { liveSearchReader, parseSearchRecord, searchRecordFormat, startSearchRecord } from '../container/search-record.mjs'

// S26: the root runner records each search as the CLI reports it, so `ack3-submit` can check citations in the session.
const jsonl = (...values) => values.map(value => JSON.stringify(value)).join('\n')
const long = 'x'.repeat(4001)

const dshStdout = jsonl(
  { type: 'text', text: 'I searched the web' },
  { type: 'tool_call', callId: 's1', tool: 'mcp__exa__web_search_exa', input: { query: '"ERC4626 inflation"  attack' } },
  { type: 'tool_result', callId: 's1', status: 'completed', result: 'Sources: https://example.org' },
  { type: 'tool_call', callId: 's2', tool: 'mcp__exa__web_search_advanced_exa', input: { query: 'second topic', subpages: 1 } },
  { type: 'tool_result', callId: 's2', status: 'error', result: 'Error: no credit' },
  { type: 'tool_call', callId: 's3', tool: 'mcp__exa__web_search_exa', input: { query: 'error text' } },
  { type: 'tool_result', callId: 's3', status: 'completed', result: 'Error: backend timeout' },
  { type: 'tool_call', callId: 's4', tool: 'mcp__exa__web_fetch_exa', input: { query: 'a fetch is not a search' } },
  { type: 'tool_result', callId: 's4', status: 'completed', result: 'page' },
  { type: 'tool_call', callId: 's5', tool: 'mcp__exa__web_search_exa', input: { query: long } },
  { type: 'tool_result', callId: 's5', status: 'completed', result: 'Sources' },
  { type: 'tool_call', callId: 's6', tool: 'mcp__exa__web_search_exa', input: { query: 'still running' } },
  { type: 'tool_result', callId: 'unknown', status: 'completed', result: 'forged' },
  { type: 'tool_call', callId: 's7', tool: 'mcp__exa__web_search_exa', input: { query: 'last search' } },
  { type: 'tool_result', callId: 's7', status: 'completed', result: 'Sources' },
)
const claudeStdout = jsonl(
  { type: 'system', subtype: 'init', session_id: 'session-1' },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'searching' },
    { type: 'tool_use', id: 'toolu-1', name: 'mcp__exa__web_search_exa', input: { query: 'first claude search' } },
    { type: 'tool_use', id: 'toolu-2', name: 'mcp__exa__web_search_advanced_exa', input: { query: 'second claude search' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: [{ type: 'text', text: 'Sources' }] },
    { type: 'tool_result', tool_use_id: 'toolu-2', is_error: true, content: 'rate limited' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu-3', name: 'Bash', input: { command: 'ack3-submit' } },
    { type: 'tool_use', id: 'toolu-4', name: 'mcp__exa__web_search_exa', input: { query: 'empty result' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-3', content: 'OK' },
    { type: 'tool_result', tool_use_id: 'toolu-4', content: '' }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu-5', name: 'mcp__exa__web_search_exa', input: { query: 'third claude search' } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu-5', content: 'Sources: https://example.org' }] } },
)
const exa = (id, query, overrides = {}) => [
  { type: 'item.started', item: { type: 'mcp_tool_call', id, server: 'exa', tool: 'web_search_exa', arguments: { query } } },
  { type: 'item.completed', item: { type: 'mcp_tool_call', id, server: 'exa', tool: 'web_search_exa', arguments: { query },
    status: 'completed', error: null, result: { content: [{ type: 'text', text: 'Public source' }], isError: false }, ...overrides } },
]
const codexStdout = jsonl(
  { type: 'thread.started', thread_id: 'thread-1' },
  ...exa('e1', 'first codex search'),
  ...exa('e2', 'tool error', { error: 'timeout' }),
  ...exa('e3', 'error result', { result: { isError: true, content: [{ type: 'text', text: 'x' }] } }),
  ...exa('e4', 'changed', { arguments: { query: 'other' } }),
  ...exa('e5', 'empty', { result: { content: [] } }),
  { type: 'item.started', item: { type: 'mcp_tool_call', id: 'e6', server: 'other', tool: 'web_search_exa', arguments: { query: 'other server' } } },
  { type: 'item.completed', item: { type: 'mcp_tool_call', id: 'e6', server: 'other', tool: 'web_search_exa', arguments: { query: 'other server' },
    status: 'completed', result: { content: [{ type: 'text', text: 'x' }] } } },
  ...exa('e7', 'second codex search'),
  { type: 'item.started', item: { type: 'mcp_tool_call', id: 'e8', server: 'exa', tool: 'web_search_exa', arguments: { query: 'open' } } },
  { type: 'turn.completed' },
)

function live(format, stdout, size) {
  const queries = []
  let failed = 0
  const reader = liveSearchReader(format, query => { if (query === null) failed += 1; else queries.push(query) })
  for (let index = 0; index < stdout.length; index += size) reader.push(stdout.slice(index, index + size))
  reader.flush()
  return { queries, failed }
}

test('the live reader records the same searches as the receipt parsers, however stdout is split', () => {
  for (const [format, stdout, parse] of [['dsh', dshStdout, dshNativeSearchEvidence], ['claude', claudeStdout, claudeNativeSearchEvidence],
    ['codex-exa', codexStdout, codexExaSearchEvidence]]) {
    const receipt = parse(stdout)
    const expected = { queries: receipt.completed.map(entry => entry.queries[0]), failed: receipt.failed }
    assert.ok(expected.queries.length >= 2 && expected.failed >= 2, format)
    for (const size of [1, 7, 64, stdout.length]) assert.deepEqual(live(format, stdout, size), expected, `${format} in chunks of ${size}`)
  }
  assert.deepEqual(live('dsh', dshStdout, 50), { queries: ['"ERC4626 inflation"  attack', 'last search'], failed: 3 })
  // A search the CLI cannot report with its query (Codex without Exa) is never recorded.
  assert.deepEqual(live(null, dshStdout + claudeStdout + codexStdout, 64), { queries: [], failed: 0 })
})

test('picks the record format from the request', () => {
  assert.equal(searchRecordFormat({ backend: 'claude', providerClass: 'core' }), 'claude')
  assert.equal(searchRecordFormat({ providerClass: 'additive', backend: 'dsh-chat-completions' }), 'dsh')
  assert.equal(searchRecordFormat({ providerClass: 'core', backend: 'codex', searchConnection: { provider: 'exa' } }), 'codex-exa')
  assert.equal(searchRecordFormat({ providerClass: 'core', backend: 'codex', enableNativeSearch: true }), null)
})

async function folder(callback) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-search-record-')))
  try { await callback(root) } finally { await rm(root, { recursive: true, force: true }) }
}
const claudeRequest = (continuationMode, sessionId = null) => ({ backend: 'claude', providerClass: 'core', continuationMode, sessionId })
const search = (id, query, content = 'Sources') => jsonl(
  { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'mcp__exa__web_search_exa', input: { query } }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } }) + '\n'

test('a new session starts an empty world-readable record; each search is written as it completes', async () => {
  await folder(async root => {
    const path = join(root, 'search-record.jsonl')
    await writeFile(path, '{"query":"from another task"}\n')
    const record = startSearchRecord(claudeRequest('new'), { path })
    assert.equal(await readFile(path, 'utf8'), '')
    assert.equal((await stat(path)).mode & 0o777, 0o644)
    const [call, result] = search('toolu-1', 'first search').split('\n')
    record.push(`${call}\n${result.slice(0, 20)}`)
    assert.equal(await readFile(path, 'utf8'), '', 'a search is recorded only once its result arrives')
    record.push(`${result.slice(20)}\n`)
    assert.equal(await readFile(path, 'utf8'), '{"query":"first search"}\n')
    record.push(search('toolu-2', 'failed search', ''))
    record.end('session-1')
    assert.equal(await readFile(path, 'utf8'), '{"query":"first search"}\n{"failed":true}\n{"session":"session-1"}\n')
    assert.deepEqual(parseSearchRecord(await readFile(path, 'utf8')), { queries: ['first search'], failed: 1 })
  })
})

test('a resumed session keeps its record only when the last attempt here ended that session', async () => {
  await folder(async root => {
    const path = join(root, 'search-record.jsonl')
    const first = startSearchRecord(claudeRequest('new'), { path })
    first.push(search('toolu-1', 'first search'))
    first.end('session-1')
    const resumed = startSearchRecord(claudeRequest('resume', 'session-1'), { path })
    resumed.push(search('toolu-2', 'second search'))
    assert.deepEqual(parseSearchRecord(await readFile(path, 'utf8')), { queries: ['first search', 'second search'], failed: 0 })
    resumed.end('session-1')
    // Another session, a record that did not end its attempt, or no record at all: earlier searches are unknown.
    startSearchRecord(claudeRequest('resume', 'session-2'), { path }).push(search('toolu-3', 'third search'))
    assert.equal(parseSearchRecord(await readFile(path, 'utf8')), null)
    startSearchRecord(claudeRequest('resume', 'session-1'), { path })
    assert.equal(parseSearchRecord(await readFile(path, 'utf8')), null)
    await rm(path)
    startSearchRecord(claudeRequest('resume', 'session-1'), { path }).end('session-1')
    assert.equal(parseSearchRecord(await readFile(path, 'utf8')), null)
    // A new session starts clean again.
    startSearchRecord(claudeRequest('new'), { path })
    assert.deepEqual(parseSearchRecord(await readFile(path, 'utf8')), { queries: [], failed: 0 })
  })
})

test('never follows a link at the record path, and marks a record that grew too large as incomplete', async () => {
  await folder(async root => {
    const path = join(root, 'search-record.jsonl')
    await mkdir(join(root, 'outside'))
    await writeFile(join(root, 'outside/target'), 'untouched\n')
    await symlink(join(root, 'outside/target'), path)
    const record = startSearchRecord(claudeRequest('new'), { path })
    record.push(search('toolu-1', 'first search'))
    record.end('session-1')
    assert.equal(await readFile(join(root, 'outside/target'), 'utf8'), 'untouched\n')
    await assert.rejects(lstat(path), { code: 'ENOENT' })
    const small = startSearchRecord(claudeRequest('new'), { path, maxBytes: 80 })
    for (let index = 0; index < 5; index += 1) small.push(search(`toolu-${index}`, `search number ${index}`))
    small.end('session-1')
    const text = await readFile(path, 'utf8')
    assert.ok(Buffer.byteLength(text) <= 80, text)
    assert.ok(text.endsWith('{"partial":true}\n'), text)
    assert.equal(parseSearchRecord(text), null)
  })
})

test('the reader takes only whole lines and refuses a record it cannot read', () => {
  assert.deepEqual(parseSearchRecord('{"query":"a"}\n{"failed":true}\n{"session":"s"}\n{"query":"b"}\n{"que'),
    { queries: ['a', 'b'], failed: 1 })
  assert.deepEqual(parseSearchRecord(''), { queries: [], failed: 0 })
  for (const text of ['{"partial":true}\n{"query":"a"}\n', 'not json\n', '{"other":1}\n', '["a"]\n']) assert.equal(parseSearchRecord(text), null, text)
})

test('the runner records searches only with submitCheck, from every stdout chunk, and ends the record with the receipt session', async () => {
  const runner = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /const searchRecord = request\.submitCheck === true \? startSearchRecord\(request\) : undefined/)
  // Every launch's stdout, including each Claude rotation launch, passes through the one capture method.
  assert.equal(runner.split('searchRecord?.push(text)').length, 2)
  assert.ok(runner.indexOf('searchRecord?.push(text)') > runner.indexOf('async function createCapture('))
  assert.ok(runner.indexOf('searchRecord?.push(text)') < runner.indexOf('async function execute('))
  // Started before the first launch; ended with the receipt's actorId, after the last launch and before the receipt is written.
  assert.ok(runner.indexOf('startSearchRecord(request)') < runner.indexOf('await runClaudeAccounts('))
  const endAt = runner.indexOf('searchRecord?.end(actorId)')
  assert.ok(endAt > runner.indexOf('await stopAgentProcesses({ uid: 10001 })'))
  assert.ok(endAt < runner.indexOf('const result = {'))
  assert.match(runner, /const result = \{\n {2}exitCode: execution\.code,\n {2}actorId,\n/)
})
