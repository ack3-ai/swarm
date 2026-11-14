import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { plainCanonicalJson } from '../src/canonical-bytes.js'
import { compareText } from '../src/text-order.js'
import { expectSameOrder, textValues } from './support/text-order.js'

const sealed = new URL('./fixtures/sealed-ca54217e/', import.meta.url)

describe('one text order for digests (C1)', () => {
  it('orders every key and short string of the sealed baseline definitions as before', () => {
    const strings = new Set<string>()
    const files = readdirSync(sealed).filter(name => name.endsWith('.definition.json'))
    expect(files).toHaveLength(4)
    for (const name of files) textValues(JSON.parse(readFileSync(new URL(name, sealed), 'utf8')), strings)
    expect(strings.size).toBeGreaterThan(400)
    expectSameOrder(strings)
  })

  it('writes canonical keys in English order', () => {
    const value = { sealedAt: 1, scope: 2, schemaVersion: 3, hash: 4, cursor: 5, checkpoints: 6 }
    const english = ['checkpoints', 'cursor', 'hash', 'schemaVersion', 'scope', 'sealedAt']
    expect(Object.keys(JSON.parse(canonicalJson(value)))).toEqual(english)
    expect(Object.keys(JSON.parse(plainCanonicalJson(value)!))).toEqual(english)
    expect(plainCanonicalJson({ ...value, skipped() {} })).toBeNull()
    expect(Object.keys(JSON.parse(canonicalJson({ ...value, skipped() {} })))).toEqual(english)
    expect(Object.keys(value).toSorted(compareText)).toEqual(english)
    // A Czech collator would place `ch` after `h`: the shared order does not follow the machine.
    expect(compareText('checkpoints', 'hash')).toBe(new Intl.Collator('en').compare('checkpoints', 'hash'))
    expect(Object.keys(value).toSorted(new Intl.Collator('cs').compare)).not.toEqual(english)
  })
})
