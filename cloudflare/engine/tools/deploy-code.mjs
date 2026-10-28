import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const engine = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

// The native /content endpoint preserves configuration, bindings and secrets.
// Its upload metadata must describe module contents only.
export function uploadMetadata(build, settings) {
  assert.equal(settings.bindings?.find(b => b.name === 'ENGINE_ROLE')?.text, 'front-door')
  assert.equal(settings.bindings.some(b => b.name === 'Sandbox' || b.type === 'workflow'), false)
  assert.equal(settings.bindings.find(b => b.name === 'VERSION_METADATA')?.type, 'version_metadata')
  assert.equal(build.compatibility_date, settings.compatibility_date, 'compatibility changes need normal publication')
  assert.deepEqual(build.compatibility_flags, settings.compatibility_flags)
  assert.equal(typeof build.main_module, 'string')
  return { main_module: build.main_module }
}

export async function uploadForm(bytes, settings) {
  const end = bytes.indexOf('\r\n')
  assert.ok(end > 2 && end < 200, 'invalid Wrangler multipart output')
  const boundary = bytes.subarray(2, end).toString()
  assert.match(boundary, /^[-a-zA-Z0-9]+$/)
  const form = await new Response(bytes, { headers: {
    'content-type': `multipart/form-data; boundary=${boundary}`,
  } }).formData()
  const metadata = uploadMetadata(JSON.parse(form.get('metadata')), settings)
  assert.ok(form.has(metadata.main_module), 'Worker module missing')
  form.set('metadata', JSON.stringify(metadata))
  return form
}

export async function observeVersion(health, version, deadline) {
  let observed = await health()
  while (observed.workerVersionId !== version && performance.now() + 100 < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    observed = await health()
  }
  return observed
}

function command(executable, args, env) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(executable, args, { cwd: engine, env, stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? resolveCommand()
      : reject(new Error(`${executable} failed (${signal ?? code}); nothing uploaded`)))
  })
}

export async function deployCode(version, check, env = process.env, start = performance.now()) {
  assert.match(version ?? '', uuid, 'usage: deploy-code.mjs EXPECTED_VERSION -- CHECK_COMMAND [ARGS...]')
  assert.ok(check.length > 0, 'focused check command required')
  const account = env.ACK3_CLOUDFLARE_ACCOUNT_ID
  assert.match(account ?? '', /^[0-9a-f]{32}$/)
  assert.ok(env.CLOUDFLARE_API_TOKEN && env.CONTROL_API_TOKEN, 'Cloudflare and Swarm control credentials required')
  const base = (env.ACK3_ENGINE_URL ?? '').replace(/\/$/, '')
  assert.match(base, /^https:\/\//, 'ACK3_ENGINE_URL is required')
  // Optional delivery deadline, measured through production verification.
  const deadlineMs = env.ACK3_DEPLOY_DEADLINE_MS === undefined ? undefined : Number(env.ACK3_DEPLOY_DEADLINE_MS)
  assert.ok(deadlineMs === undefined || (Number.isSafeInteger(deadlineMs) && deadlineMs > 0),
    'ACK3_DEPLOY_DEADLINE_MS must be a positive integer when set')
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/swarm`
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` }
  const health = async () => {
    const response = await fetch(`${base}/health`, {
      headers: { authorization: `Bearer ${env.CONTROL_API_TOKEN}` },
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30_000),
    })
    assert.equal(response.status, 200, 'production health unavailable')
    return response.json()
  }
  const dir = await mkdtemp(join(tmpdir(), 'swarm-code-'))
  let uploadAttempted = false
  try {
    const config = JSON.parse(await readFile(join(engine, 'wrangler.jsonc'), 'utf8'))
    assert.equal(config.main, 'src/worker.ts')
    for (const key of ['build', 'alias', 'define', 'no_bundle', 'tsconfig']) {
      assert.equal(config[key], undefined, `custom ${key} needs normal publication`)
    }
    const buildConfig = join(dir, 'wrangler.json')
    const outfile = join(dir, 'worker.multipart')
    await writeFile(buildConfig, JSON.stringify({
      name: 'swarm', main: join(engine, config.main), rules: config.rules,
      compatibility_date: config.compatibility_date, compatibility_flags: config.compatibility_flags,
    }), { mode: 0o600 })
    const buildStart = performance.now()
    const results = await Promise.allSettled([
      command(check[0], check.slice(1), env),
      command(process.execPath, [join(engine, 'node_modules/wrangler/bin/wrangler.js'),
        'deploy', '--config', buildConfig, '--dry-run', '--outfile', outfile],
      { ...env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(dir, 'wrangler.log') }),
      health().then(before => {
        assert.equal(before.workerVersionId, version, 'front door changed; refresh expected version')
        assert.equal(before.role, 'front-door')
      }),
      fetch(`${api}/settings`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
        .then(async response => {
          const data = await response.json()
          assert.ok(response.ok && data.success, `settings HTTP ${response.status}`)
          return data.result
        }),
    ])
    for (const result of results) if (result.status === 'rejected') throw result.reason
    const settings = results[3].value
    const form = await uploadForm(await readFile(outfile), settings)
    const checkedMs = performance.now() - buildStart
    const uploadStart = performance.now()
    uploadAttempted = true
    const response = await fetch(`${api}/content?excludeScript=true`, {
      method: 'PUT', headers, body: form, redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    const data = await response.json()
    assert.ok(response.ok && data.success, `upload HTTP ${response.status}; codes ${data.errors?.map(e => e.code)}`)
    const raw = data.result.deployment_id
    assert.equal(typeof raw, 'string', 'upload succeeded but returned no version; inspect production before retrying')
    const publishedVersion = raw.length === 32
      ? raw.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5') : raw
    assert.match(publishedVersion, uuid)
    assert.notEqual(publishedVersion, version, 'upload did not identify a new version; inspect production')
    const uploadMs = performance.now() - uploadStart
    const after = await observeVersion(health, publishedVersion, start + (deadlineMs ?? 30_000))
    const elapsedMs = performance.now() - start
    const proof = { publishedVersion, observedVersion: after.workerVersionId,
      checkedMs, uploadMs, elapsedMs, verified: after.ok === true && after.role === 'front-door' && after.workerVersionId === publishedVersion,
      deadlineMs: deadlineMs ?? null, withinDeadline: deadlineMs === undefined ? null : elapsedMs < deadlineMs }
    console.log(JSON.stringify(proof))
    assert.ok(proof.verified, 'uploaded but production version not yet observed; do not reupload')
    assert.ok(proof.withinDeadline !== false, `production verified, but the ${deadlineMs} ms deadline was missed`)
    return proof
  } catch (error) {
    if (uploadAttempted) console.error('Upload was attempted. Inspect production before any retry; an interrupted response does not prove failure.')
    throw error
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv[3], '--', 'separate the required check command with --')
  await deployCode(process.argv[2], process.argv.slice(4), process.env, 0)
}
