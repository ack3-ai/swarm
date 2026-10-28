import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import type { RuntimeRelease } from '../src/contracts.js'
import { runtimeSlotSeedSql } from '../tools/runtime-slot-seed-lib.js'

const release = (id: string, version: string): RuntimeRelease => ({
  schemaVersion: 1, id, frameworkCommit: 'a'.repeat(40), workerService: `swarm-${id}`,
  workflowName: `audit-${id}`, workerVersionId: version, containerImageDigest: `sha256:${'b'.repeat(64)}`,
})

function d1(db: DatabaseSync): D1Database {
  const statement = (query: string, values: SQLInputValue[] = []) => {
    // Node's SQLite binds numbered parameters by name.
    const named = /\?\d+/.test(query) ? Object.fromEntries(values.map((value, i) => [`?${i + 1}`, value])) : null
    const prepared = () => db.prepare(query)
    return {
      bind: (...next: unknown[]) => statement(query, next as SQLInputValue[]),
      first: async () => (named === null ? prepared().get(...values) : prepared().get(named)) ?? null,
      run: async () => ({ meta: { changes: (named === null ? prepared().run(...values) : prepared().run(named)).changes } }),
    }
  }
  return {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<{ run(): Promise<unknown> }>) => {
      for (const item of statements) await item.run()
      return []
    },
  } as unknown as D1Database
}

describe('runtime slot pool bootstrap', () => {
  it('seeds canonical slot rows that the store can lock oldest first', async () => {
    const slots = [release('runtime-01', '11111111-1111-4111-8111-111111111111'),
      release('runtime-02', '22222222-2222-4222-8222-222222222222')]
    const sql = runtimeSlotSeedSql(slots, new Date('2026-10-01T00:00:00Z'))
    const db = new DatabaseSync(':memory:')
    db.exec(sql)
    expect(db.prepare('SELECT slot_id, runtime_release_json, generation FROM runtime_slots ORDER BY deployed_at').all())
      .toEqual(slots.map(slot => ({ slot_id: slot.id, runtime_release_json: canonicalJson(slot), generation: 1 })))
    expect(db.prepare('SELECT enabled, latest_slot_id, rotating_slot_id FROM runtime_slot_control').get())
      .toEqual({ enabled: 1, latest_slot_id: 'runtime-02', rotating_slot_id: null })
    const store = new CloudflareRunStore({} as R2Bucket, {} as R2Bucket, d1(db))
    expect(await store.lockOldestIdleRuntimeSlot('33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ slotId: 'runtime-01', generation: 1, runtimeRelease: slots[0] })
    expect(() => db.exec(sql)).toThrow()
  })

  it('rejects empty, duplicate and malformed identities', () => {
    const at = new Date('2026-10-01T00:00:00Z')
    const slot = release('runtime-01', '11111111-1111-4111-8111-111111111111')
    expect(() => runtimeSlotSeedSql([], at)).toThrow('at least one')
    expect(() => runtimeSlotSeedSql([slot, slot], at)).toThrow('duplicate runtime slot')
    expect(() => runtimeSlotSeedSql([{ ...slot, workerVersionId: undefined }], at)).toThrow()
  })
})
