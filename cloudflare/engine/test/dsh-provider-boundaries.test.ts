import { describe, expect, it } from 'vitest'
import agentRunner from '../container/agent-runner.mjs?raw'
import { classifyDeepSeekUnavailability } from '../src/deepseek-provider.js'

describe('DSH provider boundaries', () => {
  it('uses native DSH JSON events without a local broker', () => {
    expect(agentRunner).toContain("'--profile', 'native-worker', '--json'")
    expect(agentRunner).toContain('dshUsage(execution.stdout)')
    expect(agentRunner).not.toContain('DEEPSEEK_BROKER_TOKEN')
    expect(agentRunner).not.toContain('DEEPSEEK_BASE_URL')
  })

  it('turns payment-required evidence into additive unavailability', () => {
    expect(classifyDeepSeekUnavailability({
      exitCode: 1,
      providerHttpStatus: 402,
      providerErrorCode: 'insufficient_balance',
    })).toBe('provider-credit')
  })

  it('does not misclassify rate limits or upstream failures as exhausted credit', () => {
    expect(classifyDeepSeekUnavailability({
      exitCode: 1,
      providerHttpStatus: 429,
      providerErrorCode: 'rate_limit_exceeded',
    })).toBeNull()
    expect(classifyDeepSeekUnavailability({
      exitCode: 1,
      providerHttpStatus: 503,
      providerErrorCode: 'server_error',
    })).toBeNull()
  })
})
