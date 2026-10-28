import { createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'

const MAX_LOCAL_LOG_BYTES = 32 * 1024 * 1024
const MAX_EVENT_CHARACTERS = 4 * 1024
const MIN_SECRET_LENGTH = 8

function credentialValues(env) {
  return Object.entries(env)
    .filter(([name, value]) => (
      typeof value === 'string'
      && value.length >= MIN_SECRET_LENGTH
      && (/^(?:TARGET_)/i.test(name) || /(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i.test(name))
    ))
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value.length - left.value.length || left.name.localeCompare(right.name))
    .filter((item, index, values) => values.findIndex(candidate => candidate.value === item.value) === index)
}

export function credentialsFromJson(source, prefix = 'ACK3_CODEX_AUTH') {
  let value
  try { value = JSON.parse(source) } catch { return [] }
  const credentials = []
  const visit = (item, path) => {
    if (credentials.length >= 256) return
    if (typeof item === 'string') {
      if (item.length >= MIN_SECRET_LENGTH) {
        const suffix = path.map(part => String(part).toUpperCase().replace(/[^A-Z0-9]+/g, '_')).filter(Boolean).join('_')
        credentials.push({ name: suffix === '' ? prefix : `${prefix}_${suffix}`, value: item })
      }
      return
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, [...path, index]))
      return
    }
    if (item !== null && typeof item === 'object') {
      for (const [name, entry] of Object.entries(item)) visit(entry, [...path, name])
    }
  }
  visit(value, [])
  return credentials
}

// install-codex-auth.sh moves the staged login into CODEX_HOME before any agent
// runs, so read the installed copy first.
export async function codexAuthCredentials(paths = ['/codex-home/auth.json', '/workspace/private/codex-auth.json']) {
  for (const path of paths) {
    try {
      return credentialsFromJson(await readFile(path, 'utf8'))
    } catch {}
  }
  return []
}

function replaceCredentials(text, credentials) {
  let value = text
  for (const credential of credentials) {
    value = value.replaceAll(credential.value, `<redacted:${credential.name}>`)
  }
  return value
}

class StreamingCredentialRedactor {
  constructor(credentials) {
    this.credentials = credentials
    this.maxSecretLength = credentials.reduce((length, item) => Math.max(length, item.value.length), 0)
    this.pending = ''
    this.pendingAt = null
  }

  push(text, at) {
    if (text === '') return []
    if (this.pendingAt === null) this.pendingAt = at
    const combined = this.pending + text
    if (this.maxSecretLength === 0) {
      this.pending = ''
      this.pendingAt = null
      return [{ at, text: combined }]
    }
    let safeEnd = Math.max(0, combined.length - this.maxSecretLength + 1)
    for (const credential of this.credentials) {
      let start = combined.indexOf(credential.value)
      while (start !== -1) {
        if (start < safeEnd && start + credential.value.length > safeEnd) safeEnd = start
        start = combined.indexOf(credential.value, start + 1)
      }
    }
    const safe = combined.slice(0, safeEnd)
    const safeAt = this.pendingAt
    this.pending = combined.slice(safeEnd)
    this.pendingAt = this.pending === '' ? null : at
    return safe === '' ? [] : [{ at: safeAt, text: replaceCredentials(safe, this.credentials) }]
  }

  flush() {
    if (this.pending === '') return []
    const event = { at: this.pendingAt ?? new Date().toISOString(), text: replaceCredentials(this.pending, this.credentials) }
    this.pending = ''
    this.pendingAt = null
    return [event]
  }
}

/**
 * Best-effort append-only capture for a paid agent process. Capture failures
 * are intentionally isolated from the child process and its execution result.
 */
export function createAgentLogWriter(path, env = process.env, now = () => new Date().toISOString(), additionalCredentials = []) {
  const credentials = [...credentialValues(env), ...additionalCredentials]
    .sort((left, right) => right.value.length - left.value.length || left.name.localeCompare(right.name))
    .filter((item, index, values) => values.findIndex(candidate => candidate.value === item.value) === index)
  const redactors = {
    stdout: new StreamingCredentialRedactor(credentials),
    stderr: new StreamingCredentialRedactor(credentials),
  }
  let stream
  let bytes = 0
  let truncated = false
  let closed = false
  try {
    stream = createWriteStream(path, { flags: 'w', mode: 0o600 })
    stream.on('error', () => { stream = undefined })
  } catch {
    stream = undefined
  }

  const appendOne = value => {
    if (stream === undefined || truncated || value.text === '') return
    const line = `${JSON.stringify({ schemaVersion: 1, at: value.at, stream: value.stream, text: value.text })}\n`
    const lineBytes = Buffer.byteLength(line)
    const marker = `${JSON.stringify({ schemaVersion: 1, kind: 'capture-truncated', at: now() })}\n`
    const markerBytes = Buffer.byteLength(marker)
    if (bytes + lineBytes + markerBytes > MAX_LOCAL_LOG_BYTES) {
      truncated = true
      if (bytes + markerBytes <= MAX_LOCAL_LOG_BYTES) {
        try { stream.write(marker); bytes += markerBytes } catch { stream = undefined }
      }
      return
    }
    try { stream.write(line); bytes += lineBytes } catch { stream = undefined }
  }

  const append = value => {
    let remaining = value.text
    while (remaining !== '') {
      let length = Math.min(MAX_EVENT_CHARACTERS, remaining.length)
      if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1] ?? '')) length -= 1
      appendOne({ ...value, text: remaining.slice(0, length) })
      remaining = remaining.slice(length)
    }
  }

  return {
    write(output, chunk) {
      if (closed || (output !== 'stdout' && output !== 'stderr')) return
      const at = now()
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const event of redactors[output].push(text, at)) append({ ...event, stream: output })
    },
    async close() {
      if (closed) return
      closed = true
      for (const output of ['stdout', 'stderr']) {
        for (const event of redactors[output].flush()) append({ ...event, stream: output })
      }
      const destination = stream
      stream = undefined
      if (destination === undefined) return
      await new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          destination.destroy()
          finish()
        }, 1_000)
        destination.once('error', finish)
        destination.end(finish)
      })
    },
  }
}
