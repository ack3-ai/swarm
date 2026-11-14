import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runtimeCodeUploadForm } from '../tools/rotate-runtime-code.mjs'

const settings = {
  compatibility_date: '2026-09-18', compatibility_flags: ['nodejs_compat'],
  usage_model: 'standard', tags: ['runtime'], tail_consumers: [], logpush: false,
  limits: { cpu_ms: 30000 }, observability: { enabled: true }, placement: { mode: 'smart' },
  annotations: { read_only: 'not upload metadata' },
  bindings: [
    { name: 'ENGINE_ROLE', type: 'plain_text', text: 'runtime' },
    { name: 'ACK3_CODEX_WORKSPACE_ID', type: 'plain_text', text: 'workspace-fixture' },
    { name: 'ACK3_CODEX_AUTH_JSON', type: 'secrets_store_secret' },
    { name: 'EXA_API_KEY', type: 'secrets_store_secret' },
    { name: 'PROVIDER_API_KEY', type: 'secrets_store_secret' },
    { name: 'CLOUDFLARE_OBSERVABILITY_TOKEN', type: 'secrets_store_secret' },
    { name: 'ACK3_CLOUDFLARE_ACCOUNT_ID', type: 'plain_text', text: 'a'.repeat(32) },
    { name: 'VERSION_METADATA', type: 'version_metadata' },
    { name: 'AGENT_SANDBOX', type: 'durable_object_namespace', class_name: 'AgentSandbox', namespace_id: 'native-namespace' },
    { name: 'COORDINATORS', type: 'durable_object_namespace', class_name: 'ExperimentCoordinator', namespace_id: 'coordinator-namespace' },
    { name: 'AUDIT_WORKFLOW', type: 'workflow' },
    { name: 'RUNTIME_ISOLATION_WORKFLOW', type: 'workflow' },
  ],
}

const containers = [{ class_name: 'AgentSandbox', name: 'native-runtime-sandbox', image: 'retained-native-image' }]

async function multipart() {
  const form = new FormData()
  form.set('metadata', JSON.stringify({ main_module: 'worker.js',
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    bindings: [{ name: 'RUNTIME_RELEASE_JSON', type: 'plain_text', text: 'stale' }],
    containers: [{ class_name: 'AgentSandbox', name: 'stale-build-container' }] }))
  form.set('worker.js', new Blob(['export default { fetch() { return new Response("ok") } }'],
    { type: 'application/javascript' }), 'worker.js')
  const request = new Request('https://example.invalid', { method: 'POST', body: form })
  return Buffer.from(await request.arrayBuffer())
}

test('runtime script upload retains module and strips stale dry-run bindings', async () => {
  const output = await runtimeCodeUploadForm(await multipart(), settings, containers)
  assert.equal(output.has('worker.js'), true)
  const { annotations, ...uploadSettings } = settings
  assert.deepEqual(JSON.parse(output.get('metadata')), {
    ...uploadSettings, main_module: 'worker.js', containers,
    bindings: settings.bindings.map(({ namespace_id, ...binding }) => binding),
  })
  assert.equal(settings.bindings.find(binding => binding.name === 'AGENT_SANDBOX').namespace_id, 'native-namespace')
})

test('runtime script upload refuses missing engine secret custody', async () => {
  const incomplete = { ...settings, bindings: settings.bindings.filter(x => x.name !== 'EXA_API_KEY') }
  await assert.rejects(runtimeCodeUploadForm(await multipart(), incomplete, containers), /EXA_API_KEY/)
})

test('runtime script upload rejects legacy local secret bindings', async () => {
  const legacy = { ...settings, bindings: settings.bindings.map(x =>
    x.type === 'secrets_store_secret' ? { ...x, type: 'secret_text' } : x) }
  await assert.rejects(runtimeCodeUploadForm(await multipart(), legacy, containers), /ACK3_CODEX_AUTH_JSON/)
})

test('a runtime without a Codex login needs no Codex binding; one with a login keeps it', async () => {
  const withoutCodex = { ...settings, bindings: settings.bindings
    .filter(binding => binding.name !== 'ACK3_CODEX_AUTH_JSON')
    .map(binding => binding.name === 'ACK3_CODEX_WORKSPACE_ID' ? { ...binding, text: '' } : binding) }
  assert.equal((await runtimeCodeUploadForm(await multipart(), withoutCodex, containers)).has('worker.js'), true)
  const missing = { ...settings, bindings: settings.bindings.filter(binding => binding.name !== 'ACK3_CODEX_AUTH_JSON') }
  await assert.rejects(runtimeCodeUploadForm(await multipart(), missing, containers), /ACK3_CODEX_AUTH_JSON/)
})

test('code-only rotation requires the monitoring binding and account already configured', async () => {
  for (const name of ['CLOUDFLARE_OBSERVABILITY_TOKEN', 'ACK3_CLOUDFLARE_ACCOUNT_ID']) {
    await assert.rejects(runtimeCodeUploadForm(await multipart(), {
      ...settings, bindings: settings.bindings.filter(binding => binding.name !== name),
    }, containers), new RegExp(name))
  }
})

test('code-only rotation refuses a slot published before its local coordinator binding', async () => {
  for (const bindings of [
    settings.bindings.filter(binding => binding.name !== 'COORDINATORS'),
    settings.bindings.map(binding => binding.name === 'COORDINATORS' ? { ...binding, class_name: 'AgentSandbox' } : binding),
  ]) {
    await assert.rejects(runtimeCodeUploadForm(await multipart(), { ...settings, bindings }, containers),
      /COORDINATORS binding is missing or changed; publish the full runtime/)
  }
})


test('preserves all supplied native container metadata instead of stale local metadata', async () => {
  const native = [...containers, { class_name: 'OtherContainer', name: 'retained-other', extra_native_field: { enabled: true } }]
  const output = await runtimeCodeUploadForm(await multipart(), settings, native)
  assert.deepEqual(JSON.parse(output.get('metadata')).containers, native)
})

test('missing or ambiguous native agent sandbox metadata prevents publication', async () => {
  for (const missing of [undefined, null, [], [{ class_name: 'OtherContainer' }], [...containers, ...containers]]) {
    await assert.rejects(runtimeCodeUploadForm(await multipart(), settings, missing), /native agent sandbox container metadata/)
  }
})


test('normalizes only Durable Object namespace IDs and omits absent optional settings', async () => {
  const minimal = {
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    bindings: [...settings.bindings, { name: 'OTHER', type: 'future_binding', namespace_id: 'retained' }],
  }
  const output = await runtimeCodeUploadForm(await multipart(), minimal, containers)
  const metadata = JSON.parse(output.get('metadata'))
  assert.equal('observability' in metadata, false)
  assert.equal('namespace_id' in metadata.bindings.find(binding => binding.name === 'AGENT_SANDBOX'), false)
  assert.equal(metadata.bindings.find(binding => binding.name === 'OTHER').namespace_id, 'retained')
})

test('builds and runs the focused checks before it asks for the slot lock', async t => {
  const root = mkdtempSync(join(tmpdir(), 'ack3-rotation-order-'))
  const saved = { fetch: globalThis.fetch, env: { ...process.env } }
  t.after(() => {
    globalThis.fetch = saved.fetch
    process.env = saved.env
    rmSync(root, { recursive: true, force: true })
  })
  const repository = join(root, 'repository')
  const engine = join(repository, 'cloudflare/engine')
  const log = join(root, 'order.log')
  mkdirSync(join(engine, 'tools'), { recursive: true })
  mkdirSync(join(engine, 'node_modules/wrangler/bin'), { recursive: true })
  copyFileSync(new URL('../tools/rotate-runtime-code.mjs', import.meta.url), join(engine, 'tools/rotate-runtime-code.mjs'))
  copyFileSync(new URL('../wrangler.jsonc', import.meta.url), join(engine, 'wrangler.jsonc'))
  writeFileSync(join(engine, 'node_modules/wrangler/package.json'), '{"type":"commonjs"}\n')
  writeFileSync(join(engine, 'node_modules/wrangler/bin/wrangler.js'), [
    "const fs = require('node:fs')",
    `fs.appendFileSync(${JSON.stringify(log)}, 'build\\n')`,
    "fs.writeFileSync(process.argv[process.argv.indexOf('--outfile') + 1], 'bundle')",
  ].join('\n'))
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
  git(['init', '-q'])
  git(['add', '--all'])
  git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '-m', 'fixture'])
  const { rotateRuntimeCode } = await import(pathToFileURL(join(engine, 'tools/rotate-runtime-code.mjs')).href)
  Object.assign(process.env, { CLOUDFLARE_API_TOKEN: 'test-token', CONTROL_API_TOKEN: 'test-token',
    ACK3_ENGINE_URL: 'https://control.invalid' })
  delete process.env.ACK3_DEPLOY_DEADLINE_MS
  globalThis.fetch = async url => {
    appendFileSync(log, `fetch ${url}\n`)
    throw new Error('test: no network')
  }
  const rotate = (intentFile, status) => rotateRuntimeCode({ intentFile, expectedCommit: git(['rev-parse', 'HEAD']),
    expectedImage: `sha256:${'b'.repeat(64)}`, account: 'a'.repeat(32), check: [[process.execPath, ['-e',
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'check\\n'); process.exit(${status})`]]] })
  const order = () => readFileSync(log, 'utf8').trim().split('\n')

  const refused = join(root, 'refused-intent.json')
  await assert.rejects(rotate(refused, 1), /bundle build or focused check failed; no slot was locked/)
  assert.deepEqual(order(), ['build', 'check'])
  assert.equal(existsSync(refused), false)

  rmSync(log)
  const accepted = join(root, 'accepted-intent.json')
  await assert.rejects(rotate(accepted, 0), /test: no network/)
  assert.deepEqual(order(), ['build', 'check', 'fetch https://control.invalid/v1/runtime-slots/rotations'])
  assert.equal(JSON.parse(readFileSync(accepted, 'utf8')).phase, 'lock-request')
})
