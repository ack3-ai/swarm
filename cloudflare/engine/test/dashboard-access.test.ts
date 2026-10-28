import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { dashboardAccessAllowed, monitoringRequestFromDashboard } from '../src/dashboard-access.js'

let privateKey: CryptoKey
let otherPrivateKey: CryptoKey
let keys: ReturnType<typeof createLocalJWKSet>
const config = {
  DASHBOARD_ACCESS_ISSUER: 'https://example-team.cloudflareaccess.com',
  DASHBOARD_ACCESS_AUDIENCE: 'a'.repeat(64),
  DASHBOARD_ACCESS_EMAILS: '@example.com, auditor@partner.example',
}
const request = (assertion?: string) => new Request('https://swarm.example.workers.dev/dashboard', {
  headers: assertion ? { 'cf-access-jwt-assertion': assertion } : {},
})
async function signed(changes: Record<string, unknown> = {}, key = privateKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ iss: config.DASHBOARD_ACCESS_ISSUER, aud: [config.DASHBOARD_ACCESS_AUDIENCE],
    sub: 'fixture-user', type: 'app', email: 'operator@example.com', iat: now, exp: now + 300, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).sign(key)
}

describe('dashboard Access boundary', () => {
  beforeAll(async () => {
    const pair = await generateKeyPair('RS256')
    privateKey = pair.privateKey
    otherPrivateKey = (await generateKeyPair('RS256')).privateKey
    keys = createLocalJWKSet({ keys: [{ ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256' }] })
  })
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))
  afterEach(() => vi.restoreAllMocks())

  it('accepts a signed dashboard session without requiring ctx.access', async () => {
    expect(await dashboardAccessAllowed(request(await signed()), keys, config)).toBe(true)
    expect(await dashboardAccessAllowed(request(await signed({ email: 'OPERATOR@EXAMPLE.COM' })), keys, config)).toBe(true)
    expect(await dashboardAccessAllowed(request(await signed({ email: 'auditor@partner.example' })), keys, config)).toBe(true)
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>]>([
    ['wrong audience', { aud: ['another-application'] }],
    ['wrong issuer', { iss: 'https://another-team.cloudflareaccess.com' }],
    ['expired', { exp: 1 }],
    ['not yet valid', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
    ['missing expiry', { exp: undefined }],
    ['missing subject', { sub: undefined }],
    ['missing email', { email: undefined }],
    ['outside organization', { email: 'operator@elsewhere.example' }],
    ['unlisted address at a listed address domain', { email: 'other@partner.example' }],
    ['lookalike domain', { email: 'operator@example.com.attacker.example' }],
    ['non-string email', { email: ['operator@example.com'] }],
    ['login metadata instead of application token', { type: 'meta' }],
  ])('denies a %s token', async (_label, claims) => {
    expect(await dashboardAccessAllowed(request(await signed(claims)), keys, config)).toBe(false)
  })

  it.each([
    {},
    { ...config, DASHBOARD_ACCESS_ISSUER: undefined },
    { ...config, DASHBOARD_ACCESS_AUDIENCE: undefined },
    { ...config, DASHBOARD_ACCESS_EMAILS: undefined },
    { ...config, DASHBOARD_ACCESS_EMAILS: 'example.com' },
    { ...config, DASHBOARD_ACCESS_ISSUER: 'http://example-team.cloudflareaccess.com' },
    { ...config, DASHBOARD_ACCESS_ISSUER: 'https://attacker.example.com' },
  ])('fails closed before key lookup for incomplete or invalid deployment configuration', async invalid => {
    const resolveKey = vi.fn(keys)
    expect(await dashboardAccessAllowed(request(await signed()), resolveKey, invalid)).toBe(false)
    expect(resolveKey).not.toHaveBeenCalled()
  })

  it('rejects signatures from an untrusted key and unsigned assertions', async () => {
    expect(await dashboardAccessAllowed(request(await signed({}, otherPrivateKey)), keys, config)).toBe(false)
    const header = btoa(JSON.stringify({ alg: 'none' }))
    const payload = btoa(JSON.stringify({ email: 'operator@example.com' }))
    expect(await dashboardAccessAllowed(request(`${header}.${payload}.`), keys, config)).toBe(false)
  })

  it('denies missing/malformed assertions and does not trust email headers or cookies alone', async () => {
    const resolveKey = vi.fn(keys)
    expect(await dashboardAccessAllowed(request(), resolveKey, config)).toBe(false)
    expect(await dashboardAccessAllowed(request('x'.repeat(16_385)), resolveKey, config)).toBe(false)
    expect(resolveKey).not.toHaveBeenCalled()
    expect(await dashboardAccessAllowed(new Request('https://swarm.example.workers.dev/dashboard', {
      headers: { 'cf-access-authenticated-user-email': 'operator@example.com', cookie: 'CF_Authorization=not-a-token' },
    }), keys, config)).toBe(false)
    expect(await dashboardAccessAllowed(request('invalid'), keys, config)).toBe(false)
  })

  it('fails closed on key lookup failures without logging tokens, identities or provider errors', async () => {
    const assertion = await signed()
    expect(await dashboardAccessAllowed(request(assertion), async () => { throw new Error('private lookup detail') }, config)).toBe(false)
    expect(console.warn).toHaveBeenCalledExactlyOnceWith('dashboard_access_denied', { reason: 'invalid_access_assertion' })
  })

  it('maps only the protected dashboard API to the existing read-only monitor routes', () => {
    const input = new Request('https://swarm.example.workers.dev/dashboard/api/runs/run-a?view=full')
    expect(monitoringRequestFromDashboard(input)?.url).toBe('https://swarm.example.workers.dev/v1/monitor/runs/run-a?view=full')
    expect(monitoringRequestFromDashboard(new Request('https://swarm.example.workers.dev/v1/monitor/runs'))).toBeNull()
  })
})
