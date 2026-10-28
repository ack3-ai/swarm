import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startAuditOnce } from '../tools/start-audit-once.mjs'

test('audit start uses the supplied control token, dispatches once and never saves it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-start-test-'))
  const previous = { token: process.env.CONTROL_API_TOKEN, url: process.env.ACK3_ENGINE_URL }
  t.after(() => {
    if (previous.token === undefined) delete process.env.CONTROL_API_TOKEN
    else process.env.CONTROL_API_TOKEN = previous.token
    if (previous.url === undefined) delete process.env.ACK3_ENGINE_URL
    else process.env.ACK3_ENGINE_URL = previous.url
    rmSync(root, { recursive: true, force: true })
  })
  const args = { runId: 'run-test', experimentId: 'experiment-test', runtimeId: 'runtime-test',
    releaseDigest: 'a'.repeat(64), intentFile: join(root, 'intent.json') }
  const runtimeRelease = { id: args.runtimeId }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.headers.authorization, 'Bearer synthetic-control-token')
    assert.ok(url.startsWith('https://swarm.example.workers.dev/'))
    calls.push(init.method ?? 'GET')
    const body = url.endsWith('/release') ? { digest: args.releaseDigest, generation: 1,
      runtimeSelector: { mode: 'release', id: args.runtimeId } }
      : url.endsWith('/identity') ? runtimeRelease
      : init.method === 'POST' ? { runId: args.runId, releaseDigest: args.releaseDigest, runtimeRelease }
      : { state: { releaseDigest: args.releaseDigest, stateGeneration: 1 }, runtimeRelease,
        workflow: { status: 'running' } }
    return Response.json(body, { status: init.method === 'POST' ? 202 : 200 })
  })
  delete process.env.CONTROL_API_TOKEN
  await assert.rejects(startAuditOnce(args), /CONTROL_API_TOKEN is required/)
  assert.equal(calls.length, 0)
  process.env.CONTROL_API_TOKEN = 'synthetic-control-token'
  delete process.env.ACK3_ENGINE_URL
  await assert.rejects(startAuditOnce(args), /ACK3_ENGINE_URL is required/)
  assert.equal(calls.length, 0)
  process.env.ACK3_ENGINE_URL = 'https://swarm.example.workers.dev/'
  assert.equal((await startAuditOnce(args)).workflow, 'running')
  await assert.rejects(startAuditOnce(args), /fresh absolute owner-only intent file/)
  assert.deepEqual(calls, ['GET', 'GET', 'POST', 'GET'])
  assert.equal(readFileSync(args.intentFile, 'utf8').includes('synthetic-control-token'), false)
})
