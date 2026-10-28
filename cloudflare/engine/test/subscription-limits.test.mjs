import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { codexSubscriptionLimits, claudeSubscriptionLimits,
  validSubscriptionLimits } from '../container/subscription-limits.mjs'
import { readCodexSubscription } from '../container/codex-subscription.mjs'

const at = '2026-10-20T12:00:00.000Z'
const now = Date.parse(at)
test('Codex and Claude normalize native quota into the same units without inventing absent quota', () => {
  const codex = codexSubscriptionLimits({ rateLimitsByLimitId: { codex: {
    primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: now / 1000 + 300 },
  } } }, at)
  const claude = claudeSubscriptionLimits({ utilization: 0.75, rateLimitType: 'five_hour',
    resetsAt: now / 1000 + 300, status: 'allowed_warning' }, at)
  assert.equal(codex.windows[0].usedPercent, claude.windows[0].usedPercent)
  assert.equal(codex.windows[0].resetsAt, '2026-10-20T12:05:00.000Z')
  for (const snapshot of [codex, claude]) {
    assert.ok(validSubscriptionLimits(snapshot))
  }
  assert.equal(codexSubscriptionLimits({}, at).windows.length, 0)
  assert.equal(claudeSubscriptionLimits({ status: 'rejected' }, at).exhausted, true)
  assert.equal(validSubscriptionLimits({ ...codex, windows: [{ ...codex.windows[0], usedPercent: -5 }] }), false)
})

test('Codex quota probe uses native initialize/read protocol, bounds errors and kills its child', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'swarm-codex-quota-'))
  try {
    const script = join(dir, 'server.mjs')
    await writeFile(script, `
      import readline from 'node:readline';
      let initialized = false;
      for await (const line of readline.createInterface({ input: process.stdin })) {
        const m = JSON.parse(line);
        if (m.method === 'initialized') initialized = true;
        if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
        if (m.method === 'account/rateLimits/read' && initialized)
          process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: {
            primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000000000 }
          } } }) + '\\n');
      }
    `)
    const quota = await readCodexSubscription({ PATH: process.env.PATH, HOME: dir },
      { command: process.execPath, prefix: [script], timeoutMs: 1000 })
    assert.equal(quota.exhausted, true)
    const unknown = await readCodexSubscription({}, { command: '/does-not-exist', timeoutMs: 100 })
    assert.deepEqual(unknown.windows, [])
    assert.equal(unknown.exhausted, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
