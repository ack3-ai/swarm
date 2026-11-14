import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createForkStartupFixture } from './support/successor-dispatch-fixture.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { canonicalJson } from '../src/canonical.js'
import { deliverStageFork } from '../src/stage-fork-delivery.js'
import { bootstrapExecution } from '../src/root-execution.js'
import { RunMachine } from '../src/machine.js'
import { stateWriter } from '../src/cloudflare-storage.js'
import { reconcileRunControls } from '../src/run-control-reconcile.js'

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// The completed audit is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
const fixture = () => createForkStartupFixture(close => closes.push(close), undefined, forks)

it('refuses old-owner startup and delivery after a later owner is selected', async () => {
  const f = await fixture(), authority = f.successor.executionAuthority!, owners = new ExecutionAuthorityStore(f.d1)
  await owners.fence(authority, 'a'.repeat(64))
  await owners.retire(authority, 'b'.repeat(64))
  const successor = { ...authority, epoch: 1, executionId: 'historical-startup-successor' }
  await f.d1.prepare(`INSERT INTO audit_execution_authority
    (audit_id, epoch, execution_id, authority_json, command_digest, status, activated_at)
    VALUES (?1, 1, ?2, ?3, ?4, 'active', ?5)`)
    .bind(successor.auditId, successor.executionId, canonicalJson(successor), 'c'.repeat(64), new Date().toISOString()).run()
  await expect(deliverStageFork(f.marker as any, f.env)).rejects.toThrow(/ownership differs/)
  await expect(f.start()).rejects.toThrow(/ownership differs/)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it.each(['generation', 'budget', 'clock'])('refuses unselected %s changes even with otherwise valid startup identity', async change => {
  const f = await fixture(), altered = structuredClone(f.successor)
  if (change === 'generation') altered.stateGeneration += 1
  if (change === 'budget') altered.budget.modelCalls += 1
  if (change === 'clock') altered.rootCreatedAt = '2000-01-01T00:00:00.000Z'
  await expect(bootstrapExecution(f.payload, f.store, f.env, altered)).rejects.toThrow()
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it('reloads exported accepted work without reading records owned by the historical version', async () => {
  const f = await fixture(), original = f.store.getStateAt.bind(f.store)
  const reads = vi.spyOn(f.store, 'getStateAt').mockImplementation((id, pointer) => {
    if (id === f.source.runId) throw new Error('historical app owns the source')
    return original(id, pointer)
  })
  const machine = await f.start(), state = machine.snapshot()
  const loaded = await RunMachine.fromState(f.release.body.definition, state,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  expect(loaded.snapshot()).toEqual(state)
  expect(state.artifacts).toEqual(f.successor.artifacts)
  expect(state.rootCreatedAt).toBe(f.successor.rootCreatedAt)
  expect(state.budget).toEqual(f.successor.budget)
  expect(reads.mock.calls.every(([id]) => id !== f.source.runId)).toBe(true)
})

it('refuses startup when an imported artifact loses its execution input manifest', async () => {
  const f = await fixture(), record = f.successor.artifacts.find(value => value.execution !== undefined)!
  expect(record).toBeDefined()
  f.objects.delete(`execution-inputs/sha256/${record.execution!.inputDigest}.json`)
  await expect(f.start()).rejects.toThrow('execution input manifest is missing')
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(await f.owners.pendingLaunches(f.successor.executionAuthority!)).toEqual([])
})

it('preserves a pre-start pause and retained work when readiness fails', async () => {
  const f = await fixture()
  await f.controls.admit({ id: 'pause-before-readiness', expectedRevision: 0, reason: 'synthetic pause',
    action: 'pause', scope: { kind: 'audit' } }, f.successor.executionAuthority!)
  const machine = await RunMachine.fromState(f.release.body.definition, f.successor,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  await reconcileRunControls({ machine, journal: f.controls, persist: await stateWriter(f.store, f.successor) })
  const paused = await f.store.getState(f.successor.runId)
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const failed = await f.start()
  await (await stateWriter(f.store, paused))(failed.view())
  const selected = await f.store.getState(f.successor.runId)
  expect(selected.status).toBe('failed')
  expect(selected.controls).toEqual(paused.controls)
  expect(selected.releaseDigest).toBe(paused.releaseDigest)
  expect(selected.artifacts).toEqual(paused.artifacts)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})
