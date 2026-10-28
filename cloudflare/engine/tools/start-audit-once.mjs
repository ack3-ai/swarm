import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const name = /^[a-z0-9][a-z0-9._-]{0,99}$/
const digest = /^[0-9a-f]{64}$/

async function read(url, token, init = {}) {
  const response = await fetch(url, { ...init,
    headers: { authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
  })
  const body = await response.json()
  return { status: response.status, body }
}

export async function startAuditOnce({ runId, experimentId, releaseDigest,
  runtimeId, intentFile, start = performance.now() }) {
  for (const value of [runId, experimentId, runtimeId]) assert.match(value ?? '', name)
  assert.match(releaseDigest ?? '', digest)
  assert.ok(intentFile && resolve(intentFile) === intentFile && !existsSync(intentFile),
    'fresh absolute owner-only intent file required')
  const token = process.env.CONTROL_API_TOKEN
  assert.ok(token, 'CONTROL_API_TOKEN is required from Cloudflare Secrets Store')
  const base = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
  assert.match(base, /^https:\/\//, 'ACK3_ENGINE_URL is required')
  // Optional delivery deadline, measured through production verification.
  const deadline = process.env.ACK3_DEPLOY_DEADLINE_MS
  const deadlineMs = deadline === undefined ? undefined : Number(deadline)
  assert.ok(deadlineMs === undefined || (Number.isSafeInteger(deadlineMs) && deadlineMs > 0),
    'ACK3_DEPLOY_DEADLINE_MS must be a positive integer when set')
  const pointer = await read(`${base}/v1/experiments/${experimentId}/release`, token)
  assert.equal(pointer.status, 200)
  assert.equal(pointer.body.digest, releaseDigest)
  assert.deepEqual(pointer.body.runtimeSelector, { mode: 'release', id: runtimeId },
    'the active release must be pinned to the requested runtime slot')
  const identity = await read(`${base}/v1/runtime-slots/${runtimeId}/identity`, token)
  assert.equal(identity.status, 200)
  assert.equal(identity.body.id, runtimeId)
  const intent = { at: new Date().toISOString(), runId, experimentId,
    releaseDigest, runtimeId, pointerGeneration: pointer.body.generation,
    runtimeRelease: identity.body,
    outcome: 'unknown', note: 'One dispatch; reconcile exact run ID after ambiguity.' }
  writeFileSync(intentFile, JSON.stringify(intent, null, 2) + '\n',
    { mode: 0o600, flag: 'wx' })
  const dispatch = await read(`${base}/v1/experiments/${experimentId}/runs`, token, {
    method: 'POST', body: JSON.stringify({ runId, expectedReleaseDigest: releaseDigest,
      expectedGeneration: pointer.body.generation, expectedRuntimeRelease: identity.body }),
  })
  if (dispatch.status !== 202) {
    throw new Error(`audit dispatch HTTP ${dispatch.status}; inspect exact intent before any retry`)
  }
  assert.equal(dispatch.body.runId, runId)
  assert.equal(dispatch.body.releaseDigest, releaseDigest)
  assert.deepEqual(dispatch.body.runtimeRelease, identity.body)
  assert.equal(dispatch.body.reusedReservation, undefined,
    'run ID was previously reserved; do not count it as a fresh launch')
  intent.dispatch = dispatch.body
  writeFileSync(intentFile, JSON.stringify(intent, null, 2) + '\n', { mode: 0o600 })
  let observed
  do {
    const result = await read(`${base}/v1/runs/${runId}`, token)
    if (result.status === 200) {
      observed = result.body
      if (observed.state?.releaseDigest === releaseDigest
        && isDeepStrictEqual(observed.runtimeRelease, identity.body)
        && observed.workflow?.status === 'running') break
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  } while (performance.now() + 100 < start + (deadlineMs ?? 30_000))
  assert.equal(observed?.state?.releaseDigest, releaseDigest,
    'audit state not yet verified; do not redispatch')
  assert.deepEqual(observed?.runtimeRelease, identity.body,
    'audit runtime differs from exact pinned release')
  assert.equal(observed?.workflow?.status, 'running',
    'durable audit Workflow not observed running; do not redispatch')
  const elapsedMs = performance.now() - start
  const proof = { runId, releaseDigest, runtimeId,
    generation: observed.state.stateGeneration, workflow: observed.workflow.status,
    elapsedMs, deadlineMs: deadlineMs ?? null, withinDeadline: deadlineMs === undefined ? null : elapsedMs < deadlineMs }
  intent.outcome = proof
  writeFileSync(intentFile, JSON.stringify(intent, null, 2) + '\n', { mode: 0o600 })
  if (proof.withinDeadline === false) throw new Error(`audit started but the ${deadlineMs} ms deadline was missed`)
  return proof
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 7,
    'usage: start-audit-once.mjs RUN_ID EXPERIMENT_ID RELEASE_DIGEST RUNTIME_ID INTENT_FILE')
  const [runId, experimentId, releaseDigest, runtimeId, intentFile] = process.argv.slice(2)
  console.log(JSON.stringify(await startAuditOnce({ runId, experimentId,
    releaseDigest, runtimeId, intentFile, start: 0 })))
}
