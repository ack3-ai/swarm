import { createControlledMachine } from './support/controlled-machine.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { expect, it } from 'vitest'
import { recordedWorkspaceTasks, groupWorkspaceAllocations, cleanupWorkspaceTasks } from '../src/execution-workspaces.js'
import { disposeTerminalWorkspaces, advanceExperimentOneWave } from '../src/runner.js'
import { RunMachine } from '../src/machine.js'
import { initialTaskOccurrences } from '../src/task-occurrences.js'
import { artifactExecution, executionConfiguration } from '../src/artifact-execution.js'
import { nativeWorkspaceKey, workspaceAllocationName } from '../src/native-workspace.js'
import { sha256 } from '../src/canonical.js'
import type { ArtifactRecord, DiscoveryCohortAdmission, RejectedAttempt, TaskDefinition } from '../src/contracts.js'
import { audit0Definition } from './support/audit0-config.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

async function fixture() {
  const definition = structuredClone(audit0Definition)
  const authority = { auditId: 'inventory-audit', executionId: 'inventory-audit', epoch: 0, runtimeDigest: await sha256(null) }
  const machine = await createControlledMachine(definition, 'a'.repeat(64), authority.auditId, undefined, undefined, authority)
  await machine.start()
  const state = machine.snapshot(), stage = definition.stages.find(value => value.kind === 'discovery')!, wave = stage.waves[0]!
  const configuration = executionConfiguration(state)
  state.waveAdmission = { inputArtifacts: [], inputDigest: await sha256([]), configuration, stageId: stage.id, waveId: wave.id, cursor: { stageIndex: 1, waveIndex: 0 },
    admittedAt: state.updatedAt, taskOccurrences: await initialTaskOccurrences(authority, configuration, wave.tasks) }
  const record = async (task: TaskDefinition) => ({ stageId: stage.id, waveId: wave.id, taskId: task.id,
    execution: await artifactExecution({ state, task, attempt: 1, inputArtifacts: [], store: new MemoryArtifactStore() }) })
  return { definition, state, stage, wave, authority, configuration, record }
}

it('inventories every unfinished ordinary admission before a provider call and between attempts', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!, rejected = await f.record(task)
  f.state.rejectedAttempts = [rejected as RejectedAttempt]
  expect(f.state.inFlightAgentAttempts ?? []).toHaveLength(0)
  const records = await recordedWorkspaceTasks(f.definition, f.state)
  expect(records.filter(value => value.admitted).map(value => value.task.id).sort()).toEqual(f.wave.tasks.map(value => value.id).sort())
  expect(records.find(value => value.evidenced)).toMatchObject({ execution: rejected.execution, configuration: f.configuration })
  expect(records.find(value => value.admitted && value.task.id === task.id)).toMatchObject({
    taskExecutionId: rejected.execution.taskExecutionId, configuration: f.configuration, stageId: f.stage.id, waveId: f.wave.id,
  })
})

it('preserves failed admission obligations until controlled cleanup', async () => {
  const definition = structuredClone(audit0Definition), id = 'cleanup-produced'
  const machine = await createControlledMachine(definition, 'a'.repeat(64), id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await machine.start()
  const store = new MemoryArtifactStore()
  await advanceExperimentOneWave({ definition, machine, artifactStore: store, provider: new DeterministicAuditProvider() })
  const stage = definition.stages[machine.view().cursor.stageIndex]!, wave = stage.waves[0]!, task = wave.tasks[0]!
  await machine.admitWave(stage.id, wave.id)
  const execution = await artifactExecution({ state: machine.view(), task, attempt: 1, inputArtifacts: [], store })
  await machine.recordRejectedAttempt({ stageId: stage.id, waveId: wave.id, taskId: task.id, execution,
    attempt: 1, promptDigest: 'b'.repeat(64), outputDigest: null, quarantineUri: null, diagnostics: ['synthetic'],
    freshContext: true, continuationMode: 'new', sessionId: null,
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  await machine.fail('synthetic framework failure')
  const disposed: string[] = [], provider = { run: async () => { throw new Error('unused') },
    disposeWorkspace: async ({ workspaceKey }: { workspaceKey: string }) => { disposed.push(workspaceKey) } }
  await expect(disposeTerminalWorkspaces(provider, definition, machine.view())).rejects.toThrow('cancel control')
  const records = await recordedWorkspaceTasks(definition, machine.view())
  expect(disposed).toEqual([])
  expect(records.filter(value => value.admitted)).toHaveLength(wave.tasks.length)
  expect(records.some(value => value.active)).toBe(false)
})

it('uses selected occurrence identity rather than an older accepted logical task', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!, record = await f.record(task)
  f.state.artifacts = [{ ...record, status: 'accepted' } as ArtifactRecord]
  expect((await recordedWorkspaceTasks(f.definition, f.state)).some(value => value.admitted && value.task.id === task.id)).toBe(false)
  f.state.waveAdmission!.taskOccurrences = f.state.waveAdmission!.taskOccurrences!.map(value => value.taskId !== task.id ? value
    : { ...value, taskExecutionId: `task-${'f'.repeat(48)}`, origin: { ...value.origin, ordinal: 1 } })
  expect((await recordedWorkspaceTasks(f.definition, f.state)).some(value => value.admitted && value.task.id === task.id)).toBe(true)
})

it('inventories independent admitted cohorts without adding other configured pool tasks', async () => {
  const f = await fixture(), selected = f.wave.tasks.slice(0, 2)
  expect(selected).toHaveLength(2)
  const admissions: DiscoveryCohortAdmission[] = await Promise.all(selected.map(async (task, i) => ({
    configuration: f.configuration, stageId: f.stage.id, waveId: f.wave.id, poolId: `pool-${i}`, waveIndex: 0,
    taskIds: [task.id], taskOccurrences: await initialTaskOccurrences(f.authority, f.configuration, [task]),
    admittedAt: f.state.updatedAt, budgetAtAdmission: f.state.budget, inputArtifacts: [], inputDigest: await sha256([]),
    materialEpoch: 0, peerPredecessors: {},
  })))
  f.state.waveAdmission = null
  f.state.discoveryScheduler = { stageId: f.stage.id, materialEpoch: 0, pools: [], admissions }
  f.state.artifacts = [{ ...await f.record(selected[0]!), status: 'accepted' } as ArtifactRecord]
  const records = await recordedWorkspaceTasks(f.definition, f.state)
  expect(records.filter(value => value.admitted).map(value => value.task.id)).toEqual([selected[1]!.id])
  expect(new Set(records.map(value => value.task.id))).toEqual(new Set(selected.map(value => value.id)))
})

it('refuses an amended occurrence route inside an immutable audit', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!, original = await f.record(task)
  const next = structuredClone(f.definition), nextTask = next.stages.find(s => s.id === f.stage.id)!.waves[0]!.tasks.find(t => t.id === task.id)!
  nextTask.workspaceKey = 'replacement-lane'
  const configuration = { releaseDigest: 'b'.repeat(64), definitionDigest: await sha256(next) }
  f.state.rejectedAttempts = [original as RejectedAttempt]
  f.state.waveAdmission!.taskOccurrences = f.state.waveAdmission!.taskOccurrences!.map(value => value.taskId !== task.id ? value
    : { ...value, configuration, taskDigest: 'c'.repeat(64), taskExecutionId: `task-${'f'.repeat(48)}` })
  await expect(recordedWorkspaceTasks(f.definition, f.state)).rejects.toThrow('workspace configuration differs')
})

it.each(['coverage-union', 'review-union', 'final-seal'] as const)('never inventories supervisor-only %s as a native actor', async kind => {
  const f = await fixture(), task = f.definition.stages.flatMap(s => s.waves.flatMap(w => w.tasks)).find(t => t.promptKind === kind)!
  expect(task).toBeDefined()
  const stage = f.definition.stages.find(s => s.waves.some(w => w.tasks.includes(task)))!, wave = stage.waves.find(w => w.tasks.includes(task))!
  f.state.waveAdmission = { inputArtifacts: [], inputDigest: await sha256([]), configuration: f.configuration, stageId: stage.id, waveId: wave.id,
    cursor: { stageIndex: 0, waveIndex: 0 }, admittedAt: f.state.updatedAt,
    taskOccurrences: await initialTaskOccurrences(f.authority, f.configuration, wave.tasks) }
  f.state.artifacts = [{ stageId: stage.id, waveId: wave.id, taskId: task.id } as ArtifactRecord]
  const records = await recordedWorkspaceTasks(f.definition, f.state)
  expect(records.some(value => value.task.id === task.id)).toBe(false)
})

it('includes native deterministic preflight before any output or paid attempt', async () => {
  const f = await fixture(), stage = f.definition.stages[0]!, wave = stage.waves[0]!
  expect(wave.tasks.some(task => task.promptKind === 'preflight')).toBe(true)
  f.state.waveAdmission = { inputArtifacts: [], inputDigest: await sha256([]), configuration: f.configuration, stageId: stage.id, waveId: wave.id,
    cursor: { stageIndex: 0, waveIndex: 0 }, admittedAt: f.state.updatedAt,
    taskOccurrences: await initialTaskOccurrences(f.authority, f.configuration, wave.tasks) }
  const records = await recordedWorkspaceTasks(f.definition, f.state)
  expect(records.filter(value => value.admitted).map(value => value.task.id)).toEqual(wave.tasks.map(task => task.id))
  expect(records.every(value => !value.evidenced && value.active)).toBe(true)
})

it('fails closed when a controlled admission loses its selected occurrence', async () => {
  const f = await fixture()
  f.state.waveAdmission!.taskOccurrences = []
  await expect(recordedWorkspaceTasks(f.definition, f.state)).rejects.toThrow('task occurrence is missing')
})


it('keeps historical and current allocation names separate in the read-only projection', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!, legacy = await f.record(task)
  // Historical bytes are supplied by their owning app, never by current admission.
  delete legacy.execution.mutationOwner
  const covered = await f.record(task)
  f.state.rejectedAttempts = [legacy as RejectedAttempt, covered as RejectedAttempt]
  f.state.status = 'failed'
  const records = (await recordedWorkspaceTasks(f.definition, f.state)).filter(record => record.task.id === task.id)
  const groups = await groupWorkspaceAllocations(records, f.state.runId)
  expect(groups).toHaveLength(2)
  expect(new Set(groups.map(group => group.workspaceKey)).size).toBe(1)
  expect(groups.map(group => group.sandboxName.slice(0, 3)).sort()).toEqual(['a0-', 'm1-'])

})

it('requires retirement verification before cleanup can exclude or target inherited actors', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!, record = await f.record(task)
  record.execution.runId = 'historical-executor'
  f.state.rejectedAttempts = [record as RejectedAttempt]
  f.state.status = 'failed'
  await expect(cleanupWorkspaceTasks(f.definition, f.state)).rejects.toThrow('verified retirement')
  let mutations = 0
  await expect(disposeTerminalWorkspaces({ run: async () => { throw new Error('unused') }, disposeWorkspace: async () => { mutations++ } },
    f.definition, f.state)).rejects.toThrow('produced by the execution machine')
  expect(mutations).toBe(0)
})


it('refuses edited historical parent state before cleanup or allocation claims', async () => {
  const f = await fixture(), task = f.wave.tasks[0]!
  const parent = await f.record(task)
  // @ts-expect-error Deliberately remove required ownership to test rejection.
  delete f.state.executionAuthority
  f.state.waveAdmission = null
  parent.execution.runId = 'legacy-parent'
  f.state.rejectedAttempts = [parent as RejectedAttempt]
  f.state.status = 'failed'
  const disposed: string[] = []
  await expect(disposeTerminalWorkspaces({ run: async () => { throw new Error('unused') },
    disposeWorkspace: async input => { disposed.push(await workspaceAllocationName(input)) } }, f.definition, f.state)).rejects.toThrow('produced by the execution machine')
  expect(disposed).toEqual([])
  expect(f.state.rejectedAttempts[0]!.execution).toEqual(parent.execution)
})

it('validates controlled history before terminal cleanup or ownership lookup', async () => {
  const f = await fixture()
  f.state.status = 'failed'
  f.state.journal = [...f.state.journal, { ...f.state.journal.at(-1)!, type: 'run.control-settled', payload: {} }]
  let effects = 0
  await expect(disposeTerminalWorkspaces({ run: async () => { throw new Error('unused') },
    disposeWorkspace: async () => { effects++ } }, f.definition, f.state, {
    loadOwnedWorkspaces: async () => { effects++; return [] },
  })).rejects.toThrow()
  expect(effects).toBe(0)
})


it('retains rejected and deferred terminal allocations while attempting all remaining cleanup', async () => {
  const definition = structuredClone(audit0Definition), id = 'completed-cleanup'
  const machine = await createControlledMachine(definition, 'a'.repeat(64), id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await runExperiment({ definition, machine, artifactStore: new MemoryArtifactStore(), provider: new DeterministicAuditProvider() })
  const attempted: string[] = []
  const result = await disposeTerminalWorkspaces({ run: async () => { throw new Error('unused') },
    disposeWorkspace: async ({ workspaceKey }) => {
      attempted.push(workspaceKey)
      if (attempted.length === 1) throw new Error('temporary transport failure')
      if (attempted.length === 2) return { status: 'deferred' as const, timeoutMs: 1000 }
    },
  }, definition, machine.view())
  expect(attempted.length).toBeGreaterThan(2)
  expect(result.mode).toBe('provider-attempted')
  expect(result.deferred?.toSorted()).toEqual(attempted.slice(0, 2).toSorted())
  expect(new Set(attempted)).toEqual(new Set(result.workspaceKeys))
})
