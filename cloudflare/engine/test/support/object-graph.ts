/** Object-graph checks for fixtures restored from snapshots: what two copies share, and whether a
 * copy has the same reference structure (aliases and frozen objects) as the value it copies. */

type Visit = (value: object, path: string) => boolean
/** Visit each object reachable through own properties, Map and Set entries, depth first in a
 * fixed order; `visit` returns false to stop at an object already seen. */
function walk(root: unknown, visit: Visit): void {
  const pending: [unknown, string][] = [[root, '$']]
  while (pending.length > 0) {
    const [value, path] = pending.pop()!
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || !visit(value, path)) continue
    const children: [unknown, string][] = []
    if (value instanceof Map) for (const [key, entry] of value) children.push([key, `${path}<key ${String(key)}>`], [entry, `${path}.get(${String(key)})`])
    if (value instanceof Set) for (const entry of value) children.push([entry, `${path}<entry>`])
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if ('value' in descriptor) children.push([descriptor.value, `${path}.${String(key)}`])
    }
    pending.push(...children.reverse())
  }
}

/** Paths (from `b`) of the objects reachable from both values that are not frozen, so that one
 * holder could change what the other sees. */
export function sharedMutableObjects(a: unknown, b: unknown, allowed: readonly object[] = []): string[] {
  const left = new Set<object>(), shared: string[] = []
  walk(a, value => { if (left.has(value)) return false; left.add(value); return true })
  const right = new Set<object>()
  walk(b, (value, path) => {
    if (right.has(value)) return false
    right.add(value)
    if (left.has(value) && !Object.isFrozen(value) && !allowed.includes(value)) shared.push(path)
    return true
  })
  return shared
}

/** Which objects are frozen and which are reached again through another path. Equal shapes and
 * equal values (`toStrictEqual`) make a copy indistinguishable from what it copies. */
export function referenceShape(root: unknown): string[] {
  const first = new Map<object, string>(), shape: string[] = []
  walk(root, (value, path) => {
    const seen = first.get(value)
    if (seen !== undefined) { shape.push(`${path} is ${seen}`); return false }
    first.set(value, path)
    if (Object.isFrozen(value)) shape.push(`${path} frozen`)
    return true
  })
  return shape
}
