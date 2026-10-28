import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dshUsage } from '../container/dsh-usage.mjs'
import { renderDshReasoningPatch, codexExaConfig, exaSourceLabel } from '../container/reasoning-config.mjs'

const session = { type: 'session', sessionId: 'fixture-session' }
const final = { type: 'final', text: 'done' }
const end = (step, usage) => ({ type: 'status', phase: 'step_end', turn: 1, step, usage })
const parse = (...events) => dshUsage(events.map(event => JSON.stringify(event)).join('\n'))

test('sums step usage, includes cache input, and ignores duplicate events and final text', () => {
  const one = end(0, { inputTokens: 70, cacheReadTokens: 30, outputTokens: 5, totalTokens: 105 })
  const two = end(1, { inputTokens: 180, cacheReadTokens: 20, outputTokens: 10, totalTokens: 210 })
  assert.deepEqual(parse(session, one, two, two, final), {
    actorId: 'fixture-session', inputTokens: 250, rawInputTokens: 300,
    cachedInputTokens: 50, outputTokens: 15, usageComplete: true, cacheAccountingComplete: true,
    providerHttpStatus: null, providerErrorCode: null,
  })
})

test('retains aggregate usage when a retry omitted the cache breakdown', () => {
  const result = parse(session, end(0, { inputTokens: 70, outputTokens: 5, totalTokens: 105 }), final)
  assert.equal(result.inputTokens, 100)
  assert.equal(result.usageComplete, true)
  assert.equal(result.cacheAccountingComplete, false)
})

test('retains all input when only some steps report cache reads', () => {
  const result = parse(session,
    end(0, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 3, totalTokens: 103 }),
    end(1, { inputTokens: 20, outputTokens: 2, totalTokens: 22 }), final)
  assert.deepEqual(result, {
    actorId: 'fixture-session', inputTokens: 120, rawInputTokens: 120,
    cachedInputTokens: 90, outputTokens: 5, usageComplete: true, cacheAccountingComplete: false,
    providerHttpStatus: null, providerErrorCode: null,
  })
})

test('unfinished usage preserves known cache reads without subtracting them', () => {
  const completed = end(0, { inputTokens: 10, cacheReadTokens: 90, outputTokens: 3, totalTokens: 103 })
  for (const tail of [[], [end(1), final],
    [{ type: 'status', phase: 'step_start', turn: 1, step: 1 }, final]]) {
    const result = parse(session, completed, ...tail)
    assert.equal(result.inputTokens, 100)
    assert.equal(result.rawInputTokens, 100)
    assert.equal(result.cachedInputTokens, 90)
    assert.equal(result.outputTokens, 3)
    assert.equal(result.usageComplete, false)
    assert.equal(result.cacheAccountingComplete, false)
  }
})

test('unknown retry usage and unfinished steps leave known usage explicitly incomplete', () => {
  for (const missing of [end(1), { type: 'status', phase: 'step_start', turn: 1, step: 1 }]) {
    const result = parse(session, end(0, { inputTokens: 100, outputTokens: 5 }), missing, final)
    assert.equal(result.inputTokens, 100)
    assert.equal(result.usageComplete, false)
    assert.equal(result.cacheAccountingComplete, false)
  }
  assert.equal(dshUsage(JSON.stringify(session) + '\n{"type":').usageComplete, false)
  assert.equal(parse(session, end(0, { inputTokens: 100, outputTokens: 5 })).usageComplete, false)
})

test('invalid counters and conflicting replays cannot inflate usage', () => {
  for (const usage of [{ inputTokens: -1, outputTokens: 10 }, { inputTokens: 1.5, outputTokens: 3 },
    { inputTokens: 100, outputTokens: 5, totalTokens: 4 },
    { inputTokens: 70, cacheReadTokens: 30, outputTokens: 5, totalTokens: 1000 }]) {
    const result = parse(session, end(0, usage), final)
    assert.equal(result.inputTokens, 0)
    assert.equal(result.usageComplete, false)
  }
  const conflict = parse(session, end(0, { inputTokens: 100, outputTokens: 5 }), end(0, { inputTokens: 900, outputTokens: 5 }), final)
  assert.equal(conflict.inputTokens, 100)
  assert.equal(conflict.usageComplete, false)
})

test('connection configuration quotes model IDs and rejects credentials embedded in URLs', () => {
  const input = { thinking: 'disabled', reasoningEffort: 'none', model: 'provider/model',
    connection: { baseUrl: 'https://example.com/v1/', apiKeyEnv: 'PROVIDER_API_KEY' } }
  const patch = renderDshReasoningPatch(input)
  assert.match(patch, /baseURL: "https:\/\/example.com\/v1"/)
  assert.match(patch, /model: "provider\/model"/)
  assert.match(patch, /id: session-log-deepseek\n  disabled: true/)
  assert.match(patch, /id: plugin-package-inventory-deepseek\n  disabled: true/)
  for (const apiKeyEnv of ['CONTROL_API_TOKEN', 'ACK3_CODEX_AUTH_JSON']) {
    assert.throws(() => renderDshReasoningPatch({ ...input, connection: { ...input.connection, apiKeyEnv } }))
  }
  for (const baseUrl of ['https://user:key@example.com', 'https://example.com?key=secret', 'http://example.com', 'file:///tmp']) {
    assert.throws(() => renderDshReasoningPatch({ ...input, connection: { ...input.connection, baseUrl } }))
  }
})

test('native DSH disables direct search and fetch even without an MCP connection', () => {
  const input = { thinking: 'enabled', reasoningEffort: 'max', model: 'deepseek-v4-flash',
    connection: { baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY' } }
  const patch = renderDshReasoningPatch(input)
  assert.match(patch, /- id: tool-web\n  disabled: true/)
  assert.match(patch, /- id: web-search-deepseek\n  disabled: true/)
  assert.throws(() => renderDshReasoningPatch({ ...input, searchConnection: {
    baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY', model: 'deepseek-v4-flash',
  } }))
})

test('native DSH behavior is identical after replacing only endpoint, key and model data', () => {
  const input = { provider: 'provider-a', thinking: 'enabled', reasoningEffort: 'max', model: 'fixture/model',
    connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' } }
  const patch = renderDshReasoningPatch(input)
  assert.match(patch, /mode: normal\n          maxRetries: 6/)
  assert.match(patch, /initialDelayMs: 2500\n            maxDelayMs: 3600000\n            jitterRatio: 0.2/)
  const providerBInput = { ...input, provider: 'provider-b', model: 'deepseek-v4-flash',
    connection: { baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY' } }
  const providerB = renderDshReasoningPatch(providerBInput)
  const normalize = (value, configuration) => value
    .replaceAll(JSON.stringify(configuration.connection.baseUrl), '"ENDPOINT"')
    .replaceAll(JSON.stringify(configuration.connection.apiKeyEnv), '"KEY_ENV"')
    .replaceAll(JSON.stringify(configuration.model), '"MODEL"')
  assert.equal(normalize(providerB, providerBInput), normalize(patch, input))
  for (const provider of [undefined, 'deepseek', 'provider-c', 'other']) {
    assert.equal(renderDshReasoningPatch({ ...input, provider }), patch)
  }
})


const attribution = { agent: 'deepseek', stage: 'discovery', wave: 'wave-1', task: 'research-2' }

test('uses the official authenticated Exa MCP with scoped attribution in both native harnesses', () => {
  const input = { thinking: 'enabled', reasoningEffort: 'max', model: 'deepseek-v4-flash',
    connection: { baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY' },
    searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' }, searchAttribution: attribution }
  const patch = renderDshReasoningPatch(input)
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/)
  assert.match(patch, /transport: streamable-http/)
  assert.match(patch, /Authorization: !!js String\("Bearer " \+ process.env.EXA_API_KEY\)/)
  assert.ok(patch.includes(exaSourceLabel(attribution)))
  assert.doesNotMatch(patch, /dsh-web-search-exa|searchProvider: exa|fetchProvider: http/)
  assert.throws(() => renderDshReasoningPatch({ ...input, searchAttribution: undefined }))
  assert.throws(() => exaSourceLabel({ ...attribution, task: 'bad\r\nheader' }))
  assert.throws(() => exaSourceLabel({ agent: 'a'.repeat(100), stage: 's'.repeat(100), wave: 'w'.repeat(100), task: 'task' }))
  assert.throws(() => renderDshReasoningPatch({ ...input, searchConnection: { provider: 'exa', apiKeyEnv: 'bad;key' } }))
  const args = codexExaConfig(input.searchConnection, attribution)
  assert.ok(args.includes('mcp_servers.exa.tool_timeout_sec=120'))
  assert.ok(args.includes('mcp_servers.exa.bearer_token_env_var="EXA_API_KEY"'))
  assert.ok(args.includes('web_search="disabled"'))
  assert.ok(args.includes(`mcp_servers.exa.http_headers={"x-exa-source"=${JSON.stringify(exaSourceLabel(attribution))}}`))
  assert.throws(() => codexExaConfig({ provider: 'exa', apiKeyEnv: 'bad;key' }, attribution))
})
