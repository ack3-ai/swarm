// The root runner's record of this session's web searches, written as the CLI reports
// them, so `ack3-submit` can check search citations before the agent stops (S26).
// Root writes it under /control, where the agent can read but not write. The
// Worker's check of the receipt stays the authority; this record only lets the
// agent fix a citation problem inside the session.
//
// One JSON object per line: {"query": "..."} for a successful search,
// {"failed": true} for a failed one, {"session": "..."} at the end of each attempt,
// and {"partial": true} when the record cannot hold all of the session's searches.
import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'
import { exaSearchTools } from './native-search-evidence.mjs'

export const SEARCH_RECORD_PATH = '/control/search-record.jsonl'
export const SEARCH_RECORD_MAX_BYTES = 4 * 1024 * 1024
// The receipt counts a completed search whose query exceeds this as failed (see bounded() in native-search-evidence.mjs).
const QUERY_MAX_CHARS = 4000
const PARTIAL = '{"partial":true}\n'

/** The receipt format of this request's CLI; null when its searches can never be cited (Codex without Exa). */
export function searchRecordFormat(request) {
  if (request.backend === 'claude') return 'claude'
  if (request.providerClass === 'additive') return 'dsh'
  if (request.providerClass === 'core' && request.searchConnection?.provider === 'exa') return 'codex-exa'
  return null
}

/**
 * Pairs each search call with its result as stdout arrives, by the rules of the receipt parsers in
 * native-search-evidence.mjs, and reports it at once: onSearch(query) for a successful search,
 * onSearch(null) for a failed one. It does not wait for the turn to end, as the receipt does.
 */
export function liveSearchReader(format, onSearch) {
  const pending = new Map()
  let rest = ''
  const settle = (callId, succeeded) => {
    const query = pending.get(callId)
    pending.delete(callId)
    onSearch(succeeded && query.length <= QUERY_MAX_CHARS ? query : null)
  }
  // DSH events; Claude's tool blocks are read in the same shape, as claudeNativeSearchEvidence does.
  const harnessEvent = event => {
    if (event?.type === 'tool_call' && exaSearchTools.some(tool => event.tool === `mcp__exa__${tool}`)
      && typeof event.callId === 'string' && event.callId.length > 0
      && typeof event.input?.query === 'string' && event.input.query.trim().length > 0) {
      if (!pending.has(event.callId)) pending.set(event.callId, event.input.query)
    } else if (event?.type === 'tool_result' && pending.has(event.callId)) {
      settle(event.callId, event.status === 'completed' && typeof event.result === 'string'
        && event.result.length > 0 && !event.result.startsWith('Error:'))
    }
  }
  const line = text => {
    let event
    try { event = JSON.parse(text) } catch { return }
    if (format === 'dsh') harnessEvent(event)
    if (format === 'claude' && ['assistant', 'user'].includes(event?.type) && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (event.type === 'assistant' && block?.type === 'tool_use') {
          harnessEvent({ type: 'tool_call', tool: block.name, callId: block.id, input: block.input })
        }
        if (event.type === 'user' && block?.type === 'tool_result') {
          const result = typeof block.content === 'string' ? block.content
            : Array.isArray(block.content) ? block.content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : ''
          harnessEvent({ type: 'tool_result', callId: block.tool_use_id, status: block.is_error ? 'failed' : 'completed', result })
        }
      }
    }
    const item = event?.item
    if (format !== 'codex-exa' || item?.type !== 'mcp_tool_call' || item.server !== 'exa' || !exaSearchTools.includes(item.tool)) return
    if (event.type === 'item.started' && typeof item.arguments?.query === 'string' && item.arguments.query.trim()) {
      pending.set(item.id, item.arguments.query)
    }
    if (event.type !== 'item.completed' || !pending.has(item.id)) return
    settle(item.id, item.status === 'completed' && !item.error && item.result?.isError !== true
      && item.arguments?.query === pending.get(item.id)
      && item.result?.content?.some(part => part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) === true)
  }
  return {
    push(text) {
      const lines = `${rest}${text}`.split('\n')
      rest = lines.pop()
      for (const value of lines) if (value.trim()) line(value)
    },
    flush() {
      if (rest.trim()) line(rest)
      rest = ''
    },
  }
}

function readRecord(path) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch { return null }
  try {
    const stat = fstatSync(fd)
    return stat.isFile() && stat.size <= SEARCH_RECORD_MAX_BYTES ? readFileSync(fd, 'utf8') : null
  } catch { return null } finally { closeSync(fd) }
}

function lastSession(text) {
  if (text === null || !text.endsWith('\n')) return null
  try { return JSON.parse(text.slice(text.lastIndexOf('\n', text.length - 2) + 1)).session ?? null } catch { return null }
}

/**
 * The runner's side, started before the first launch and fed every stdout chunk of the attempt.
 * A new session starts an empty record. A resumed session keeps its record only when the last
 * attempt in this container ended that same session; otherwise the record says its earlier
 * searches are unknown, and `ack3-submit` leaves the check to the Worker.
 */
export function startSearchRecord(request, { path = SEARCH_RECORD_PATH, maxBytes = SEARCH_RECORD_MAX_BYTES } = {}) {
  let fd = null
  let bytes = 0
  const close = () => {
    try { closeSync(fd) } catch {}
    fd = null
  }
  const write = text => {
    if (fd === null) return
    try {
      if (bytes + Buffer.byteLength(text) > maxBytes - PARTIAL.length) {
        writeSync(fd, PARTIAL)
        close()
      } else bytes += writeSync(fd, text)
    } catch {
      // A record that could not be kept up to date must not be read as complete.
      close()
      try { unlinkSync(path) } catch {}
    }
  }
  try {
    const resumed = request.continuationMode === 'resume'
    const keep = resumed && lastSession(readRecord(path)) === request.sessionId
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
      | (keep ? constants.O_APPEND : constants.O_TRUNC), 0o644)
    fchmodSync(fd, 0o644)
    bytes = fstatSync(fd).size
    if (resumed && !keep) write(PARTIAL)
  } catch {
    if (fd !== null) close()
    // Never leave an older record behind as if it were this session's (O_NOFOLLOW refuses a link; unlink removes the link itself).
    try { unlinkSync(path) } catch {}
  }
  const reader = liveSearchReader(searchRecordFormat(request),
    query => write(`${JSON.stringify(query === null ? { failed: true } : { query })}\n`))
  return {
    push(text) { if (fd !== null) reader.push(text) },
    /** After the last launch: the session ID the receipt reports, so a resumed session can keep this record. */
    end(sessionId) {
      if (fd === null) return
      reader.flush()
      write(`${JSON.stringify({ session: sessionId })}\n`)
      if (fd !== null) close()
    },
  }
}

/** `ack3-submit`'s side: the successful queries and the failed count, or null when the record is incomplete or unreadable. */
export function parseSearchRecord(text) {
  const queries = []
  let failed = 0
  // Whole lines only: the runner may be writing the next one.
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n')) {
    if (line === '') continue
    let entry
    try { entry = JSON.parse(line) } catch { return null }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.partial === true) return null
    if (typeof entry.query === 'string') queries.push(entry.query)
    else if (entry.failed === true) failed += 1
    else if (typeof entry.session !== 'string') return null
  }
  return { queries, failed }
}
