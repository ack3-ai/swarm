import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { quotaHandoffExitCode, runClaude } from '../container/claude-runner.mjs'
import { claudeAccountEnvironment, runClaudeAccounts } from '../container/claude-accounts.mjs'
import { claudeUsage } from '../container/claude-usage.mjs'
import { attemptWaitWindow, subscriptionSwitches, subscriptionWaitStatusReader, subscriptionWaits,
  validSubscriptionSwitches } from '../container/subscription-limits.mjs'
import { validClaudeAccounts } from '../container/reasoning-config.mjs'

// The Worker puts account 1 in CLAUDE_CODE_OAUTH_TOKEN and each fallback under its own binding.
const tokens = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-a', CLAUDE_B_OAUTH_TOKEN: 'sk-ant-oat-test-b',
  CLAUDE_C_OAUTH_TOKEN: 'sk-ant-oat-test-c' }
const environment = { PATH: process.env.PATH, HOME: '/workspace/home', ANTHROPIC_API_KEY: 'must-not-fall-back', ...tokens }
const accounts = ['CLAUDE_TEAM_OAUTH_TOKEN', 'CLAUDE_B_OAUTH_TOKEN', 'CLAUDE_C_OAUTH_TOKEN']
const request = { model: 'claude-sonnet-5', prompt: 'Read proof.txt.', workingDirectory: '/workspace/source',
  reasoningEffort: 'high', subagents: { mode: 'disabled' }, continuationMode: 'new', sessionId: null,
  credentialSource: accounts[0], claudeAccounts: accounts }
const start = Date.parse('2026-01-01T00:00:00Z')
const hours = value => start + value * 60 * 60_000
const iso = value => new Date(value).toISOString()
const result = { type: 'result', subtype: 'success', is_error: false, session_id: 'rotation-session',
  usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }

/** Fake SDK: query N is rejected with resets[N] when set, fails on failures[N], and succeeds otherwise.
 * A rejected query answers first only when N is in `answered`; the SDK reports the rejection
 * itself as an assistant message with `error` set. */
function scripted(resets, queries, failures = {}, answered = []) {
  return ({ prompt, options }) => {
    const index = queries.length
    queries.push({ prompt, options })
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: 'system', subtype: 'init', session_id: failures[index] === 'other-session' ? 'other-session-id' : 'rotation-session' }
        if (failures[index] === 'revoked') { yield { ...result, is_error: true }; return }
        if (resets[index] === undefined) { yield result; return }
        if (answered.includes(index)) {
          yield { type: 'assistant', session_id: 'rotation-session', message: { role: 'assistant', content: [{ type: 'text', text: 'Reading proof.txt.' }] } }
        }
        yield { type: 'rate_limit_event', session_id: 'rotation-session',
          rate_limit_info: { status: 'rejected', utilization: 1, rateLimitType: 'five_hour', resetsAt: resets[index] / 1000 } }
        yield { type: 'assistant', error: 'rate_limit', session_id: 'rotation-session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'You have hit your limit.' }] } }
        yield { ...result, is_error: true }
        throw Object.assign(new Error('Claude Code returned an error result: limit'), { errorClass: 'error_result' })
      },
      close() {},
    }
  }
}

/** The root loop with each launch running the real claude-runner in handoff mode, as agent-runner does. */
async function rotate(input, resets, failures, answered) {
  let clock = start
  let stdout = ''
  let slept = 0
  const launches = [], queries = [], launchWindows = []
  const attempt = attemptWaitWindow(() => clock)
  const record = text => { stdout += text }
  const code = await runClaudeAccounts({ request: input, environment, now: () => clock,
    sleep: async ms => { assert.ok(ms > 0 && ms <= 60_000); slept += ms; clock += ms },
    emit: event => record(`${/[^\n]$/.test(stdout) ? '\n' : ''}${JSON.stringify(event)}\n`),
    launch: async (env, launchRequest) => {
      launches.push({ env, request: launchRequest })
      const launchedAt = clock
      let out = ''
      let launchCode
      try {
        launchCode = await runClaude(JSON.parse(JSON.stringify(launchRequest)), env, scripted(resets, queries, failures, answered),
          event => { out += `${JSON.stringify(event)}\n` }, () => {},
          { now: () => clock, sleep: async () => assert.fail('a handoff launch never waits') })
      } catch { launchCode = 1 }
      attempt.launchEnded()
      launchWindows.push([launchedAt, clock])
      record(out)
      return { code: launchCode, stdout: out, stderr: '' }
    } })
  return { code, launches, queries, stdout, slept, clock, attempt, launchWindows,
    tokens: launches.map(launch => launch.env.CLAUDE_CODE_OAUTH_TOKEN),
    prompts: launches.map(launch => launch.request.prompt),
    switches: subscriptionSwitches(stdout), waits: subscriptionWaits(stdout) ?? [] }
}

const switched = (from, to, at, resetsAt) => ({ provider: 'claude', sessionId: 'rotation-session',
  from, to, at: iso(at), resetsAt: iso(resetsAt) })

test('a quota rejection resumes the same session at once on the next account', async () => {
  // The model answered on account 1 before it hit the limit.
  const outcome = await rotate(request, [hours(5)], {}, [0])
  assert.equal(outcome.code, 0)
  assert.equal(outcome.slept, 0)
  assert.deepEqual(outcome.tokens, [tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN])
  assert.deepEqual(outcome.launches.map(launch => launch.request.claudeQuotaHandoff), [{ queryIndex: 0 }, { queryIndex: 1 }])
  assert.equal(outcome.launches[0].request.continuationMode, 'new')
  assert.equal(outcome.launches[1].request.continuationMode, 'resume')
  assert.equal(outcome.launches[1].request.sessionId, 'rotation-session')
  assert.equal(outcome.queries[1].options.resume, 'rotation-session')
  assert.equal(outcome.prompts[0], request.prompt)
  assert.match(outcome.prompts[1], /continues on another account/)
  assert.deepEqual(outcome.switches, [switched(accounts[0], accounts[1], start, hours(5))])
  assert.deepEqual(outcome.waits, [])
  for (const value of Object.values(tokens)) assert.ok(!outcome.stdout.includes(value))
  // Usage counts each query once across launches.
  assert.equal(claudeUsage(outcome.stdout).rawInputTokens, 20)
  assert.equal(claudeUsage(outcome.stdout).actorId, 'rotation-session')
})

test('a task rejected before the model answered gets its own prompt again, in the same session (E12)', async () => {
  // Account 1 is used up: the first request is rejected before any answer, so the
  // session may not hold the task. Account 2 resumes that session with the task text.
  const outcome = await rotate(request, [hours(5)])
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.prompts, [request.prompt, request.prompt])
  assert.equal(outcome.queries[1].prompt, request.prompt)
  assert.equal(outcome.launches[1].request.continuationMode, 'resume')
  assert.equal(outcome.launches[1].request.sessionId, 'rotation-session')
  assert.equal(outcome.queries[1].options.resume, 'rotation-session')
  assert.deepEqual(outcome.tokens, [tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN])
  // Same session, so the switch record still names the session the result reports.
  const usage = claudeUsage(outcome.stdout)
  assert.deepEqual(outcome.switches, [switched(accounts[0], accounts[1], start, hours(5))])
  assert.ok(outcome.switches.every(item => item.sessionId === usage.actorId))
  // Usage still counts each query once across launches.
  assert.deepEqual(outcome.launches.map(launch => launch.request.claudeQuotaHandoff), [{ queryIndex: 0 }, { queryIndex: 1 }])
  assert.equal(usage.rawInputTokens, 20)

  // Two used-up accounts in a row: the third still gets the task text.
  const twice = await rotate(request, [hours(5), hours(6)])
  assert.deepEqual(twice.prompts, [request.prompt, request.prompt, request.prompt])
  assert.equal(claudeUsage(twice.stdout).rawInputTokens, 30)
  // Once the model has answered in this attempt, later launches continue the session.
  const answeredFirst = await rotate(request, [hours(5), hours(6)], {}, [0])
  assert.match(answeredFirst.prompts[1], /continues on another account/)
  assert.match(answeredFirst.prompts[2], /continues on another account/)
  const answeredSecond = await rotate(request, [hours(5), hours(6)], {}, [1])
  assert.deepEqual(answeredSecond.prompts.slice(0, 2), [request.prompt, request.prompt])
  assert.match(answeredSecond.prompts[2], /continues on another account/)
  // A correction turn rejected before any answer gets its correction text, in its own session.
  const correction = { ...request, continuationMode: 'resume', sessionId: 'rotation-session', prompt: 'Fix the output format.' }
  const repaired = await rotate(correction, [hours(5)])
  assert.deepEqual(repaired.prompts, [correction.prompt, correction.prompt])
  assert.deepEqual(repaired.queries.map(query => query.options.resume), ['rotation-session', 'rotation-session'])
  // Every account used up: after the wait, the task that never got an answer still gets its text.
  const waited = await rotate({ ...request, claudeAccounts: accounts.slice(0, 2) }, [hours(5), hours(2)])
  assert.deepEqual(waited.prompts, [request.prompt, request.prompt, request.prompt])
  assert.equal(waited.waits.length, 1)
})

test('a launch environment holds only the active token and never a fallback binding', async () => {
  const outcome = await rotate(request, [hours(5), hours(6)])
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.tokens, Object.values(tokens))
  for (const [index, launch] of outcome.launches.entries()) {
    for (const name of accounts) assert.equal(Object.hasOwn(launch.env, name), false, `launch ${index} ${name}`)
    assert.equal(Object.values(launch.env).filter(value => Object.values(tokens).includes(value)).length, 1)
    assert.equal(launch.request.claudeAccounts, undefined)
    // The CLI gets the same single token.
    const cli = outcome.queries[index].options.env
    assert.equal(cli.CLAUDE_CODE_OAUTH_TOKEN, launch.env.CLAUDE_CODE_OAUTH_TOKEN)
    assert.equal(Object.values(cli).filter(value => Object.values(tokens).includes(value)).length, 1)
  }
  const env = claudeAccountEnvironment({ ...environment, CLAUDE_TEAM_OAUTH_TOKEN: 'sk-ant-oat-test-a' }, accounts, 2)
  assert.deepEqual(Object.keys(env).filter(name => name.startsWith('CLAUDE_')), ['CLAUDE_CODE_OAUTH_TOKEN'])
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_C_OAUTH_TOKEN)
  assert.equal(environment.CLAUDE_B_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN)
})

test('two used-up accounts wait for the earliest reset, then resume on that account', async () => {
  const outcome = await rotate({ ...request, claudeAccounts: accounts.slice(0, 2) }, [hours(5), hours(2)], {}, [0])
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.tokens, [tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN])
  assert.deepEqual(outcome.switches, [switched(accounts[0], accounts[1], start, hours(5))])
  assert.deepEqual(outcome.waits, [{ provider: 'claude', sessionId: 'rotation-session',
    startedAt: iso(start), resumedAt: iso(hours(2) + 1000), resetsAt: iso(hours(2)) }])
  assert.match(outcome.prompts[2], /after the subscription quota reset/)
  assert.equal(outcome.queries[2].options.resume, 'rotation-session')
  // The loop's wait lines drive the same live status the dashboard reads.
  assert.deepEqual(subscriptionWaitStatusReader()(outcome.stdout),
    [{ provider: 'claude', resetsAt: iso(hours(2)) }, { provider: 'claude', resetsAt: null }])
})

test('when every account is used up the task waits, resumes and keeps rotating by reset time', async () => {
  // A, B and C are used up; B resets first. After the wait B is rejected again and C resets next.
  const outcome = await rotate(request, [hours(3), hours(1), hours(2), hours(4)])
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.tokens, [tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN,
    tokens.CLAUDE_C_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN, tokens.CLAUDE_C_OAUTH_TOKEN])
  assert.deepEqual(outcome.switches, [switched(accounts[0], accounts[1], start, hours(3)),
    switched(accounts[1], accounts[2], start, hours(1))])
  assert.deepEqual(outcome.waits.map(wait => [wait.resetsAt, wait.resumedAt]),
    [[iso(hours(1)), iso(hours(1) + 1000)], [iso(hours(2)), iso(hours(2) + 1000)]])
  assert.equal(outcome.clock, hours(2) + 1000)
  assert.equal(claudeUsage(outcome.stdout).rawInputTokens, 50)
})

test('the root runner keeps a rotation wait between two launches and drops waits outside the attempt (S24)', async () => {
  // Account 2 is rejected too, so the root runner waits between launches 2 and 3, outside any single launch.
  const outcome = await rotate({ ...request, claudeAccounts: accounts.slice(0, 2) }, [hours(5), hours(2)])
  assert.equal(outcome.code, 0)
  assert.equal(outcome.waits.length, 1)
  const [wait] = outcome.waits
  assert.deepEqual(outcome.launchWindows.map(([from]) => from), [start, start, hours(2) + 1000])
  assert.deepEqual(outcome.attempt.within(outcome.waits), outcome.waits)
  // A window of one launch would drop it.
  for (const [from, to] of outcome.launchWindows) {
    assert.ok(Date.parse(wait.startedAt) < from || Date.parse(wait.resumedAt) > to)
  }
  // Waits that start before the attempt or end after its last launch are dropped; the rest are kept.
  const early = { ...wait, startedAt: iso(start - 1) }
  const late = { ...wait, resumedAt: iso(outcome.clock + 1) }
  assert.deepEqual(outcome.attempt.within([early, wait, late]), [wait])
  assert.equal(outcome.attempt.within([early, late]), undefined)
  assert.equal(outcome.attempt.within(undefined), undefined)
  // Before any launch has ended, nothing counts.
  let clock = start
  const fresh = attemptWaitWindow(() => clock)
  clock = hours(3)
  assert.equal(fresh.within(outcome.waits), undefined)
  fresh.launchEnded()
  assert.deepEqual(fresh.within(outcome.waits), outcome.waits)
})

test('the agent runner bounds reported quota waits by the whole attempt, not one launch', async () => {
  const runner = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
  const windowAt = runner.indexOf('const attemptWaits = attemptWaitWindow()')
  assert.ok(windowAt > -1 && windowAt < runner.indexOf('const request = JSON.parse('))
  // Every launch, including each claude-runner launch of the rotation loop, goes through execute().
  assert.match(runner, /settled = true\n {6}stopWatching\(\)\n {6}attemptWaits\.launchEnded\(\)/)
  assert.equal(runner.split('attemptWaits.launchEnded()').length, 2)
  assert.match(runner, /const waits = attemptWaits\.within\(/)
})

test('stale resets never spin: each account is tried once per round, then the task waits a minute', async () => {
  const stale = hours(-1)
  const outcome = await rotate({ ...request, claudeAccounts: accounts.slice(0, 2) }, [stale, stale, stale, stale])
  assert.equal(outcome.code, 0)
  assert.deepEqual(outcome.tokens, [tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN,
    tokens.CLAUDE_CODE_OAUTH_TOKEN, tokens.CLAUDE_B_OAUTH_TOKEN, tokens.CLAUDE_CODE_OAUTH_TOKEN])
  assert.equal(outcome.switches.length, 2)
  assert.equal(outcome.waits.length, 2)
  assert.equal(outcome.slept, 2 * 60_000)
})

test('anything but an evidenced handoff ends the loop with that launch exit code', async () => {
  const revoked = await rotate(request, [hours(5)], { 1: 'revoked' })
  assert.equal(revoked.code, 1)
  assert.equal(revoked.launches.length, 2)
  const changed = await rotate(request, [hours(5)], { 1: 'other-session' })
  assert.equal(changed.code, 1)
  const missing = await rotate({ ...request, claudeAccounts: [accounts[0], 'CLAUDE_MISSING_OAUTH_TOKEN'] }, [hours(5)])
  assert.equal(missing.code, 1)
  assert.equal(missing.launches[1].env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  // A handoff exit without usable rejection evidence fails closed.
  for (const stdout of ['', JSON.stringify({ type: 'subscription_rejected', provider: 'claude', sessionId: 'rotation-session',
    startedAt: iso(start), resetsAt: 'never' }), JSON.stringify({ type: 'subscription_rejected', provider: 'claude',
    sessionId: 'another-session', startedAt: iso(start), resetsAt: iso(hours(1)) })]) {
    let launches = 0
    const resumed = { ...request, continuationMode: 'resume', sessionId: 'rotation-session' }
    assert.equal(await runClaudeAccounts({ request: resumed, environment, emit: () => assert.fail('no switch'),
      sleep: async () => assert.fail('no wait'),
      launch: async () => { launches += 1; return { code: quotaHandoffExitCode, stdout, stderr: '' } } }), quotaHandoffExitCode)
    assert.equal(launches, 1)
  }
})

test('claude-runner hands an evidenced quota rejection back instead of waiting', async () => {
  const { claudeAccounts: _, ...single } = request
  const events = [], queries = []
  const code = await runClaude({ ...single, claudeQuotaHandoff: { queryIndex: 3 } }, environment,
    scripted([hours(5)], queries), event => events.push(event), () => {},
    { now: () => start, sleep: async () => assert.fail('must not wait') })
  assert.equal(code, quotaHandoffExitCode)
  assert.equal(queries.length, 1)
  assert.deepEqual(events.find(event => event.type === 'claude_query_started'), { type: 'claude_query_started', queryIndex: 3 })
  assert.deepEqual(events.at(-1), { type: 'subscription_rejected', provider: 'claude', sessionId: 'rotation-session',
    startedAt: iso(start), resetsAt: iso(hours(5)) })
  assert.ok(!events.some(event => event.type?.startsWith('subscription_wait')))
  const handoff = { ...single, claudeQuotaHandoff: { queryIndex: 0 } }
  assert.equal(await runClaude(handoff, environment, scripted([], []), () => {}, () => {}), 0)
  assert.equal(await runClaude(handoff, environment, scripted([hours(5)], [], { 0: 'revoked' }), () => {}, () => {}), 1)
  for (const value of [true, null, {}, { queryIndex: -1 }, { queryIndex: 1.5 }, { queryIndex: 0, extra: 1 }]) {
    await assert.rejects(runClaude({ ...single, claudeQuotaHandoff: value }, environment, scripted([], []), () => {}, () => {}),
      /invalid Claude quota handoff/, JSON.stringify(value))
  }
})

test('switch records hold binding names only', () => {
  const valid = switched(accounts[0], accounts[1], start, hours(5))
  assert.equal(validSubscriptionSwitches(undefined), true)
  assert.equal(validSubscriptionSwitches([]), true)
  assert.equal(validSubscriptionSwitches([valid]), true)
  for (const patch of [{ to: valid.from }, { from: tokens.CLAUDE_CODE_OAUTH_TOKEN }, { to: 'OTHER_TOKEN' },
    { provider: 'codex' }, { sessionId: '' }, { at: 'invalid' }, { resetsAt: undefined }, { token: tokens.CLAUDE_B_OAUTH_TOKEN }]) {
    assert.equal(validSubscriptionSwitches([{ ...valid, ...patch }]), false, JSON.stringify(patch))
  }
  assert.equal(validSubscriptionSwitches(valid), false)
  assert.deepEqual(subscriptionSwitches(['not json', JSON.stringify({ type: 'subscription_switch', switch: valid }),
    JSON.stringify({ type: 'subscription_switch', switch: { ...valid, to: valid.from } })].join('\n')), [valid])
})

test('account lists hold 2 to 8 distinct Claude bindings and never reuse CLAUDE_CODE_OAUTH_TOKEN as a fallback', () => {
  assert.equal(validClaudeAccounts(accounts), true)
  assert.equal(validClaudeAccounts(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_B_OAUTH_TOKEN']), true)
  for (const names of [[accounts[0]], Array.from({ length: 9 }, (_, index) => `CLAUDE_${index}_OAUTH_TOKEN`),
    [accounts[0], accounts[0]], [accounts[0], 'CODEX_B_AUTH_JSON'], [accounts[0], 'CLAUDE_CODE_OAUTH_TOKEN'], 'CLAUDE_B_OAUTH_TOKEN']) {
    assert.equal(validClaudeAccounts(names), false, JSON.stringify(names))
  }
})

test('the agent runner checks the account list before any workspace change', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-claude-accounts-'))
  try {
    const base = { prompt: 'p', model: 'claude-sonnet-5', taskId: 'task', runId: 'run', requestDigest: 'a'.repeat(64),
      providerClass: 'core', backend: 'claude', reasoningEffort: 'high', subagents: { mode: 'disabled' },
      expectedFiles: [], credentialSource: accounts[0], claudeAccounts: accounts.slice(0, 2),
      // An invalid working directory stops the runner right after the account check.
      workingDirectory: '/elsewhere', continuationMode: 'new', sessionId: null }
    const runner = async (body, extraEnv = {}) => {
      const path = join(dir, 'request.json')
      await writeFile(path, JSON.stringify(body))
      try {
        await promisify(execFile)(process.execPath, [new URL('../container/agent-runner.mjs', import.meta.url).pathname,
          path, join(dir, 'result.json')], { env: { PATH: process.env.PATH, ...extraEnv } })
        return 'exited'
      } catch (error) { return error.stderr }
    }
    const bound = { CLAUDE_B_OAUTH_TOKEN: tokens.CLAUDE_B_OAUTH_TOKEN }
    assert.match(await runner(base, bound), /invalid agent working directory/)
    for (const [body, extraEnv] of [[base, {}], [base, { CLAUDE_B_OAUTH_TOKEN: 'api-key' }],
      [{ ...base, backend: 'codex' }, bound], [{ ...base, claudeAccounts: [accounts[1], accounts[0]] }, bound],
      [{ ...base, claudeAccounts: [accounts[0]] }, bound], [{ ...base, claudeAccounts: [accounts[0], accounts[0]] }, bound]]) {
      assert.match(await runner(body, extraEnv), /invalid Claude account list/)
    }
    assert.match(await runner({ ...base, claudeQuotaHandoff: { queryIndex: 0 } }, bound), /invalid Claude quota handoff/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
