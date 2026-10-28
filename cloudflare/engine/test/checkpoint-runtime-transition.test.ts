import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { RunState, RuntimeRelease } from '../src/contracts.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { prepareCheckpointRuntimeTransition } from '../src/checkpoint-runtime-transition.js'
import { PermanentRunFailure } from '../src/run-errors.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import { assertReleaseProviderCredentials } from '../src/release-provider-credentials.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { sealReleasePackage } from '../src/release.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { placement } from '../src/placement.js'

const runtimeA: RuntimeRelease = { schemaVersion: 1, id: 'runtime-a', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-a', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-a', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const runtimeB: RuntimeRelease = { ...runtimeA, id: 'runtime-b', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-b', workerVersionId: '22222222-2222-4222-8222-222222222222', workflowName: 'audit-b' }

async function fixture() {
  const release = await sealReleasePackage(audit0PackageBody), definition = release.body.definition
  let machine = await RunMachine.create(definition, release.digest, 'upgrade-source', undefined, runtimeA)
  const artifactStore = new MemoryArtifactStore(), provider = new DeterministicAuditProvider()
  while (definition.stages[machine.snapshot().cursor.stageIndex]?.kind !== 'reporting') {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore })
  }
  // Sanitized historical recovery, structurally valid and preserved as ancestry.
  machine = await RunMachine.fromState(definition, { ...machine.snapshot(), failedWaveRecovery: {
    sourceRunId: 'historical-source', sourceStateGeneration: 9, sourceStateDigest: 'c'.repeat(64),
    checkpointDigest: 'd'.repeat(64), sourceRuntimeRelease: runtimeB, targetRuntimeRelease: runtimeA,
    importedTaskIds: ['historical-peer'], inheritedRejectedAttemptCount: 0, unknownUsageAttemptCount: 0,
  } })
  const checkpoint = await machine.seal()
  await machine.stop('operator-runtime-upgrade-at-sealed-checkpoint')
  const source = machine.snapshot()
  const input = { definition, checkpoint, source, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: runtimeB }
  const evidence = await prepareCheckpointRuntimeTransition(input)
  return { ...input, evidence, release, artifactStore }
}

describe('stopped checkpoint runtime transition', () => {
  it('preserves prior work and clocks, executes only reporting, and seals resumable historical evidence', async () => {
    const f = await fixture(), original = canonicalJson(f.source)
    const child = await RunMachine.resume(f.definition, f.checkpoint, 'upgrade-child', new Set(),
      undefined, undefined, runtimeB, f.evidence, f.source)
    const state = child.snapshot()
    expect(state.runtimeRelease).toEqual(runtimeB)
    expect(state.runtimeTransition).toEqual(f.evidence)
    expect(state.failedWaveRecovery).toEqual(f.source.failedWaveRecovery)
    for (const key of ['artifacts', 'rejectedAttempts', 'budget', 'modelStartedAt', 'rootCreatedAt',
      'waveReceipts', 'stageEndReceipts', 'availabilityBoundaries'] as const) expect(state[key]).toEqual(f.source[key])
    await expect(RunMachine.fromState(f.definition, state)).resolves.toBeDefined()
    const provider = new DeterministicAuditProvider(), run = vi.fn(provider.run.bind(provider))
    const outcome = await runExperiment({ definition: f.definition, machine: child, provider: { run }, artifactStore: f.artifactStore })
    expect(run.mock.calls.map(([request]) => request.task.id)).toEqual(['reporter', 'seal-final'])
    expect(run.mock.calls.filter(([request]) => request.task.providerClass !== 'deterministic').map(([request]) => request.task.id)).toEqual(['reporter'])
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.checkpoints.at(-1)?.body.runtimeTransition).toEqual(f.evidence)
    await expect(RunMachine.resume(f.definition, outcome.state.checkpoints.at(-1)!, 'ordinary-child',
      new Set(), undefined, undefined, runtimeB)).resolves.toBeDefined()
    expect(canonicalJson(f.source)).toBe(original)
  })

  it('keeps ordinary resumes pinned and rejects implicit upgrades and duplicate child identities', async () => {
    const f = await fixture()
    await expect(RunMachine.resume(f.definition, f.checkpoint, 'implicit-child', new Set(),
      undefined, undefined, runtimeB)).rejects.toThrow('runtime release mismatch')
    await expect(RunMachine.resume(f.definition, f.checkpoint, f.source.runId, new Set(),
      undefined, undefined, runtimeB, f.evidence, f.source)).rejects.toThrow('fresh child')
    await expect(RunMachine.resume(f.definition, f.checkpoint, 'duplicate', new Set(['duplicate']),
      undefined, undefined, runtimeB, f.evidence, f.source)).rejects.toThrow('already exists')
    expect((await RunMachine.resume(f.definition, f.checkpoint, 'ordinary')).snapshot().runtimeRelease).toEqual(runtimeA)
  })

  it('rejects newer source state, admissions, wrong ownership, nonlatest checkpoints and altered frontier', async () => {
    const f = await fixture()
    const mutations: Array<(source: RunState) => RunState> = [
      s => ({ ...s, stateGeneration: s.stateGeneration + 1 }),
      s => ({ ...s, status: 'running' }),
      s => ({ ...s, inFlightAgentAttempts: [{} as never] }),
      s => ({ ...s, waveAdmission: {} as never }),
      s => ({ ...s, runtimeRelease: runtimeB }),
      s => ({ ...s, checkpoints: [] }),
      s => ({ ...s, artifacts: [] }),
      s => ({ ...s, modelStartedAt: '2026-01-01T00:00:00.000Z' }),
    ]
    for (const mutate of mutations) await expect(prepareCheckpointRuntimeTransition({ ...f, source: mutate(f.source) }))
      .rejects.toThrow('exact stopped sealed source')
    const changed = { ...f.source, budget: { ...f.source.budget, outputTokens: f.source.budget.outputTokens + 1 } }
    await expect(prepareCheckpointRuntimeTransition({ ...f, source: changed, sourceStateDigest: await sha256(changed) }))
      .rejects.toThrow('sealed frontier')
    await expect(RunMachine.resume(f.definition, f.checkpoint, 'wrong-source-owner', new Set(), undefined,
      undefined, runtimeB, { ...f.evidence, sourceRuntimeRelease: runtimeB }, f.source)).rejects.toThrow('evidence mismatch')
  })

  it('does not let an upgrade excuse tampered inherited recovery evidence', async () => {
    const f = await fixture(), child = await RunMachine.resume(f.definition, f.checkpoint, 'history-child',
      new Set(), undefined, undefined, runtimeB, f.evidence, f.source)
    const state = child.snapshot()
    await expect(RunMachine.fromState(f.definition, { ...state,
      failedWaveRecovery: { ...state.failedWaveRecovery!, inheritedRejectedAttemptCount: 1 },
    })).rejects.toThrow('inherited evidence mismatch')
    await expect(RunMachine.resume(f.definition, f.checkpoint, 'wrong-target', new Set(), undefined,
      undefined, runtimeB, { ...f.evidence, targetRuntimeRelease: runtimeA }, f.source)).rejects.toThrow('evidence mismatch')
  })

  it('revalidates the exact original source before a retried bootstrap even when child state exists', async () => {
    const f = await fixture(), child = await RunMachine.resume(f.definition, f.checkpoint, 'bootstrap-child',
      new Set(), undefined, undefined, runtimeB, f.evidence, f.source)
    const text = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    const code = stripTypeScriptTypes(text.slice(text.indexOf('export class AuditWorkflow'),
      text.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
    const Workflow = new Function('WorkflowEntrypoint', 'RunMachine', 'engineRole', 'assertLocalRuntime',
      'runIdPattern', 'digestPattern', 'sameRuntimeRelease', 'canonicalJson', 'PermanentRunFailure',
      'assertReleaseEnvironmentMatchesRuntime',
      `${code}; return AuditWorkflow;`)(class { env = {} }, RunMachine, () => 'runtime', () => runtimeB,
      /^[a-z0-9][a-z0-9._-]{0,99}$/, /^[a-f0-9]{64}$/, (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
      canonicalJson, PermanentRunFailure, assertReleaseEnvironmentMatchesRuntime)
    let source = f.source
    const store = { getCheckpoint: async () => f.checkpoint, getRelease: async () => f.release,
      getStateIfPresent: async () => child.snapshot(), getState: async () => source }
    const payload = { mode: 'resume', experimentId: f.definition.id, runId: 'bootstrap-child',
      checkpointDigest: f.checkpoint.digest, runtimeRelease: runtimeB, runtimeTransition: f.evidence }
    await expect(new Workflow().bootstrap(payload, store)).resolves.toBeDefined()
    source = { ...source, stateGeneration: source.stateGeneration + 1 }
    await expect(new Workflow().bootstrap(payload, store)).rejects.toThrow('exact stopped sealed source')
  })

  it('rechecks the stopped source at the runtime dispatch boundary and refuses drift without a Workflow', async () => {
    const f = await fixture()
    const text = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
    const code = stripTypeScriptTypes(text.slice(text.indexOf('async function createAuditResume'),
      text.indexOf('async function createAuditFailedWaveRecovery')))
    let source = f.source
    class Store {
      runRuntime = async () => runtimeB
      checkpointRuntime = async () => runtimeA
      getCheckpoint = async () => f.checkpoint
      getRelease = async () => f.release
      getState = async () => source
    }
    const dispatch = vi.fn(async (_env: unknown, _payload: unknown) => ({ id: 'runtime-child', reused: false }))
    const route = new Function('CloudflareRunStore', 'assertLocalRuntime', 'sameRuntimeRelease', 'RunMachine',
      'resolveTargetEnvironment', 'ensureAuditWorkflow', 'response', 'runIdPattern', 'assertReleaseEnvironmentMatchesRuntime',
      'assertReleaseProviderCredentials', 'placement',
      `${code}; return createAuditResume;`)(Store, () => runtimeB,
      (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b), RunMachine, () => ({}), dispatch,
      (_env: unknown, body: unknown, status: number) => Response.json(body, { status }),
      /^[a-z0-9][a-z0-9._-]{0,99}$/, assertReleaseEnvironmentMatchesRuntime, assertReleaseProviderCredentials, placement)
    const request = () => new Request('https://runtime.internal/internal/runtime/audit-resumes', {
      method: 'POST', body: JSON.stringify({ experimentId: f.definition.id, childRunId: 'runtime-child',
        checkpointDigest: f.checkpoint.digest, runtimeRelease: runtimeB, runtimeTransition: f.evidence }),
    })
    const env = { ACK3_CODEX_AUTH_JSON: 'test-auth', ACK3_CODEX_WORKSPACE_ID: 'test-workspace',
      PROVIDER_A_API_KEY: 'test-key' }
    source = { ...source, stateGeneration: source.stateGeneration + 1 }
    await expect(route(request(), env)).rejects.toThrow('exact stopped sealed source')
    expect(dispatch).not.toHaveBeenCalled()
    source = f.source
    expect((await route(request(), env)).status).toBe(202)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![1]).toMatchObject({ runtimeTransition: f.evidence })
  })
})
