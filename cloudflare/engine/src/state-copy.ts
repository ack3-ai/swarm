import { deepClone } from './canonical.js'

const arrayIndexLike = /^(?:0|[1-9][0-9]*)$/

/** Snapshots repeat evidence in artifacts, checkpoints and journal entries.
 * Share equal immutable strings while preserving independent JSON containers.
 * The pool belongs to this parse only; it never retains another audit's data. */
export function parseStateJson<T>(content: string): T {
  const strings = new Map<string, string>()
  return JSON.parse(content, (_key, value: unknown) => {
    if (typeof value !== 'string') return value
    const shared = strings.get(value)
    if (shared !== undefined) return shared
    strings.set(value, value)
    return value
  }) as T
}

// RunState is JSON data. Copy its containers without re-allocating every
// immutable string (structuredClone duplicates large protocol strings). A caller
// importing several parsed snapshots can share equal strings within its own
// short-lived pool; object/array containers remain independently mutable.
export function copyState<T>(value: T, copies = new Map<object, unknown>(), strings?: Map<string, string>): T {
  if (typeof value === 'string' && strings !== undefined) {
    const shared = strings.get(value)
    if (shared !== undefined) return shared as T
    strings.set(value, value)
    return value
  }
  if (value === null || typeof value !== 'object') return value
  if (copies.has(value)) return copies.get(value) as T
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) return deepClone(value)
  const array = Array.isArray(value)
  const copy: Record<string, unknown> | unknown[] = array ? new Array(value.length) : {}
  copies.set(value, copy)
  for (const key of Object.keys(value)) {
    const entry = copyState((value as Record<string, unknown>)[key], copies, strings)
    // Plain assignment creates the same own data property, much faster. Only a
    // "__proto__" key, or a non-index key on an array, needs defineProperty.
    if (array ? arrayIndexLike.test(key) : key !== '__proto__') (copy as Record<string, unknown>)[key] = entry
    else Object.defineProperty(copy, key, { value: entry, enumerable: true, writable: true, configurable: true })
  }
  return copy as T
}
