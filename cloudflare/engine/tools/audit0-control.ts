/// <reference types="node" />
import { audit0Request, operationLatency, summarizeStatus } from './audit0-control-lib.js'

const endpoint = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
const token = process.env.CONTROL_API_TOKEN ?? ''
const experimentId = process.env.ACK3_EXPERIMENT_ID ?? ''
if (endpoint === '' || token === '' || experimentId === '') {
  throw new Error('ACK3_ENGINE_URL, CONTROL_API_TOKEN and ACK3_EXPERIMENT_ID are required')
}

const [command, ...args] = process.argv.slice(2)
const operation = audit0Request(command, args, experimentId)
const started = performance.now()
const response = await fetch(`${endpoint}${operation.path}`, {
  method: operation.method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
})
const endToEndMs = performance.now() - started
const text = await response.text()
let result: unknown
try {
  result = JSON.parse(text)
} catch {
  throw new Error(`control API returned non-JSON status ${response.status}`)
}
if (!response.ok) throw new Error(`control API ${response.status}: ${JSON.stringify(result)}`)
if (operation.timingField !== undefined) {
  const record = result as Record<string, unknown>
  result = { ...record, ...operationLatency(operation.timingField, record[operation.timingField], endToEndMs) }
}
console.log(JSON.stringify(command === 'status' ? summarizeStatus(result) : result))
