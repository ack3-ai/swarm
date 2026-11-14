import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { afterEach, expect, it } from 'vitest'
import type { AgentRequest, ArtifactRecord } from '../src/contracts.js'
import { artifactExecution, artifactReferences, executionConfiguration } from '../src/artifact-execution.js'
import { sha256 } from '../src/canonical.js'
import { sqliteD1 } from './support/sqlite-d1.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { runStateKey } from '../src/run-state-pointer.js'
import { RunMachine } from '../src/machine.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const databases: ReturnType<typeof sqliteD1>[] = []
afterEach(() => databases.splice(0).forEach(db => db.sqlite.close()))

async function run() {
  const requests = new Map<string, AgentRequest>()
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'execution-input-fixture')
  const provider = new DeterministicAuditProvider()
  const store = new MemoryArtifactStore()
  await runExperiment({ definition: audit0Definition, machine, artifactStore: store,
    provider: { async run(request) {
      requests.set(request.task.id, structuredClone(request))
      return provider.run(request)
    } },
  })
  return { state: machine.snapshot(), requests, store, machine }
}

it('binds every accepted output to its actual request inputs, configuration and task', async () => {
  const { state, requests, store, machine } = await run()
  expect(state.status).toBe('completed')
  for (const record of state.artifacts) {
    const request = requests.get(record.taskId)!
    expect(request).toBeDefined()
    expect(record.execution).toEqual({ runId: state.runId, releaseDigest: state.releaseDigest,
      definitionDigest: state.definitionDigest, attempt: request.attempt,
      taskDigest: await sha256(request.task), inputCount: request.visibleArtifacts.length,
      inputDigest: await sha256(artifactReferences(request.visibleArtifacts)),
      taskExecutionId: request.taskExecutionId, workspaceKey: request.execution!.workspaceKey,
      mutationOwner: request.execution!.mutationOwner,
    })
    expect(await store.readExecutionInputs(record.execution!.inputDigest)).toEqual(artifactReferences(request.visibleArtifacts))
    expect(request.execution).toEqual(record.execution)
    expect(record.promptDigest).toBe(request.promptDigest)
  }
  await restoreSelected(machine)
})

it('refuses to capture invented upstream work or an invalid attempt', async () => {
  const { state, store } = await run()
  const task = audit0Definition.stages[0]!.waves[0]!.tasks[0]!
  await expect(artifactExecution({ state, task, store, attempt: 0, inputArtifacts: [] })).rejects.toThrow('attempt')
  await expect(artifactExecution({ state, task, store, attempt: 1,
    inputArtifacts: [{ id: 'invented', contentDigest: 'a'.repeat(64) }] })).rejects.toThrow('upstream')
  await expect(artifactExecution({ state, task, store, attempt: 1,
    inputArtifacts: artifactReferences([state.artifacts[0]!]) })).rejects.toThrow('upstream')
})


it('preserves the dispatched release across restore and rejects relabeled outputs', async () => {
  const original = 'a'.repeat(64), replacement = 'b'.repeat(64)
  let machine = await createControlledMachine(audit0Definition, original, 'draining-contract-fixture')
  const artifactStore = new MemoryArtifactStore(), provider = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore, provider })
  const requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore,
    provider: { async run(request) { requests.push(request); throw new AgentExecutionPending(request.task.id) } } })
  const request = requests[0]!, dispatched = structuredClone(request.execution!)
  expect(dispatched.releaseDigest).toBe(original)
  const before = machine.snapshot()
  expect(before.inFlightAgentAttempts!.find(attempt => attempt.taskId === request.task.id)?.execution).toEqual(dispatched)
  await expect(restoreSelected(machine, { ...before, releaseDigest: replacement }))
    .rejects.toThrow('snapshot has no matching state selection receipt')
  machine = await restoreSelected(machine)
  const result = await provider.run(request)
  const input = { wave: request.wave, task: request.task, promptDigest: request.promptDigest,
    result, artifactStore, stageId: request.stage.id, attempt: request.attempt,
    inputArtifacts: artifactReferences(request.visibleArtifacts), execution: dispatched }
  await expect(machine.recordResult({ ...input, execution: { ...dispatched, releaseDigest: replacement } }))
    .rejects.toThrow('selected task occurrence')
  const accepted = await machine.recordResult(input)
  expect(accepted.execution).toEqual(dispatched)
  expect(accepted.execution!.releaseDigest).toBe(original)
  expect(machine.view().budget.modelCalls).toBe(before.budget.modelCalls + 1)
})

it('keeps the original dispatch contract on a quarantined attempt and its correction', async () => {
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'repair-contract-fixture')
  const artifactStore = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const requests: AgentRequest[] = []
  let corrupted = false
  const provider = { async run(request: AgentRequest) {
    requests.push(structuredClone(request))
    const result = await base.run(request)
    if (!corrupted && request.task.providerClass !== 'deterministic') {
      corrupted = true
      return { ...result, files: {} }
    }
    return result
  } }
  await runExperiment({ definition: audit0Definition, machine, artifactStore, provider })
  const rejected = machine.view().rejectedAttempts[0]!
  expect(rejected).toBeDefined()
  const first = requests.find(request => request.task.id === rejected.taskId && request.attempt === rejected.attempt)!
  expect(rejected.execution).toEqual(first.execution)
  const accepted = machine.view().artifacts.find(record => record.taskId === rejected.taskId)!
  expect(accepted.execution!.attempt).toBeGreaterThan(rejected.execution!.attempt)
  expect(accepted.execution!.releaseDigest).toBe(rejected.execution!.releaseDigest)
  expect(accepted.execution!.inputDigest).toBe(rejected.execution!.inputDigest)
})


it('reobserves an already-admitted request without changing its native identity', async () => {
  let machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'admitted-contract-fixture')
  const artifactStore = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore, provider: base })
  const pending = new Map<string, AgentRequest>(), receipts = new Map<string, AgentExecutionReceipt>()
  let initial = true, receiptObservations = 0
  const db = sqliteD1(); databases.push(db)
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const owners = new ExecutionAuthorityStore(db.d1)
  await owners.activate(machine.view().executionAuthority!, 'a'.repeat(64))
  async function native(request: AgentRequest) {
    const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic-workspace', INDEX: db.d1 } as any) as any
    provider.assertProviderCredentials = async () => {}
    provider.executionReceipts = { get: async (_run: string, digest: string) => {
      receiptObservations++
      if (!receipts.has(digest)) {
        if (!initial) throw new Error('admitted native request digest changed')
        const state = machine.view(), pointer = { generation: state.stateGeneration, digest: await sha256(state) }
        db.sqlite.prepare(`INSERT INTO experiment_runs VALUES (?, ?, 'running', ?, ?, NULL, ?, NULL)
          ON CONFLICT(run_id) DO UPDATE SET state_key=excluded.state_key, state_generation=excluded.state_generation`)
          .run(state.runId, state.experimentId, runStateKey(state.runId, pointer.generation, pointer.digest), pointer.generation, state.updatedAt)
        expect(await owners.admitLaunch(request.executionAuthority!, request.taskExecutionId!, digest, pointer)).toBe(true)
        const result = await base.run(request)
        receipts.set(digest, { requestDigest: digest, exitCode: 0, stderr: '', actorId: result.actorId,
          files: { ...result.files }, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd })
      }
      return receipts.get(digest)!
    } }
    return provider.run(request)
  }
  await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore,
    provider: { async run(request) {
      pending.set(request.task.id, structuredClone(request))
      await native(request)
      throw new AgentExecutionPending(request.task.id)
    } } })
  machine = await restoreSelected(machine)
  initial = false
  const receiptCount = receipts.size, originalTasks = [...pending.keys()]
  let observed = 0
  await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore,
    provider: { async run(request) {
      const original = pending.get(request.task.id)
      if (original !== undefined) {
        expect(request.execution).toBeDefined()
        expect(request).toEqual(original)
        pending.delete(request.task.id); observed++
        return native(request)
      }
      return base.run(request)
    } } })
  expect(observed).toBeGreaterThan(0)
  expect(pending.size).toBe(0)
  expect(receipts.size).toBe(receiptCount)
  expect(receiptObservations).toBe(receiptCount * 2)
  for (const taskId of originalTasks) expect(machine.view().artifacts.some(record => record.taskId === taskId)).toBe(true)
  expect(machine.view().inFlightAgentAttempts?.some(attempt => originalTasks.includes(attempt.taskId))).toBe(false)
  expect(machine.view().rejectedAttempts).toEqual([])
})

it('rejects historical in-place configuration revisions instead of authorizing them', () => {
  const reference = { releaseDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64) }
  expect(executionConfiguration(reference)).toEqual(reference)
  for (const configurationRevision of [undefined, 0, 1, 2]) {
    expect(() => executionConfiguration({ ...reference, configurationRevision } as typeof reference))
      .toThrow('historical app version')
  }
})
