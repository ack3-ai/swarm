import { describe, expect, it } from 'vitest'
import { dashboardThroughput, dashboardTiming } from '../src/dashboard-timing.js'

const usage = { modelCalls: 1, inputTokens: 100, rawInputTokens: 140, cachedInputTokens: 40, outputTokens: 20, costUsd: 0 }
const start = '2026-09-24T12:00:00.000Z'
const finish = '2026-09-24T12:00:10.000Z'
const timing = dashboardTiming(start, finish, false, finish, 'wave')

describe('recorded dashboard throughput', () => {
  it('counts cached input once and separates output throughput', () => {
    expect(dashboardThroughput(usage, timing)).toEqual({ elapsedMs: 10000,
      inputTokensPerSecond: 14, outputTokensPerSecond: 2, totalTokensPerSecond: 16,
      partial: false, provisional: false })
    const { rawInputTokens: _raw, ...withoutRawCounter } = usage
    expect(dashboardThroughput(withoutRawCounter, timing)?.totalTokensPerSecond).toBe(12)
  })

  it('keeps provisional and incomplete accounting explicit', () => {
    expect(dashboardThroughput(usage, timing, true, true)).toMatchObject({ partial: true, provisional: true })
  })

  it('does not turn absent, zero-length or reversed timing into infinite or zero speed', () => {
    for (const elapsedMs of [null, 0, -1, NaN, Infinity]) {
      expect(dashboardThroughput(usage, { ...timing, elapsedMs })).toBeNull()
    }
    expect(dashboardThroughput(usage, undefined)).toBeNull()
    expect(dashboardThroughput({ ...usage, inputTokens: 0, rawInputTokens: 0, outputTokens: 0 }, timing)).toBeNull()
  })
})
