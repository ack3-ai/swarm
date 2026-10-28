import assert from 'node:assert/strict'
import test from 'node:test'
import { dshCost } from '../container/dsh-cost.mjs'
import { dshUsage } from '../container/dsh-usage.mjs'
import { dshNativeSearchAttempted } from '../container/native-search-evidence.mjs'

const rates = {
  uncachedInputUsdPerMillion: 2,
  cachedInputUsdPerMillion: 0.5,
  outputUsdPerMillion: 5,
}

test('prices complete uncached, cached, and output tokens once', () => {
  assert.deepEqual(dshCost({ rawInputTokens: 5_000, cachedInputTokens: 1_000,
    outputTokens: 44, usageComplete: true, cacheAccountingComplete: true }, rates), {
    costUsd: 0.00872, costAccountingComplete: true,
  })
})

test('includes cache writes in uncached input and prices only cache reads at the cache rate', () => {
  const events = [
    { type: 'session', sessionId: 'fixture-session' },
    { type: 'status', phase: 'step_end', turn: 1, step: 0,
      usage: { inputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2,
        outputTokens: 1, totalTokens: 10 } },
    { type: 'final', text: 'done' },
  ]
  const usage = dshUsage(events.map(event => JSON.stringify(event)).join('\n'))
  assert.equal(usage.rawInputTokens, 9)
  assert.equal(usage.cachedInputTokens, 3)
  assert.deepEqual(dshCost(usage, rates), { costUsd: 0.0000185,
    costAccountingComplete: true })
  assert.deepEqual(dshCost(usage, rates, true), { costUsd: 0.0000185,
    costAccountingComplete: false })
})

test('DSH tasks disclose separate search cost only when search was attempted', () => {
  const usage = { rawInputTokens: 5_000, cachedInputTokens: 1_000,
    outputTokens: 44, usageComplete: true, cacheAccountingComplete: true }
  for (const [events, complete] of [
    [[{ type: 'final', text: 'done without search' }], true],
    [[{ type: 'tool_call', tool: 'mcp__exa__web_search_exa', input: { query: 'public topic' } },
      { type: 'tool_result', status: 'completed', result: 'Sources: public' }], false],
    [[{ type: 'tool_call', tool: 'mcp__exa__web_search_exa', input: { query: 'public topic' } },
      { type: 'tool_result', status: 'error', result: 'Error: backend timeout' }], false],
  ]) {
    const stdout = events.map(event => JSON.stringify(event)).join('\n')
    const result = dshCost(usage, rates, dshNativeSearchAttempted(stdout))
    assert.equal(result.costUsd, 0.00872)
    assert.equal(result.costAccountingComplete, complete)
  }
})

test('does not price missing retry or cache samples as a complete estimate', () => {
  assert.deepEqual(dshCost({ rawInputTokens: 5_000, cachedInputTokens: 1_000,
    outputTokens: 44, usageComplete: false, cacheAccountingComplete: true }, rates), {
    costUsd: 0, costAccountingComplete: false,
  })
  assert.deepEqual(dshCost({ rawInputTokens: 5_000, cachedInputTokens: 1_000,
    outputTokens: 44, usageComplete: true, cacheAccountingComplete: false }, rates), {
    costUsd: 0, costAccountingComplete: false,
  })
})

test('unknown rates or invalid token partitions cannot be presented as complete', () => {
  const usage = { rawInputTokens: 5_000, cachedInputTokens: 1_000,
    outputTokens: 44, usageComplete: true, cacheAccountingComplete: true }
  assert.deepEqual(dshCost(usage), { costUsd: 0, costAccountingComplete: false })
  assert.deepEqual(dshCost({ ...usage, cachedInputTokens: 6_000 }, rates),
    { costUsd: 0, costAccountingComplete: false })
})
