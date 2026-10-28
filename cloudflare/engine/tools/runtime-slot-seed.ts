/// <reference types="node" />
import { runtimeSlotSeedSql } from './runtime-slot-seed-lib.js'

const endpoint = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
const token = process.env.CONTROL_API_TOKEN ?? ''
if (endpoint === '' || token === '') throw new Error('ACK3_ENGINE_URL and CONTROL_API_TOKEN are required')
const slots = process.argv.slice(2)
if (slots.length === 0) throw new Error('usage: pnpm slots:seed-sql OLDEST_RUNTIME_ID ... LATEST_RUNTIME_ID')

// Probe each deployed runtime through the front door's static catalog.
const identities = []
for (const slot of slots) {
  const response = await fetch(`${endpoint}/v1/runtime-slots/${encodeURIComponent(slot)}/identity`, {
    headers: { authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`runtime slot identity ${slot}: HTTP ${response.status}`)
  identities.push(await response.json())
}
process.stdout.write(runtimeSlotSeedSql(identities, new Date()))
