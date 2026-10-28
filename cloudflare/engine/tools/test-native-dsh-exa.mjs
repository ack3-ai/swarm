// Installed DSH + real MCP bridge, with a scripted local model (no paid model calls).
// DSH_BIN=/opt/harness/node_modules/.bin/dsh node tools/test-native-dsh-exa.mjs
// LIVE_EXA=1 EXA_API_KEY=... uses the official hosted MCP for one public search.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { renderDshReasoningPatch, exaMcpUrl, exaSourceLabel } from '../container/reasoning-config.mjs'
import { dshNativeSearchAttempted, dshNativeSearchEvidence } from '../container/native-search-evidence.mjs'

const bin = process.env.DSH_BIN
assert.ok(bin, 'Set DSH_BIN to the installed, pinned native DSH CLI')
const live = process.env.LIVE_EXA === '1'
const key = live ? process.env.EXA_API_KEY : 'fixture-exa-secret'
assert.ok(key, 'EXA_API_KEY is required for a hosted MCP smoke test')
let moduleRoot = dirname(await realpath(bin))
while (!moduleRoot.endsWith('/node_modules') && dirname(moduleRoot) !== moduleRoot) moduleRoot = dirname(moduleRoot)
assert.ok(moduleRoot.endsWith('/node_modules'))
const root = await mkdtemp(join(tmpdir(), 'swarm-native-exa-'))
const profile = join(root, 'profiles/native-worker')
const attribution = { agent: 'fixture-model', stage: 'discovery', wave: 'wave-0', task: 'public-search-fixture' }
const query = 'Solidity checks effects interactions reentrancy pattern'
const requests = [], mcpRequests = []
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server => server.address().port
const bodyOf = async request => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks)) }
const mcp = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(405).end(); return }
  const body = await bodyOf(request)
  mcpRequests.push({ method: body.method, authorization: request.headers.authorization, source: request.headers['x-exa-source'] })
  let result
  if (body.method === 'initialize') result = { protocolVersion: body.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: 'fixture-exa', version: '1' } }
  else if (body.method === 'tools/list') result = { tools: ['web_search_exa', 'web_fetch_exa'].map(name => ({
    name, description: 'Public evidence fixture', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  })) }
  else if (body.method === 'tools/call') {
    assert.equal(body.params.name, 'web_search_exa')
    result = body.params.arguments.query === 'fixture search error'
      ? { isError: true, content: [{ type: 'text', text: 'fixture backend error' }] }
      : { content: [{ type: 'text', text: 'Public fixture source: https://example.org/solidity' }] }
  } else {
    if (body.id === undefined) { response.writeHead(204).end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
})
const model = createServer(async (request, response) => {
  const body = await bodyOf(request)
  requests.push(body)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const data = payload => response.write(`data: ${JSON.stringify(payload)}\n\n`)
  const searchCount = live ? 1 : 2
  if (requests.length <= searchCount) {
    data({ id: `step-${requests.length}`, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
      id: `search-${requests.length}`, type: 'function', function: { name: 'mcp__exa__web_search_exa',
        arguments: JSON.stringify({ query: requests.length === 1 ? query : 'fixture search error' }) } }] }, finish_reason: null }] })
    data({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
  } else data({ id: 'complete', choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-complete' }, finish_reason: 'stop' }] })
  response.end('data: [DONE]\n\n')
})
try {
  await Promise.all([listen(mcp), listen(model)])
  await mkdir(profile, { recursive: true })
  await symlink(moduleRoot, join(profile, 'node_modules'))
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'native-exa-fixture', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } } }))
  const input = { model: 'fixture-model', thinking: 'disabled', reasoningEffort: 'none',
    connection: { baseUrl: `http://127.0.0.1:${port(model)}/v1`, apiKeyEnv: 'FIXTURE_API_KEY' },
    searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' }, searchAttribution: attribution }
  // Match production layering: provider profile first, search MCP in native HOME.
  await writeFile(join(profile, 'cordis.patch.yml'), renderDshReasoningPatch({ ...input, searchConnection: undefined }))
  const patch = renderDshReasoningPatch(input)
  assert.ok(!patch.includes(key))
  await writeFile(join(root, 'cordis.patch.yml'), live ? patch : patch.replace(exaMcpUrl, `http://127.0.0.1:${port(mcp)}/mcp`))
  const result = await new Promise(resolve => {
    const child = spawn(bin, ['--profile', 'native-worker', '--json', 'Use mcp__exa__web_search_exa to inspect the public Solidity mechanism.'], {
      cwd: root, env: { PATH: process.env.PATH, HOME: root, DSH_HOME: root, FIXTURE_API_KEY: 'fixture-model-secret', EXA_API_KEY: key,
        DSH_TELEMETRY_MODE: 'DISABLED', DSH_PERMISSION_MODE: 'danger-full-access', DSH_TOOLS_MODE: 'native' },
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = setTimeout(() => child.kill('SIGKILL'), live ? 150_000 : 30_000)
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
  assert.equal(result.code, 0, result.stderr.replaceAll(key, '<redacted>'))
  assert.equal(requests.length, live ? 2 : 3)
  const names = requests[0].tools.map(tool => tool.function.name)
  assert.ok(names.includes('mcp__exa__web_search_exa'))
  assert.ok(names.includes('mcp__exa__web_fetch_exa'))
  assert.ok(!names.includes('web_search') && !names.includes('web_fetch'))
  assert.ok(dshNativeSearchAttempted(result.stdout))
  const evidence = dshNativeSearchEvidence(result.stdout)
  assert.equal(evidence.completed.length, 1, JSON.stringify(evidence))
  assert.equal(evidence.failed, live ? 0 : 1)
  assert.deepEqual(evidence.completed[0].queries, [query])
  assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key), 'Native logs must not expose MCP authentication')
  if (!live) {
    assert.ok(mcpRequests.some(request => request.method === 'tools/call'))
    for (const request of mcpRequests) {
      assert.equal(request.authorization, `Bearer ${key}`)
      assert.equal(request.source, exaSourceLabel(attribution))
    }
  }
  console.log(JSON.stringify({ passed: true, live, nativeTools: names.filter(name => /exa|web_search|web_fetch/.test(name)),
    modelRequests: requests.length, completedSearches: evidence.completed.length, failedSearches: evidence.failed,
    source: exaSourceLabel(attribution), localMcpHeadersVerified: !live, credentialsAbsentFromLogs: true }))
} finally {
  for (const server of [mcp, model]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  await rm(root, { recursive: true, force: true })
}
