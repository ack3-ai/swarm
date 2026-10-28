import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { claudeOptions, runClaude } from '../container/claude-runner.mjs'
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

const require = createRequire(new URL('../container/harness/package.json', import.meta.url))
let sdk
try { sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href) } catch {}
test('installed official SDK exchanges native JSON and resumes through its transport (no network)', { skip: !sdk }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-claude-sdk-'))
  try {
    const cli = join(dir, 'cli.mjs')
    await writeFile(cli, `
      import readline from 'node:readline';
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
    const code = await runClaude({ ...request, continuationMode: 'resume', sessionId: 'retained-session' },
      env, query, message => emitted.push(message), () => {})
    assert.equal(code, 0)
    assert.equal(emitted.at(-1).session_id, 'retained-session')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
