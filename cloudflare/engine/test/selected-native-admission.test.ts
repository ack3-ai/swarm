import { afterEach, expect, it } from 'vitest'
import { createExecutorSourceFixture } from './support/successor-fixture.js'
import { advanceExperimentOneWave, audit0RunPolicy, disposeTerminalWorkspaces } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import type { AgentRequest } from '../src/contracts.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { assertNativeTaskAdmission } from '../src/native-launch-authority.js'
import { sha256 } from '../src/canonical.js'

const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))

it('authenticates the selected native admission without replaying its historical journal', async () => {
  const f = await createExecutorSourceFixture(close => closes.push(close))
  const requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine,
    artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy,
    provider: { async run(request) { requests.push(request); throw new AgentExecutionPending(request.task.id) } } })
  const state = f.machine.view(), request = requests[0]!
  expect(request).toBeDefined()
  const releases = (digest: string) => f.store.getRelease(digest), source = f.store.executionSources()
  await expect(assertNativeTaskAdmission(state, request, releases, source)).rejects.toThrow('no matching state selection')
  await f.store.putState(state, { generation: f.source.stateGeneration, digest: await sha256(f.source) })
  await assertNativeTaskAdmission(state, request, releases, source)
  const editedState = structuredClone(state)
  editedState.budget.modelCalls++
  await expect(assertNativeTaskAdmission(editedState, request, releases, source)).rejects.toThrow('no matching state selection')
  const editedRequest = structuredClone(request)
  editedRequest.task.model = 'substituted-model'
  await expect(assertNativeTaskAdmission(state, editedRequest, releases, source)).rejects.toThrow('matching persisted task admission')
  await expect(assertNativeTaskAdmission(state, request, releases)).rejects.toThrow('matching persisted task admission')
})

it('refuses an operator-invented discovery completion before its policy permits closure', async () => {
  const f = await createExecutorSourceFixture(close => closes.push(close))
  expect(f.machine.view().phase).toBe('discovery')
  const before = f.machine.snapshot(), now = new Date().toISOString()
  await expect(f.machine.endStage('safety-ceiling-reached', { decidedAt: now,
    decisionJournalHead: before.journal.at(-1)!.digest }, before.cursor.stageIndex, now))
    .rejects.toThrow('admission policy')
  expect(f.machine.snapshot()).toEqual(before)
})

it('checks exact shared inputs and attempt admission before certifying native results', async () => {
  const f = await createExecutorSourceFixture(close => closes.push(close), false, undefined, 2)
  const admit = f.machine.admitAgentAttempt.bind(f.machine)
  const artifacts = new MemoryArtifactStore()
  let checked = 0
  f.machine.admitAgentAttempt = async (admission, now) => {
    const state = f.machine.view()
    const wave = f.machine.definition.stages.find(stage => stage.id === admission.stageId)!.waves
      .find(wave => wave.id === admission.waveId)!
    const task = wave.tasks.find(task => task.id === admission.taskId)!
    const execution = admission.execution!
    expect(execution.inputCount).toBeGreaterThan(0)
    await expect(admit({ ...admission, execution: { ...execution, inputCount: 0, inputDigest: await sha256([]) } }, now))
      .rejects.toThrow('inputs differ from the admitted frontier')
    const inputArtifacts = await artifacts.readExecutionInputs(execution.inputDigest)
    const result = { status: 'accepted' as const, actorId: 'test', model: task.model,
      provider: (await import('../src/provider-identity.js')).providerIdentity(task), files: {}, assertions: [],
      protocol: {}, inputTokens: 1, outputTokens: 1, costUsd: 0 }
    const input = { wave, task, stageId: admission.stageId, attempt: admission.attempt,
      promptDigest: admission.promptDigest, execution, inputArtifacts, artifactStore: artifacts, result }
    await expect(f.machine.recordResult(input)).rejects.toThrow('native acceptance lacks its exact admitted attempt')
    expect(f.machine.view()).toBe(state)
    const digest = await admit(admission, now)
    for (const changed of [{ ...result, provider: 'other' }, { ...result, model: 'other' }]) {
      await expect(f.machine.recordResult({ ...input, result: changed })).rejects.toThrow('provider or model differs')
    }
    checked++
    return digest
  }
  await advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine, artifactStore: artifacts,
    policy: audit0RunPolicy, provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  expect(checked).toBeGreaterThan(0)
})


it('rejects a fabricated cleanup state before ownership lookup or native disposal', async () => {
  const f = await createExecutorSourceFixture(close => closes.push(close))
  await f.machine.fail('synthetic terminal failure')
  const state = f.machine.view()
  await f.store.putState(state, { generation: f.source.stateGeneration, digest: await sha256(f.source) })
  let effects = 0
  const provider = { async run() { throw new Error('unused') }, async disposeWorkspace() { effects++ } }
  const options = { loadExecution: f.store.executionSources(), async loadOwnedWorkspaces() { effects++; return [] } }
  const invented = structuredClone(state)
  invented.budget.modelCalls++
  await expect(disposeTerminalWorkspaces(provider, f.machine.definition, invented, options))
    .rejects.toThrow('no matching state selection')
  expect(effects).toBe(0)
  await expect(disposeTerminalWorkspaces(provider, f.machine.definition, state, options)).rejects.toThrow('cancel control')
  expect(effects).toBe(0)
})


it('refuses a new cohort that omits previously sealed research from shared knowledge', async () => {
  const f = await createExecutorSourceFixture(close => closes.push(close))
  const complete = f.machine.recordDiscoveryCohortReceipt.bind(f.machine)
  let completedPool = ''
  f.machine.recordDiscoveryCohortReceipt = async (...args) => {
    await complete(...args)
    completedPool = args[2]
    throw new Error('test stops after real cohort completion')
  }
  const { DeterministicAuditProvider } = await import('./support/deterministic-audit-provider.js')
  await expect(advanceExperimentOneWave({ definition: f.machine.definition, machine: f.machine,
    artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy, provider: new DeterministicAuditProvider() }))
    .rejects.toThrow('test stops after real cohort completion')
  const before = f.machine.view()
  const progress = before.discoveryScheduler!.pools.find(pool => pool.poolId === completedPool)!
  expect(before.waveReceipts.some(receipt => receipt.poolId === completedPool)).toBe(true)
  await expect(f.machine.admitDiscoveryCohort({ stageId: before.discoveryScheduler!.stageId,
    poolId: completedPool, waveIndex: progress.nextWaveIndex, inputArtifacts: [], peerPredecessors: {} }))
    .rejects.toThrow('complete sealed research frontier')
  expect(f.machine.view()).toBe(before)
})
