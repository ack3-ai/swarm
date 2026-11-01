import { canonicalJsonDigest } from './canonical-bytes.js'

const encoder = new TextEncoder()

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    )
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('canonical values cannot contain non-finite numbers')
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value))
}

// Only take the bounded path for data objects. Preserve the historical
// canonicalJson behavior for custom objects, getters and toJSON functions.
function plainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value)) return true
  if (typeof value !== 'object') return false
  if (seen.has(value) || 'toJSON' in value) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  for (const entry of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!entry.enumerable) continue
    if (!('value' in entry) || !plainData(entry.value, seen)) return false
  }
  seen.delete(value)
  return true
}

export async function sha256(value: unknown): Promise<string> {
  if (value !== undefined && typeof value !== 'string' && plainData(value)) return canonicalJsonDigest(value)
  const bytes = encoder.encode(typeof value === 'string' ? value : canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
