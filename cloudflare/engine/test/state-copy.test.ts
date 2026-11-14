import { expect, it } from 'vitest'
import { copyState, parseStateJson } from '../src/state-copy.js'
import { canonicalJson, sha256 } from '../src/canonical.js'

it('preserves JSON bytes and independent evidence containers when sharing strings', async () => {
  const text = 'Evidence \\u0000 雪 🛡'.repeat(1000)
  const content = JSON.stringify({ artifacts: [{ text }], checkpoint: { artifacts: [{ text }] },
    empty: '', missing: null, flags: [false, 0, 1.5] })
  const parsed = parseStateJson<{ artifacts: { text: string }[]; checkpoint: { artifacts: { text: string }[] } }>(content)
  expect(JSON.stringify(parsed)).toBe(content)
  expect(await sha256(parsed)).toBe(await sha256(JSON.parse(content)))
  expect(parsed.artifacts[0]).not.toBe(parsed.checkpoint.artifacts[0])
  parsed.artifacts[0]!.text = 'changed'
  expect(parsed.checkpoint.artifacts[0]!.text).toBe(text)
  expect(parseStateJson<typeof parsed>(content).artifacts[0]!.text).toBe(text)
  expect(() => parseStateJson('{')).toThrow(SyntaxError)
  const special = '{"__proto__":{"polluted":true},"constructor":"ordinary data"}'
  expect(JSON.stringify(parseStateJson(special))).toBe(special)
  expect(Object.prototype).not.toHaveProperty('polluted')
})

it('shares only immutable string values across independent JSON copies', async () => {
  const strings = new Map<string, string>()
  const source = { nested: [{ text: 'repeated evidence'.repeat(1000) }], empty: '' }
  const before = canonicalJson(source), digest = await sha256(source)
  const first = copyState(source, undefined, strings)
  const second = copyState(JSON.parse(before) as typeof source, undefined, strings)
  expect(strings.size).toBe(2)
  expect(first).toEqual(source)
  expect(second).toEqual(source)
  expect(first.nested).not.toBe(second.nested)
  first.nested[0]!.text = 'changed'
  second.nested.push({ text: 'new' })
  expect(canonicalJson(source)).toBe(before)
  expect(await sha256(source)).toBe(digest)
})

it('copies exactly like the defineProperty copy, including unusual keys and shapes', () => {
  // The copy before plain assignment replaced defineProperty, kept as the reference.
  function historical<T>(value: T, copies = new Map<object, unknown>()): T {
    if (value === null || typeof value !== 'object') return value
    if (copies.has(value)) return copies.get(value) as T
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null) return structuredClone(value)
    const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : {}
    copies.set(value, copy)
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: historical(entry, copies), enumerable: true, writable: true, configurable: true })
    }
    return copy as T
  }
  // Same prototypes, own property descriptors (order included), holes, sharing and cycles.
  function describe(value: unknown, seen = new Map<object, number>()): unknown {
    if (value === null || typeof value !== 'object') return value
    if (seen.has(value)) return { ref: seen.get(value) }
    seen.set(value, seen.size)
    const prototype = Object.getPrototypeOf(value)
    return {
      kind: Array.isArray(value) ? 'array' : prototype === null ? 'null-prototype' : prototype === Object.prototype ? 'object' : 'other',
      json: prototype === Object.prototype || prototype === null || Array.isArray(value) ? undefined : JSON.stringify(value),
      length: Array.isArray(value) ? value.length : undefined,
      properties: Reflect.ownKeys(value).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!
        return [String(key), descriptor.enumerable, descriptor.writable, descriptor.configurable,
          'value' in descriptor ? describe(descriptor.value, seen) : 'accessor']
      }),
    }
  }
  const shared = { s: 'shared' }
  const cyclic: Record<string, unknown> = { a: 1 }
  cyclic.self = cyclic
  const extraArray = Object.assign(['x', , 'z'], { note: 'extra', 7: 'late' })
  const values: unknown[] = [
    JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "toString": "s", "hasOwnProperty": 2, "10": 1, "2": 2, "b": 3}'),
    extraArray, [shared, shared, { again: shared }], cyclic,
    Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, nested: { b: [1, 2] } }),
    Object.defineProperty({ visible: 1 }, 'hidden', { value: 2, enumerable: false }),
    Object.defineProperty({ b: 1 }, 'computed', { get: () => ({ c: 3 }), enumerable: true }),
    { date: new Date('2026-01-01T00:00:00Z'), map: new Map([[1, 2]]) },
    { [Symbol('s')]: 1, plain: [undefined, null, { deep: [[]] }] },
  ]
  for (const value of values) {
    const copy = copyState(value)
    expect(describe(copy)).toEqual(describe(historical(value)))
    if (value !== null && typeof value === 'object') expect(copy).not.toBe(value)
    expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(historical(value)))
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})
