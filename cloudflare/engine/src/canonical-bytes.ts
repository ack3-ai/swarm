import { createHash } from 'node:crypto'
import { compareText } from './text-order.js'

const encoder = new TextEncoder()
const arrayIndexLike = /^(?:0|[1-9][0-9]*)$/
// Records repeat a small set of key names; their JSON form is cached (bounded).
const quotedKeys = new Map<string, string>()
function quotedKey(key: string): string {
  let quoted = quotedKeys.get(key)
  if (quoted === undefined) {
    quoted = JSON.stringify(key)
    if (key.length <= 128) {
      if (quotedKeys.size >= 8192) quotedKeys.clear()
      quotedKeys.set(key, quoted)
    }
  }
  return quoted
}

/** Thrown inside a strict walk when the value is not plain JSON data. */
export const notPlainData = Symbol('not plain data')

// Match canonicalJson's normalization and JavaScript property order without
// building a second normalized object graph or one full UTF-16 JSON string.
// Strict mode serves sha256 and canonicalJson: it stops (throws notPlainData)
// where the historical path differs or must decide (toJSON, class instances,
// functions, symbols, bigints, cycles), so the caller can use that path instead.
function writeChunks(value: unknown, emit: (chunk: string) => void, strict = false): void {
  const parents = new Set<object>()
  let parts: string[] = [], length = 0
  const flush = () => {
    if (length > 0) emit(parts.join(''))
    parts = []
    length = 0
  }
  const token = (text: string) => {
    parts.push(text)
    length += text.length
    if (length >= 64 * 1024) flush()
  }
  const skipped = (child: unknown) => typeof child === 'function' || typeof child === 'symbol'
  // A direct visitor avoids forwarding every small token through a generator
  // at each enclosing object/array depth.
  const visit = (entry: unknown): void => {
    if (entry !== null && typeof entry === 'object') {
      if (strict) {
        if (parents.has(entry) || 'toJSON' in entry) throw notPlainData
        if (!Array.isArray(entry)) {
          const prototype = Object.getPrototypeOf(entry)
          if (prototype !== Object.prototype && prototype !== null) throw notPlainData
        }
      } else if (parents.has(entry)) throw new TypeError('canonical values cannot contain cycles')
      parents.add(entry)
      if (Array.isArray(entry)) {
        token('[')
        for (let i = 0; i < entry.length; i++) {
          if (i > 0) token(',')
          const child: unknown = entry[i]
          if (strict && skipped(child)) throw notPlainData
          if (child === undefined || skipped(child)) token('null')
          else visit(child)
        }
        token(']')
      } else {
        // Sorted keys, except that integer-like keys follow JavaScript property
        // order (ascending, first), as Object.fromEntries would place them.
        const pairs: [string, unknown][] = []
        let indexLike = false
        for (const key of Object.keys(entry)) {
          const child: unknown = (entry as Record<string, unknown>)[key]
          if (strict && skipped(child)) throw notPlainData
          if (child === undefined || skipped(child)) continue
          if (!indexLike && key.charCodeAt(0) <= 57 && arrayIndexLike.test(key)) indexLike = true
          pairs.push([key, child])
        }
        pairs.sort(([left], [right]) => compareText(left, right))
        const ordered = indexLike ? Object.entries(Object.fromEntries(pairs)) : pairs
        token('{')
        for (let i = 0; i < ordered.length; i++) {
          if (i > 0) token(',')
          const [key, child] = ordered[i]!
          token(quotedKey(key))
          token(':')
          visit(child)
        }
        token('}')
      }
      parents.delete(entry)
    } else {
      if (strict && entry !== null && typeof entry !== 'string' && typeof entry !== 'number'
        && typeof entry !== 'boolean') throw notPlainData
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('canonical values cannot contain non-finite numbers')
      const text = JSON.stringify(entry)
      if (text === undefined) throw new TypeError('canonical root must be JSON serializable')
      token(text)
    }
  }
  visit(value)
  flush()
}

/** Canonical JSON text of plain data, or null where the historical canonicalJson must decide. */
export function plainCanonicalJson(value: unknown): string | null {
  let text = ''
  try { writeChunks(value, chunk => { text += chunk }, true) } catch (error) {
    if (error === notPlainData) return null
    throw error
  }
  return text
}

/** Digest of plain data's canonical JSON, or null where the historical path must decide. */
export function plainCanonicalJsonDigest(value: unknown): string | null {
  const hash = createHash('sha256')
  try { writeChunks(value, chunk => { hash.update(encoder.encode(chunk)) }, true) } catch (error) {
    if (error === notPlainData) return null
    throw error
  }
  return hash.digest('hex')
}

/** Hash canonical JSON data without buffering its full encoded form. */
export function canonicalJsonDigest(value: unknown): string {
  const hash = createHash('sha256')
  writeChunks(value, chunk => { hash.update(encoder.encode(chunk)) })
  return hash.digest('hex')
}

/** One UTF-8 upload buffer, with scratch space bounded by the largest field. */
export function canonicalJsonBytes(value: unknown): { bytes: Uint8Array, digest: string } {
  const hash = createHash('sha256')
  let length = 0
  writeChunks(value, chunk => {
    const encoded = encoder.encode(chunk)
    hash.update(encoded)
    length += encoded.byteLength
  })
  const bytes = new Uint8Array(length)
  let offset = 0
  writeChunks(value, chunk => {
    const encoded = encoder.encode(chunk)
    bytes.set(encoded, offset)
    offset += encoded.byteLength
  })
  return { bytes, digest: hash.digest('hex') }
}
