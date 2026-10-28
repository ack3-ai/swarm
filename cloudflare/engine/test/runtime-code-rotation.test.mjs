import assert from 'node:assert/strict'
import test from 'node:test'
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
    { name: 'Sandbox', type: 'durable_object_namespace', class_name: 'Sandbox', namespace_id: 'native-namespace' },
    { name: 'AUDIT_WORKFLOW', type: 'workflow' },
    { name: 'RUNTIME_ISOLATION_WORKFLOW', type: 'workflow' },
  ],
}

const containers = [{ class_name: 'Sandbox', name: 'native-runtime-sandbox', image: 'retained-native-image' }]

async function multipart() {
  const form = new FormData()
  form.set('metadata', JSON.stringify({ main_module: 'worker.js',
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    bindings: [{ name: 'RUNTIME_RELEASE_JSON', type: 'plain_text', text: 'stale' }],
    containers: [{ class_name: 'Sandbox', name: 'stale-build-container' }] }))
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
  assert.equal(settings.bindings.find(binding => binding.name === 'Sandbox').namespace_id, 'native-namespace')
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


test('preserves all supplied native container metadata instead of stale local metadata', async () => {
  const native = [...containers, { class_name: 'OtherContainer', name: 'retained-other', extra_native_field: { enabled: true } }]
  const output = await runtimeCodeUploadForm(await multipart(), settings, native)
  assert.deepEqual(JSON.parse(output.get('metadata')).containers, native)
})

test('missing or ambiguous native Sandbox metadata prevents publication', async () => {
  for (const missing of [undefined, null, [], [{ class_name: 'OtherContainer' }], [...containers, ...containers]]) {
    await assert.rejects(runtimeCodeUploadForm(await multipart(), settings, missing), /native Sandbox container metadata/)
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
  assert.equal('namespace_id' in metadata.bindings.find(binding => binding.name === 'Sandbox'), false)
  assert.equal(metadata.bindings.find(binding => binding.name === 'OTHER').namespace_id, 'retained')
})
