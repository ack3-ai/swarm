import { expect } from 'vitest'
import { compareText } from '../../src/text-order.js'

/** Every object key and every string value of up to 256 characters in a JSON value. */
export function textValues(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.length <= 256) into.add(value)
  } else if (Array.isArray(value)) {
    for (const item of value) textValues(item, into)
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      into.add(key)
      textValues(item, into)
    }
  }
  return into
}

/** Proof that the shared comparator keeps today's order (C1): it sorts these strings exactly
 * as the Workers default locale (en-US) does and, on an English machine, as plain
 * localeCompare does, with the same result for every neighbouring pair. */
export function expectSameOrder(strings: Iterable<string>): void {
  const values = [...strings]
  const sign = (value: number) => Math.sign(value)
  const comparators = [(left: string, right: string) => left.localeCompare(right, 'en-US')]
  if (new Intl.Collator().resolvedOptions().locale.startsWith('en')) {
    comparators.push((left, right) => left.localeCompare(right))
  }
  for (const order of [values, values.toReversed()]) {
    const shared = order.toSorted(compareText)
    for (const compare of comparators) {
      expect(order.toSorted(compare)).toEqual(shared)
      const differing = shared.slice(1).map((value, index) => [shared[index]!, value] as const)
        .filter(([left, right]) => sign(compare(left, right)) !== sign(compareText(left, right)))
      expect(differing).toEqual([])
    }
  }
}
