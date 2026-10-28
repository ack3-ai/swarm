import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const digest = value => createHash('sha256').update(value).digest('hex')

/** Claude's official SDK forwards the native assistant/user tool blocks. */
export function claudeNativeSearchEvidence(stdout) {
  const events = []
  for (const line of stdout.split('\n')) {
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (!['assistant', 'user'].includes(event.type) || !Array.isArray(event.message?.content)) continue
    for (const block of event.message.content) {
      if (event.type === 'assistant' && block.type === 'tool_use') {
        events.push({ type: 'tool_call', tool: block.name, callId: block.id, input: block.input })
      }
      if (event.type === 'user' && block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content
          : Array.isArray(block.content)
            ? block.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : ''
        events.push({ type: 'tool_result', callId: block.tool_use_id,
          status: block.is_error ? 'failed' : 'completed', result: text })
      }
    }
  }
  return { ...dshNativeSearchEvidence(events.map(event => JSON.stringify(event)).join('\n')), source: 'claude-json' }
}

function codexSearchQueries(action) {
  if (action?.type !== 'search') return null
  if (typeof action.query === 'string' && action.query.trim()) return [action.query]
  if (Array.isArray(action.queries) && action.queries.length > 0
    && action.queries.every(query => typeof query === 'string' && query.trim())) return action.queries
  return null
}

function isSecureSearchResult(result) {
  if (result?.type !== 'text_result' || typeof result.url !== 'string') return false
  try { return new URL(result.url).protocol === 'https:' } catch { return false }
}

/** Only paired native harness tool events count; model prose and exits never do. */
export function dshNativeSearchEvidence(stdout) {
  const pending = new Map()
  const completed = []
  let failed = 0
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type === 'tool_call' && event.tool === 'mcp__exa__web_search_exa'
      && typeof event.callId === 'string' && event.callId.length > 0
      && typeof event.input?.query === 'string' && event.input.query.trim().length > 0) {
      if (!pending.has(event.callId)) pending.set(event.callId, { queryDigest: digest(JSON.stringify([event.input.query])), queries: [event.input.query] })
      continue
    }
    if (event?.type !== 'tool_result' || !pending.has(event.callId)) continue
    const { queryDigest, queries } = pending.get(event.callId)
    pending.delete(event.callId)
    if (event.status !== 'completed' || typeof event.result !== 'string' || event.result.length === 0
      || event.result.startsWith('Error:')) {
      failed += 1
      continue
    }
    completed.push({ callId: event.callId, queryDigest, queries, resultDigest: digest(event.result) })
  }
  return { schemaVersion: 1, source: 'dsh-json', completed, failed, incomplete: pending.size }
}

/** An Exa search or fetch may incur a separate charge even when its result fails validation. */
export function dshNativeSearchAttempted(stdout) {
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event?.type === 'tool_call' && ['mcp__exa__web_search_exa', 'mcp__exa__web_fetch_exa'].includes(event.tool)) return true
    } catch {}
  }
  return false
}

/** CLI item completion is only a candidate: it also occurs for failed searches. */
function codexCliSearchCandidates(stdout) {
  const pending = new Set()
  const completed = []
  let failed = 0
  let turnFailed = false
  let turnCompleted = false
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event?.type === 'turn.failed') turnFailed = true
    if (event?.type === 'turn.completed') turnCompleted = true
    if (event?.type === 'item.started' && event.item?.type === 'web_search'
      && typeof event.item.id === 'string' && event.item.id.length > 0) {
      pending.add(event.item.id)
      continue
    }
    if (event?.type !== 'item.completed' || event.item?.type !== 'web_search'
      || !pending.has(event.item.id)) continue
    pending.delete(event.item.id)
    const action = event.item.action
    if (action?.type !== 'search') continue
    const queries = codexSearchQueries(action)
    if (!queries || typeof event.item.query !== 'string' || !event.item.query.trim()
      || (typeof action.query === 'string' && event.item.query !== action.query)) {
      failed += 1
      continue
    }
    completed.push({ callId: event.item.id, queryDigest: digest(queries.length === 1 ? queries[0] : JSON.stringify(queries)),
      displayQueryDigest: digest(event.item.query), resultDigest: digest(JSON.stringify(action)) })
  }
  return { schemaVersion: 1, source: 'codex-json', completed: turnFailed || !turnCompleted ? [] : completed,
    failed: failed + (turnFailed ? completed.length : 0), incomplete: pending.size }
}

export async function readCodexNativeJournal(root, sessionId) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(sessionId ?? '')) return null
  const queue = [[root, 0]]
  let visited = 0
  while (queue.length > 0 && visited < 10_000) {
    const [directory, depth] = queue.shift()
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return null }
    for (const entry of entries) {
      visited += 1
      if (visited > 10_000) return null
      const path = join(directory, entry.name)
      if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) {
        try { return await readFile(path, 'utf8') } catch { return null }
      }
      if (entry.isDirectory() && depth < 4) queue.push([path, depth + 1])
    }
  }
  return null
}

/** Require the exact native journal response status for this prompt and turn. */
export function codexNativeSearchEvidence(stdout, journalText, prompt, sessionId) {
  const cli = codexCliSearchCandidates(stdout)
  if (typeof journalText !== 'string' || typeof prompt !== 'string'
    || !/^[a-zA-Z0-9-]{8,100}$/.test(sessionId ?? '')) {
    return { ...cli, completed: [], failed: cli.failed + cli.completed.length, journalStatus: 'missing' }
  }
  const events = []
  for (const line of journalText.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {
      return { ...cli, completed: [], failed: cli.failed + cli.completed.length, journalStatus: 'mismatch' }
    }
  }
  const meta = events.find(event => event?.type === 'session_meta')
  if (meta?.payload?.session_id !== sessionId && meta?.payload?.id !== sessionId) {
    return { ...cli, completed: [], failed: cli.failed + cli.completed.length, journalStatus: 'mismatch' }
  }
  const lastTurn = events.filter(event => event?.type === 'event_msg'
    && event.payload?.type === 'task_started').at(-1)?.payload?.turn_id
  const turnComplete = events.some(event => event?.type === 'event_msg'
    && event.payload?.type === 'task_complete' && event.payload.turn_id === lastTurn)
  const exactPrompt = events.some(event => event?.type === 'response_item'
    && event.payload?.type === 'message' && event.payload.role === 'user'
    && event.payload.internal_chat_message_metadata_passthrough?.turn_id === lastTurn
    && event.payload.content?.some(item => item?.type === 'input_text' && item.text === prompt))
  if (typeof lastTurn !== 'string' || !turnComplete || !exactPrompt) {
    return { ...cli, completed: [], failed: cli.failed + cli.completed.length, journalStatus: 'mismatch' }
  }
  const nativeCalls = new Map()
  const nativeExtensions = new Map()
  for (const event of events) {
    const payload = event?.payload
    if (event?.type === 'event_msg' && payload?.type === 'item_completed'
      && payload.thread_id === sessionId && payload.turn_id === lastTurn
      && payload.item?.type === 'Extension'
      && payload.item.kind === 'web.search' && typeof payload.item.id === 'string'
      && !nativeExtensions.has(payload.item.id)) {
      nativeExtensions.set(payload.item.id, payload.item)
    }
    if (event?.type !== 'response_item' || payload?.type !== 'web_search_call'
      || payload.internal_chat_message_metadata_passthrough?.turn_id !== lastTurn
      || typeof payload.id !== 'string' || nativeCalls.has(payload.id)) continue
    nativeCalls.set(payload.id, payload)
  }
  const completed = []
  for (const candidate of cli.completed) {
    const native = nativeCalls.get(candidate.callId) ?? nativeExtensions.get(candidate.callId)
    const queries = codexSearchQueries(native?.action)
    if (!native || !queries || digest(queries.length === 1 ? queries[0] : JSON.stringify(queries))
      !== candidate.queryDigest) continue
    if (nativeCalls.has(candidate.callId)) {
      if (native.status !== 'completed') continue
    } else if ((native.status !== undefined && native.status !== 'completed')
      || typeof native.query !== 'string' || digest(native.query) !== candidate.displayQueryDigest
      || !Array.isArray(native.results) || !native.results.some(isSecureSearchResult)) continue
    completed.push({ ...candidate, resultDigest: digest(JSON.stringify(native)) })
  }
  return { ...cli, completed, failed: cli.failed + cli.completed.length - completed.length,
    journalStatus: 'verified' }
}

/** Exa MCP returns the actual response in paired native CLI events. */
export function codexExaSearchEvidence(stdout) {
  const pending = new Map(), completed = []
  let failed = 0, turnCompleted = false, turnFailed = false
  for (const line of stdout.split('\n')) {
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type === 'turn.completed') turnCompleted = true
    if (e.type === 'turn.failed') turnFailed = true
    const i = e.item
    if (i?.type !== 'mcp_tool_call' || i.server !== 'exa' || i.tool !== 'web_search_exa') continue
    if (e.type === 'item.started' && typeof i.arguments?.query === 'string' && i.arguments.query.trim()) {
      pending.set(i.id, i.arguments.query)
    }
    if (e.type !== 'item.completed' || !pending.has(i.id)) continue
    const query = pending.get(i.id); pending.delete(i.id)
    if (i.status !== 'completed' || i.error || i.result?.isError === true || i.arguments?.query !== query
      || !i.result?.content?.some(c => c.type === 'text' && typeof c.text === 'string' && c.text.trim())) {
      failed++; continue
    }
    completed.push({ callId: i.id, queries: [query], queryDigest: digest(JSON.stringify([query])),
      resultDigest: digest(JSON.stringify(i.result)) })
  }
  return { schemaVersion: 1, source: 'codex-exa', completed: turnCompleted && !turnFailed ? completed : [],
    failed: failed + (turnFailed ? completed.length : 0), incomplete: pending.size }
}
