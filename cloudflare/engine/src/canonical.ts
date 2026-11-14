import { plainCanonicalJson, plainCanonicalJsonDigest } from './canonical-bytes.js'
import { compareText } from './text-order.js'

const encoder = new TextEncoder()

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, normalized(entry)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical values cannot contain non-finite numbers')
  }
  return value
}

// Plain data objects take the one-pass writer. Custom objects, toJSON functions,
// functions, symbols and cycles keep the historical normalize-and-stringify
// path. Both produce the same text for plain data, accessors included.
export function canonicalJson(value: unknown): string {
  const plain = value !== null && typeof value === 'object' ? plainCanonicalJson(value) : null
  return plain ?? JSON.stringify(normalized(value))
}

export async function sha256(value: unknown): Promise<string> {
  const plain = value !== undefined && typeof value !== 'string' ? plainCanonicalJsonDigest(value) : null
  if (plain !== null) return plain
  const bytes = encoder.encode(typeof value === 'string' ? value : canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
