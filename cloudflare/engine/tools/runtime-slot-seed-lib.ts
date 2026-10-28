import { canonicalJson } from '../src/canonical.js'
import type { RuntimeRelease } from '../src/contracts.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { assertRuntimeRelease } from '../src/runtime-release.js'

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`

// Initial rows for the rotating runtime pool. Slots are listed oldest first and
// the last one becomes the latest slot. Plain INSERTs refuse to replace an
// existing pool.
export function runtimeSlotSeedSql(releases: readonly unknown[], at: Date): string {
  if (releases.length === 0) throw new Error('at least one runtime slot identity is required')
  const ids = new Set<string>()
  const rows = releases.map((release, index) => {
    assertRuntimeRelease(release, `runtime slot ${index + 1}`)
    if (ids.has(release.id)) throw new Error(`duplicate runtime slot: ${release.id}`)
    ids.add(release.id)
    const deployedAt = new Date(at.getTime() + index * 1_000).toISOString()
    return `INSERT INTO runtime_slots (slot_id, runtime_release_json, generation, deployed_at) VALUES (${
      quote(release.id)}, ${quote(canonicalJson(release))}, 1, ${quote(deployedAt)});`
  })
  const latest = (releases.at(-1) as RuntimeRelease).id
  return [
    ...ROUTING_SCHEMA_SQL.map(sql => `${sql};`),
    ...rows,
    `INSERT INTO runtime_slot_control (singleton, enabled, latest_slot_id, updated_at) VALUES (1, 1, ${
      quote(latest)}, ${quote(at.toISOString())});`,
  ].join('\n') + '\n'
}
