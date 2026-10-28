import { describe, expect, it } from 'vitest'
// The parser runs inside the Sandbox image as native ESM.
// @ts-expect-error JavaScript container module intentionally has no TS build step.
import { codexUsage } from '../container/codex-usage.mjs'

describe('Codex provider usage accounting', () => {
  it('budgets uncached input plus output rather than cached top-level input', () => {
    const stdout = `${JSON.stringify({
      type: 'turn.completed', thread_id: 'thread-1',
      usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 12 },
    })}\n`
    expect(codexUsage(stdout)).toEqual({
      inputTokens: 20, rawInputTokens: 100, cachedInputTokens: 80,
      outputTokens: 12, actorId: 'thread-1', cacheAccountingComplete: true,
    })
  })

  it('accepts nested cache details emitted by OpenAI-compatible usage', () => {
    const stdout = `${JSON.stringify({ response: { usage: {
      input_tokens: 40, input_tokens_details: { cached_tokens: 25 }, output_tokens: 3,
    } } })}\n`
    expect(codexUsage(stdout)).toMatchObject({
      inputTokens: 15, rawInputTokens: 40, cachedInputTokens: 25, outputTokens: 3,
      cacheAccountingComplete: true,
    })
  })

  it('conservatively counts all input when cache evidence is absent or invalid', () => {
    const missing = codexUsage(`${JSON.stringify({ usage: { input_tokens: 30, output_tokens: 2 } })}\n`)
    const invalid = codexUsage(`${JSON.stringify({ usage: {
      input_tokens: 30, cached_input_tokens: 31, output_tokens: 2,
    } })}\n`)
    expect(missing).toMatchObject({ inputTokens: 30, cachedInputTokens: 0, cacheAccountingComplete: false })
    expect(invalid).toMatchObject({ inputTokens: 30, cachedInputTokens: 0, cacheAccountingComplete: false })
  })

  it('keeps raw, cached, and uncached counters from one cumulative usage record', () => {
    const stdout = [
      { usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2 } },
      { usage: { input_tokens: 60, output_tokens: 5 } },
    ].map(value => JSON.stringify(value)).join('\n')
    expect(codexUsage(stdout)).toMatchObject({
      inputTokens: 60, rawInputTokens: 60, cachedInputTokens: 0,
      outputTokens: 5, cacheAccountingComplete: false,
    })
  })
})
