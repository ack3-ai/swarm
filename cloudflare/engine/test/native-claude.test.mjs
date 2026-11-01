import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { claudeOptions, runClaude } from '../container/claude-runner.mjs'
import { subscriptionWaits } from '../container/subscription-limits.mjs'
import { claudeUsage } from '../container/claude-usage.mjs'
import { claudeNativeSearchEvidence } from '../container/native-search-evidence.mjs'

const request = { model: 'claude-sonnet-5', prompt: 'Read proof.txt.', workingDirectory: '/workspace/source',
  reasoningEffort: 'high', subagents: { mode: 'disabled' }, continuationMode: 'new', sessionId: null }
const env = { PATH: process.env.PATH, HOME: '/workspace/home', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-only',
  ANTHROPIC_API_KEY: 'must-not-fall-back', ANTHROPIC_BASE_URL: 'https://wrong.example',
  CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EXTRA_BODY: '{"thinking":"wrong"}' }
const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'native-session',
  usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, output_tokens: 5 } }

test('Claude uses only the configured subscription and native session, without local hooks or extra tools', () => {
  const options = claudeOptions({ ...request, continuationMode: 'resume', sessionId: 'retained-session' }, env)
  assert.equal(options.resume, 'retained-session')
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, env.CLAUDE_CODE_OAUTH_TOKEN)
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_EXTRA_BODY']) {
    assert.equal(options.env[key], undefined)
  }
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.strictMcpConfig, true)
  assert.deepEqual(options.mcpServers, {})
  assert.ok(options.disallowedTools.includes('WebSearch'))
  assert.ok(options.disallowedTools.includes('Agent'))
  assert.throws(() => claudeOptions(request, { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-api-key' }), /subscription/)
  assert.throws(() => claudeOptions({ ...request, subagents: { mode: 'native' } }, env), /subagents/)
})

test('Fable 5.1 and Opus 5.5 allow 128K output without accepting ambient Claude overrides', () => {
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', request.model]) {
    for (const continuationMode of ['new', 'resume']) {
      const options = claudeOptions({ ...request, model, continuationMode, sessionId: 'retained-session' },
        { ...env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000' })
      assert.equal(options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, model === request.model ? undefined : '128000')
      assert.equal(options.resume, continuationMode === 'resume' ? 'retained-session' : undefined)
      assert.equal(options.env.CLAUDE_CODE_USE_BEDROCK, undefined)
      assert.equal(options.env.ANTHROPIC_BASE_URL, undefined)
      assert.equal(options.env.CLAUDE_CODE_EXTRA_BODY, undefined)
      assert.deepEqual(options.mcpServers, {})
      assert.ok(options.disallowedTools.includes('WebSearch'))
    }
  }
})

test('Claude Exa arguments use the shared endpoint and attribution', () => {
  const options = claudeOptions({ ...request, searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' },
    searchAttribution: { agent: 'claude', stage: 'discovery', wave: 'wave-0', task: 'research-1' } },
  { ...env, EXA_API_KEY: 'test-only-exa' })
  assert.equal(options.mcpServers.exa.headers.Authorization, 'Bearer test-only-exa')
  assert.match(options.mcpServers.exa.headers['x-exa-source'], /agent=claude;stage=discovery/)
})

test('Claude result usage counts cached input once and never calls SDK estimated cost an invoice', () => {
  const usage = claudeUsage([JSON.stringify(result), JSON.stringify(result)].join('\n'))
  assert.equal(usage.rawInputTokens, 130)
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.cachedInputTokens, 100)
  assert.equal(usage.cacheAccountingComplete, true)
  assert.equal(usage.costAccountingComplete, false)
  assert.equal(claudeUsage('{}').cacheAccountingComplete, false)
})

test('Claude search evidence requires paired successful native tool blocks', () => {
  const call = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'search-1',
    name: 'mcp__exa__web_search_exa', input: { query: 'example query' } }] } }
  const answer = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'search-1',
    content: [{ type: 'text', text: 'Public source evidence' }] }] } }
  const parse = (...events) => claudeNativeSearchEvidence(events.map(JSON.stringify).join('\n'))
  assert.equal(parse(call).incomplete, 1)
  assert.equal(parse(call, answer).completed.length, 1)
  assert.equal(parse(call, answer).source, 'claude-json')
  answer.message.content[0].is_error = true
  assert.equal(parse(call, answer).failed, 1)
})

test('SDK result errors fail the process and native quota events are preserved', async () => {
  const emitted = []
  let closed = false
  const query = () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', utilization: 1, rateLimitType: 'five_hour' } }
      yield { ...result, is_error: true }
    }, close() { closed = true },
  })
  assert.equal(await runClaude(request, env, query, value => emitted.push(value), () => {}), 1)
  assert.equal(emitted.find(event => event.type === 'subscription_limits').limits.exhausted, true)
  assert.equal(closed, true)
})

test('quota waits cross step slices and five hours, then resume the exact session without repeating work', async () => {
  let clock = Date.parse('2026-01-01T00:00:00Z')
  const start = clock
  const resetAt = start + 6 * 60 * 60_000
  const events = [], prompts = [], closes = []
  let queries = 0, actions = 0
  const query = ({ prompt, options }) => {
    const index = queries++
    prompts.push(prompt)
    assert.equal(options.cwd, request.workingDirectory)
    assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
    if (index > 0) {
      assert.equal(options.resume, 'quota-session')
      assert.ok(clock >= (index === 1 ? resetAt + 1000 : resetAt + 61_000))
      assert.notEqual(prompt, request.prompt)
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'quota-session' }
        if (index === 0) actions++ // persisted tool result in this native session
        if (index < 2) {
          yield { type: 'rate_limit_event', session_id: 'quota-session',
            rate_limit_info: { status: 'rejected', utilization: 1.01, rateLimitType: 'five_hour', resetsAt: resetAt / 1000 } }
          yield { ...result, session_id: 'quota-session', is_error: true }
          throw new Error('error_result')
        }
        assert.equal(actions, 1)
        yield { ...result, session_id: 'quota-session' }
        yield { ...result, session_id: 'quota-session' } // duplicate frame is not extra usage
      }, close() { closes.push(index); if (index < 2) throw new Error('error_result') },
    }
  }
  const code = await runClaude(request, env, query, event => events.push(event), () => {}, {
    now: () => clock, sleep: async ms => {
      assert.ok(ms > 0 && ms <= 60_000)
      assert.equal(queries, clock < resetAt + 1000 ? 1 : 2)
      clock += ms
    },
  })
  assert.equal(code, 0)
  assert.equal(queries, 3)
  assert.equal(actions, 1)
  assert.deepEqual(closes, [0, 1, 2])
  const stdout = events.map(JSON.stringify).join('\n')
  const waits = subscriptionWaits(stdout)
  assert.equal(waits.length, 2)
  assert.equal(Date.parse(waits[0].resumedAt) - Date.parse(waits[0].startedAt), 6 * 60 * 60_000 + 1000)
  assert.equal(Date.parse(waits[1].resumedAt) - Date.parse(waits[1].startedAt), 60_000)
  assert.equal(events.find(event => event.type === 'subscription_limits').limits.windows[0].usedPercent, null)
  assert.equal(claudeUsage(stdout).rawInputTokens, 390)
  assert.equal(claudeUsage(stdout).cachedInputTokens, 300)
  assert.equal(claudeUsage(stdout).outputTokens, 15)
  assert.equal(claudeUsage(stdout).costAccountingComplete, false)
})

test('quota recovery refuses changed native identity and unrelated SDK errors', async () => {
  for (const failure of ['changed-session', 'unrelated-close', 'unrelated-iterator', 'missing-reset']) {
    const query = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: 'retained-session' }
        yield { type: 'rate_limit_event', session_id: 'retained-session',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour',
            ...(failure === 'missing-reset' ? {} : { resetsAt: 1793332200 }) } }
        yield { ...result, session_id: failure === 'changed-session' ? 'other-session' : 'retained-session', is_error: true }
        if (failure === 'unrelated-iterator') throw new Error('transport failure')
        if (failure === 'missing-reset') throw Object.assign(new Error('Claude Code returned an error result: quota'),
          { errorClass: 'error_result' })
      }, close() { if (failure === 'unrelated-close') throw new Error('disk failure') },
    })
    await assert.rejects(runClaude({ ...request, continuationMode: 'resume', sessionId: 'retained-session' },
      env, query, () => {}, () => {}, { sleep: async () => { assert.fail('must not resume') } }),
    failure === 'changed-session' ? /identity changed/ : failure === 'unrelated-close' ? /disk failure/
      : failure === 'unrelated-iterator' ? /transport failure/ : /returned an error result/)
  }
})

test('Claude query accounting retains known usage when a later query has no usage', () => {
  const events = [{ type: 'claude_query_started', queryIndex: 0 }, result,
    { type: 'claude_query_started', queryIndex: 1 }, { type: 'result', subtype: 'error_during_execution' }]
  const usage = claudeUsage(events.map(JSON.stringify).join('\n'))
  assert.equal(usage.rawInputTokens, 130)
  assert.equal(usage.inputTokens, 130)
  assert.equal(usage.outputTokens, 5)
  assert.equal(usage.cacheAccountingComplete, false)
})

const require = createRequire(new URL('../container/harness/package.json', import.meta.url))
let sdk
try { sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href) } catch {}
for (const model of [request.model, 'claude-fable-5-1', 'claude-opus-5-5']) {
  test(`installed official SDK passes ${model} output allowance and resumes through its transport (no network)`, { skip: !sdk }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'swarm-claude-sdk-'))
    try {
      const cli = join(dir, 'cli.mjs')
      await writeFile(cli, `
        import readline from 'node:readline';
        import assert from 'node:assert/strict';
        assert.equal(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, ${model === request.model ? 'undefined' : JSON.stringify('128000')});
        assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
        assert.equal(process.env.CLAUDE_CODE_USE_BEDROCK, undefined);
        const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
        for await (const line of readline.createInterface({ input: process.stdin })) {
          const message = JSON.parse(line);
          if (message.type === 'control_request') emit({ type: 'control_response',
            response: { subtype: 'success', request_id: message.request_id, response: {} } });
          if (message.type === 'user') {
            emit({ type: 'system', subtype: 'init', session_id: 'retained-session', tools: [] });
            emit(${JSON.stringify({ ...result, session_id: 'retained-session' })});
          }
        }
      `)
      const emitted = []
      const query = args => {
        assert.equal(args.options.resume, 'retained-session')
        return sdk.query({ ...args, options: { ...args.options, cwd: dir,
          env: { ...args.options.env, HOME: dir }, pathToClaudeCodeExecutable: cli } })
      }
      const code = await runClaude({ ...request, model, continuationMode: 'resume', sessionId: 'retained-session' },
        env, query, message => emitted.push(message), () => {})
      assert.equal(code, 0)
      assert.equal(emitted.at(-1).session_id, 'retained-session')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
}

const quotaErrorText = "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your session limit resets 4:30pm (UTC)"
for (const sdkError of [false, true]) test(`installed SDK quota result waits and resumes the same session (error_result=${sdkError}, no network)`, { skip: !sdk }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-claude-quota-sdk-'))
  const start = Date.parse('2026-01-01T00:00:00Z')
  const resetAt = start + 6 * 60 * 60_000
  let clock = start, queries = 0
  try {
    const cli = join(dir, 'cli.mjs')
    await writeFile(cli, `
      import readline from 'node:readline';
      const resumed = process.env.TEST_QUERY_INDEX === '1';
      const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
      for await (const line of readline.createInterface({ input: process.stdin })) {
        const message = JSON.parse(line);
        if (message.type === 'control_request') emit({ type: 'control_response',
          response: { subtype: 'success', request_id: message.request_id, response: {} } });
        if (message.type === 'user') {
          emit({ type: 'system', subtype: 'init', session_id: 'retained-session', tools: [] });
          if (!resumed) emit({ type: 'rate_limit_event', session_id: 'retained-session',
            rate_limit_info: { status: 'rejected', utilization: 1.01, rateLimitType: 'five_hour', resetsAt: ${resetAt / 1000} } });
          emit({ ...${JSON.stringify({ ...result, session_id: 'retained-session' })}, is_error: !resumed,
            ...(!resumed && ${sdkError} ? { result: ${JSON.stringify(quotaErrorText)} } : {}) });
          if (!resumed && ${sdkError}) { process.exitCode = 1; break; }
        }
      }
    `)
    const emitted = [], sdkErrors = []
    const query = args => {
      const index = queries++
      assert.equal(args.options.resume, index === 0 ? undefined : 'retained-session')
      if (index > 0) {
        assert.ok(clock >= resetAt + 1000)
        assert.notEqual(args.prompt, request.prompt)
      }
      const native = sdk.query({ ...args, options: { ...args.options, cwd: dir,
        env: { ...args.options.env, HOME: dir, TEST_QUERY_INDEX: String(index) }, pathToClaudeCodeExecutable: cli } })
      return {
        async *[Symbol.asyncIterator]() {
          try { yield* native } catch (error) { sdkErrors.push(error); throw error }
        },
        async close() {
          try { await native.close() } catch (error) { sdkErrors.push(error); throw error }
        },
      }
    }
    assert.equal(await runClaude(request, env, query, message => emitted.push(message), () => {}, {
      now: () => clock, sleep: async ms => { clock += ms },
    }), 0)
    assert.equal(queries, 2)
    if (sdkError) {
      assert.ok(sdkErrors.length > 0)
      assert.ok(sdkErrors.every(error => error.errorClass === 'error_result'
        && error.message === `Claude Code returned an error result: ${quotaErrorText}`))
    }
    assert.equal(emitted.filter(event => event.type === 'subscription_wait_started').length, 1)
    const stdout = emitted.map(JSON.stringify).join('\n')
    assert.equal(subscriptionWaits(stdout).length, 1)
    assert.equal(claudeUsage(stdout).rawInputTokens, 260)
    assert.equal(claudeUsage(stdout).outputTokens, 10)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
