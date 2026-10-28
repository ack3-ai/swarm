import { describe, expect, it } from 'vitest'
import { resolveTargetEnvironment } from '../src/target-environment.js'

describe('target Cloudflare secret bindings', () => {
  it('maps a descriptive Worker binding to the variable expected by the target', () => {
    expect(resolveTargetEnvironment(
      { API_KEY_ALCHEMY: 'TARGET_TEA_API_KEY_ALCHEMY' },
      { TARGET_TEA_API_KEY_ALCHEMY: 'secret-value' },
    )).toEqual({ API_KEY_ALCHEMY: 'secret-value' })
  })

  it('fails before model work when a configured binding is absent', () => {
    expect(() => resolveTargetEnvironment(
      { API_KEY_ALCHEMY: 'TARGET_TEA_API_KEY_ALCHEMY' },
      {},
    )).toThrow('target runtime Cloudflare secret is missing: TARGET_TEA_API_KEY_ALCHEMY')
  })
})


it('never forwards the runtime monitoring credential as a target secret', () => {
  expect(() => resolveTargetEnvironment({ TARGET_KEY: 'CLOUDFLARE_OBSERVABILITY_TOKEN' },
    { CLOUDFLARE_OBSERVABILITY_TOKEN: 'monitor-secret' })).toThrow('target runtime Cloudflare secret is missing')
})
