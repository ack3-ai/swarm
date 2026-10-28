import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { codexNativeSearchEvidence, dshNativeSearchAttempted, dshNativeSearchEvidence } from '../container/native-search-evidence.mjs'

const jsonl = (...values) => values.map(value => JSON.stringify(value)).join('\n')
const sessionId = 'fixture-session-1234'
const turnId = 'fixture-turn-1234'
const prompt = 'Search a generic public condition.'
const journal = (status, query = 'site:example.org generic condition') => jsonl(
  { type: 'session_meta', payload: { session_id: sessionId } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: prompt }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
  { type: 'response_item', payload: { type: 'web_search_call', id: 'exec-1', status,
    action: { type: 'search', query },
    internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
)
const batchQueries = ['site:example.org generic condition', 'site:example.net second condition']
const batchDisplay = 'generic condition across public sources'
const batchStdout = jsonl(
  { type: 'item.started', item: { type: 'web_search', id: 'exec-batch' } },
  { type: 'item.completed', item: { type: 'web_search', id: 'exec-batch', query: batchDisplay,
    action: { type: 'search', queries: batchQueries } } },
  { type: 'turn.completed' },
)
const batchJournal = (overrides = {}) => jsonl(
  { type: 'session_meta', payload: { session_id: overrides.sessionId ?? sessionId } },
  { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } },
  { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: overrides.prompt ?? prompt }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
  { type: 'event_msg', payload: { type: overrides.eventType ?? 'item_completed',
    thread_id: overrides.threadId ?? sessionId, turn_id: overrides.turnId ?? turnId,
    item: { type: 'Extension', kind: overrides.kind ?? 'web.search', id: overrides.id ?? 'exec-batch',
      status: overrides.status, query: overrides.display ?? batchDisplay,
      action: { type: overrides.actionType ?? 'search', queries: overrides.queries ?? batchQueries },
      results: overrides.results ?? [{ type: 'text_result', url: 'https://example.org/public' }] } } },
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } },
)

describe('native search evidence', () => {
  it('marks actual DSH search attempts for separate-cost uncertainty, including failed calls', () => {
    assert.equal(dshNativeSearchAttempted(jsonl({ type: 'text', text: 'web_search' })), false)
    assert.equal(dshNativeSearchAttempted(jsonl({ type: 'tool_call', tool: 'other' })), false)
    assert.equal(dshNativeSearchAttempted(jsonl({ type: 'tool_call', tool: 'web_search' })), false)
    assert.equal(dshNativeSearchAttempted(jsonl({ type: 'tool_call', tool: 'mcp__exa__web_fetch_exa' })), true)
    assert.equal(dshNativeSearchAttempted(jsonl({ type: 'tool_call', tool: 'mcp__exa__web_search_exa', input: {} })), true)
    assert.equal(dshNativeSearchAttempted(jsonl(
      { type: 'tool_call', tool: 'mcp__exa__web_search_exa', input: { query: 'public topic' } },
      { type: 'tool_result', status: 'error', result: 'Error: backend timeout' },
    )), true)
  })
  it('counts only a matching completed DSH tool call and result', () => {
    const proof = dshNativeSearchEvidence(jsonl(
      { type: 'tool_call', callId: 'search-1', tool: 'mcp__exa__web_search_exa', input: { query: 'generic path condition' } },
      { type: 'tool_result', callId: 'search-1', status: 'completed', result: 'Sources:\n- [Public](https://example.org/path)' },
    ))
    assert.equal(proof.source, 'dsh-json')
    assert.equal(proof.completed.length, 1)
    assert.match(proof.completed[0].queryDigest, /^[a-f0-9]{64}$/)
    assert.match(proof.completed[0].resultDigest, /^[a-f0-9]{64}$/)
    assert.equal(proof.failed, 0)
    assert.equal(proof.incomplete, 0)
  })

  it('rejects missing credentials, incomplete calls, and model-prose claims', () => {
    const proof = dshNativeSearchEvidence(jsonl(
      { type: 'text', text: 'I searched the web and found https://example.org' },
      { type: 'tool_call', callId: 'search-1', tool: 'mcp__exa__web_search_exa', input: { query: 'public topic' } },
      { type: 'tool_result', callId: 'search-1', status: 'error', result: 'Error: missing credential' },
      { type: 'tool_call', callId: 'search-2', tool: 'mcp__exa__web_search_exa', input: { query: 'other topic' } },
      { type: 'tool_result', callId: 'unknown', status: 'completed', result: 'Sources: forged' },
    ))
    assert.deepEqual(proof.completed, [])
    assert.equal(proof.failed, 1)
    assert.equal(proof.incomplete, 1)
  })

  it('requires a completed native Codex search action in a completed turn', () => {
    const stdout = jsonl(
      { type: 'turn.started' },
      { type: 'item.started', item: { type: 'web_search', id: 'exec-1', query: '', action: { type: 'other' } } },
      { type: 'item.completed', item: { type: 'web_search', id: 'exec-1',
        query: 'site:example.org generic condition', action: { type: 'search', query: 'site:example.org generic condition' } } },
      { type: 'turn.completed' },
    )
    const proof = codexNativeSearchEvidence(stdout, journal('completed'), prompt, sessionId)
    assert.equal(proof.completed.length, 1)
    assert.equal(proof.completed[0].callId, 'exec-1')
    assert.equal(proof.failed, 0)
    assert.equal(codexNativeSearchEvidence(stdout, journal('failed'), prompt, sessionId).completed.length, 0)
    assert.equal(codexNativeSearchEvidence(stdout, null, prompt, sessionId).completed.length, 0)
    assert.equal(codexNativeSearchEvidence(stdout, journal('completed'), 'different prompt', sessionId).completed.length, 0)
    assert.equal(codexNativeSearchEvidence(jsonl(
      { type: 'item.started', item: { type: 'web_search', id: 'exec-1' } },
      { type: 'item.completed', item: { type: 'web_search', id: 'exec-1',
        query: '', action: { type: 'other' } } },
      { type: 'turn.completed' },
    ), journal('completed'), prompt, sessionId).completed.length, 0)
    assert.equal(codexNativeSearchEvidence(jsonl(
      { type: 'item.started', item: { type: 'web_search', id: 'exec-1' } },
      { type: 'item.completed', item: { type: 'web_search', id: 'exec-1',
        query: 'query', action: { type: 'search', query: 'query' } } },
      { type: 'turn.failed' },
    ), journal('completed', 'query'), prompt, sessionId).completed.length, 0)
  })

  it('binds batch searches to native completed extension results in the exact session and turn', () => {
    const proof = codexNativeSearchEvidence(batchStdout, batchJournal(), prompt, sessionId)
    assert.equal(proof.completed.length, 1)
    assert.equal(proof.completed[0].callId, 'exec-batch')
    assert.equal(proof.failed, 0)
    for (const mismatch of [
      { sessionId: 'another-session-1234' },
      { prompt: 'Another prompt' },
      { turnId: 'another-turn-1234' },
      { threadId: 'another-session-1234' },
      { id: 'another-exec' },
      { queries: [...batchQueries].reverse() },
      { display: 'Another display query' },
      { eventType: 'item_started' },
      { kind: 'another.tool' },
      { actionType: 'other' },
      { status: 'failed' },
      { queries: ['', batchQueries[1]] },
      { results: [] },
      { results: [{ type: 'text_result', url: '' }] },
      { results: [{ type: 'text_result', url: 'not-a-url' }] },
      { results: [{ type: 'text_result', url: 'http://example.org/public' }] },
    ]) {
      assert.equal(codexNativeSearchEvidence(batchStdout, batchJournal(mismatch), prompt, sessionId).completed.length,
        0, JSON.stringify(mismatch))
    }
    assert.equal(codexNativeSearchEvidence(batchStdout, null, prompt, sessionId).completed.length, 0)
    assert.equal(codexNativeSearchEvidence(jsonl(
      { type: 'item.started', item: { type: 'web_search', id: 'exec-batch' } },
      { type: 'item.completed', item: { type: 'web_search', id: 'exec-batch', query: batchDisplay,
        action: { type: 'search', queries: batchQueries } } },
      { type: 'turn.failed' },
    ), batchJournal(), prompt, sessionId).completed.length, 0)
  })
})

const exaItem = { type: 'mcp_tool_call', id: 'exa-1', server: 'exa', tool: 'web_search_exa',
  arguments: { query: 'generic guard semantics' } }
const exaResult = { ...exaItem, status: 'completed', error: null,
  result: { content: [{ type: 'text', text: 'Public source: https://example.org/guard' }], isError: false } }

describe('official Exa MCP evidence', () => {
  it('pairs actual native calls and successful tool results and retains query attribution', async () => {
    const { codexExaSearchEvidence } = await import('../container/native-search-evidence.mjs')
    const proof = codexExaSearchEvidence(jsonl({ type: 'item.started', item: exaItem },
      { type: 'item.completed', item: exaResult }, { type: 'turn.completed' }))
    assert.deepEqual(proof.completed.map(c => c.queries), [['generic guard semantics']])
  })
  it('rejects tool errors, changed queries, unpaired output and incomplete turns', async () => {
    const { codexExaSearchEvidence } = await import('../container/native-search-evidence.mjs')
    for (const result of [{ ...exaResult, error: 'timeout' },
      { ...exaResult, result: { isError: true, content: exaResult.result.content } },
      { ...exaResult, arguments: { query: 'changed' } },
      { ...exaResult, result: { content: [] } }]) {
      assert.equal(codexExaSearchEvidence(jsonl({ type: 'item.started', item: exaItem },
        { type: 'item.completed', item: result }, { type: 'turn.completed' })).completed.length, 0)
    }
    assert.equal(codexExaSearchEvidence(jsonl({ type: 'item.completed', item: exaResult }, { type: 'turn.completed' })).completed.length, 0)
    assert.equal(codexExaSearchEvidence(jsonl({ type: 'item.started', item: exaItem }, { type: 'item.completed', item: exaResult })).completed.length, 0)
  })
})


test('direct search, another MCP server and fetch never satisfy a search citation', () => {
  for (const tool of ['web_search', 'mcp__other__web_search_exa', 'mcp__exa__web_fetch_exa']) {
    const proof = dshNativeSearchEvidence(jsonl(
      { type: 'tool_call', callId: 'call-1', tool, input: { query: 'public topic', queries: ['public topic'] } },
      { type: 'tool_result', callId: 'call-1', status: 'completed', result: 'Public source text' },
    ))
    assert.equal(proof.completed.length, 0)
  }
})
