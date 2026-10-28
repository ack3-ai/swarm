import { test, vi, afterEach } from 'vitest'
import assert from 'node:assert/strict'
// @ts-expect-error The operator entry point is intentionally plain Node.js.
import { deployCode, observeVersion, uploadForm, uploadMetadata } from '../tools/deploy-code.mjs'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

const version = '11111111-2222-4333-8444-555555555555'
const build = { main_module: 'worker.js', compatibility_date: '2026-09-18', compatibility_flags: ['nodejs_compat'],
  migrations: { new_sqlite_classes: ['NeverCreateThis'] }, containers: [{ class_name: 'Sandbox' }],
  bindings: [{ name: 'CONTROL_API_TOKEN', type: 'secret_text', text: 'must-not-upload' }] }
const settings = {
  compatibility_date: build.compatibility_date, compatibility_flags: build.compatibility_flags,
  bindings: [
    { name: 'ENGINE_ROLE', type: 'plain_text', text: 'front-door' },
    { name: 'VERSION_METADATA', type: 'version_metadata' },
    { name: 'CONTROL_API_TOKEN', type: 'secret_text' },
    { name: 'COORDINATORS', type: 'durable_object_namespace', namespace_id: 'existing' },
    { name: 'RUNTIME_X', type: 'service', service: 'existing-private-runtime' },
    { name: 'RUNTIME_CATALOG_JSON', type: 'plain_text', text: '{"latest":"x"}' },
    { name: 'ARTIFACTS', type: 'r2_bucket', bucket_name: 'existing-artifacts' },
  ],
  limits: { cpu_ms: 300000 }, observability: { enabled: true }, logpush: false,
  placement: { mode: 'smart' }, tags: ['unchanged'], tail_consumers: [], annotations: { 'workers/message': 'existing' },
}

test('sends code-only metadata, never bindings, secrets or resource changes', () => {
  assert.deepEqual(uploadMetadata(build, settings), { main_module: 'worker.js' })
})

test('cannot publish to a runtime or change the compatibility contract', () => {
  for (const binding of [
    { name: 'ENGINE_ROLE', type: 'plain_text', text: 'runtime' },
    { name: 'Sandbox', type: 'durable_object_namespace' },
    { name: 'AUDIT_WORKFLOW', type: 'workflow' },
  ]) {
    const bindings = settings.bindings.filter(b => b.name !== binding.name).concat(binding)
    assert.throws(() => uploadMetadata(build, { ...settings, bindings }))
  }
  assert.throws(() => uploadMetadata({ ...build, compatibility_date: '2026-10-01' }, settings))
  assert.throws(() => uploadMetadata({ ...build, compatibility_flags: [] }, settings))
  assert.throws(() => uploadMetadata(build, { ...settings, bindings: [] }))
})

test('preserves all module bytes from Wrangler multipart output, replacing metadata only', async () => {
  const form = new FormData()
  const binary = new Uint8Array([0, 255, 123, 13, 10])
  form.set('metadata', JSON.stringify(build))
  form.set('worker.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'worker.js')
  form.set('dashboard.html', new Blob(['<h1>Dashboard</h1>'], { type: 'text/plain' }), 'dashboard.html')
  form.set('data.bin', new Blob([binary], { type: 'application/octet-stream' }), 'data.bin')
  const bytes = Buffer.from(await new Response(form).arrayBuffer())
  const uploaded = await uploadForm(bytes, settings)
  assert.deepEqual([...uploaded.keys()], [...form.keys()])
  for (const key of ['worker.js', 'dashboard.html', 'data.bin']) {
    assert.deepEqual(await uploaded.get(key).arrayBuffer(), await (form.get(key) as File).arrayBuffer())
    assert.equal(uploaded.get(key).type, (form.get(key) as File).type)
  }
  assert.deepEqual(JSON.parse(uploaded.get('metadata')), uploadMetadata(build, settings))
  await assert.rejects(uploadForm(Buffer.from('not multipart'), settings))
})


test('failed focused checks prevent upload, even after successful build and remote preparation', async () => {
  const methods: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation( async (url, init) => {
    methods.push(init?.method ?? 'GET')
    return Response.json(String(url).endsWith('/health')
      ? { role: 'front-door', workerVersionId: version }
      : { success: true, result: settings })
  })
  await assert.rejects(deployCode(version, [process.execPath, '-e', 'process.exit(23)'], {
    ...process.env, ACK3_CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'test-only', CONTROL_API_TOKEN: 'test-only', ACK3_ENGINE_URL: 'https://swarm.example.workers.dev',
  }), /failed \(23\)/)
  assert.deepEqual(methods, ['GET', 'GET'])
}, 30_000)


test('waits for propagation without another upload and stops at the delivery deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  const health = vi.fn().mockResolvedValueOnce({ workerVersionId: 'old' }).mockResolvedValue({ workerVersionId: version })
  const next = observeVersion(health, version, performance.now() + 500)
  await vi.advanceTimersByTimeAsync(100)
  assert.deepEqual(await next, { workerVersionId: version })
  assert.equal(health.mock.calls.length, 2)
  const unchanged = vi.fn().mockResolvedValue({ workerVersionId: 'old' })
  const expired = observeVersion(unchanged, version, performance.now() + 250)
  await vi.advanceTimersByTimeAsync(250)
  assert.deepEqual(await expired, { workerVersionId: 'old' })
  assert.equal(unchanged.mock.calls.length, 3)
})
