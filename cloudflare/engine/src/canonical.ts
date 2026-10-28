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

export async function sha256(value: unknown): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : encoder.encode(canonicalJson(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function deepClone<T>(value: T): T {
  return structuredClone(value)
}
