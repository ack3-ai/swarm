import { createHash } from 'node:crypto'

const encoder = new TextEncoder()

// Match canonicalJson's normalization and JavaScript property order without
// building a second normalized object graph or one full UTF-16 JSON string.
function writeChunks(value: unknown, emit: (chunk: Uint8Array) => void): void {
  const parents = new Set<object>()
  let parts: string[] = [], length = 0
  const flush = () => {
    if (length > 0) emit(encoder.encode(parts.join('')))
    parts = []
    length = 0
  }
  const token = (text: string) => {
    parts.push(text)
    length += text.length
    if (length >= 64 * 1024) flush()
  }
  // A direct visitor avoids forwarding every small token through a generator
  // at each enclosing object/array depth.
  const visit = (entry: unknown): void => {
    if (entry !== null && typeof entry === 'object') {
      if (parents.has(entry)) throw new TypeError('canonical values cannot contain cycles')
      parents.add(entry)
      if (Array.isArray(entry)) {
        token('[')
        for (let i = 0; i < entry.length; i++) {
          if (i > 0) token(',')
          const child: unknown = entry[i]
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol') token('null')
          else visit(child)
        }
        token(']')
      } else {
        const ordered = Object.fromEntries(Object.entries(entry)
          .filter(([, child]) => child !== undefined && typeof child !== 'function' && typeof child !== 'symbol')
          .sort(([left], [right]) => left.localeCompare(right)))
        token('{')
        let first = true
        for (const [key, child] of Object.entries(ordered)) {
          if (!first) token(',')
          first = false
          token(JSON.stringify(key))
          token(':')
          visit(child)
        }
        token('}')
      }
      parents.delete(entry)
    } else {
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('canonical values cannot contain non-finite numbers')
      const text = JSON.stringify(entry)
      if (text === undefined) throw new TypeError('canonical root must be JSON serializable')
      token(text)
    }
  }
  visit(value)
  flush()
}

/** Hash canonical JSON data without buffering its full encoded form. */
export function canonicalJsonDigest(value: unknown): string {
  const hash = createHash('sha256')
  writeChunks(value, chunk => { hash.update(chunk) })
  return hash.digest('hex')
}

/** One UTF-8 upload buffer, with scratch space bounded by the largest field. */
export function canonicalJsonBytes(value: unknown): { bytes: Uint8Array, digest: string } {
  const hash = createHash('sha256')
  let length = 0
  writeChunks(value, chunk => {
    hash.update(chunk)
    length += chunk.byteLength
  })
  const bytes = new Uint8Array(length)
  let offset = 0
  writeChunks(value, chunk => {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  })
  return { bytes, digest: hash.digest('hex') }
}
