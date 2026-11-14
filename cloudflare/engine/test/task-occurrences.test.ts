import { artifactExecution } from '../src/artifact-execution.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { assertAcceptedTaskOccurrence } from '../src/task-occurrences.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { discoveryRepairAllowed } from '../src/discovery-policy.js'
import { beforeAll, expect, it, vi } from 'vitest'
import type { AgentRequest, RejectedAttempt, RunState, TaskOccurrence } from '../src/contracts.js'
import { sha256 } from '../src/canonical.js'
import { taskExecutionIdentity } from '../src/execution-authority.js'
import { taskAttemptRejections, assertAgentAttemptPolicy } from '../src/attempt-policy.js'
import { persistedTerminalTaskFailures } from '../src/execution-failures.js'
import { RunMachine } from '../src/machine.js'
import { sealReleasePackage } from '../src/release.js'
import { advanceExperimentOneWave, runNextWave } from '../src/runner.js'
import { AgentExecutionPending, PermanentRunFailure } from '../src/run-errors.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

async function pending() {
  const release = await sealReleasePackage(audit0PackageBody), id = 'task-occurrence-evidence'
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const store = new MemoryArtifactStore(), requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: new DeterministicAuditProvider() })
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: { async run(request) { requests.push(request); throw new AgentExecutionPending(request.task.id) } } })
  return { machine, state: machine.snapshot(), requests }
}
let f: Awaited<ReturnType<typeof pending>>
beforeAll(async () => { f = await pending() })

it('retains original native identities and exact task contracts through discovery admission and reload', async () => {
  const restored = await restoreSelected(f.machine)
  for (const admission of restored.view().discoveryScheduler!.admissions) for (const occurrence of admission.taskOccurrences!) {
    const request = f.requests.find(value => value.task.id === occurrence.taskId)!
    expect(occurrence.taskExecutionId).toBe(`task-${(await sha256({ authority: f.state.executionAuthority, taskId: occurrence.taskId })).slice(0, 48)}`)
    expect(occurrence.taskExecutionId).toBe(request.taskExecutionId)
    expect(occurrence.configuration).toEqual(admission.configuration)
    expect(occurrence.taskDigest).toBe(await sha256(request.task))
    expect(occurrence.origin.ordinal).toBe(0)
  }
  expect(restored.view().discoveryScheduler).toEqual(f.state.discoveryScheduler)
  expect(restored.view().waveReceipts[0]!.taskOccurrences).toHaveLength(1)
})

it.each(['missing', 'duplicate', 'origin', 'ordinal', 'configuration', 'task-digest'] as const)(
  'rejects a rehashed %s cohort snapshot without its selection receipt', async corruption => {
    const state = structuredClone(f.state), admission = state.discoveryScheduler!.admissions[0]!
    const occurrence = admission.taskOccurrences![0]!
    if (corruption === 'missing') Reflect.deleteProperty(admission, 'taskOccurrences')
    if (corruption === 'duplicate') admission.taskOccurrences = [...admission.taskOccurrences!, occurrence]
    if (corruption === 'origin') occurrence.origin.authority.executionId = 'forged-origin'
    if (corruption === 'ordinal') occurrence.origin.ordinal = 1
    if (corruption === 'configuration') occurrence.configuration.releaseDigest = 'f'.repeat(64)
    if (corruption === 'task-digest') occurrence.taskDigest = 'f'.repeat(64)
    if (corruption === 'origin' || corruption === 'ordinal') occurrence.taskExecutionId = `task-${(await sha256(occurrence.origin.ordinal === 0
      ? { authority: occurrence.origin.authority, taskId: occurrence.taskId }
      : { version: 1, authority: occurrence.origin.authority, taskId: occurrence.taskId, ordinal: occurrence.origin.ordinal })).slice(0, 48)}`
    state.journal.find(event => event.type === 'discovery.cohort-admitted'
      && (event.payload as { poolId: string }).poolId === admission.poolId)!.payload = structuredClone(admission)
    await rehash(state)
    await expect(restoreSelected(f.machine, state)).rejects.toThrow('state selection receipt')
  },
)

it('rejects accepted occurrence substitution and missing rejection identity on reload', async () => {
  const state = JSON.parse(JSON.stringify(f.state)) as typeof f.state
  state.artifacts[0]!.execution!.taskExecutionId = `task-${'f'.repeat(48)}`
  const artifact = state.artifacts[0]!
  const occurrence = f.state.waveReceipts.flatMap(receipt => receipt.taskOccurrences ?? []).find(value => value.taskId === artifact.taskId)!
  expect(occurrence).toBeDefined()
  expect(() => assertAcceptedTaskOccurrence(occurrence, artifact)).toThrow('selected task occurrence')
  await expect(restoreSelected(f.machine, state)).rejects.toThrow('state selection receipt')
  const machine = await restoreSelected(f.machine)
  const attempt = machine.view().inFlightAgentAttempts![0]!
  await machine.recordRejectedAttempt({ ...attempt, outputDigest: null, quarantineUri: null, diagnostics: ['synthetic'],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  expect(machine.view().rejectedAttempts[0]).not.toHaveProperty('repairScopeRunId')
  const rejected = JSON.parse(JSON.stringify(machine.snapshot())) as typeof f.state
  delete rejected.rejectedAttempts[0]!.execution
  const before = machine.snapshot()
  await expect(machine.recordRejectedAttempt(rejected.rejectedAttempts[0]!)).rejects.toThrow('controlled rejection')
  expect(machine.snapshot()).toEqual(before)
  await expect(restoreSelected(machine, rejected)).rejects.toThrow('state selection receipt')
})

it('does not let a historical repair scope authorize a foreign rejection', async () => {
  const machine = await restoreSelected(f.machine), before = machine.snapshot()
  const attempt = before.inFlightAgentAttempts![0]!
  const foreign = { ...attempt, execution: { ...attempt.execution!, runId: 'foreign-run' },
    repairScopeRunId: 'foreign-run', outputDigest: null, quarantineUri: null, diagnostics: ['synthetic'],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  await expect(machine.recordRejectedAttempt(foreign)).rejects.toThrow('execution workspace differs')
  expect(machine.snapshot()).toEqual(before)
})

it('scopes retry history by occurrence across executors while retaining unrelated and unknown usage', async () => {
  const request = f.requests.find(value => value.task.providerClass === 'core')!, execution = request.execution!
  const oldId = execution.taskExecutionId!, newId = await taskExecutionIdentity({ ...f.state.executionAuthority!, auditId: 'new-fork', executionId: 'new-fork' }, request.task.id)
  expect(newId).not.toBe(oldId)
  expect(await taskExecutionIdentity(f.state.executionAuthority!, request.task.id)).toBe(oldId)
  const rejection = { execution, stageId: request.stage.id, waveId: request.wave.id, taskId: request.task.id,
    attempt: 1, promptDigest: request.promptDigest, outputDigest: null, quarantineUri: null, diagnostics: ['synthetic'],
    freshContext: false, continuationMode: 'new', sessionId: 'session-prior', rejectedAt: f.state.updatedAt,
    repairScopeRunId: 'previous-executor', usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0,
      usageComplete: false, costAccountingComplete: false } } as RejectedAttempt
  const history = [rejection], before = structuredClone(history)
  expect(taskAttemptRejections(history, request.task.id, oldId)).toEqual(history)
  expect(taskAttemptRejections(history, request.task.id, newId)).toEqual([])
  expect(() => taskAttemptRejections(history, request.task.id, '')).toThrow('selected task occurrence')
  const admission = f.state.inFlightAgentAttempts!.find(value => value.taskId === request.task.id)!
  expect(() => assertAgentAttemptPolicy(request.task, { ...admission, execution: { ...execution, taskExecutionId: newId } },
    history)).not.toThrow()
  expect(history).toEqual(before)
  const exhausted = { ...f.state, rejectedAttempts: history, inFlightAgentAttempts: [],
    budget: { ...f.state.budget, modelCalls: f.machine.definition.limits.maxModelCalls } }
  // D1: the call cap stops new cohorts only; a task of an admitted cohort may still correct its output.
  expect(discoveryRepairAllowed(f.machine.definition, exhausted, request.task.id)).toBe(true)
})

it('keeps old failures in history without blocking a different selected occurrence or resetting peers', async () => {
  const machine = await restoreSelected(f.machine)
  const selected = machine.view().discoveryScheduler!.admissions.flatMap(value => value.taskOccurrences!)
  for (const occurrence of selected.slice(0, 2)) {
    await machine.recordFailure(f.requests.find(value => value.task.id === occurrence.taskId)!.task,
      new PermanentRunFailure('synthetic exhausted credit', 'provider-rejected'), undefined, occurrence.taskExecutionId)
  }
  const state = machine.snapshot(), old = selected[0]!, peer = selected[1]!
  expect(persistedTerminalTaskFailures(state).has(old.taskId)).toBe(true)
  // Projection test only: replacement activation is not authorized by editing this state.
  state.discoveryScheduler = structuredClone(state.discoveryScheduler!)
  const changed = state.discoveryScheduler!.admissions.flatMap(value => value.taskOccurrences!).find(value => value.taskId === old.taskId) as TaskOccurrence
  changed.origin.ordinal = 1
  changed.taskExecutionId = `task-${(await sha256({ version: 1, authority: changed.origin.authority, taskId: changed.taskId, ordinal: 1 })).slice(0, 48)}`
  expect(persistedTerminalTaskFailures(state).has(old.taskId)).toBe(false)
  expect(persistedTerminalTaskFailures(state).has(peer.taskId)).toBe(true)
  expect(state.journal.filter(event => event.type === 'task.failed')).toHaveLength(2)
  expect(state.budget).toEqual(f.state.budget)
  await expect(restoreSelected(f.machine, state)).rejects.toThrow('state selection receipt')
})


async function rehash(state: RunState) {
  let previousDigest: string | null = null
  for (const event of state.journal) {
    event.previousDigest = previousDigest
    const { digest: _, ...unsigned } = event
    event.digest = await sha256(unsigned); previousDigest = event.digest
  }
}


it.each([undefined, `task-${'f'.repeat(48)}`])('rejects terminal failures with unproven occurrence %s without recording them', async taskExecutionId => {
  const machine = await restoreSelected(f.machine), before = machine.snapshot()
  await expect(machine.recordFailure(f.requests[0]!.task,
    new PermanentRunFailure('synthetic exhausted credit', 'provider-rejected'), undefined, taskExecutionId))
    .rejects.toThrow('terminal task failure lacks its admitted occurrence')
  expect(machine.snapshot()).toEqual(before)
})


it('refuses execution creation without a selected occurrence before writing inputs', async () => {
  const state = structuredClone(f.state)
  // @ts-expect-error Deliberately remove required ownership to test rejection.
  delete state.executionAuthority
  state.waveAdmission = null
  delete state.discoveryScheduler
  let writes = 0
  await expect(artifactExecution({ state, task: f.requests[0]!.task, attempt: 1, inputArtifacts: [],
    store: { async putExecutionInputs() { writes++; return 'a'.repeat(64) } } }))
    .rejects.toThrow('task occurrence is missing or duplicated')
  expect(writes).toBe(0)
})

it.each(['configuration', 'taskDigest'] as const)('refuses foreign %s before dispatching an admitted task', async corruption => {
  const release = await sealReleasePackage(audit0PackageBody)
  const machine = await createControlledMachine(release.body.definition, release.digest, 'immutable-dispatch')
  await machine.start()
  const stage = machine.definition.stages[0]!, wave = stage.waves[0]!
  await machine.admitWave(stage.id, wave.id)
  const original = machine.snapshot(), altered = machine.snapshot()
  const occurrence = altered.waveAdmission!.taskOccurrences![0]!
  if (corruption === 'configuration') occurrence.configuration.releaseDigest = 'f'.repeat(64)
  else occurrence.taskDigest = 'f'.repeat(64)
  // Isolate dispatch's defensive boundary; persisted mutations are also rejected on load.
  const view = vi.spyOn(machine, 'view').mockReturnValue(altered)
  const run = vi.fn()
  try {
    await expect(runNextWave({ definition: machine.definition, machine,
      provider: { run }, artifactStore: new MemoryArtifactStore() })).rejects.toThrow('immutable manifest')
    expect(run).not.toHaveBeenCalled()
  } finally { view.mockRestore() }
  expect(machine.snapshot()).toEqual(original)
})
