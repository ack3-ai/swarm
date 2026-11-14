import { admittedProviderRequest } from './support/admitted-provider-request.js'
import { artifactExecution, artifactReferences } from '../src/artifact-execution.js'
import { selectVisibleArtifacts } from '../src/prompts.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { RunMachine } from '../src/machine.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { settleCancelledExecution, settleControlledFailure } from '../src/run-control-executor.js'
import { rootExecutionMachine } from '../src/root-execution.js'
import { CommandCustodyCollector } from '../src/command-custody.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { hasPendingNativeControl, settleTerminalAdmissionControls, settleTerminalControlsAndDispose } from '../src/run-control-reconcile.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { stateWriter } from '../src/cloudflare-storage.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
const providerCloses: (() => void)[] = []
const initializeMutationOwner = async (owner: unknown) => ({ owner, objectId: "a".repeat(64) })
afterEach(() => { vi.mocked(getAgentSandbox).mockReset(); providerCloses.splice(0).forEach(close => close()) })
import { getAgentSandbox } from '../src/agent-sandbox-client.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { AgentExecutionReceiptIntegrityError } from '../src/agent-execution-receipt.js'
import { executionLaunchGraceMs, SandboxAgentProvider } from '../src/sandbox-provider.js'
import { executionRequestBody } from '../src/native-request.js'
import { disposeTerminalWorkspaces, advanceExperimentOneWave } from '../src/runner.js'
import {
  AgentExecutionPending, isPermanentRunFailure, PermanentRunFailure, TransientRunFailure,
} from '../src/run-errors.js'
import { sameRuntimeRelease } from '../src/runtime-release.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import {
  workflowProgress, workflowFailureDisposition, failureForWorkflowProgress,
} from '../src/workflow-outcome.js'
import { agentProcessWaitSliceMs, waveStepConfig } from '../src/workflow-step-config.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))
vi.mock('../src/agent-process.js', () => ({
  agentProcessId: (digest: string) => `agent-${digest.slice(0, 40)}`,
  waitForAgentProcess: async () => 'unavailable',
}))

it('keeps launch revocation grace independent from the observation slice', () => {
  expect(agentProcessWaitSliceMs).toBe(2 * 60_000)
  expect(executionLaunchGraceMs).toBe(15 * 60_000)
  expect(executionLaunchGraceMs).toBeGreaterThan(agentProcessWaitSliceMs)
})

it('keeps an admitted long-running Sandbox alive across Workflow observation gaps', async () => {
  const setKeepAlive = vi.fn(async () => {})
  const sandbox = { setKeepAlive, initializeMutationOwner } as any
  vi.mocked(getAgentSandbox).mockReturnValueOnce(sandbox)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, {
    executionReceipts: { get: async () => null },
    observationHealth: { get: async () => null },
    runInSandbox: async () => {
      throw new AgentExecutionPending('synthetic-process', 'unfinished')
    },
  })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close), 'research')
  await expect(provider.run(request as any)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
  expect(getAgentSandbox).toHaveBeenCalledWith(expect.any(Object), expect.any(String), expect.objectContaining({
    keepAlive: true,
    inactivityTimeoutMs: 30 * 60_000,
  }))
  expect(setKeepAlive).toHaveBeenCalledWith(true)
})

it('recovers an exact successful durable receipt without waiting for Sandbox keep-alive', async () => {
  const setKeepAlive = vi.fn(() => new Promise<void>(() => {}))
  vi.mocked(getAgentSandbox).mockClear()
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  const runInSandbox = vi.fn()
  Object.assign(provider, {
    executionReceipts: { get: async (_runId: string, requestDigest: string) => ({
      requestDigest, exitCode: 0, actorId: 'durable',
      files: { '.swarm/submission.json': '{"complete":true,"retainedReferences":[]}' },
      inputTokens: 5, outputTokens: 2,
      costUsd: 0, stderr: '',
    }) },
    runInSandbox,
  })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close), 'reporting')
  await expect(provider.run(request as any)).resolves.toMatchObject({ status: 'accepted', actorId: 'durable' })
  expect(setKeepAlive).not.toHaveBeenCalled()
  expect(getAgentSandbox).not.toHaveBeenCalled()
  expect(runInSandbox).not.toHaveBeenCalled()
})

it('keeps Sandbox lifetime confirmation for a nonzero receipt that may need native custody', async () => {
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValueOnce({ setKeepAlive, initializeMutationOwner } as any)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  const result = { status: 'additive-unavailable' }
  const runInSandbox = vi.fn(async () => result)
  Object.assign(provider, {
    executionReceipts: { get: async () => ({ exitCode: 1 }) },
    observationHealth: { get: async () => null }, runInSandbox,
  })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close), 'research')
  await expect(provider.run(request as any)).resolves.toBe(result)
  expect(setKeepAlive).toHaveBeenCalledWith(true)
  expect(runInSandbox).toHaveBeenCalledOnce()
})

it('classifies a durable receipt read outage before container access or paid repair', async () => {
  vi.mocked(getAgentSandbox).mockClear()
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, { executionReceipts: { get: async () => { throw new Error('R2 unavailable') } } })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close), 'research')
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'TransientRunFailure', message: 'durable execution receipt observation is temporarily unavailable',
  })
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('keeps a corrupt durable receipt in the integrity-failure category', async () => {
  vi.mocked(getAgentSandbox).mockClear()
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, { executionReceipts: { get: async () => {
    throw new AgentExecutionReceiptIntegrityError('agent execution receipt provenance mismatch')
  } } })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close), 'research')
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'PermanentRunFailure', category: 'integrity-failed',
  })
  expect(getAgentSandbox).not.toHaveBeenCalled()
})

it('disables keep-alive before terminal workspace destruction', async () => {
  const setKeepAlive = vi.fn(async () => {})
  const destroy = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValueOnce({ setKeepAlive, destroy } as any)
  const provider = new SandboxAgentProvider({} as any)
  await expect(provider.disposeWorkspace({ runId: 'terminal', workspaceKey: 'lane' }))
    .resolves.toMatchObject({ status: 'destroyed' })
  expect(getAgentSandbox).toHaveBeenLastCalledWith(undefined, expect.any(String), expect.objectContaining({
    keepAlive: false,
    inactivityTimeoutMs: 30 * 60_000,
  }))
  expect(setKeepAlive).toHaveBeenCalledWith(false)
  expect(destroy).toHaveBeenCalledOnce()
})

it('defers terminal disposal when keep-alive stalls and never destroys after a late response', async () => {
  let release!: () => void
  const setKeepAlive = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const destroy = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValueOnce({ setKeepAlive, destroy } as any)
  const provider = new SandboxAgentProvider({} as any)
  await expect(provider.disposeWorkspace({ runId: 'terminal', workspaceKey: 'lane' }))
    .resolves.toMatchObject({ status: 'deferred' })
  expect(setKeepAlive).toHaveBeenCalledOnce()
  release()
  await Promise.resolve()
  await Promise.resolve()
  expect(destroy).not.toHaveBeenCalled()
}, 8_000)

it('does not execute or destroy under an unconfirmed Sandbox lifetime setting', async () => {
  const configureError = new Error('synthetic configuration failure')
  const runInSandbox = vi.fn(async () => { throw new Error('must not execute') })
  vi.mocked(getAgentSandbox).mockReturnValueOnce({
    initializeMutationOwner,
    setKeepAlive: vi.fn(async () => { throw configureError }),
  } as any)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, {
    executionReceipts: { get: async () => null },
    observationHealth: { get: async () => null }, runInSandbox,
  })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close))
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'TransientRunFailure', message: 'Cloudflare Sandbox lifetime configuration failed',
  })
  expect(runInSandbox).not.toHaveBeenCalled()

  const destroy = vi.fn(async () => {})
  vi.mocked(getAgentSandbox).mockReturnValueOnce({
    initializeMutationOwner,
    setKeepAlive: vi.fn(async () => { throw configureError }), destroy,
  } as any)
  await expect(provider.disposeWorkspace({ runId: 'terminal', workspaceKey: 'lane' }))
    .rejects.toThrow('synthetic configuration failure')
  expect(destroy).not.toHaveBeenCalled()
})

it('keeps diagnostic observers outside Sandbox lifecycle ownership', () => {
  for (const [path, marker, endMarker] of [
    ['../src/runtime-service.ts', 'async function laneResult', 'async function readiness'],
    ['../src/worker.ts', 'const diagnosticMatch', 'const runMatch'],
  ] as const) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const start = source.indexOf(marker)
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf(endMarker, start)
    expect(end).toBeGreaterThan(start)
    const diagnostic = source.slice(start, end)
    expect(diagnostic).toContain('durableLaneDiagnostic')
    expect(diagnostic).not.toContain('getAgentSandbox')
  }
})

async function cleanupFixture() {
  const machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'terminal-fixture')
  await advanceExperimentOneWave({ definition: audit0Definition, machine,
    provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore() })
  const stage = audit0Definition.stages[machine.view().cursor.stageIndex]!, wave = stage.waves[0]!
  const [failed, pending] = wave.tasks
  await machine.admitWave(stage.id, wave.id)
  const state = machine.view(), store = new MemoryArtifactStore()
  const executionFor = (task: typeof failed & {}) => artifactExecution({ state, task, attempt: 1, store,
    inputArtifacts: artifactReferences(selectVisibleArtifacts(task, state.artifacts, state.waveReceipts,
      state.cursor.stageIndex, state.cursor.waveIndex, audit0Definition)) })
  const failedExecution = await executionFor(failed!), pendingExecution = await executionFor(pending!)
  const attempt = { stageId: stage.id, waveId: wave.id, attempt: 1, promptDigest: 'b'.repeat(64),
    freshContext: false, continuationMode: 'new' as const, sessionId: null }
  await machine.recordRejectedAttempt({ ...attempt, taskId: failed!.id, execution: failedExecution, outputDigest: null,
    quarantineUri: null, diagnostics: ['synthetic failure'],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  await machine.admitAgentAttempt({ ...attempt, taskId: pending!.id, execution: pendingExecution })
  await machine.fail('synthetic terminal failure')
  const disposed: string[] = [], provider = { run: async () => { throw new Error('unused') },
    disposeWorkspace: async ({ workspaceKey }: { workspaceKey: string }) => {
      disposed.push(workspaceKey); return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  return { machine, provider, disposed, failed: failedExecution.workspaceKey!, pending: pendingExecution.workspaceKey! }
}

it('refuses failed cleanup outside the cancellation control, preserving all native lanes', async () => {
  const f = await cleanupFixture(), before = f.machine.snapshot()
  await expect(disposeTerminalWorkspaces(f.provider, audit0Definition, f.machine.view())).rejects.toThrow('cancel control')
  expect(f.disposed).toEqual([])
  expect(f.machine.snapshot()).toEqual(before)
})

it('rejects historical cleanup: does not force-dispose a native lane adopted from a parent run', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-owned' },
  ] }] }] } as any
  const state = { releaseDigest: 'a'.repeat(64), definitionDigest: await sha256(definition), runId: 'child-run', status: 'failed', artifacts: [], rejectedAttempts: [],
    inFlightAgentAttempts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-owned', workspaceAllocationRunId: 'parent-run' } },
  } as any
  await expect(disposeTerminalWorkspaces(provider, definition, state)).rejects.toThrow('historical app version')
  expect(disposed).toEqual([])
})

it('rejects historical cleanup: cleans a completed child lane through its verified parent allocation', async () => {
  const disposed: Array<{ runId: string, workspaceKey: string }> = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { runId: string, workspaceKey: string }) {
      disposed.push(input)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-lane' },
  ] }] }] } as any
  const state = { releaseDigest: 'a'.repeat(64), definitionDigest: await sha256(definition), runId: 'child-run', status: 'completed',
    artifacts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    rejectedAttempts: [], inFlightAgentAttempts: [],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-lane', workspaceAllocationRunId: 'parent-run' } },
  } as any
  await expect(disposeTerminalWorkspaces(provider, definition, state)).rejects.toThrow('historical app version')
  expect(disposed).toEqual([])
})

it('rejects historical cleanup: blocks completed cleanup proof when a child lacks its parent workspace claim', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-lane' },
  ] }] }] } as any
  const state = { releaseDigest: 'a'.repeat(64), definitionDigest: await sha256(definition), runId: 'child-run', status: 'completed',
    artifacts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    rejectedAttempts: [], inFlightAgentAttempts: [],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-lane', workspaceAllocationRunId: 'parent-run' } },
  } as any
  await expect(disposeTerminalWorkspaces(provider, definition, state)).rejects.toThrow('historical app version')
  expect(disposed).toEqual([])
})

function workflow(overrides: Record<string, unknown>) {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(
    source.indexOf('export class AuditWorkflow'), source.indexOf('async function forwardCoordinator'),
  ).replace('export class', 'class'))
  class NonRetryableError extends Error {}
  const deps = {
    assertExecutionOwner: async () => {},
    WorkflowEntrypoint: class { env = {} }, CloudflareRunStore: class { executionSources() { return async () => { throw new Error('unexpected historical source read') } } },
    waveStepConfig, workflowProgress, stateWriter, rootExecutionMachine,
    settleTerminalControlsAndDispose, settleTerminalAdmissionControls, hasPendingNativeControl,
    RunCommandJournal, CommandCustodyCollector, ExecutionAuthorityStore, settleCancelledExecution, settleControlledFailure,
    workflowFailureDisposition, failureForWorkflowProgress, isPermanentRunFailure,
    PermanentRunFailure, TransientRunFailure, NonRetryableError, sameRuntimeRelease, canonicalJson,
    assertReleaseEnvironmentMatchesRuntime,
    sameCursor: (a: { stageIndex: number, waveIndex: number }, b: { stageIndex: number, waveIndex: number }) => (
      a.stageIndex === b.stageIndex && a.waveIndex === b.waveIndex
    ),
    engineRole: () => 'legacy-monolith', assertLocalRuntime: () => {},
    runIdPattern: /^[a-z0-9._-]+$/, digestPattern: /^[0-9a-f]{64}$/,
    QuarantinedRevalidationProvider: class {}, PromotedExecutionProvider: class {},
    SandboxAgentProvider: class {}, R2ArtifactStore: class {},
    R2AgentExecutionReceiptStore: class {}, R2AgentExecutionLogStore: class {},
    disposeTerminalWorkspaces: async () => ({ mode: 'not-applicable', workspaceKeys: [], activeWorkspaceKeys: [] }),
    audit0RunPolicy: { assessCompletion: () => [] },
    ...overrides,
  }
  const Workflow = new Function(...Object.keys(deps), `${code}; return AuditWorkflow`)(...Object.values(deps))
  return new Workflow() as any
}

const initialState = (at: string) => ({
  schemaVersion: 2,
  runId: 'synthetic-flow', experimentId: 'synthetic', releaseDigest: 'a'.repeat(64),
  status: 'running', stateGeneration: 1, createdAt: at, updatedAt: at,
  rootRunId: 'synthetic-flow', recoveryEpoch: 0, parentRunId: null, parentCheckpointDigest: null,
  modelStartedAt: null, cursor: { stageIndex: 0, waveIndex: 0 }, checkpoints: [], terminalReason: null,
  journal: [],
})

it('keeps a deferred terminal destroy retryable', async () => {
  const instance = workflow({
    disposeTerminalWorkspaces: async () => ({
      mode: 'provider-attempted', workspaceKeys: ['lane'], activeWorkspaceKeys: [], deferred: ['lane'],
    }),
  })
  await expect(instance.cleanupTerminalWorkspaces({ stages: [] }, {
    ...initialState('2026-09-26T10:00:00.000Z'), status: 'stopped',
  })).rejects.toMatchObject({ category: 'transport', retryable: true })
})

function legacyRevalidationFixture() {
  const checkpoint = { digest: 'b'.repeat(64), body: {
    experimentId: 'synthetic', runId: 'synthetic-parent', releaseDigest: 'a'.repeat(64),
    cursor: { stageIndex: 0, waveIndex: 0 },
  } }
  const definition = { id: 'synthetic', stages: [{ id: 'review', waves: [{ id: 'review-1', tasks: [
    { id: 'reviewer', retryPolicy: 'none' },
  ] }] }] }
  const candidate = {
    stageId: 'review', waveId: 'review-1', taskId: 'reviewer', attempt: 1,
    promptDigest: 'c'.repeat(64), outputDigest: 'd'.repeat(64), quarantineUri: 'r2://quarantine/output',
    usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  }
  const source = {
    ...initialState('2026-09-25T10:00:00.000Z'), status: 'failed', runId: 'synthetic-parent',
    releaseDigest: checkpoint.body.releaseDigest, cursor: checkpoint.body.cursor,
    checkpoints: [checkpoint], parentCheckpointDigest: null, rejectedAttempts: [candidate],
  }
  const revalidation = { sourceRunId: source.runId, ...candidate }
  const payload = { mode: 'resume', experimentId: 'synthetic', runId: 'synthetic-child',
    checkpointDigest: checkpoint.digest, revalidation }
  const store = {
    getCheckpoint: async () => structuredClone(checkpoint),
    getRelease: async () => ({ digest: checkpoint.body.releaseDigest, body: { definition } }),
    getStateIfPresent: async () => null,
    getState: vi.fn(async () => source),
  }
  const resume = vi.fn(async () => ({ retained: true }))
  return { checkpoint, definition, source, payload, store, resume, instance: workflow({ RunMachine: { resume } }) }
}

it.each(['plain', 'clock-only', 'transition'])('refuses absent-state %s resume without reading or constructing a source', async kind => {
  const f = legacyRevalidationFixture()
  const payload: any = { ...f.payload }
  delete payload.revalidation
  if (kind === 'clock-only') payload.timeAmendment = { amendedModelStartedAt: '2026-09-26T10:00:00.000Z' }
  if (kind === 'transition') payload.runtimeTransition = { sourceRunId: 'synthetic-parent' }
  await expect(f.instance.bootstrap(payload, f.store)).rejects.toMatchObject({ category: 'invalid-configuration' })
  expect(f.store.getState).not.toHaveBeenCalled()
  expect(f.resume).not.toHaveBeenCalled()
})

it.each(['valid', 'marker', 'changed-usage'])('refuses delayed absent legacy revalidation (%s) without source reads or child creation', field => {
  const f = legacyRevalidationFixture()
  if (field === 'marker') f.payload.revalidation = {} as any
  if (field === 'changed-usage') f.payload.revalidation.usage.costUsd = 900
  return expect(f.instance.bootstrap(f.payload, f.store)).rejects.toMatchObject({ category: 'invalid-configuration' })
    .then(() => {
      expect(f.store.getState).not.toHaveBeenCalled()
      expect(f.resume).not.toHaveBeenCalled()
    })
})

it('publishes every checkpoint before committing its advanced cursor', async () => {
  let durable = initialState('2026-09-25T10:00:00.000Z')
  let publishCalls = 0
  let waveCalls = 0
  const store = { executionSources: () => async () => { throw new Error('unexpected historical source read') },
    getState: async () => structuredClone(durable),
    getRelease: async () => ({ body: { definition: { stages: [{}, {}] } } }),
    putState: async (state: typeof durable) => { durable = structuredClone(state) },
    putCheckpoint: async () => {
      publishCalls += 1
      if (publishCalls === 1) throw new Error('temporary R2 unavailable')
    },
  }
  const instance = workflow({
    reconcileRunControls: async () => true, RunCommandJournal: class {}, CommandCustodyCollector: class {},
    RunMachine: { fromState: async (definition: unknown, state: typeof durable) => ({
      definition, value: state,
      snapshot() { return structuredClone(this.value) },
      view() { return structuredClone(this.value) },
    }) },
    advanceExperimentOneWave: async ({ machine, onCheckpoint }: any) => {
      waveCalls += 1
      machine.value.stateGeneration += 1
      machine.value.cursor = { stageIndex: 1, waveIndex: 0 }
      machine.value.checkpoints = [{ digest: 'b'.repeat(64) }]
      await onCheckpoint(machine.value.checkpoints[0])
    },
  })
  const payload = { runId: 'synthetic-flow' }
  const cursor = { stageIndex: 0, waveIndex: 0 }

  await expect(instance.runOneWave(payload, cursor, store)).rejects.toThrow('temporary R2 unavailable')
  expect(durable.cursor.stageIndex).toBe(0)
  await expect(instance.runOneWave(payload, cursor, store)).resolves.toMatchObject({
    cursor: { stageIndex: 1, waveIndex: 0 }, checkpointDigest: 'b'.repeat(64),
  })
  expect(publishCalls).toBe(2)
  expect(waveCalls).toBe(2)
  expect(durable.cursor.stageIndex).toBe(1)
})

it('does not launch an exact paid attempt twice after ephemeral process loss', async () => {
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  const claimStart = vi.fn()
    .mockResolvedValueOnce({ acquired: true, claimedAt: new Date().toISOString() })
    .mockResolvedValueOnce({ acquired: false, claimedAt: '2020-01-01T00:00:00.000Z' })
  Object.assign(provider, {
    executionReceipts: { get: async () => null, claimStart },
    prepareSandbox: async () => {}, runtimeEnvironment: async () => ({}),
  })
  const startProcess = vi.fn(async (_command: string, options: any) => ({ id: options.processId }))
  const sandbox = {
    exists: async () => ({ success: true, exists: false }),
    getProcess: async () => null, startProcess,
    exec: async () => ({ success: true }), mkdir: async () => {}, writeFile: async () => {},
  }
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close))

  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    name: 'AgentExecutionPending',
  })
  await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({
    name: 'AgentAttemptFailure', includeDiagnosticsInRepair: false,
  })
  expect(startProcess).toHaveBeenCalledTimes(1)
  expect(claimStart).toHaveBeenCalledTimes(2)
})

it('retries immutable prompt publication with the original admission timestamp', async () => {
  const putRequest = vi.fn()
    .mockRejectedValueOnce(new Error('temporary monitor write failure'))
    .mockResolvedValueOnce(undefined)
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_WORKSPACE_ID: 'synthetic', ARTIFACTS: {}, PACKAGES: {}, INDEX: {},
  } as any)
  Object.assign(provider, {
    executionReceipts: { getStart: vi.fn(async () => ({ acquired: false, claimedAt: '2026-09-26T12:00:00.000Z' })) },
    executionLogs: { putRequest },
    runs: { getRelease: async () => ({ body: { definition: { prompts: { researcherProtocol: 'Protocol' } } } }) },
  })
  const request = {
    runId: 'synthetic-flow', prompt: 'Exact prompt', promptDigest: await sha256('Exact prompt'), attempt: 1,
    stage: { id: 'discovery' }, wave: { id: 'wave-0' }, releaseDigest: 'a'.repeat(64),
    task: { id: 'synthetic-task', model: 'synthetic', providerClass: 'core' },
  }
  await (provider as any).ensureAgentLogRequest(request, 'b'.repeat(64))
  await (provider as any).ensureAgentLogRequest(request, 'b'.repeat(64))
  expect(putRequest).toHaveBeenCalledTimes(2)
  expect(putRequest.mock.calls[0]?.[0]).toEqual(putRequest.mock.calls[1]?.[0])
  expect(putRequest.mock.calls[1]?.[0]).toMatchObject({
    prompt: 'Exact prompt', startedAt: '2026-09-26T12:00:00.000Z', startedAtBasis: 'execution-admission',
  })
})

it('keeps a losing launch observer read-only and reattaches to the winner', async () => {
  let processRegistered = false
  let modelActive = false
  let claims = 0
  let lookups = 0
  let winnerStarted!: () => void
  const started = new Promise<void>(resolve => { winnerStarted = resolve })
  let releaseInitialLookups!: () => void
  const bothLooked = new Promise<void>(resolve => { releaseInitialLookups = resolve })
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  Object.assign(provider, {
    executionReceipts: {
      get: async () => null,
      claimStart: async () => ++claims === 1
        ? { acquired: true, claimedAt: new Date().toISOString() }
        : { acquired: false, claimedAt: new Date().toISOString() },
    },
    prepareSandbox: async () => {}, runtimeEnvironment: async () => ({}),
  })
  const removalsWhileActive: string[] = []
  const process = { id: 'synthetic-process' }
  const sandbox = {
    exists: async (path: string) => ({ success: true, exists: modelActive && path.endsWith('/result.txt') }),
    deleteFile: async (path: string) => { if (modelActive) removalsWhileActive.push(path); return { success: true } },
    getProcess: async () => {
      const observed = processRegistered ? process : null
      lookups += 1
      if (lookups === 2) releaseInitialLookups()
      if (lookups <= 2) await bothLooked
      return observed
    },
    startProcess: vi.fn(async () => { processRegistered = true; winnerStarted(); return process }),
    exec: async () => ({ success: true }), mkdir: async () => {},
    writeFile: async (path: string) => { if (path.includes('/agent-ready-')) modelActive = true },
  }
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close))
  const first = (provider as any).runInSandbox(sandbox, request)
  const second = (provider as any).runInSandbox(sandbox, request)
  await started
  const results = await Promise.allSettled([first, second])

  expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
  expect(lookups).toBe(3)
  expect(results.every(result => result.status === 'rejected'
    && result.reason.name === 'AgentExecutionPending')).toBe(true)
  expect(removalsWhileActive).toEqual([])
})

it('stops leftover agent processes before it prepares a new launch, never on a reattach (T2)', async () => {
  const sweepPath = '/usr/local/bin/ack3-stop-agent-processes'
  const launchAndReattach = async (image: 'current' | 'old' | 'failing') => {
    const events: string[] = []
    let processRegistered = false
    let claims = 0
    const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
    Object.assign(provider, {
      executionReceipts: { get: async () => null,
        claimStart: async () => ({ acquired: ++claims === 1, claimedAt: new Date().toISOString() }) },
      prepareSandbox: async () => { events.push('prepare') }, runtimeEnvironment: async () => ({}),
    })
    const process = { id: 'synthetic-process' }
    const sandbox = {
      exists: async (path: string) => ({ success: true, exists: image !== 'old' && path === sweepPath }),
      getProcess: async () => processRegistered ? process : null,
      startProcess: vi.fn(async () => { events.push('start'); processRegistered = true; return process }),
      exec: async (command: string) => {
        events.push(`exec:${command}`)
        return command !== sweepPath ? { success: true, stdout: '', stderr: '' }
          : image === 'failing' ? { success: false, exitCode: 1, stdout: '', stderr: 'sweep failed' }
            : { success: true, exitCode: 0, stdout: '{"stopped":2,"remaining":0}\n', stderr: '' }
      },
      mkdir: async (path: string) => { events.push(`mkdir:${path}`) },
      writeFile: async (path: string) => { events.push(`write:${path}`) },
      deleteFile: async (path: string) => { events.push(`delete:${path}`); return { success: true } },
    }
    const request = await admittedProviderRequest(provider, close => providerCloses.push(close))
    await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    const launched = events.splice(0)
    // The next observation finds the registered process and reattaches.
    await expect((provider as any).runInSandbox(sandbox, request)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
    return { launched, reattached: events }
  }
  const current = await launchAndReattach('current')
  const sweep = current.launched.indexOf(`exec:${sweepPath}`)
  expect(current.launched.filter(event => event === `exec:${sweepPath}`)).toHaveLength(1)
  // Only the root-only private folder exists before it; preparation and every workspace write come after.
  expect(current.launched.slice(0, sweep)).toEqual(['mkdir:/workspace/private'])
  expect(current.launched[sweep + 1]).toBe('prepare')
  expect(current.launched.indexOf('start')).toBeGreaterThan(sweep)
  expect(current.reattached.some(event => event.includes(sweepPath))).toBe(false)
  // An image without the script skips the sweep; a failed sweep is logged. Neither stops the launch.
  const old = await launchAndReattach('old')
  expect(old.launched.some(event => event.includes(sweepPath))).toBe(false)
  expect(old.launched).toContain('start')
  expect((await launchAndReattach('failing')).launched).toContain('start')
})

it('fences a delayed setup owner before authorizing a replacement attempt', async () => {
  let claims = 0
  let revoked = false
  let releaseHolder!: () => void
  const holderBlocked = new Promise<void>(resolve => { releaseHolder = resolve })
  let holderInvoked!: () => void
  const holderStarted = new Promise<void>(resolve => { holderInvoked = resolve })
  const prepareSandbox = vi.fn(async () => {})
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
  Object.assign(provider, {
    executionReceipts: {
      get: async () => null,
      claimStart: async () => ++claims === 1
        ? { acquired: true, claimedAt: '2020-01-01T00:00:00.000Z' }
        : { acquired: false, claimedAt: '2020-01-01T00:00:00.000Z' },
    },
    prepareSandbox, runtimeEnvironment: async () => ({}),
  })
  const process = { id: 'synthetic-process' }
  const sandbox = {
    exists: async (path: string) => ({ success: true, exists: revoked && path.endsWith('/revoked') }),
    getProcess: async () => null,
    startProcess: vi.fn(async () => { holderInvoked(); await holderBlocked; return process }),
    exec: async (command: string) => {
      if (command.startsWith('if mkdir /workspace/private/agent-launch-')) revoked = true
      return { success: true }
    },
    mkdir: async () => {}, writeFile: async () => {}, deleteFile: async () => ({ success: true }),
  }
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close))
  const owner = (provider as any).runInSandbox(sandbox, request)
  await holderStarted
  const recovery = (provider as any).runInSandbox(sandbox, request)
  const recoveryResult = await recovery.catch((error: unknown) => error)
  releaseHolder()
  const ownerResult = await owner.catch((error: unknown) => error)

  expect(recoveryResult).toMatchObject({ name: 'AgentAttemptFailure' })
  expect(ownerResult).toMatchObject({ name: 'AgentExecutionPending' })
  expect(prepareSandbox).toHaveBeenCalledOnce()
  expect(sandbox.startProcess).toHaveBeenCalledTimes(1)
})

it('keeps the final receipt path private until the request digest is stamped', () => {
  const wrapper = readFileSync(new URL('../src/agent-execution-receipt.ts', import.meta.url), 'utf8')
  const rawPathAt = wrapper.indexOf("const rawResultPath = resultPath + '.raw-'")
  const stampAt = wrapper.indexOf('result.requestDigest = request.requestDigest')
  const publishAt = wrapper.indexOf('await rename(temporaryPath, resultPath)')
  expect(rawPathAt).toBeGreaterThan(-1)
  expect(stampAt).toBeGreaterThan(rawPathAt)
  expect(publishAt).toBeGreaterThan(stampAt)
  expect(wrapper).toContain("spawn('/usr/local/bin/ack3-agent-runner', [requestPath, rawResultPath]")
})

it('redacts known credentials before making an execution receipt durable', () => {
  const provider = readFileSync(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
  const parseAt = provider.indexOf('const parsedResult = parseExactAgentExecutionReceipt')
  const redactAt = provider.indexOf('stderr: this.redactKnownCredentials(parsedResult.stderr)', parseAt)
  const persistAt = provider.indexOf('this.executionReceipts.put(request.runId, requestDigest, result, request)', parseAt)
  expect(parseAt).toBeGreaterThan(-1)
  expect(redactAt).toBeGreaterThan(parseAt)
  expect(persistAt).toBeGreaterThan(redactAt)
})

// A receipt read back from the sandbox, on either recovery path, is stored as the normal path stores it (T3).
async function sandboxReceiptRecovery(beforeLaunch: boolean) {
  const secret = 'synthetic-provider-secret-value'
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', PROVIDER_API_KEY: secret } as any)
  const put = vi.fn(async () => {})
  const agentResult = vi.fn(async (_sandbox: unknown, _request: unknown, receipt: unknown) => receipt)
  Object.assign(provider, {
    executionReceipts: { get: async () => null, put,
      claimStart: async () => ({ acquired: false, claimedAt: new Date().toISOString() }) },
    runtimeEnvironment: async () => ({}), ensureAgentLogRequest: async () => {}, drainAgentLogs: async () => {}, agentResult,
  })
  const request = await admittedProviderRequest(provider, close => providerCloses.push(close))
  const requestDigest = await sha256(canonicalJson(executionRequestBody(request, 'synthetic')))
  const receipt = { requestDigest, exitCode: 1, actorId: 'synthetic-actor', files: {}, inputTokens: 1, outputTokens: 1,
    costUsd: 0, stderr: `provider refused ${secret}\n` }
  // Before a launch the receipt is already there; after a lost claim it appears once the winner wrote it.
  let receiptChecks = 0
  const sandbox = {
    exists: async (path: string) => ({ success: true,
      exists: path.endsWith('/agent-result.json') && (beforeLaunch || ++receiptChecks > 1) }),
    readFile: async () => ({ content: JSON.stringify(receipt) }),
    getProcess: async () => null, mkdir: async () => {}, exec: async () => ({ success: true }),
  }
  await (provider as any).runInSandbox(sandbox, request)
  return { put, agentResult }
}

it('redacts known credentials in a receipt recovered from the sandbox before a launch (T3)', async () => {
  const { put, agentResult } = await sandboxReceiptRecovery(true)
  expect(put).toHaveBeenCalledTimes(1)
  expect((put.mock.calls[0] as any[])[2].stderr).toBe('provider refused <redacted:PROVIDER_API_KEY>\n')
  expect((agentResult.mock.calls[0] as any[])[2].stderr).toBe('provider refused <redacted:PROVIDER_API_KEY>\n')
})

it('redacts known credentials in a receipt recovered from the sandbox after a lost launch claim (T3)', async () => {
  const { put, agentResult } = await sandboxReceiptRecovery(false)
  expect(put).toHaveBeenCalledTimes(1)
  expect((put.mock.calls[0] as any[])[2].stderr).toBe('provider refused <redacted:PROVIDER_API_KEY>\n')
  expect((agentResult.mock.calls[0] as any[])[2].stderr).toBe('provider refused <redacted:PROVIDER_API_KEY>\n')
})

it('redacts the tokens inside a Codex login binding one by one, as the container log does (T3)', async () => {
  const login = (access: string) => JSON.stringify({ auth_mode: 'chatgpt',
    tokens: { access_token: access, refresh_token: `${access}-refresh` } })
  const provider = new SandboxAgentProvider({
    ACK3_CODEX_AUTH_JSON: login('synthetic-access-token'),
    CODEX_TEAM_AUTH_JSON: { get: async () => login('synthetic-team-access-token') },
    PROVIDER_API_KEY: 'not-json-secret-value',
  } as any)
  const redact = (text: string): string => (provider as any).redactKnownCredentials(text)
  expect(redact(`stderr synthetic-access-token and synthetic-access-token-refresh, ${login('synthetic-access-token')}`))
    .toBe('stderr <redacted:ACK3_CODEX_AUTH_TOKENS_ACCESS_TOKEN> and <redacted:ACK3_CODEX_AUTH_TOKENS_REFRESH_TOKEN>, '
      + '<redacted:ACK3_CODEX_AUTH_JSON>')
  expect(redact('not-json-secret-value')).toBe('<redacted:PROVIDER_API_KEY>')
  // A Secrets Store binding is listed once this provider has resolved it, like every other credential.
  expect(redact('synthetic-team-access-token')).toBe('synthetic-team-access-token')
  await (provider as any).credential('CODEX_TEAM_AUTH_JSON')
  expect(redact('synthetic-team-access-token / synthetic-team-access-token-refresh'))
    .toBe('<redacted:CODEX_TEAM_AUTH_TOKENS_ACCESS_TOKEN> / <redacted:CODEX_TEAM_AUTH_TOKENS_REFRESH_TOKEN>')
  // The values of a JSON binding that is no Codex login stay one value.
  const other = new SandboxAgentProvider({ PROVIDER_API_KEY: '{"key":"synthetic-inner-value"}' } as any)
  expect((other as any).redactKnownCredentials('synthetic-inner-value')).toBe('synthetic-inner-value')
})

it('does not clear a Sandbox result unless this observer wins the durable launch claim', () => {
  const provider = readFileSync(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
  const privateParentAt = provider.indexOf("sandbox.mkdir('/workspace/private', { recursive: true })")
  const claimAt = provider.indexOf('await this.executionReceipts.claimStart(request.runId, requestDigest)')
  const outputClearAt = provider.indexOf('await clearUntrustedTaskOutputs', claimAt)
  const clearAt = provider.indexOf('sandbox.exec(`rm -f ${resultPath}`')
  const launchAt = provider.indexOf('sandbox.startProcess(guardedLaunch')
  const readyAt = provider.indexOf("sandbox.writeFile(launchReadyPath, 'ready')")
  expect(privateParentAt).toBeGreaterThan(-1)
  expect(claimAt).toBeGreaterThan(privateParentAt)
  expect(launchAt).toBeGreaterThan(claimAt)
  expect(outputClearAt).toBeGreaterThan(launchAt)
  expect(clearAt).toBeGreaterThan(outputClearAt)
  expect(readyAt).toBeGreaterThan(clearAt)
})


it('retains controlled failed work when command settlement is unavailable instead of racing legacy disposal', async () => {
  const dispose = vi.fn(), preserve = vi.fn(async () => { throw new TransientRunFailure('synthetic D1 outage') })
  const instance = workflow({ disposeTerminalWorkspaces: dispose, settleControlledFailure: preserve })
  await expect(instance.cleanupTerminalWorkspaces({ stages: [] }, {
    ...initialState('2026-09-26T10:00:00.000Z'), status: 'failed',
    executionAuthority: { auditId: 'synthetic-flow', executionId: 'synthetic-flow', epoch: 0, runtimeDigest: null },
  })).rejects.toMatchObject({ retryable: true })
  expect(preserve).toHaveBeenCalledExactlyOnceWith('synthetic-flow', instance.env)
  expect(dispose).not.toHaveBeenCalled()
})

it('does not schedule, complete or cross a stop boundary while a native command is pending', async () => {
  const durable: any = { ...initialState('2026-11-01T00:00:00Z'), executionAuthority: {
    auditId: 'synthetic-flow', executionId: 'synthetic-flow', epoch: 0, runtimeDigest: await sha256(null),
  } }
  const definition = { stages: [{ id: 'discovery', kind: 'discovery' }] }
  const machine = { definition, view: () => durable }
  const advance = vi.fn(), cleanup = vi.fn()
  const instance = workflow({ RunMachine: { fromState: async () => machine }, RunCommandJournal: class {},
    reconcileRunControls: async () => false, advanceExperimentOneWave: advance })
  instance.cleanupTerminalWorkspaces = cleanup
  const store = { executionSources: () => async () => { throw new Error('unexpected historical source read') }, getState: async () => durable, getRelease: async () => ({ body: { definition } }) }
  expect(await instance.runOneWave({ runId: durable.runId }, durable.cursor, store)).toMatchObject({ status: 'running' })
  expect(advance).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
})

it('delegates canceled Workflow cleanup to the same executor cleanup used by command delivery', async () => {
  const state: any = { ...initialState('2026-11-01T00:00:00Z'), status: 'stopped',
    journal: [{ type: 'run.cancelled' }, { type: 'run.control-settled' }] }
  const result = { mode: 'command-cancelled', workspaceKeys: ['native-lane'], activeWorkspaceKeys: [],
    retainedWorkspaceKeys: [], proofDigest: 'd'.repeat(64) }
  const cleanup = vi.fn(async () => result), legacy = vi.fn(() => { throw new Error('legacy disposal must not run') })
  const instance = workflow({ settleCancelledExecution: cleanup, disposeTerminalWorkspaces: legacy })
  expect(await instance.cleanupTerminalWorkspaces({ stages: [] }, state)).toEqual(result)
  expect(cleanup).toHaveBeenCalledExactlyOnceWith(state, instance.env)
  expect(legacy).not.toHaveBeenCalled()
})

it('preserves pending native intent instead of converting an unrelated permanent error into legacy failure cleanup', async () => {
  const state: any = { ...initialState('2026-11-01T00:00:00Z'), executionAuthority: {
    auditId: 'synthetic-flow', executionId: 'synthetic-flow', epoch: 0, runtimeDigest: await sha256(null),
  } }
  const definition = { stages: [{ id: 'discovery', kind: 'discovery' }] }
  const fail = vi.fn(), cleanup = vi.fn(), persist = vi.fn(async () => {})
  const instance = workflow({
    RunMachine: { fromState: async () => ({ definition, view: () => state, fail }) },
    RunCommandJournal: class { async atRevision() { return { status: 'applying', source: { authority: state.executionAuthority },
      nativeEffect: { kind: 'revoke-admission' } } } },
    reconcileRunControls: async () => true,
    advanceExperimentOneWave: async () => { throw new PermanentRunFailure('synthetic callback failure', 'integrity-failed') },
  })
  instance.cleanupTerminalWorkspaces = cleanup
  const store = { executionSources: () => async () => { throw new Error('unexpected historical source read') }, getState: async () => state, getRelease: async () => ({ body: { definition } }), putState: persist }
  await expect(instance.runOneWave({ runId: state.runId }, state.cursor, store)).rejects.toMatchObject({ retryable: true })
  expect(fail).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
  await expect(instance.recordTerminalFailure(state.runId, store, new PermanentRunFailure('synthetic platform failure', 'integrity-failed')))
    .rejects.toThrow('terminal failure and cleanup both failed')
  expect(fail).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
})


it('retries terminal cleanup when a wave retry reads an already persisted stopped state', async () => {
  const state: any = { ...initialState('2026-11-01T00:00:00Z'), status: 'stopped' }
  const instance = workflow({})
  const cleanup = vi.fn().mockRejectedValueOnce(new TransientRunFailure('ACK outage')).mockResolvedValue(state)
  instance.cleanupPersistedTerminal = cleanup
  const store = { executionSources: () => async () => { throw new Error('unexpected historical source read') }, getState: async () => state }
  await expect(instance.runOneWave({ runId: state.runId }, state.cursor, store)).rejects.toThrow('ACK outage')
  await expect(instance.runOneWave({ runId: state.runId }, state.cursor, store)).resolves.toEqual(state)
  expect(cleanup).toHaveBeenCalledTimes(2)
})

it('keeps polling stopped-state cleanup after wave and recovery retries exhaust instead of reporting success', async () => {
  const running: any = { ...initialState('2026-11-01T00:00:00Z'), status: 'running' }
  const stopped = { ...running, status: 'stopped', terminalReason: 'operator cancellation' }
  const store = { executionSources: () => async () => { throw new Error('unexpected historical source read') }, getState: async () => stopped }
  const instance = workflow({ CloudflareRunStore: class { constructor() { return store } } })
  const cleanup = vi.fn().mockRejectedValueOnce(new TransientRunFailure('ACK outage'))
    .mockRejectedValueOnce(new TransientRunFailure('ACK outage')).mockResolvedValue(stopped)
  instance.cleanupPersistedTerminal = cleanup
  const steps: string[] = []
  const step = {
    do: async (name: string, _config: unknown, callback: () => Promise<unknown>) => {
      steps.push(name)
      if (name === 'initialize-index') return { ready: true }
      if (name === 'bootstrap-run') return running
      if (name.startsWith('advance-or-poll-')) {
        if (name === 'advance-or-poll-0') throw new TransientRunFailure('wave retries exhausted')
        return callback()
      }
      return callback()
    }, sleep: vi.fn(async () => {}),
  }
  await expect(instance.run({ payload: { runId: running.runId } }, step)).resolves.toMatchObject({ status: 'stopped' })
  expect(steps).toContain('recover-wave-state-0')
  expect(steps).toContain('recover-wave-state-1')
  expect(steps).toContain('reconcile-stopped-workspaces')
  expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(3)
  expect(step.sleep).toHaveBeenCalled()
})

it.each(['created', 'running'] as const)('terminal cleanup leaves %s work untouched', async status => {
  const state = { ...initialState('2026-11-01T00:00:00Z'), status }
  const instance = workflow({}), cleanup = vi.fn(), getRelease = vi.fn()
  instance.cleanupTerminalWorkspaces = cleanup
  await expect(instance.cleanupPersistedTerminal(state.runId, { getState: async () => state, getRelease }))
    .resolves.toMatchObject({ status })
  expect(getRelease).not.toHaveBeenCalled(); expect(cleanup).not.toHaveBeenCalled()
})
