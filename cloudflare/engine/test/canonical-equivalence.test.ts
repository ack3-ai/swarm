import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { canonicalJsonBytes, canonicalJsonDigest } from '../src/canonical-bytes.js'

// The canonical form and digests before the one-pass writer, kept verbatim as the reference.
function historicalNormalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(historicalNormalized)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, historicalNormalized(entry)]))
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('canonical values cannot contain non-finite numbers')
  return value
}
const historicalCanonicalJson = (value: unknown): string => JSON.stringify(historicalNormalized(value))
function historicalPlainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value)) return true
  if (typeof value !== 'object') return false
  if (seen.has(value) || 'toJSON' in value) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  for (const entry of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!entry.enumerable) continue
    if (!('value' in entry) || !historicalPlainData(entry.value, seen)) return false
  }
  seen.delete(value)
  return true
}
function historicalWriterDigest(value: unknown): string {
  const hash = createHash('sha256'), parents = new Set<object>()
  const visit = (entry: unknown): void => {
    if (entry !== null && typeof entry === 'object') {
      if (parents.has(entry)) throw new TypeError('canonical values cannot contain cycles')
      parents.add(entry)
      if (Array.isArray(entry)) {
        hash.update('[')
        for (let i = 0; i < entry.length; i++) {
          if (i > 0) hash.update(',')
          const child: unknown = entry[i]
          if (child === undefined || typeof child === 'function' || typeof child === 'symbol') hash.update('null')
          else visit(child)
        }
        hash.update(']')
      } else {
        const ordered = Object.fromEntries(Object.entries(entry)
          .filter(([, child]) => child !== undefined && typeof child !== 'function' && typeof child !== 'symbol')
          .sort(([left], [right]) => left.localeCompare(right)))
        hash.update('{')
        let first = true
        for (const [key, child] of Object.entries(ordered)) {
          if (!first) hash.update(',')
          first = false
          hash.update(JSON.stringify(key))
          hash.update(':')
          visit(child)
        }
        hash.update('}')
      }
      parents.delete(entry)
    } else {
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new TypeError('canonical values cannot contain non-finite numbers')
      const text = JSON.stringify(entry)
      if (text === undefined) throw new TypeError('canonical root must be JSON serializable')
      hash.update(text)
    }
  }
  visit(value)
  return hash.digest('hex')
}
async function historicalSha256(value: unknown): Promise<string> {
  if (value !== undefined && typeof value !== 'string' && historicalPlainData(value)) return historicalWriterDigest(value)
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : historicalCanonicalJson(value))
  return createHash('sha256').update(bytes).digest('hex')
}

type Outcome = { value: string } | { error: string }
async function outcome(run: () => unknown): Promise<Outcome> {
  try { return { value: String(await run()) } } catch (error) {
    return { error: error instanceof Error ? error.constructor.name : typeof error }
  }
}
async function expectSame(value: unknown): Promise<void> {
  expect(await outcome(() => canonicalJson(value))).toEqual(await outcome(() => historicalCanonicalJson(value)))
  expect(await outcome(() => sha256(value))).toEqual(await outcome(() => historicalSha256(value)))
  expect(await outcome(() => canonicalJsonDigest(value))).toEqual(await outcome(() => historicalWriterDigest(value)))
  expect(await outcome(() => canonicalJsonBytes(value).digest)).toEqual(await outcome(() => historicalWriterDigest(value)))
}

// Deterministic generator so a failure is reproducible from its seed.
function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const keys = ['a', 'B', 'b', 'Z', 'ä', 'é', 'z', '_', '-', '0', '1', '2', '10', '01', '-1', '1.5', '4294967294',
  '4294967295', '__proto__', 'constructor', 'toString', 'id', 'Id', 'ID', '😀', ' ', ' ', '']
const strings = ['', 'x', 'é', '😀', '\ud800', '\udc00x', '"\\\n\t', '  ', 'a'.repeat(70_000)]
function generate(next: () => number, depth: number): unknown {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!
  const roll = next()
  if (depth > 4 || roll < 0.35) {
    return pick([null, true, false, 0, -0, 1, -1.5, 1e21, 1e-7, 2 ** 53, Number.MIN_VALUE,
      undefined, ...strings, Math.floor(next() * 1e6)])
  }
  if (roll < 0.55) {
    const array: unknown[] = Array.from({ length: Math.floor(next() * 5) }, () => generate(next, depth + 1))
    if (next() < 0.1) array.length += 2
    return array
  }
  const object: Record<string, unknown> = next() < 0.1 ? Object.create(null) : {}
  for (let i = Math.floor(next() * 7); i > 0; i -= 1) {
    Object.defineProperty(object, pick(keys), { value: generate(next, depth + 1), enumerable: true, writable: true, configurable: true })
  }
  return object
}

describe('canonical JSON one-pass writer', () => {
  it('matches the historical canonical text and digests on generated plain data', async () => {
    for (let seed = 1; seed <= 1500; seed += 1) {
      const value = generate(random(seed), 0)
      try { await expectSame(value) } catch (error) {
        throw new Error(`seed ${seed} differs`, { cause: error })
      }
    }
  })

  it('matches the historical path for values that are not plain data', async () => {
    class Box { constructor(readonly inner: unknown) {} }
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic.self = cyclic
    const cyclicArray: unknown[] = [1]
    cyclicArray.push(cyclicArray)
    const shared = { z: 1, a: [1, 2] }
    const getter = Object.defineProperty({ b: 1 }, 'a', { get: () => ({ y: 2, x: [3] }), enumerable: true })
    const hiddenGetter = Object.defineProperty({ b: 1 }, 'a', { get: () => 1, enumerable: false })
    const values: unknown[] = [
      undefined, Symbol('s'), () => 1, 'text', '', 7, null, [], {}, [undefined, () => 1, Symbol('x')],
      { f: () => 1, s: Symbol('x'), u: undefined, ok: 1 },
      { toJSON: () => ({ replaced: true }) }, { toJSON: 5 }, { nested: { toJSON: () => 'x' } },
      Object.defineProperty({}, 'toJSON', { value: () => ({ hidden: true }) }),
      Object.create({ toJSON() { return 'inherited' } }), Object.create({ inherited: 1 }),
      new Date('2026-01-01T00:00:00Z'), new Map([[1, 2]]), new Set([1]), new Box({ a: 1 }),
      { box: new Box(1) }, new Uint8Array([3, 1, 2]), { typed: new Uint8Array([1]) }, /re/g,
      getter, { outer: getter }, hiddenGetter, [shared, shared, { again: shared }],
      Object.assign([1, 2], { extra: 'x' }), { big: 1n }, [1n], 1n,
      { n: Infinity }, [NaN], -Infinity, cyclic, cyclicArray, { inner: cyclic },
      JSON.parse('{"__proto__": {"a": 1}, "b": 2}'),
    ]
    for (const [index, value] of values.entries()) {
      try { await expectSame(value) } catch (error) {
        throw new Error(`value ${index} differs`, { cause: error })
      }
    }
  })
})
