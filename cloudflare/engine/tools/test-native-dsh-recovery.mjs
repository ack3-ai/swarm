// Zero-provider-cost recovery checks against the installed, pinned DSH CLI.
// DSH_BIN=/opt/harness/node_modules/.bin/dsh node tools/test-native-dsh-recovery.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, chown, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { renderDshReasoningPatch } from '../container/reasoning-config.mjs'
import { dshUsage } from '../container/dsh-usage.mjs'

assert.ok(process.env.DSH_BIN, 'Set DSH_BIN to the installed, pinned CLI')
const bin = process.env.DSH_BIN
const receiptWrapper = process.env.DSH_RECEIPT_WRAPPER_BIN
const runner = receiptWrapper ?? process.env.DSH_RUNNER_BIN
let modules = dirname(await realpath(bin))
while (!modules.endsWith('/node_modules') && dirname(modules) !== modules) modules = dirname(modules)
assert.ok(modules.endsWith('/node_modules'))
assert.equal(JSON.parse(await readFile(join(modules, '@deepseek-ai/dsh/package.json'))).version, '0.2.1-rc.2')

const cases = [
  { name: 'minute-outage', outageMs: 60_000 },
  { name: 'timeout-after-six-idles', silentResponses: 6 },
  { name: 'home-overlay-after-six-idles', silentResponses: 6, nativeHomeOverlay: true },
  { name: 'exhausted-timeout', silentResponses: 7, exhausted: true, expectedCode: 'TIMEOUT' },
  { name: 'long-retry-after', retryAfter: '12' },
  { name: 'retry-after-over-cap', retryAfter: '3601', delegated: true },
  { name: 'failed-partial-and-transport' },
  { name: 'cancel-backoff', retryAfter: '12', cancel: true },
  { name: 'auth', status: 401, errorCode: 'invalid_api_key', expectedCode: 'AUTH' },
  { name: 'quota', status: 402, errorCode: 'insufficient_quota', expectedCode: 'QUOTA' },
  { name: 'invalid-request', status: 400, errorCode: 'invalid_request', expectedCode: 'INVALID_REQUEST' },
  { name: 'missing-credential', missingCredential: true },
  { name: 'exhausted-server', exhausted: true, failureStatus: 503, expectedCode: 'SERVER' },
  { name: 'exhausted-internal-server', exhausted: true, failureStatus: 500, expectedCode: 'SERVER' },
  { name: 'exhausted-rate-limit', exhausted: true, failureStatus: 429, expectedCode: 'RATE_LIMIT' },
  { name: 'exhausted-empty-response', exhausted: true, emptyResponse: true, expectedCode: 'EMPTY_RESPONSE' },
  { name: 'exhausted-missing-finish', exhausted: true, missingFinish: true, expectedCode: 'TRANSPORT' },
]
const selected = process.env.DSH_RECOVERY_CASES?.split(',')
if (selected) assert.ok(selected.every(name => cases.some(spec => spec.name === name)), 'Unknown recovery case')
const selectedCases = selected ? cases.filter(spec => selected.includes(spec.name)) : cases

async function runCase(spec) {
  const root = await mkdtemp(join(tmpdir(), 'swarm-native-recovery-'))
  const profile = join(root, 'profiles/native-worker')
  const requests = []
  let failureAt = null
  let recoveredAt = null
  let cancelledAt = null
  let forcedKill = false
  let child
  const signalChild = signal => runner ? process.kill(-child.pid, signal) : child.kill(signal)
  const timers = new Set()
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer) }
  await mkdir(profile, { recursive: true })
  await symlink(modules, join(profile, 'node_modules'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'native-recovery-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } },
  }))
  const marker = join(root, 'executed-once.txt')

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ at: Date.now(), body })
    const index = requests.length
    assert.equal(body.stream, true)
    assert.deepEqual(body.thinking, { type: 'enabled' })
    assert.equal(body.reasoning_effort, 'max')
    const error = (status, code, retryAfter) => {
      res.writeHead(status, { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) })
      res.end(JSON.stringify({ error: { code, message: 'Synthetic upstream failure' } }))
    }
    const start = () => res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    if (spec.status) { error(spec.status, spec.errorCode); return }
    if (index === 1) {
      start()
      data({ id: 'completed-step', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'completed-reasoning' }, finish_reason: null }] })
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'completed-tool', type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: `printf 'executed\\n' >> '${marker}'; printf 'completed-tool-evidence'`,
          description: 'Write one synthetic execution marker' }),
      } }] }, finish_reason: null }] })
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })
      res.end('data: [DONE]\n\n')
      return
    }
    failureAt ??= Date.now()
    if (spec.silentResponses && index <= 1 + spec.silentResponses) {
      start()
      res.flushHeaders()
      if (index === 2) data({ id: 'failed-partial-timeout', choices: [{ index: 0, delta: {
        role: 'assistant', reasoning_content: 'FAILED-PARTIAL-REASONING', content: 'FAILED-PARTIAL-TEXT',
        tool_calls: [{ index: 0, id: 'failed-read', type: 'function', function: {
          name: 'read', arguments: JSON.stringify({ file_path: join(root, 'must-not-read.txt') }),
        } }],
      }, finish_reason: null }] })
      return
    }
    if (spec.exhausted) {
      if (spec.emptyResponse || spec.missingFinish) {
        start()
        if (spec.emptyResponse) data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        res.end('data: [DONE]\n\n')
      }
      else error(spec.failureStatus, 'synthetic_retry_exhaustion', '1')
      return
    }
    if (spec.outageMs && Date.now() - failureAt < spec.outageMs) { req.socket.destroy(); return }
    if (spec.retryAfter && index === 2) {
      error(503, 'server_error', spec.retryAfter)
      if (spec.cancel) later(() => { cancelledAt = Date.now(); signalChild('SIGINT') }, 300)
      return
    }
    if (spec.name === 'failed-partial-and-transport' && index === 2) {
      start()
      res.flushHeaders()
      data({ id: 'failed-step', choices: [{ index: 0, delta: {
        role: 'assistant', reasoning_content: 'FAILED-PARTIAL-REASONING', content: 'FAILED-PARTIAL-TEXT',
        tool_calls: [{ index: 0, id: 'failed-read', type: 'function', function: {
          name: 'read', arguments: JSON.stringify({ file_path: join(root, 'must-not-read.txt') }),
        } }],
      }, finish_reason: null }] })
      later(() => res.destroy(), 100)
      return
    }
    if (spec.name === 'failed-partial-and-transport' && index === 3) { req.socket.destroy(); return }
    recoveredAt = Date.now()
    start()
    data({ id: 'recovered-step', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-complete' }, finish_reason: 'stop' }] })
    data({ choices: [], usage: { prompt_tokens: 200, completion_tokens: 10 } })
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const configuration = {
    provider: 'provider-a', model: 'fixture/recovery', thinking: 'enabled', reasoningEffort: 'max',
    connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_API_KEY' },
  }
  // Loopback-only short backoff and stream watchdog keep fault injection fast;
  // production retains its configured backoff and the native 300-second watchdog.
  const patch = renderDshReasoningPatch(configuration)
    .replace('initialDelayMs: 2500', `initialDelayMs: ${spec.emptyResponse || spec.missingFinish || spec.silentResponses ? 10 : 2500}`)
    .replace('        retryPolicy:', spec.silentResponses ? '        streamIdleTimeoutMs: 500\n        retryPolicy:' : '        retryPolicy:')
  if (spec.nativeHomeOverlay) {
    // The installed image has a one-retry profile; the launch-fenced HOME
    // layer must override it without changing the installed profile.
    const installedProfile = renderDshReasoningPatch({ ...configuration, provider: 'other' }).replace('maxRetries: 6', 'maxRetries: 1')
    await writeFile(join(profile, 'cordis.patch.yml'), installedProfile)
    await writeFile(join(root, 'cordis.patch.yml'), patch)
    assert.match(installedProfile, /maxRetries: 1/)
  } else await writeFile(join(profile, 'cordis.patch.yml'), patch)
  const requestPath = join(root, 'request.json'), resultPath = join(root, 'result.json')
  const requestDigest = 'a'.repeat(64)
  if (runner) {
    await mkdir('/workspace/private', { recursive: true })
    await mkdir('/workspace/source', { recursive: true })
    await chown('/workspace/source', 10001, 10001)
    await chown(root, 10001, 10001)
    await writeFile('/opt/dsh-home/cordis.patch.yml', patch, { mode: 0o600 })
    await chmod('/opt/dsh-home/cordis.patch.yml', 0o444)
    await writeFile(requestPath, JSON.stringify({ ...configuration, requestDigest,
      providerClass: 'additive', expectedFiles: [], taskId: 'fixture', runId: spec.name, attempt: 1,
      prompt: 'Execute the harmless marker tool once, then finish.',
      workingDirectory: '/workspace/source', continuationMode: 'new', sessionId: null,
    }))
  }
  try {
    const result = await new Promise((resolve, reject) => {
      child = spawn(runner ? process.execPath : bin, runner ? [runner, requestPath, resultPath]
        : ['--profile', 'native-worker', '--json', 'Execute the harmless marker tool once, then finish.'], {
        cwd: root,
        detached: Boolean(runner),
        env: { PATH: process.env.PATH, HOME: root, DSH_HOME: root,
          ...(spec.missingCredential ? {} : { FIXTURE_API_KEY: 'synthetic-fixture-key' }),
          DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'danger-full-access', DSH_TOOLS_MODE: 'native' },
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const timeout = setTimeout(() => { forcedKill = true; signalChild('SIGKILL') }, spec.outageMs ? 120_000 : 30_000)
      child.on('error', error => { clearTimeout(timeout); reject(error) })
      child.on('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, stdout, stderr, closedAt: Date.now() }) })
    })
    assert.equal(forcedKill, false, `${spec.name}: CLI did not settle`)
    if (runner && !spec.missingCredential) {
      const log = await readFile(`/workspace/private/agent-log-${requestDigest}.jsonl`, 'utf8')
      result.stdout = log.split('\n').filter(Boolean).map(line => JSON.parse(line))
        .filter(event => event.stream === 'stdout').map(event => event.text).join('')
      // A group cancellation can interrupt the parent's log redactor mid-line.
      if (spec.cancel) result.stdout = result.stdout.slice(0, result.stdout.lastIndexOf('\n') + 1)
      const rewritten = await readFile('/opt/dsh-home/profiles/native-worker/cordis.patch.yml', 'utf8')
      assert.equal(rewritten, renderDshReasoningPatch(configuration),
        'runner profile must retain production policy while HOME supplies fixture overrides')
    }
    const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line))
    if (spec.missingCredential) {
      assert.notEqual(result.code, 0)
      assert.equal(requests.length, 0, 'missing credentials must fail before a model request')
    } else if (spec.status) {
      assert.notEqual(result.code, 0)
      assert.equal(requests.length, 1, 'permanent failures must not be retried')
      assert.equal(dshUsage(result.stdout).providerErrorCode, spec.expectedCode)
      assert.equal(dshUsage(result.stdout).providerHttpStatus, spec.status)
      assert.equal(dshUsage(result.stdout).usageComplete, false)
    } else {
      assert.equal(events.filter(event => event.type === 'tool_call' && event.callId === 'completed-tool').length, 1,
        'completed tools must not replay')
      assert.equal(events.filter(event => event.type === 'tool_result' && event.callId === 'completed-tool').length, 1)
      assert.equal(await readFile(marker, 'utf8'), 'executed\n', 'the real tool side effect must execute exactly once')
      assert.equal(events.some(event => event.type === 'tool_call' && event.callId === 'failed-read'), false)
      const retained = requests[1].body.messages
      assert.ok(retained.some(message => message.role === 'tool' && message.tool_call_id === 'completed-tool'
        && message.content.includes('completed-tool-evidence')))
      assert.ok(retained.some(message => message.role === 'assistant' && message.reasoning_content === 'completed-reasoning'))
      for (const request of requests.slice(2)) assert.deepEqual(request.body.messages, retained,
        'failed-step retries must retain completed history and exclude failed partial output')
      if (spec.exhausted) {
        assert.notEqual(result.code, 0)
        assert.equal(requests.length, 8, 'one successful tool step plus seven failed requests (six retries)')
        const usage = dshUsage(result.stdout)
        assert.equal(usage.providerErrorCode, spec.expectedCode)
        assert.equal(usage.inputTokens, 100, `known usage before failure must survive: ${result.stdout}`)
        assert.equal(usage.outputTokens, 5)
        assert.equal(usage.usageComplete, false, 'Unreported failed-attempt usage must remain unknown')
        if (runner) {
          const receipt = JSON.parse(await readFile(resultPath, 'utf8'))
          if (receiptWrapper) assert.equal(receipt.requestDigest, requestDigest)
          assert.equal(receipt.exitCode, 1, 'exhaustion must yield a real terminal receipt')
          assert.equal(receipt.providerErrorCode, spec.expectedCode)
          assert.equal(receipt.inputTokens, 100)
          assert.equal(receipt.outputTokens, 5)
        }
      } else if (spec.delegated) {
        assert.notEqual(result.code, 0)
        assert.equal(requests.length, 2, 'Retry-After above the native delay cap must delegate immediately')
        assert.ok(result.closedAt - failureAt < 3_000)
        assert.equal(dshUsage(result.stdout).providerErrorCode, 'SERVER')
      } else if (spec.cancel) {
        assert.notEqual(cancelledAt, null)
        assert.ok(result.closedAt - cancelledAt < 3_000, 'cancellation must abort native backoff promptly')
        assert.equal(requests.length, 2, 'cancelled backoff must not start another provider request')
        assert.equal(events.some(event => event.type === 'text' && event.text.includes('fixture-complete')), false)
      } else {
        assert.equal(result.code, 0, result.stderr)
        assert.ok(events.some(event => event.type === 'text' && event.text.includes('fixture-complete')))
        if (spec.outageMs) assert.ok(recoveredAt - failureAt >= spec.outageMs, 'real minute outage was not exercised')
        if (spec.retryAfter) {
          assert.equal(requests.length, 3)
          assert.ok(requests[2].at - requests[1].at >= 11_800, 'provider Retry-After was not honored')
        }
        if (spec.name === 'failed-partial-and-transport') assert.equal(requests.length, 4)
        if (spec.silentResponses) assert.equal(requests.length, 8,
          'recovery must succeed only after six idle timeouts exceed the former five-retry limit')
      }
    }
    console.log(JSON.stringify({ case: spec.name, result: 'PASS', providerRequests: requests.length,
      recoveredAfterMs: recoveredAt === null ? null : recoveredAt - failureAt, paidModelCalls: 0,
      delivery: runner ? 'native-home-overlay-with-installed-runner'
        : spec.nativeHomeOverlay ? 'native-home-overlay-with-pinned-cli' : 'profile' }))
  } finally {
    for (const timer of timers) clearTimeout(timer)
    if (child && child.exitCode === null && child.signalCode === null) signalChild('SIGKILL')
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

// The installed runner intentionally shares one HOME; each process gets its
// complete override before launch. Direct CLI cases use isolated profiles.
if (runner) { for (const spec of selectedCases) await runCase(spec) }
else {
  // Finish fixture cleanup even when another concurrent case fails.
  const results = await Promise.allSettled(selectedCases.map(runCase))
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
