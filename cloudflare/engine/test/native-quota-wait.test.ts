import { expect, it } from 'vitest'
import { nativeQuotaWait } from '../src/native-quota-wait.js'
import { sha256 } from '../src/canonical.js'

it('binds native quota wait to its rejected session/window and clears it on continuation', async () => {
  const rejection = { type: 'rate_limit_event', session_id: 'fixture-session-001',
    rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1767398400 } }
  const result = { type: 'result', is_error: true, session_id: 'fixture-session-001' }
  const wait = { type: 'subscription_wait_started', provider: 'claude', sessionId: 'fixture-session-001',
    startedAt: '2026-01-01T00:00:00Z', resetsAt: '2026-01-03T00:00:00Z' }
  const stream = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n'
  expect(await nativeQuotaWait(stream(rejection, result, wait))).toEqual({ provider: 'claude', sessionId: wait.sessionId,
    window: 'seven_day', startedAt: wait.startedAt, resetsAt: new Date(wait.resetsAt).toISOString(),
    rejectionDigest: await sha256(rejection), resultDigest: await sha256(result), waitDigest: await sha256(wait), waitCapture: 'complete' })
  expect(await nativeQuotaWait(stream(wait))).toBeNull()
  const marker = '{"type":"subscription_wait_started","provider":"claude","sessionId":"fixture-'
  const partial = await nativeQuotaWait(stream(rejection, result) + marker)
  expect(partial).toMatchObject({ waitCapture: 'partial', startedAt: null, sessionId: 'fixture-session-001',
    resetsAt: new Date(wait.resetsAt).toISOString(), rejectionDigest: await sha256(rejection), resultDigest: await sha256(result), waitDigest: await sha256(marker) })
  expect(await nativeQuotaWait(stream(rejection) + marker)).toBeNull()
  expect(await nativeQuotaWait(stream(rejection, result) + marker + 'wrong')).toBeNull()
  expect(await nativeQuotaWait(stream(rejection, result, { ...wait, sessionId: 'different-session' }))).toBeNull()
  expect(await nativeQuotaWait(stream(rejection, result, { ...wait, resetsAt: '2026-01-04T00:00:00Z' }))).toBeNull()
  expect(await nativeQuotaWait(stream(rejection, result, wait, { type: 'subscription_wait' }))).toBeNull()
  expect(await nativeQuotaWait(stream(rejection, result, wait, { type: 'claude_query_started' }))).toBeNull()
})
