import { assertExecutionOwner } from '../src/run-control-executor.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { bootstrapExecution } from '../src/root-execution.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { waveStepConfig } from '../src/workflow-step-config.js'
import { workflowProgress, failureForWorkflowProgress, workflowFailureDisposition } from '../src/workflow-outcome.js'
import { isPermanentRunFailure } from '../src/run-errors.js'
import { localRuntimeRelease, sameRuntimeRelease } from '../src/runtime-release.js'
import type { Env } from '../src/env.js'
import type { RuntimeRelease } from '../src/contracts.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createForkStartupFixture } from './support/successor-dispatch-fixture.js'
import { forkFixtures } from './support/stage-fork-command-fixture.js'
import { dispatchAuditWorkflow } from '../src/execution-workflow.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { RunMachine } from '../src/machine.js'
import { stateWriter } from '../src/cloudflare-storage.js'
import { reconcileRunControls } from '../src/run-control-reconcile.js'
import { CommandCustodyCollector } from '../src/command-custody.js'
import { settleCancelledExecution, deliverRunControl, settleControlledFailure } from '../src/run-control-executor.js'
import { sha256 } from '../src/canonical.js'
import { runStateKey } from '../src/run-state-pointer.js'

const closes: Array<() => void> = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// The completed audit is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false]), 120_000)
const fixture = () => createForkStartupFixture(close => closes.push(close), undefined, forks)
type Fixture = Awaited<ReturnType<typeof fixture>>
async function failure(f: Fixture) {
  const before = await f.store.getState(f.successor.runId)
  f.env.ACK3_CODEX_AUTH_JSON = ''
  const machine = await f.start()
  return { machine, persist: await stateWriter(f.store, before) }
}

it('ordinary failed-audit cancellation preserves accepted work and the applied fork command', async () => {
  const f = await fixture(), { machine: failed, persist } = await failure(f)
  await persist(failed.view())
  const state = await f.store.getState(f.successor.runId)
  expect(state.status).toBe('failed')
  expect(state.artifacts).toEqual(f.successor.artifacts)
  expect(state.budget).toEqual(f.successor.budget)
  expect(state.modelStartedAt).toBe(f.successor.modelStartedAt)
  await f.controls.admit({ id: 'cancel-failed-start', expectedRevision: 0, reason: 'synthetic cancellation',
    action: 'cancel', scope: { kind: 'audit' } }, state.executionAuthority!)
  const machine = await RunMachine.fromState(f.release.body.definition, state,
    f.store.getRelease.bind(f.store), f.store.executionSources())
  await reconcileRunControls({ machine, journal: f.controls, persist: await stateWriter(f.store, state),
    native: new CommandCustodyCollector(f.env) })
  const stopped = await f.store.getState(state.runId)
  await settleCancelledExecution(stopped, f.env)
  expect(stopped.status).toBe('stopped')
  expect(stopped.artifacts).toEqual(state.artifacts)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect((await f.start()).snapshot()).toEqual(stopped)
  expect(f.binding.create).not.toHaveBeenCalled()
})

it('reconciles a lost state-write acknowledgement without a second failure protocol', async () => {
  const f = await fixture(), { machine, persist } = await failure(f)
  f.onAfterRun(sql => {
    if (sql.includes('INSERT INTO experiment_runs')) { f.onAfterRun(); throw new Error('lost write ACK') }
  })
  await expect(persist(machine.view())).rejects.toThrow('lost write ACK')
  expect(await f.store.getState(f.successor.runId)).toEqual(machine.snapshot())
  await persist(machine.view())
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})

it('does not replace unsettled native work with a startup failure', async () => {
  const f = await fixture(), { machine, persist } = await failure(f)
  f.sqlite.prepare(`INSERT INTO audit_execution_launches
    (audit_id, epoch, task_execution_id, request_digest, admitted_at)
    VALUES (?, 0, 'unexpected-task', ?, ?)`).run(f.successor.rootRunId, 'a'.repeat(64), '2030-01-01T00:00:00.000Z')
  await expect(persist(machine.view())).rejects.toThrow(/unsettled native work/)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
})

it('an admitted native cancellation prevents failure from taking over its terminal transition', async () => {
  const f = await fixture(), { machine, persist } = await failure(f)
  const command = { id: 'cancel-before-failure', expectedRevision: 0, reason: 'synthetic cancellation',
    action: 'cancel' as const, scope: { kind: 'audit' as const } }
  let operation = await f.controls.admit(command, f.successor.executionAuthority!)
  operation = await f.controls.beginEffect(command.id, operation.version, f.successor)
  await f.controls.beginNativeEffect(command.id, operation.version, 'a'.repeat(64))
  await expect(persist(machine.view())).rejects.toThrow()
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
})

it('ambiguous Workflow creation does not select a failure or create a second identity', async () => {
  const f = await fixture()
  f.binding.create.mockRejectedValueOnce(new Error('ambiguous create'))
  f.binding.get.mockRejectedValueOnce(new Error('native read unavailable'))
  await expect(dispatchAuditWorkflow(f.env, f.payload)).rejects.toThrow('ambiguous create')
  expect(await f.journal.get(f.command.id)).toEqual(f.operation)
  expect(await f.store.getState(f.successor.runId)).toEqual(f.successor)
  expect(f.binding.create).toHaveBeenCalledOnce()
  expect(f.binding.get).toHaveBeenCalledWith(f.successor.runId)
})

it('missing selected failure bytes cannot be treated as successful dispatch', async () => {
  const f = await fixture(), { machine, persist } = await failure(f)
  await persist(machine.view())
  f.objects.delete(runStateKey(f.successor.runId, machine.view().stateGeneration, await sha256(machine.view())))
  await expect(dispatchAuditWorkflow(f.env, f.payload)).rejects.toThrow()
  expect(f.binding.create).not.toHaveBeenCalled()
})

it('the actual Workflow bootstrap durably fails readiness without starting models or claiming cleanup', async () => {
  const f = await fixture()
  delete (f.env as Partial<typeof f.env>).ACK3_CODEX_AUTH_JSON
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
  const deps = { assertExecutionOwner, WorkflowEntrypoint: class { env = f.env }, CloudflareRunStore: class { constructor() { return f.store } },
    bootstrapExecution, stateWriter, workflowProgress, waveStepConfig, failureForWorkflowProgress,
    CommandCustodyCollector, ExecutionAuthorityStore, RunCommandJournal, settleCancelledExecution, settleControlledFailure,
    workflowFailureDisposition, isPermanentRunFailure, NonRetryableError: class extends Error {},
    runIdPattern: /^[a-z0-9._-]+$/, engineRole: () => 'runtime',
    assertLocalRuntime: (env: Env, runtime: RuntimeRelease) => { expect(sameRuntimeRelease(localRuntimeRelease(env), runtime)).toBe(true) } }
  const Workflow = new Function(...Object.keys(deps), `${code}; return AuditWorkflow;`)(...Object.values(deps))
  const workflow = new Workflow(), runOneWave = vi.spyOn(workflow, 'runOneWave'), names: string[] = []
  await expect(workflow.run({ payload: f.payload }, { do: async (name: string, _options: unknown, fn: () => unknown) => {
    names.push(name); return fn()
  }, sleep: vi.fn(() => { throw new Error('unexpected model polling') }) })).rejects.toThrow('core provider credentials are missing')
  expect(runOneWave).not.toHaveBeenCalled()
  expect(names).toEqual(['initialize-index', 'bootstrap-run', 'reconcile-terminal-workspaces', 'reconcile-terminal-failure-workspaces'])
  const result = (await f.journal.get(f.reference.commandId))!
  expect(result).toEqual(f.operation)
  const failed = await f.store.getState(f.successor.runId)
  expect(failed.status).toBe('failed')
  expect(await f.store.executionBootstrapped(failed)).toBe(true)
  expect(failed.artifacts).toEqual(f.successor.artifacts)
  expect(failed.modelStartedAt).toBe(f.successor.modelStartedAt)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  await expect(f.owners.assertActive(f.successor.executionAuthority!)).resolves.toBeUndefined()
})
