import { describe, expect, it } from 'vitest'
// The parser runs inside the Sandbox image as native ESM.
// @ts-expect-error JavaScript container module intentionally has no TS build step.
import { codexProviderFailure, codexUsage } from '../container/codex-usage.mjs'

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

describe('Codex provider failure evidence (P2-06)', () => {
  const failed = (message: string) => [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    // Retries in progress are reported as top-level errors; only the turn's final failure counts.
    JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (stream disconnected before completion: eof)' }),
    JSON.stringify({ type: 'turn.failed', error: { message } }), '',
  ].join('\n')

  it('maps the last failed turn to a provider code and HTTP status for the receipt', () => {
    // Message texts as Codex prints them (checked against the strings of a Codex 0.152 binary).
    for (const [message, code, status] of [
      ['exceeded retry limit, last status: 503 Service Unavailable, request id: abc', 'SERVER', 503],
      ['exceeded retry limit, last status: 529 <unknown status code>', 'SERVER', 529],
      ['exceeded retry limit, last status: 429 Too Many Requests', 'RATE_LIMIT', 429],
      ['unexpected status 502 Bad Gateway: upstream', 'SERVER', 502],
      ['unexpected status 401 Unauthorized: token expired', 'HTTP_401', 401],
      ['stream disconnected before completion: error decoding response body', 'STREAM_CLOSED', null],
      ['stream closed before response.completed', 'STREAM_CLOSED', null],
      ['Error while reading the server response: connection reset', 'TRANSPORT', null],
      ['Connection failed: error sending request', 'TRANSPORT', null],
      ['request timed out', 'TIMEOUT', null],
      ["We're currently experiencing high demand, which may cause temporary errors.", 'SERVER', null],
      ['Selected model is at capacity. Please try a different model.', 'OVERLOADED', null],
    ] as const) {
      expect(codexProviderFailure(failed(message)), message).toEqual({ providerErrorCode: code, providerHttpStatus: status })
    }
  })

  it('reports nothing for a quota, a model or tool failure, or a turn that did not fail', () => {
    for (const message of ["You've hit your usage limit. Upgrade to Pro", 'Quota exceeded. Check your plan and billing details.',
      "Codex ran out of room in the model's context window.", 'timeout waiting for child process to exit', '']) {
      expect(codexProviderFailure(failed(message)), message).toBeNull()
    }
    expect(codexProviderFailure(`${JSON.stringify({ type: 'error', message: 'stream disconnected before completion' })}\n`)).toBeNull()
    expect(codexProviderFailure(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`)).toBeNull()
    expect(codexProviderFailure('not json\n')).toBeNull()
    // A later successful turn clears an earlier failure.
    expect(codexProviderFailure(`${failed('request timed out')}${JSON.stringify({ type: 'turn.completed' })}\n`)).toBeNull()
  })
})
