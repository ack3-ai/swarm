import { reconcileAuditStartup } from '../src/execution-workflow.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createForkStartupFixture } from './support/successor-dispatch-fixture.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { stateWriter } from '../src/cloudflare-storage.js'

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// The completed audit is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
const fixture = () => createForkStartupFixture(close => closes.push(close), undefined, forks)

it('publication and in-memory bootstrap do not imply durable Workflow bootstrap', async () => {
  const f = await fixture()
  expect(await f.store.executionBootstrapped(f.successor)).toBe(false)
  await f.start()
  expect(await f.store.executionBootstrapped(f.successor)).toBe(false)
  await f.store.recordExecutionBootstrap(f.successor)
  expect(await f.store.executionBootstrapped(f.successor)).toBe(true)
  await f.store.recordExecutionBootstrap(f.successor)
  expect(f.sqlite.prepare('SELECT COUNT(*) AS n FROM execution_bootstrap').get()!.n).toBe(1)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})

it('requires the selected state, not merely archived failure bytes', async () => {
  const f = await fixture()
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const failed = await f.start()
  await expect(f.store.recordExecutionBootstrap(failed.view())).rejects.toThrow('no longer selected')
  expect(await f.store.executionBootstrapped(f.successor)).toBe(false)
  await (await stateWriter(f.store, f.successor))(failed.view())
  await expect(f.store.recordExecutionBootstrap(f.successor)).rejects.toThrow('no longer selected')
  await f.store.recordExecutionBootstrap(failed.view())
  expect(await f.store.executionBootstrapped(failed.view())).toBe(true)
})

it('reconciles lost witness acknowledgement without changing its first selected pointer', async () => {
  const f = await fixture()
  f.onAfterRun(sql => {
    if (sql.includes('INSERT INTO execution_bootstrap')) { f.onAfterRun(); throw new Error('lost bootstrap ACK') }
  })
  await expect(f.store.recordExecutionBootstrap(f.successor)).rejects.toThrow('lost bootstrap ACK')
  const before = f.sqlite.prepare('SELECT * FROM execution_bootstrap').get()
  await f.store.recordExecutionBootstrap(f.successor)
  expect(f.sqlite.prepare('SELECT * FROM execution_bootstrap').get()).toEqual(before)
  expect(await f.store.executionBootstrapped(f.successor)).toBe(true)
})

it.each(['authority', 'pointer'])('rejects a bootstrap witness with a forged %s', async change => {
  const f = await fixture()
  await f.store.recordExecutionBootstrap(f.successor)
  if (change === 'authority') f.sqlite.prepare('UPDATE execution_bootstrap SET authority_json = ?').run('{}')
  else f.sqlite.prepare('UPDATE execution_bootstrap SET state_key = ?').run('unselected-state')
  await expect(f.store.executionBootstrapped(f.successor)).rejects.toThrow('witness differs')
})


it('keeps launch delivery pending until actual bootstrap records its witness', async () => {
  const f = await fixture()
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(false)
  await f.store.recordExecutionBootstrap(f.successor)
  f.binding.get.mockRejectedValue(new Error('no further native polling after bootstrap'))
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(true)
})

it.each(['errored', 'terminated', 'complete'])('records native %s before bootstrap as ordinary failure, preserving work and lease', async status => {
  const f = await fixture()
  f.binding.get.mockResolvedValue({ id: f.successor.runId, status: vi.fn(async () => ({ status })) })
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(true)
  const failed = await f.store.getState(f.successor.runId)
  expect(failed.status).toBe('failed')
  expect(failed.artifacts).toEqual(f.successor.artifacts)
  expect(failed.budget).toEqual(f.successor.budget)
  expect(failed.modelStartedAt).toBe(f.successor.modelStartedAt)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?').get(f.successor.runId)!.released_at).toBeNull()
  expect(await f.store.executionBootstrapped(failed)).toBe(false)
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(true)
  expect(await f.store.getState(f.successor.runId)).toEqual(failed)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('does not infer failure from an unavailable or mismatched native observation', async () => {
  const f = await fixture()
  f.binding.get.mockRejectedValueOnce(new Error('native observation unavailable'))
  await expect(reconcileAuditStartup(f.env, f.payload)).rejects.toThrow('observation unavailable')
  f.binding.get.mockResolvedValueOnce({ id: 'unrelated-workflow', status: vi.fn(async () => ({ status: 'errored' })) })
  await expect(reconcileAuditStartup(f.env, f.payload)).rejects.toThrow('identity differs')
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})

it('adopts a bootstrap witness committed while native status was being observed', async () => {
  const f = await fixture()
  f.binding.get.mockImplementationOnce(async () => {
    await f.store.recordExecutionBootstrap(f.successor)
    return { id: f.successor.runId, status: vi.fn(async () => ({ status: 'errored' })) }
  })
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(true)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})

it('a bootstrap witness committed immediately before failure selection wins the race', async () => {
  const f = await fixture()
  f.binding.get.mockResolvedValue({ id: f.successor.runId, status: vi.fn(async () => ({ status: 'errored' })) })
  const { CloudflareRunStore } = await import('../src/cloudflare-storage.js')
  const original = CloudflareRunStore.prototype.putState
  vi.spyOn(CloudflareRunStore.prototype, 'putState').mockImplementationOnce(async function (this: InstanceType<typeof CloudflareRunStore>, ...args) {
    await f.store.recordExecutionBootstrap(f.successor)
    return original.apply(this, args)
  })
  await expect(reconcileAuditStartup(f.env, f.payload)).rejects.toThrow('stale run-state generation')
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(await reconcileAuditStartup(f.env, f.payload)).toBe(true)
})
