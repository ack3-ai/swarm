import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(engine, '../..')
const sha = /^[0-9a-f]{40}$/
const digest = /^sha256:[0-9a-f]{64}$/
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export async function runtimeCodeUploadForm(bytes, settings, containers) {
  const bindings = settings.bindings ?? []
  const named = name => bindings.find(item => item.name === name)
  assert.equal(named('ENGINE_ROLE')?.text, 'runtime', 'ENGINE_ROLE must be runtime')
  const codex = (named('ACK3_CODEX_WORKSPACE_ID')?.text ?? '') !== ''
  for (const [name, type] of [
    ...(codex ? [['ACK3_CODEX_AUTH_JSON', 'secrets_store_secret']] : []),
    ['EXA_API_KEY', 'secrets_store_secret'],
    ['CLOUDFLARE_OBSERVABILITY_TOKEN', 'secrets_store_secret'],
    ['VERSION_METADATA', 'version_metadata'],
    ['Sandbox', 'durable_object_namespace'],
    ['AUDIT_WORKFLOW', 'workflow'],
    ['RUNTIME_ISOLATION_WORKFLOW', 'workflow'],
  ]) assert.equal(named(name)?.type, type, `${name} binding is missing or changed`)
  assert.match(named('ACK3_CLOUDFLARE_ACCOUNT_ID')?.text ?? '', /^[0-9a-f]{32}$/i,
    'ACK3_CLOUDFLARE_ACCOUNT_ID binding is missing; configure the reserved idle slot before code rotation')
  assert.ok(Array.isArray(containers) && containers.filter(item => item?.class_name === 'Sandbox').length === 1,
    'native Sandbox container metadata is missing or ambiguous; refusing code-only publication')
  const end = bytes.indexOf('\r\n')
  assert.ok(end > 2 && end < 200, 'Wrangler multipart output is invalid')
  const boundary = bytes.subarray(2, end).toString()
  assert.match(boundary, /^[-a-zA-Z0-9]+$/)
  const form = await new Response(bytes, { headers: {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  } }).formData()
  const metadata = JSON.parse(form.get('metadata'))
  assert.equal(metadata.compatibility_date, settings.compatibility_date)
  assert.deepEqual(metadata.compatibility_flags, settings.compatibility_flags)
  assert.equal(typeof metadata.main_module, 'string')
  assert.ok(form.has(metadata.main_module))
  // Use the standard script upload to retain native container capability as well
  // as recorded metadata. Carry current settings, never stale dry-run bindings.
  const uploadMetadata = { main_module: metadata.main_module, containers }
  for (const key of ['compatibility_date', 'compatibility_flags', 'usage_model',
    'tags', 'tail_consumers', 'logpush', 'limits', 'observability', 'placement']) {
    if (settings[key] !== undefined) uploadMetadata[key] = settings[key]
  }
  uploadMetadata.bindings = bindings.map(binding => {
    if (binding.type !== 'durable_object_namespace') return binding
    const { namespace_id, ...uploadBinding } = binding
    return uploadBinding
  })
  form.set('metadata', JSON.stringify(uploadMetadata))
  return form
}

function normalizedVersion(value) {
  assert.equal(typeof value, 'string')
  const result = /^[0-9a-f]{32}$/.test(value)
    ? value.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : value
  assert.match(result, uuid)
  return result
}

async function requestJson(url, token, init = {}) {
  const response = await fetch(url, { ...init,
    headers: { authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers },
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`request HTTP ${response.status}: ${new URL(url).pathname}`)
  return body
}

function saveIntent(path, record, first = false) {
  const contents = JSON.stringify(record, null, 2) + '\n'
  if (first) {
    writeFileSync(path, contents, { mode: 0o600, flag: 'wx' })
    return
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, contents, { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally { rmSync(temporary, { force: true }) }
}

export async function rotateRuntimeCode({ intentFile, expectedCommit, expectedImage, account,
  check = [], start = performance.now() }) {
  assert.match(expectedCommit ?? '', sha)
  assert.match(expectedImage ?? '', digest)
  assert.match(account ?? '', /^[0-9a-f]{32}$/)
  assert.ok(intentFile && resolve(intentFile) === intentFile && !existsSync(intentFile),
    'fresh absolute owner-only intent file required')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
  assert.equal(head, expectedCommit, 'source checkout differs from reviewed commit')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(),
    '', 'source checkout must be clean')
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN
  assert.ok(cloudflareToken, 'CLOUDFLARE_API_TOKEN is required')
  const control = process.env.CONTROL_API_TOKEN
  assert.ok(control, 'CONTROL_API_TOKEN is required from Cloudflare Secrets Store')
  const intent = randomUUID()
  const base = (process.env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
  assert.match(base, /^https:\/\//, 'ACK3_ENGINE_URL is required')
  // Optional delivery deadline, measured through production verification.
  const deadline = process.env.ACK3_DEPLOY_DEADLINE_MS
  const deadlineMs = deadline === undefined ? undefined : Number(deadline)
  assert.ok(deadlineMs === undefined || (Number.isSafeInteger(deadlineMs) && deadlineMs > 0),
    'ACK3_DEPLOY_DEADLINE_MS must be a positive integer when set')
  const fileRecord = { at: new Date().toISOString(), intent, expectedCommit, expectedImage,
    phase: 'lock-request', outcome: 'unknown',
    note: 'Never reupload on an uncertain result; reconcile this exact intent.' }
  saveIntent(intentFile, fileRecord, true)
  const locked = await requestJson(`${base}/v1/runtime-slots/rotations`, control, {
    method: 'POST', body: JSON.stringify({ intent }),
  })
  assert.equal(locked.slotId, locked.runtimeRelease?.id)
  fileRecord.locked = locked
  fileRecord.phase = 'before-upload'
  saveIntent(intentFile, fileRecord)
  assert.equal(locked.runtimeRelease.containerImageDigest, expectedImage,
    'oldest idle slot needs one-time image normalization; lock must be reconciled')
  const service = locked.runtimeRelease.workerService
  const script = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${service}`
  const settingsResponse = await requestJson(`${script}/settings`, cloudflareToken)
  assert(settingsResponse.success && settingsResponse.result)
  const settings = settingsResponse.result
  const declared = JSON.parse(settings.bindings.find(item => item.name === 'RUNTIME_RELEASE_JSON')?.text)
  for (const field of ['id', 'workerService', 'workflowName', 'containerImageDigest']) {
    assert.equal(declared[field], locked.runtimeRelease[field], `slot binding changed: ${field}`)
  }
  const priorObserved = await requestJson(`${base}/v1/runtime-slots/${locked.slotId}/identity`, control)
  assert.deepEqual(priorObserved, locked.runtimeRelease,
    'native slot identity changed before publication')
  const priorVersion = await requestJson(`${script}/versions/${priorObserved.workerVersionId}`, cloudflareToken)
  assert.ok(priorVersion.success && priorVersion.result)
  assert.equal(normalizedVersion(priorVersion.result.id), priorObserved.workerVersionId)
  const containers = priorVersion.result.resources?.script_runtime?.containers
  const dir = mkdtempSync(join(tmpdir(), 'ack3-runtime-rotation-'))
  let uploadAttempted = false
  try {
    const baseConfig = JSON.parse(readFileSync(join(engine, 'wrangler.jsonc'), 'utf8'))
    const buildConfig = join(dir, 'wrangler.json')
    const outfile = join(dir, 'worker.multipart')
    writeFileSync(buildConfig, JSON.stringify({
      name: service, main: join(engine, 'src/worker.ts'), rules: baseConfig.rules,
      compatibility_date: baseConfig.compatibility_date,
      compatibility_flags: baseConfig.compatibility_flags,
      define: { __ACK3_RUNTIME_BUILD_COMMIT_SHA__: JSON.stringify(expectedCommit) },
    }), { mode: 0o600 })
    const tasks = [
      [process.execPath, [join(engine, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy', '--config', buildConfig, '--dry-run', '--outfile', outfile]],
      ...check,
    ]
    const checks = tasks.map(([binary, args]) => spawnSync(binary, args, {
      cwd: engine, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    }))
    for (const item of checks) if (item.error || item.status !== 0) {
      throw new Error('bundle build or focused check failed; rotation lock remains until reconciled')
    }
    const form = await runtimeCodeUploadForm(readFileSync(outfile), settings, containers)
    // Persist the uncertain phase before the only PUT. A crash after this
    // write must never permit an automatic second upload or cancellation.
    fileRecord.phase = 'upload-uncertain'
    saveIntent(intentFile, fileRecord)
    uploadAttempted = true
    const upload = await fetch(`${script}?excludeScript=true&bindings_inherit=strict`, {
      method: 'PUT', headers: { authorization: `Bearer ${cloudflareToken}` },
      body: form, redirect: 'error', signal: AbortSignal.timeout(15000),
    })
    const uploadBody = await upload.json()
    if (!upload.ok || !uploadBody.success) {
      throw new Error(`runtime script publication HTTP ${upload.status}; reconcile intent`)
    }
    const publishedVersion = normalizedVersion(uploadBody.result?.deployment_id)
    fileRecord.publishedVersion = publishedVersion
    fileRecord.phase = 'uploaded'
    saveIntent(intentFile, fileRecord)
    let observed
    do {
      try {
        observed = await requestJson(`${base}/v1/runtime-slots/${locked.slotId}/identity`, control)
      } catch { /* Edge propagation may lag; the intent remains locked. */ }
      if (observed?.workerVersionId === publishedVersion) break
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    } while (performance.now() + 100 < start + (deadlineMs ?? 30_000))
    assert.equal(observed?.workerVersionId, publishedVersion,
      'published runtime version was not observed; do not reupload')
    assert.equal(observed.frameworkCommit, expectedCommit)
    assert.equal(observed.containerImageDigest, expectedImage)
    assert.equal(observed.id, locked.slotId)
    const afterSettings = (await requestJson(`${script}/settings`, cloudflareToken)).result
    assert.deepEqual(afterSettings, settings,
      'runtime settings, bindings or secrets changed during code-only publication')
    const publishedNative = await requestJson(`${script}/versions/${publishedVersion}`, cloudflareToken)
    assert.ok(publishedNative.success && publishedNative.result)
    assert.equal(normalizedVersion(publishedNative.result.id), publishedVersion)
    assert.deepEqual(publishedNative.result.resources?.script_runtime?.containers, containers,
      'native container class metadata changed during code-only publication')
    const activated = await requestJson(`${base}/v1/runtime-slots/rotations/${intent}/activate`,
      control, { method: 'POST', body: JSON.stringify({
        expectedGeneration: locked.generation,
        prior: locked.runtimeRelease, expectedCommit,
      }) })
    assert.equal(activated.runtimeRelease.workerVersionId, publishedVersion)
    const selected = await requestJson(`${base}/v1/runtime-slots/rotations/${intent}`, control)
    assert.equal(selected.lockHeld, false)
    assert.equal(selected.latest, true)
    assert.equal(selected.runtimeRelease.workerVersionId, publishedVersion)
    const elapsedMs = performance.now() - start
    const proof = { intent, slotId: locked.slotId, priorVersion: locked.runtimeRelease.workerVersionId,
      publishedVersion, expectedCommit, imageDigest: expectedImage, elapsedMs,
      verified: true, deadlineMs: deadlineMs ?? null,
      withinDeadline: deadlineMs === undefined ? null : elapsedMs < deadlineMs }
    fileRecord.outcome = proof
    fileRecord.phase = 'activated'
    saveIntent(intentFile, fileRecord)
    if (proof.withinDeadline === false) throw new Error(`production rotation verified but the ${deadlineMs} ms deadline was missed`)
    return proof
  } catch (error) {
    if (uploadAttempted) throw new Error(`runtime upload may have occurred: ${error.message}; reconcile intent before any retry`)
    throw error
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [intentFile, expectedCommit, expectedImage, account] = process.argv.slice(2)
  assert.equal(process.argv.length, 6,
    'usage: rotate-runtime-code.mjs INTENT_FILE EXPECTED_COMMIT IMAGE_DIGEST ACCOUNT_ID')
  console.log(JSON.stringify(await rotateRuntimeCode({ intentFile, expectedCommit,
    expectedImage, account, check: [
      [join(engine, 'node_modules/.bin/tsc'), ['--noEmit']],
      [join(engine, 'node_modules/.bin/vitest'), ['run', 'test/runtime-slot-admission.test.ts']],
    ], start: 0 })))
}
