// Run only inside the sandbox image, with network disabled. DSH uses loopback
// fixtures; Codex's launch contract is checked by a CLI double, without auth.
// node /src/tools/test-native-prompt-stdin.mjs /src/container/agent-runner.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { chmod, chown, mkdir, readFile, writeFile } from 'node:fs/promises'
import { renderDshReasoningPatch } from '../container/reasoning-config.mjs'

assert.equal(process.platform, 'linux')
assert.equal(process.getuid(), 0, 'Requires a disposable sandbox container')
const runner = process.argv[2]
assert.ok(runner)
for (const path of ['/workspace/private', '/workspace/source', '/workspace/results', '/workspace/home', '/fixture-bin']) {
  await mkdir(path, { recursive: true })
  await chown(path, 10001, 10001)
}
const prompt = '  Begin full diagnostics\n' + 'Distinct diagnostic αβγ: preserve all bytes.\n'.repeat(16000) + '\nEND\n '
assert.ok(Buffer.byteLength(prompt) > 512 * 1024)
const requests = []
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  requests.push(JSON.parse(Buffer.concat(chunks)))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-complete' }, finish_reason: 'stop' }] })}\n\n`)
  res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = { provider: 'fixture', model: 'fixture/model', thinking: 'enabled', reasoningEffort: 'max',
  connection: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_API_KEY' } }
let ordinal = 0
async function run(request) {
  const digest = (++ordinal).toString(16).padStart(64, '0')
  const requestPath = `/workspace/private/request-${ordinal}.json`, resultPath = `/workspace/private/result-${ordinal}.json`
  await writeFile(requestPath, JSON.stringify({ ...request, requestDigest: digest, expectedFiles: [],
    taskId: 'stdin-fixture', runId: 'stdin-fixture', attempt: ordinal, workingDirectory: '/workspace/source' }))
  const child = spawn(process.execPath, [runner, requestPath, resultPath], { env: {
    PATH: `/fixture-bin:${process.env.PATH}`, FIXTURE_API_KEY: 'synthetic-fixture-key',
    ACK3_CODEX_WORKSPACE_ID: '00000000-0000-4000-8000-000000000001',
  }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout.resume()
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, stderr)
  const result = JSON.parse(await readFile(resultPath, 'utf8'))
  assert.equal(result.exitCode, 0)
  return result
}
try {
  await writeFile('/opt/dsh-home/cordis.patch.yml', renderDshReasoningPatch(config), { mode: 0o644 })
  const first = await run({ ...config, providerClass: 'additive', backend: 'dsh-chat-completions',
    prompt, continuationMode: 'new', sessionId: null })
  const resumePrompt = prompt.replace('Begin full diagnostics', 'Resume full diagnostics')
  await writeFile('/opt/dsh-home/cordis.patch.yml', renderDshReasoningPatch(config) + [
    '- id: headless-runner', '  config:', '    task: !!js ctx.headlessStartup.task',
    '    json: !!js ctx.headlessStartup.json', `    sessionId: ${JSON.stringify(first.actorId)}`, '',
  ].join('\n'))
  const resumed = await run({ ...config, providerClass: 'additive', backend: 'dsh-chat-completions',
    prompt: resumePrompt, continuationMode: 'resume', sessionId: first.actorId })
  assert.equal(resumed.actorId, first.actorId)
  assert.equal(requests.length, 2, 'No retry or history replay')
  const text = message => typeof message.content === 'string' ? message.content
    : message.content.map(part => part.text ?? '').join('')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const userPrompts = request => request.messages.filter(m => m.role === 'user').map(text)
    .filter(value => !value.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'))
  assert.deepEqual(userPrompts(requests[0]).map(hash), [hash(prompt)])
  assert.deepEqual(userPrompts(requests[1]).map(hash), [hash(prompt), hash(resumePrompt)])
  assert.ok(requests[1].messages.some(m => m.role === 'assistant' && text(m) === 'fixture-complete'))
  console.log('PASS installed DSH: large UTF-8 prompts, new/resume, exact bytes, same session/history, two loopback requests')

  // A double isolates the adapter from subscription authentication. The installed
  // Codex exec/resume help separately documents the native "-" stdin contract.
  await writeFile('/fixture-bin/codex', `#!/usr/bin/env node
import{writeFileSync}from'node:fs';
if(process.argv.includes('app-server'))process.exit(0);
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
writeFileSync('/workspace/results/codex-capture.json',JSON.stringify({args:process.argv.slice(2),stdin:Buffer.concat(chunks).toString('utf8')}));
console.log(JSON.stringify({type:'thread.started',thread_id:'00000000-0000-4000-8000-000000000002'}));
`)
  await chmod('/fixture-bin/codex', 0o755)
  for (const continuationMode of ['new', 'resume']) {
    const sessionId = continuationMode === 'new' ? null : '00000000-0000-4000-8000-000000000002'
    await run({ providerClass: 'core', backend: 'codex', model: 'fixture', reasoningEffort: 'high',
      prompt, continuationMode, sessionId })
    const captured = JSON.parse(await readFile('/workspace/results/codex-capture.json', 'utf8'))
    assert.equal(hash(captured.stdin), hash(prompt))
    assert.equal(captured.args.at(-1), '-')
    assert.ok(captured.args.every(arg => Buffer.byteLength(arg) < 1024))
    assert.equal(captured.args.includes('resume'), continuationMode === 'resume')
    if (sessionId) assert.equal(captured.args.at(-2), sessionId)
  }
  console.log('PASS Codex adapter: large UTF-8 stdin, new/resume argv and session preserved (CLI double)')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
