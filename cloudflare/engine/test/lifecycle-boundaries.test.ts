import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { getSandbox } from '@cloudflare/sandbox'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { AgentExecutionReceiptIntegrityError } from '../src/agent-execution-receipt.js'
import { executionLaunchGraceMs, SandboxAgentProvider } from '../src/sandbox-provider.js'
import { disposeTerminalWorkspaces } from '../src/runner.js'
import {
  AgentExecutionPending, isPermanentRunFailure, PermanentRunFailure, TransientRunFailure,
} from '../src/run-errors.js'
import { sameRuntimeRelease } from '../src/runtime-release.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import {
  canStopAtSealedWaveBoundary, workflowProgress, workflowFailureDisposition, failureForWorkflowProgress,
} from '../src/workflow-outcome.js'
import { agentProcessWaitSliceMs, waveStepConfig, workflowBootstrapProgress } from '../src/workflow-step-config.js'

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))
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
  const sandbox = { setKeepAlive } as any
  vi.mocked(getSandbox).mockReturnValueOnce(sandbox)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, {
    executionReceipts: { get: async () => null },
    observationCooldowns: { get: async () => null },
    observationHealth: { get: async () => null },
    runInSandbox: async () => {
      throw new AgentExecutionPending('synthetic-process', 'unfinished')
    },
  })
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    stage: { id: 'discovery' }, wave: { id: 'wave-0' }, promptDigest: 'a'.repeat(64),
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'research', output: { requiredFiles: [] } },
  }
  await expect(provider.run(request as any)).rejects.toMatchObject({ name: 'AgentExecutionPending' })
  expect(getSandbox).toHaveBeenCalledWith(undefined, expect.any(String), expect.objectContaining({
    keepAlive: true,
    sleepAfter: '30m',
  }))
  expect(setKeepAlive).toHaveBeenCalledWith(true)
})

it('recovers an exact successful durable receipt without waiting for Sandbox keep-alive', async () => {
  const setKeepAlive = vi.fn(() => new Promise<void>(() => {}))
  vi.mocked(getSandbox).mockClear()
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
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    stage: { id: 'reporting' }, wave: { id: 'wave-0' }, promptDigest: 'a'.repeat(64),
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'reporting', output: { requiredFiles: [] } },
    visibleArtifacts: [],
  }
  await expect(provider.run(request as any)).resolves.toMatchObject({ status: 'accepted', actorId: 'durable' })
  expect(setKeepAlive).not.toHaveBeenCalled()
  expect(getSandbox).not.toHaveBeenCalled()
  expect(runInSandbox).not.toHaveBeenCalled()
})

it('keeps Sandbox lifetime confirmation for a nonzero receipt that may need native custody', async () => {
  const setKeepAlive = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValueOnce({ setKeepAlive } as any)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  const result = { status: 'additive-unavailable' }
  const runInSandbox = vi.fn(async () => result)
  Object.assign(provider, {
    executionReceipts: { get: async () => ({ exitCode: 1 }) },
    observationHealth: { get: async () => null }, runInSandbox,
  })
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    stage: { id: 'discovery' }, wave: { id: 'wave-0' }, promptDigest: 'a'.repeat(64),
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'research', output: { requiredFiles: [] } },
  }
  await expect(provider.run(request as any)).resolves.toBe(result)
  expect(setKeepAlive).toHaveBeenCalledWith(true)
  expect(runInSandbox).toHaveBeenCalledOnce()
})

it('classifies a durable receipt read outage before container access or paid repair', async () => {
  vi.mocked(getSandbox).mockClear()
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, { executionReceipts: { get: async () => { throw new Error('R2 unavailable') } } })
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'research', output: { requiredFiles: [] } },
  }
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'TransientRunFailure', message: 'durable execution receipt observation is temporarily unavailable',
  })
  expect(getSandbox).not.toHaveBeenCalled()
})

it('keeps a corrupt durable receipt in the integrity-failure category', async () => {
  vi.mocked(getSandbox).mockClear()
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, { executionReceipts: { get: async () => {
    throw new AgentExecutionReceiptIntegrityError('agent execution receipt provenance mismatch')
  } } })
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'research', output: { requiredFiles: [] } },
  }
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'PermanentRunFailure', category: 'integrity-failed',
  })
  expect(getSandbox).not.toHaveBeenCalled()
})

it('disables keep-alive before terminal workspace destruction', async () => {
  const setKeepAlive = vi.fn(async () => {})
  const destroy = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValueOnce({ setKeepAlive, destroy } as any)
  const provider = new SandboxAgentProvider({} as any)
  await expect(provider.disposeWorkspace({ runId: 'terminal', workspaceKey: 'lane' }))
    .resolves.toMatchObject({ status: 'destroyed' })
  expect(getSandbox).toHaveBeenLastCalledWith(undefined, expect.any(String), expect.objectContaining({
    keepAlive: false,
    sleepAfter: '30m',
  }))
  expect(setKeepAlive).toHaveBeenCalledWith(false)
  expect(destroy).toHaveBeenCalledOnce()
})

it('defers terminal disposal when keep-alive stalls and never destroys after a late response', async () => {
  let release!: () => void
  const setKeepAlive = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
  const destroy = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValueOnce({ setKeepAlive, destroy } as any)
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
  vi.mocked(getSandbox).mockReturnValueOnce({
    setKeepAlive: vi.fn(async () => { throw configureError }),
  } as any)
  const provider = new SandboxAgentProvider({ ACK3_CODEX_WORKSPACE_ID: 'synthetic', ACK3_CODEX_AUTH_JSON: '{}' } as any)
  Object.assign(provider, {
    executionReceipts: { get: async () => null }, observationCooldowns: { get: async () => null },
    observationHealth: { get: async () => null }, runInSandbox,
  })
  const request = {
    experimentId: 'synthetic', prompt: 'No model invocation', runId: 'synthetic-flow', attempt: 1,
    stage: { id: 'discovery' }, wave: { id: 'wave-0' }, promptDigest: 'a'.repeat(64),
    task: { id: 'synthetic-task', workspaceKey: 'synthetic-lane', model: 'synthetic', providerClass: 'core',
      reasoning: 'none', promptKind: 'research', output: { requiredFiles: [] } },
  }
  await expect(provider.run(request as any)).rejects.toMatchObject({
    name: 'TransientRunFailure', message: 'Cloudflare Sandbox lifetime configuration failed',
  })
  expect(runInSandbox).not.toHaveBeenCalled()

  const destroy = vi.fn(async () => {})
  vi.mocked(getSandbox).mockReturnValueOnce({
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
    expect(diagnostic).not.toContain('getSandbox')
  }
})

it('disposes evidenced terminal lanes while preserving unresolved owners', async () => {
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'complete', workspaceKey: 'lane-complete' },
    { id: 'failed', workspaceKey: 'lane-failed' },
    { id: 'pending', workspaceKey: 'lane-pending' },
  ] }] }] } as any
  const disposed: string[] = []
  const provider = {
    async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    },
  }
  const state = {
    runId: 'terminal-fixture', status: 'failed',
    artifacts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'complete' }],
    rejectedAttempts: [
      { stageId: 'discovery', waveId: 'wave-0', taskId: 'failed' },
      { stageId: 'discovery', waveId: 'wave-0', taskId: 'pending' },
    ],
    inFlightAgentAttempts: [
      { stageId: 'discovery', waveId: 'wave-0', taskId: 'pending' },
    ],
  } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state)
  expect(disposed).toEqual(['lane-complete', 'lane-failed'])
  expect(cleanup.activeWorkspaceKeys).toEqual(['lane-pending'])

  disposed.length = 0
  await disposeTerminalWorkspaces(provider, definition, {
    ...state, status: 'stopped', inFlightAgentAttempts: [],
  })
  expect(disposed).toEqual(['lane-complete', 'lane-failed', 'lane-pending'])
})

it('force-disposes an in-flight-only owned lane after an immediate terminal fence', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'in-flight', workspaceKey: 'owned-in-flight' },
  ] }] }] } as any
  const state = { runId: 'direct-stop', status: 'stopped', artifacts: [], rejectedAttempts: [],
    inFlightAgentAttempts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'in-flight' }] } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, { forceOwnedWorkspaces: true })
  expect(disposed).toEqual(['owned-in-flight'])
  expect(cleanup.deferred).toEqual([])
})

it('force-disposes an admitted deterministic preflight before it emits an artifact', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'preflight', waves: [{ id: 'identity-tools-baseline', tasks: [
    { id: 'preflight', promptKind: 'preflight', providerClass: 'deterministic', workspaceKey: 'preflight' },
  ] }] }] } as any
  const admitted = { stageId: 'preflight', waveId: 'identity-tools-baseline' }
  const state = { runId: 'preflight-stop', status: 'stopped', artifacts: [], rejectedAttempts: [],
    inFlightAgentAttempts: [], waveAdmission: admitted } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, { forceOwnedWorkspaces: true })
  expect(disposed).toEqual(['preflight'])
  expect(cleanup.activeWorkspaceKeys).toEqual(['preflight'])
  expect(cleanup.deferred).toEqual([])

  disposed.length = 0
  await disposeTerminalWorkspaces(provider, definition, { ...state, status: 'failed' },
    { forceOwnedWorkspaces: true })
  expect(disposed).toEqual(['preflight'])

  disposed.length = 0
  await disposeTerminalWorkspaces(provider, definition, { ...state, waveAdmission: null },
    { forceOwnedWorkspaces: true })
  expect(disposed).toEqual([])

  disposed.length = 0
  await disposeTerminalWorkspaces(provider, definition, { ...state, artifacts: [{
    stageId: 'preflight', waveId: 'identity-tools-baseline', taskId: 'preflight', status: 'accepted',
  }] }, { forceOwnedWorkspaces: true })
  expect(disposed).toEqual(['preflight'])
})

it('does not force-dispose a native lane adopted from a parent run', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-owned' },
  ] }] }] } as any
  const state = { runId: 'child-run', status: 'failed', artifacts: [], rejectedAttempts: [],
    inFlightAgentAttempts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-owned', workspaceAllocationRunId: 'parent-run' } },
  } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, { forceOwnedWorkspaces: true })
  expect(disposed).toEqual([])
  expect(cleanup.workspaceKeys).toEqual([])
})

it('protects a parent-owned lane claimed by a recovery child', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'retained', workspaceKey: 'retained-parent' },
    { id: 'ordinary', workspaceKey: 'owned-unclaimed' },
  ] }] }] } as any
  const state = { runId: 'parent-run', status: 'failed', artifacts: [],
    rejectedAttempts: [
      { stageId: 'discovery', waveId: 'wave-0', taskId: 'retained' },
      { stageId: 'discovery', waveId: 'wave-0', taskId: 'ordinary' },
    ], inFlightAgentAttempts: [] } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, {
    forceOwnedWorkspaces: true,
    workspaceAllocationForOwner: async key => key === 'retained-parent' ? null : 'parent-run',
  })
  expect(disposed).toEqual(['owned-unclaimed'])
  expect(cleanup.retainedWorkspaceKeys).toEqual(['retained-parent'])
})

it('cleans a completed child lane through its verified parent allocation', async () => {
  const disposed: Array<{ runId: string, workspaceKey: string }> = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { runId: string, workspaceKey: string }) {
      disposed.push(input)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-lane' },
  ] }] }] } as any
  const state = { runId: 'child-run', status: 'completed',
    artifacts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    rejectedAttempts: [], inFlightAgentAttempts: [],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-lane', workspaceAllocationRunId: 'parent-run' } },
  } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, {
    workspaceAllocationForOwner: async key => key === 'parent-lane' ? 'parent-run' : null,
  })
  expect(disposed).toEqual([{ runId: 'parent-run', workspaceKey: 'parent-lane' }])
  expect(cleanup.deferred).toEqual([])
})

it('blocks completed cleanup proof when a child lacks its parent workspace claim', async () => {
  const disposed: string[] = []
  const provider = { async run() { throw new Error('not used') },
    async disposeWorkspace(input: { workspaceKey: string }) {
      disposed.push(input.workspaceKey)
      return { status: 'destroyed' as const, timeoutMs: 1 }
    } }
  const definition = { stages: [{ id: 'discovery', waves: [{ id: 'wave-0', tasks: [
    { id: 'adopted', workspaceKey: 'parent-lane' },
  ] }] }] } as any
  const state = { runId: 'child-run', status: 'completed',
    artifacts: [{ stageId: 'discovery', waveId: 'wave-0', taskId: 'adopted' }],
    rejectedAttempts: [], inFlightAgentAttempts: [],
    failedWaveRecovery: { retainedNative: { workspaceKey: 'parent-lane', workspaceAllocationRunId: 'parent-run' } },
  } as any
  const cleanup = await disposeTerminalWorkspaces(provider, definition, state, {
    workspaceAllocationForOwner: async () => null,
  })
  expect(disposed).toEqual([])
  expect(cleanup.workspaceKeys).toEqual([])
  expect(cleanup.retainedWorkspaceKeys).toEqual(['parent-lane'])
})

function workflow(overrides: Record<string, unknown>) {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(
    source.indexOf('export class AuditWorkflow'), source.indexOf('async function forwardCoordinator'),
  ).replace('export class', 'class'))
  class NonRetryableError extends Error {}
  const deps = {
    WorkflowEntrypoint: class { env = {} }, CloudflareRunStore: class {},
    waveStepConfig, workflowBootstrapProgress, workflowProgress,
    workflowFailureDisposition, failureForWorkflowProgress, canStopAtSealedWaveBoundary, isPermanentRunFailure,
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

it('persists a sealed-boundary stop before terminal lane cleanup', async () => {
  let durable: any = {
    ...initialState('2026-09-26T10:00:00.000Z'), status: 'running', waveAdmission: null,
    inFlightAgentAttempts: [],
  }
  let loseAcknowledgement = true
  const order: string[] = []
  let machineState = structuredClone(durable)
  const machine = { stop: async () => {
    order.push('stop')
    machineState = {
      ...machineState, status: 'stopped', terminalReason: 'operator-requested-stop-at-sealed-wave-boundary',
    }
  }, snapshot: () => structuredClone(machineState) }
  const instance = workflow({
    RunMachine: { fromState: async () => machine },
    disposeTerminalWorkspaces: async (_provider: unknown, _definition: unknown, state: { status: string }) => {
      expect(state.status).toBe('stopped')
      order.push('dispose')
      return { mode: 'provider-attempted', workspaceKeys: ['lane'], activeWorkspaceKeys: [], deferred: [] }
    },
  })
  const store = {
    getState: async () => structuredClone(durable),
    stopRequested: async () => true,
    getRelease: async () => ({ body: { definition: { stages: [] } } }),
    putState: async (state: typeof durable) => {
      expect(state.status).toBe('stopped')
      durable = structuredClone(state)
      order.push('persist')
      if (loseAcknowledgement) {
        loseAcknowledgement = false
        throw new Error('synthetic lost acknowledgement after commit')
      }
    },
  }
  await expect(instance.stopAtBoundary('terminal-fixture', store)).rejects.toThrow('lost acknowledgement')
  expect(order).toEqual(['stop', 'persist'])
  await expect(instance.stopAtBoundary('terminal-fixture', store)).resolves.toMatchObject({ status: 'stopped' })
  expect(order).toEqual(['stop', 'persist', 'dispose'])
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

it('adopts an identical committed bootstrap after its write acknowledgement is lost', async () => {
  const persisted = initialState('2026-09-25T10:00:00.000Z')
  let durable: typeof persisted | null = null
  let creations = 0
  const machine = (state: typeof persisted) => ({
    start: async () => {}, snapshot: () => structuredClone(state),
  })
  const RunMachine = {
    create: async () => { creations += 1; return machine(persisted) },
    fromState: async (_definition: unknown, state: typeof persisted) => machine(state),
  }
  const store = {
    getRelease: async () => ({ digest: 'a'.repeat(64), body: { definition: { id: 'synthetic' } } }),
    getStateIfPresent: async () => durable === null ? null : structuredClone(durable),
    putState: async (state: typeof persisted) => { durable = structuredClone(state) },
  }
  const instance = workflow({ RunMachine })
  const payload = {
    mode: 'start', experimentId: 'synthetic', runId: 'synthetic-flow', releaseDigest: 'a'.repeat(64),
  }

  const first = await instance.bootstrap(payload, store)
  await first.start()
  await store.putState(first.snapshot())
  const adopted = await instance.bootstrap(payload, store)

  expect(adopted.snapshot()).toEqual(persisted)
  expect(creations).toBe(1)
})

it('adopts the same committed resume bootstrap without rebuilding its child lineage', async () => {
  const checkpointDigest = 'b'.repeat(64)
  const persisted = {
    ...initialState('2026-09-25T10:00:00.000Z'),
    runId: 'synthetic-child', rootRunId: 'synthetic-root', rootCreatedAt: '2026-09-24T10:00:00.000Z',
    recoveryEpoch: 2, parentRunId: 'synthetic-parent', parentCheckpointDigest: checkpointDigest,
  }
  const resume = vi.fn()
  const fromState = vi.fn(async (_definition: unknown, state: typeof persisted) => ({
    snapshot: () => structuredClone(state),
  }))
  const store = {
    getCheckpoint: async () => ({ digest: checkpointDigest, body: {
      releaseDigest: 'a'.repeat(64), experimentId: 'synthetic', rootRunId: 'synthetic-root',
      recoveryEpoch: 1, runId: 'synthetic-parent', rootCreatedAt: persisted.rootCreatedAt, modelStartedAt: null,
    } }),
    getRelease: async () => ({ digest: 'a'.repeat(64), body: { definition: { id: 'synthetic' } } }),
    getStateIfPresent: async () => structuredClone(persisted),
  }
  const instance = workflow({ RunMachine: { fromState, resume } })
  const adopted = await instance.bootstrap({
    mode: 'resume', experimentId: 'synthetic', runId: 'synthetic-child', checkpointDigest,
  }, store)

  expect(adopted.snapshot()).toEqual(persisted)
  expect(fromState).toHaveBeenCalledOnce()
  expect(resume).not.toHaveBeenCalled()
})

it('publishes every checkpoint before committing its advanced cursor', async () => {
  let durable = initialState('2026-09-25T10:00:00.000Z')
  let publishCalls = 0
  let waveCalls = 0
  const store = {
    getState: async () => structuredClone(durable),
    getRelease: async () => ({ body: { definition: { stages: [{}, {}] } } }),
    putState: async (state: typeof durable) => { durable = structuredClone(state) },
    putCheckpoint: async () => {
      publishCalls += 1
      if (publishCalls === 1) throw new Error('temporary R2 unavailable')
    },
  }
  const instance = workflow({
    RunMachine: { fromState: async (_definition: unknown, state: typeof durable) => ({
      value: state,
      snapshot() { return structuredClone(this.value) },
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
  const request = {
    prompt: 'Synthetic fixture, no model invocation', runId: 'synthetic-flow', attempt: 1,
    task: { id: 'synthetic-task', model: 'synthetic', providerClass: 'core', reasoning: 'none',
      promptKind: 'research', output: { requiredFiles: [] } },
    continuationMode: 'new', sessionId: null, releaseDigest: 'a'.repeat(64),
    visibleArtifacts: [], repairFiles: {}, diagnostics: [],
  }

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
    executionReceipts: { claimStart: vi.fn(async () => ({ acquired: false, claimedAt: '2026-09-26T12:00:00.000Z' })) },
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
  const request = {
    prompt: 'Synthetic coordination fixture, no model calls', runId: 'synthetic-flow', attempt: 1,
    task: { id: 'synthetic-task', model: 'synthetic', providerClass: 'core', reasoning: 'none',
      promptKind: 'research', output: { requiredFiles: ['result.txt'] } },
    continuationMode: 'new', sessionId: null, releaseDigest: 'a'.repeat(64),
    visibleArtifacts: [], repairFiles: {}, diagnostics: [],
  }
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
  const request = {
    prompt: 'Synthetic fencing fixture, no model calls', runId: 'synthetic-flow', attempt: 1,
    task: { id: 'synthetic-task', model: 'synthetic', providerClass: 'core', reasoning: 'none',
      promptKind: 'research', output: { requiredFiles: ['result.txt'] } },
    continuationMode: 'new', sessionId: null, releaseDigest: 'a'.repeat(64),
    visibleArtifacts: [], repairFiles: {}, diagnostics: [],
  }
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
