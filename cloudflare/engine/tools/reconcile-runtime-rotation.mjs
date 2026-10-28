import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const intentFile = process.argv[2]
assert.ok(intentFile && resolve(intentFile) === intentFile && process.argv.length === 3,
  'usage: reconcile-runtime-rotation.mjs EXISTING_INTENT_FILE')
const intent = JSON.parse(readFileSync(intentFile, 'utf8'))
assert.match(intent.intent ?? '', /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i)
assert.match(intent.expectedCommit ?? '', /^[0-9a-f]{40}$/)
assert.ok(['lock-request', 'before-upload', 'upload-uncertain', 'uploaded', 'activated']
  .includes(intent.phase), 'publication phase is missing or invalid')
const token = process.env.CONTROL_API_TOKEN
assert.ok(token, 'CONTROL_API_TOKEN is required from Cloudflare Secrets Store')
const base = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
assert.match(base, /^https:\/\//, 'ACK3_ENGINE_URL is required')
async function get(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init, headers: { authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  })
  const body = await response.json()
  assert(response.ok, `reconciliation HTTP ${response.status}: ${path}`)
  return body
}
const path = `/v1/runtime-slots/rotations/${intent.intent}`
const state = await get(path)
if (intent.locked === undefined) {
  assert.equal(intent.phase, 'lock-request', 'lock response is missing after publication began')
  assert.equal(state.lockHeld, true, 'no authoritative held lock for lost lock response')
  intent.locked = { slotId: state.slotId, generation: state.generation,
    runtimeRelease: state.runtimeRelease }
} else assert.equal(state.slotId, intent.locked.slotId)
const observed = await get(`/v1/runtime-slots/${state.slotId}/identity`)
if (state.latest && !state.lockHeld) {
  assert.equal(observed.workerVersionId, state.runtimeRelease.workerVersionId)
  assert.equal(observed.frameworkCommit, intent.expectedCommit)
  intent.outcome = { reconciled: true, alreadyActivated: true,
    slotId: state.slotId, workerVersionId: observed.workerVersionId }
} else {
  assert.equal(state.lockHeld, true, 'rotation is neither active nor selected')
  assert.equal(observed.id, state.slotId)
  if (intent.phase === 'lock-request' || intent.phase === 'before-upload') {
    assert.deepEqual(observed, intent.locked.runtimeRelease,
      'native version changed despite no upload; preserve the lock for investigation')
    const cancelled = await get(`${path}/cancel-unpublished`, { method: 'POST',
      body: JSON.stringify({ expectedGeneration: intent.locked.generation,
        prior: intent.locked.runtimeRelease, ownerProof: 'upload-not-attempted' }) })
    assert.equal(cancelled.cancelled, true)
    intent.phase = 'cancelled'
    intent.outcome = { reconciled: true, cancelledBeforeUpload: true, slotId: state.slotId }
  } else {
  assert.equal(observed.containerImageDigest, intent.expectedImage)
  if (observed.workerVersionId === intent.locked.runtimeRelease.workerVersionId) {
    throw new Error('old Worker version remains live; do not reupload or unlock on an ambiguous publication')
  }
  assert.equal(observed.frameworkCommit, intent.expectedCommit,
    'a different Worker build is live; preserve lock for investigation')
  if (intent.publishedVersion !== undefined) {
    assert.equal(observed.workerVersionId, intent.publishedVersion)
  }
  const activated = await get(`${path}/activate`, { method: 'POST', body: JSON.stringify({
    expectedGeneration: intent.locked.generation,
    prior: intent.locked.runtimeRelease,
    expectedCommit: intent.expectedCommit,
  }) })
  assert.equal(activated.runtimeRelease.workerVersionId, observed.workerVersionId)
  const selected = await get(path)
  assert.equal(selected.latest, true)
  assert.equal(selected.lockHeld, false)
  intent.outcome = { reconciled: true, activatedAfterUnknownResult: true,
    slotId: state.slotId, workerVersionId: observed.workerVersionId }
  intent.phase = 'activated'
  }
}
const temporary = `${intentFile}.${randomUUID()}.tmp`
try {
  writeFileSync(temporary, JSON.stringify(intent, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, intentFile)
} finally { rmSync(temporary, { force: true }) }
console.log(JSON.stringify(intent.outcome))
