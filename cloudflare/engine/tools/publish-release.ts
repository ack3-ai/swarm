/// <reference types="node" />
import { loadAuditConfig } from './load-audit-config.js'

const [configPath, expectedGenerationText] = process.argv.slice(2)
const endpoint = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
const token = process.env.CONTROL_API_TOKEN ?? ''
let expectedGeneration = expectedGenerationText === undefined ? undefined : Number(expectedGenerationText)
if (configPath === undefined || endpoint === '' || token === '' || (expectedGeneration !== undefined
  && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0))) {
  throw new Error('usage: ACK3_ENGINE_URL=... CONTROL_API_TOKEN=... pnpm release:publish EXPERIMENT_JSON [EXPECTED_GENERATION]')
}
const body = await loadAuditConfig(configPath)
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const experimentId = body.definition.id
if (expectedGeneration === undefined) {
  const current = await fetch(`${endpoint}/v1/experiments/${encodeURIComponent(experimentId)}/release`, { headers })
  const pointer = await current.json() as { generation?: unknown }
  if (!current.ok || !Number.isSafeInteger(pointer.generation)) throw new Error(`release pointer read failed: ${JSON.stringify(pointer)}`)
  expectedGeneration = pointer.generation as number
}
const started = performance.now()
const uploaded = await fetch(`${endpoint}/v1/releases`, { method: 'POST', headers, body: JSON.stringify(body) })
const uploadResult = await uploaded.json() as { digest?: unknown }
if (!uploaded.ok || typeof uploadResult.digest !== 'string') throw new Error(`release upload failed: ${JSON.stringify(uploadResult)}`)
const activated = await fetch(`${endpoint}/v1/experiments/${encodeURIComponent(experimentId)}/activate`, {
  method: 'POST', headers, body: JSON.stringify({ digest: uploadResult.digest, expectedGeneration }),
})
const activation = await activated.json() as { activationMs?: unknown }
if (!activated.ok) throw new Error(`release activation failed: ${JSON.stringify(activation)}`)
const endToEndMs = performance.now() - started
if (typeof activation.activationMs !== 'number' || !Number.isFinite(activation.activationMs)) {
  throw new Error('activation timing is missing from the control response')
}
const latencyTargetMs = 1_000
console.log(JSON.stringify({
  ...activation,
  uploadAndActivationMs: endToEndMs,
  latencyTargetMs,
  uploadAndActivationTargetMet: activation.activationMs < latencyTargetMs && endToEndMs < latencyTargetMs,
}))
