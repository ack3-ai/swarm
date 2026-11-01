import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { subscriptionWaits } from '../container/subscription-limits.mjs'

// Use the installed native dependency; no provider or model requests are made.
const require = createRequire(process.env.ACK3_NATIVE_HARNESS_DIR
  ? resolve(process.env.ACK3_NATIVE_HARNESS_DIR, 'package.json')
  : new URL('../container/harness/package.json', import.meta.url))
let nativePath
try { nativePath = require.resolve('@deepseek-ai/dsh-llm-retry') } catch {}

async function patchedNativeRetry() {
  const patch = await readFile(new URL('../container/harness/patch-dsh-pi.mjs', import.meta.url), 'utf8')
  // Evaluate only the production replacement table, never its file-writing CLI.
  const edits = runInNewContext(patch.slice(patch.indexOf('const edits = ['),
    patch.indexOf('// Validate every input')) + '\nedits')
  const edit = edits.find(value => value.name === '@deepseek-ai/dsh-llm-retry')
  let source = await readFile(nativePath, 'utf8')
  assert.equal(createHash('sha256').update(source).digest('hex'), edit.digest)
  for (const [before, after] of edit.replacements) {
    assert.equal(source.split(before).length, 2)
    source = source.replace(before, () => after)
  }
  const nativeRequire = createRequire(nativePath)
  source = source.replace(/from "([^"\n]+)"/g, (match, name) => name.startsWith('node:')
    ? match : `from "${pathToFileURL(nativeRequire.resolve(name)).href}"`)
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

for (const enabled of [true, false]) {
  test(`native DSH window waits preserve the bounded failure budget (enabled=${enabled})`,
    { skip: !nativePath }, async t => {
      const native = await patchedNativeRetry()
      const original = process.env.ACK3_PROVIDER_WINDOW_WAIT
      process.env.ACK3_PROVIDER_WINDOW_WAIT = enabled ? '1' : '0'
      t.after(() => {
        if (original === undefined) delete process.env.ACK3_PROVIDER_WINDOW_WAIT
        else process.env.ACK3_PROVIDER_WINDOW_WAIT = original
      })
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-01-01T00:00:00Z') })
      let stderr = '', projection, recover, state = {}
      t.mock.method(process.stderr, 'write', text => { stderr += text; return true })
      const events = []
      const session = { append(type, data) {
        const event = { type, data }
        events.push(event)
        state = projection.apply(state, event)
      } }
      const agent = { id: 'session-window-fixture', session }
      native.apply({
        sessionProjections: { register(value) { projection = value }, stateOf: () => state },
        on(_event, handler) { recover = handler; return () => {} }, effect() {}, logger: console,
      })
      const policy = { mode: 'normal', maxRetries: 6, retryableCodes: ['RATE_LIMIT', 'SERVER'],
        initialDelayMs: 2500, maxDelayMs: 3600000, jitterRatio: 0 }
      async function failure(code, status, providerRetryAfterMs) {
        const pending = recover({ agent, turn: 0, step: 0, provider: 'fixture',
          retryPolicy: policy, signal: new AbortController().signal,
          failure: { code, status, ...(providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs }) },
        }, () => undefined)
        t.mock.timers.tick(3600000)
        return pending
      }
      for (let i = 0; i < (enabled ? 7 : 6); i++) {
        assert.equal((await failure('RATE_LIMIT', 429, 1000))?.kind, 'retry')
      }
      if (enabled) {
        assert.equal(Object.values(state)[0].ordinaryRetries, 0)
        assert.equal((await failure('SERVER', 503))?.kind, 'retry')
        assert.equal(events.filter(e => e.type === 'llm/retry').at(-1).data.delayMs, 2500)
        // A successful response can now finish this same step. Also verify the
        // full remaining budget if transient failures continue instead.
        state = events.reduce((value, event) => projection.apply(value, event), projection.init())
        assert.equal(projection.stateSchema.safeParse(state).success, true)
        for (let i = 1; i < 6; i++) assert.equal((await failure('SERVER', 503))?.kind, 'retry')
      }
      assert.equal(await failure('SERVER', 503), undefined)
      assert.equal(await failure('QUOTA_EXCEEDED', 429, 1000), undefined)
      const scheduled = events.filter(e => e.type === 'llm/retry')
      assert.deepEqual(scheduled.map(e => e.data.retry), scheduled.map((_, i) => i + 1))
      assert.equal(new Set(scheduled.map(e => e.data.retryId)).size, 1)
      assert.equal(events.filter(e => e.type === 'llm/retry-started').length, scheduled.length)
      const waits = subscriptionWaits(stderr) ?? []
      assert.equal(waits.length, enabled ? 7 : 0)
      assert.ok(waits.every(wait => wait.sessionId === agent.id))
    })
}
