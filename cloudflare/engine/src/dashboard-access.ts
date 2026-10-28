import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

// Identity of the Terraform-managed dashboard Access application, rendered into
// the front door. Never derive the issuer, audience, or key URL from a request or token.
type DashboardAccessConfig = {
  DASHBOARD_ACCESS_ISSUER?: string
  DASHBOARD_ACCESS_AUDIENCE?: string
  // Comma-separated addresses (user@example.com) or domains (@example.com).
  DASHBOARD_ACCESS_EMAILS?: string
}
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export async function dashboardAccessAllowed(
  request: Request, keys?: JWTVerifyGetKey, config: DashboardAccessConfig = {},
): Promise<boolean> {
  const assertion = request.headers.get('cf-access-jwt-assertion')
  if (!assertion || assertion.length > 16_384) {
    console.warn('dashboard_access_denied', { reason: 'missing_or_oversized_assertion' })
    return false
  }
  try {
    const { DASHBOARD_ACCESS_ISSUER: issuer = '', DASHBOARD_ACCESS_AUDIENCE: audience = '' } = config
    const allowed = (config.DASHBOARD_ACCESS_EMAILS ?? '').split(',').map(entry => entry.trim().toLowerCase())
      .filter(entry => /^[^@\s]*@[^@\s]+$/.test(entry))
    if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)
      || !/^[a-f0-9]{64}$/.test(audience) || allowed.length === 0) throw new Error('Invalid dashboard Access configuration')
    if (keys === undefined) {
      if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
        timeoutDuration: 5_000,
      }))
      keys = keySets.get(issuer)!
    }
    const { payload } = await jwtVerify(assertion, keys, {
      issuer, audience,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'iat', 'sub', 'email', 'type'],
    })
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    const domain = email.slice(email.indexOf('@'))
    if (payload.type === 'app' && /^[^@\s]+@[^@\s]+$/.test(email)
      && (allowed.includes(email) || allowed.includes(domain))) return true
    console.warn('dashboard_access_denied', { reason: 'identity_not_allowed' })
  } catch {
    console.warn('dashboard_access_denied', { reason: 'invalid_access_assertion' })
  }
  return false
}

export function monitoringRequestFromDashboard(request: Request): Request | null {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/dashboard/api/')) return null
  url.pathname = `/v1/monitor/${url.pathname.slice('/dashboard/api/'.length)}`
  return new Request(url, request)
}
