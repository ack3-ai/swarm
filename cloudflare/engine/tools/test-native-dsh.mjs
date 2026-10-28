// Exercises the installed, pinned CLI against local OpenAI-compatible endpoints.
// Usage: DSH_BIN=/path/to/node_modules/.bin/dsh node tools/test-native-dsh.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { renderDshReasoningPatch } from '../container/reasoning-config.mjs'
import { dshUsage } from '../container/dsh-usage.mjs'

const bin = process.env.DSH_BIN
assert.ok(bin, 'Set DSH_BIN to the installed, pinned DSH CLI')
const modules = dirname(dirname(dirname(await realpath(bin))))
// The CLI binary is @deepseek-ai/dsh/bin/dsh.mjs; resolve its node_modules root.
let moduleRoot = modules
while (!moduleRoot.endsWith('/node_modules') && dirname(moduleRoot) !== moduleRoot) moduleRoot = dirname(moduleRoot)
assert.ok(moduleRoot.endsWith('/node_modules'))
const root = await mkdtemp(join(tmpdir(), 'swarm-native-dsh-'))
const profile = join(root, 'profiles', 'native-worker')
await mkdir(profile, { recursive: true })
await symlink(moduleRoot, join(profile, 'node_modules'))
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'native-dsh-fixture', private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } } }))
await writeFile(join(root, 'evidence.txt'), 'native-tool-round-trip')

async function runEndpoint(index) {
  const model = index === 4 ? 'deepseek-v4-flash' : `fixture/model-${index}`
  const key = `synthetic-provider-key-${index}`
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    requests.push({ path: req.url, authorization: req.headers.authorization, body })
    if (index === 3) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Fixture credits exhausted' } }));
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const data = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    const wireUsage = (prompt, output, cached) => index === 6 ? undefined
      : index === 7 ? { completion_tokens: output }
      : { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
        ...(index === 5 ? {} : { prompt_tokens_details: { cached_tokens: cached } }) }
    if (requests.length === 1) {
      data({ id: 'fixture-1', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: index === 2 ? 'fixture-reasoning' : undefined }, finish_reason: null }] })
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: {
        name: index === 4 ? 'bash' : 'read', arguments: index === 4 ? '{"command": "cd /workspace/source && cat >' : JSON.stringify({ file_path: join(root, 'evidence.txt') }),
      } }] }, finish_reason: null }] })
      data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: wireUsage(100, 5, 30) })
    } else {
      data({ id: 'fixture-2', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-complete' }, finish_reason: 'stop' }] })
      data({ choices: [], usage: wireUsage(200, 10, 20) })
    }
    res.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const connection = { baseUrl: `http://127.0.0.1:${server.address().port}/v1/`, apiKeyEnv: 'FIXTURE_API_KEY' }
  await writeFile(join(profile, 'cordis.patch.yml'), renderDshReasoningPatch({ model, connection,
    thinking: index === 1 ? 'disabled' : 'enabled', reasoningEffort: index === 1 ? 'none' : 'high' }))
  try {
    const result = await new Promise(resolve => {
      const child = spawn(bin, ['--profile', 'native-worker', '--json', 'Read evidence.txt, then finish.'], { cwd: root,
        env: { PATH: process.env.PATH, HOME: root, DSH_HOME: root, FIXTURE_API_KEY: key,
          DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'danger-full-access', DSH_TOOLS_MODE: 'native' } })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000)
      child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }) })
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
    if (index === 3) {
      assert.equal(result.code, 1)
      assert.equal(requests.length, 1, 'credit failures must not be retried')
      const usage = dshUsage(result.stdout)
      assert.equal(usage.providerHttpStatus, 402, JSON.stringify(result))
      assert.equal(usage.providerErrorCode, 'QUOTA')
      assert.equal(usage.usageComplete, false)
      console.log('PASS credit exhaustion: one native request, structured status402/QUOTA, unknown usage')
      return
    }
    assert.equal(result.code, 0, result.stderr)
    assert.equal(requests.length, 2, JSON.stringify({ requests: requests.map(r => ({ path: r.path, model: r.body.model, thinking: r.body.thinking, effort: r.body.reasoning_effort, max: r.body.max_tokens, keys: Object.keys(r.body), messages: r.body.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 120) : m.content, tool_calls: m.tool_calls })) })), stdout: result.stdout, stderr: result.stderr }))
    for (const request of requests) {
      assert.equal(request.path, '/v1/chat/completions')
      assert.equal(request.authorization, `Bearer ${key}`)
      assert.equal(request.body.model, model)
      assert.deepEqual(request.body.thinking, { type: index === 1 ? 'disabled' : 'enabled' })
      assert.equal(request.body.reasoning_effort, index === 1 ? undefined : 'high')
      assert.equal(request.body.stream, true)
      assert.equal(request.body.max_tokens, 256000)
      assert.ok(!('max_completion_tokens' in request.body))
      assert.ok(!('store' in request.body))
      assert.ok(!('session_log' in request.body))
      assert.ok(!('plugin_packages' in request.body))
    }
    const tool = requests[1].body.messages.find(message => message.role === 'tool')
    if (index === 4) {
      assert.match(tool?.content ?? '', /command|required|invalid/i)
      const call = requests[1].body.messages.find(message => message.role === 'assistant').tool_calls[0]
      assert.deepEqual(JSON.parse(call.function.arguments), {}, 'Malformed history must not poison the next request')
    } else assert.ok(tool?.content.includes('native-tool-round-trip'))
    assert.equal(tool.tool_call_id, 'read-fixture')
    if (index === 2) assert.equal(requests[1].body.messages.find(message => message.role === 'assistant').reasoning_content, 'fixture-reasoning')
    else assert.equal(requests[1].body.messages.find(message => message.role === 'assistant').reasoning_content, '')
    const usage = dshUsage(result.stdout)
    if (index === 6 || index === 7) {
      assert.equal(usage.usageComplete, false, 'Absent/partial wire usage must not settle synthetic zero counters')
      assert.equal(usage.cacheAccountingComplete, false)
    } else assert.deepEqual({ ...usage, actorId: 'redacted' }, { actorId: 'redacted', inputTokens: index === 5 ? 300 : 250, rawInputTokens: 300,
      cachedInputTokens: index === 5 ? 0 : 50, outputTokens: 15, usageComplete: true, cacheAccountingComplete: true,
      providerHttpStatus: null, providerErrorCode: null })
    assert.ok(result.stdout.includes('fixture-complete'))
    console.log(`PASS endpoint ${index}: native CLI, model, credential, thinking, tool history and step usage`)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

try {
  const cliPackage = JSON.parse(await readFile(join(moduleRoot, '@deepseek-ai/dsh/package.json')))
  assert.equal(cliPackage.version, '0.2.1-rc.2')
  await runEndpoint(1)
  await runEndpoint(2)
  await runEndpoint(3)
  await runEndpoint(4)
  await runEndpoint(5)
  await runEndpoint(6)
  await runEndpoint(7)
} finally { await rm(root, { recursive: true, force: true }) }
