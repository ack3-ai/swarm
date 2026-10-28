import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProvider, RunState, RuntimeRelease } from '../src/contracts.js'
import { sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { createAudit0RunPolicy } from '../src/runner.js'
import { prepareTerminalCompletionRecovery } from '../src/terminal-completion-recovery.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { sealReleasePackage } from '../src/release.js'
import { assertReleaseProviderCredentials } from '../src/release-provider-credentials.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { placement } from '../src/placement.js'

const sourceRuntime: RuntimeRelease = {
  schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source', containerImageDigest: `sha256:${'a'.repeat(64)}`,
}
const targetRuntime: RuntimeRelease = {
  ...sourceRuntime, id: 'runtime-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'audit-runtime-target',
}

async function fixture() {
  const definition = structuredClone(audit0Definition)
  definition.limits.maxCostUsd = 2
  const release = await sealReleasePackage({ ...audit0PackageBody, definition })
  const machine = await RunMachine.create(definition, release.digest, 'terminal-source', undefined, sourceRuntime)
  const base = new DeterministicAuditProvider()
  const provider: AgentProvider = {
    async run(request) {
      const result = await base.run(request)
      return { ...result, costUsd: request.stage.kind === 'discovery' ? 0.25 : 0 }
    },
  }
  const artifactStore = new MemoryArtifactStore()
  const completed = (await runExperiment({
    definition, machine, provider, artifactStore, policy: createAudit0RunPolicy(),
  })).state
  const finalStage = definition.stages.at(-1)!
  const finalWave = finalStage.waves.at(-1)!
  const checkpoint = completed.checkpoints.find(candidate => (
    candidate.body.cursor.stageIndex === definition.stages.length - 1
      && candidate.body.cursor.waveIndex === finalStage.waves.length - 1
      && !candidate.body.acceptedArtifacts.some(artifact => artifact.taskId === finalWave.tasks[0]!.id)
  ))!
  expect(checkpoint).toBeDefined()
  const source: RunState = {
    ...structuredClone(completed),
    status: 'failed', phase: 'reporting', cursor: structuredClone(checkpoint.body.cursor),
    stageEndReceipts: structuredClone(checkpoint.body.stageEndReceipts),
    terminalReason: 'completion contract failed: no post-map research wave is present',
  }
  const sourceStateDigest = await sha256(source)
  return { definition, checkpoint, source, sourceStateDigest, artifactStore }
}

describe('terminal completion recovery', () => {
  it('does not require retired model keys for the exact all-deterministic terminal route', async () => {
    const value = await fixture()
    const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function createAuditTerminalCompletionRecovery(')
    const end = source.indexOf('async function auditRunStatus(', start)
    const code = stripTypeScriptTypes(source.slice(start, end))
    const ensureAuditWorkflow = vi.fn(async () => ({ id: 'terminal-child', reused: false }))
    const handler = new Function(
      'runIdPattern', 'response', 'assertLocalRuntime', 'CloudflareRunStore', 'sameRuntimeRelease',
      'assertReleaseEnvironmentMatchesRuntime', 'resolveTargetEnvironment',
      'assertReleaseProviderCredentials', 'prepareTerminalCompletionRecovery',
      'RunMachine', 'ensureAuditWorkflow', 'placement',
      `${code}; return createAuditTerminalCompletionRecovery;`,
    )(
      /^[a-z0-9][a-z0-9._-]{0,99}$/,
      (_env: unknown, body: unknown, status: number) => ({ body, status }),
      () => targetRuntime,
      class {
        async runRuntime() { return targetRuntime }
        async getState() { return value.source }
        async getCheckpoint() { return value.checkpoint }
        async getRelease() { return { body: { definition: value.definition } } }
      },
      () => true, () => {}, () => {}, assertReleaseProviderCredentials,
      prepareTerminalCompletionRecovery, RunMachine, ensureAuditWorkflow, placement,
    ) as (request: { json(): Promise<unknown> }, env: unknown) => Promise<{ status: number }>
    const result = await handler({ json: async () => ({
      experimentId: value.definition.id, childRunId: 'terminal-child', sourceRunId: value.source.runId,
      sourceStateGeneration: value.source.stateGeneration, sourceStateDigest: value.sourceStateDigest,
      checkpointDigest: value.checkpoint.digest, runtimeRelease: targetRuntime,
    }) }, {})
    expect(result.status).toBe(202)
    expect(ensureAuditWorkflow).toHaveBeenCalledOnce()
  })

  it('replays only the final deterministic seal and completes with zero provider calls', async () => {
    const value = await fixture()
    const evidence = await prepareTerminalCompletionRecovery({
      ...value, sourceStateGeneration: value.source.stateGeneration,
      targetRuntimeRelease: targetRuntime,
    })
    const recovered = await RunMachine.recoverTerminalCompletion(
      value.definition, value.checkpoint, value.source, 'terminal-child', evidence,
    )
    const deterministic = new DeterministicAuditProvider()
    const modelCalls = vi.fn(async () => { throw new Error('model provider must not be called') })
    const run = vi.fn(async (request) => request.task.providerClass === 'deterministic'
      ? deterministic.run(request) : modelCalls())
    const outcome = await runExperiment({
      definition: value.definition, machine: recovered, provider: { run },
      artifactStore: value.artifactStore, policy: createAudit0RunPolicy(),
    })
    expect(modelCalls).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0].task.id).toBe('seal-final')
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.parentRunId).toBe(value.source.runId)
    expect(outcome.state.terminalCompletionRecovery).toEqual(evidence)
    expect(outcome.state.stageEndReceipts.find(receipt => receipt.stageIndex === 1)?.reason)
      .toBe('measured-budget-inability')
  })

  it('rejects drift, admission, unrelated failures, unowned checkpoints, and later paid work', async () => {
    const value = await fixture()
    const prepare = async (source: RunState, definition = value.definition) => prepareTerminalCompletionRecovery({
      definition, checkpoint: value.checkpoint, source,
      sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
      targetRuntimeRelease: targetRuntime,
    })
    await expect(prepareTerminalCompletionRecovery({
      definition: value.definition, checkpoint: value.checkpoint, source: value.source,
      sourceStateGeneration: value.source.stateGeneration + 1, sourceStateDigest: value.sourceStateDigest,
      targetRuntimeRelease: targetRuntime,
    })).rejects.toThrow('exact post-seal completion failure')
    await expect(prepare({ ...value.source, waveAdmission: {
      stageId: 'reporting', waveId: 'seal', cursor: value.source.cursor, admittedAt: new Date().toISOString(),
    } })).rejects.toThrow('exact post-seal completion failure')
    await expect(prepare({ ...value.source, terminalReason: 'provider failed' }))
      .rejects.toThrow('exact post-seal completion failure')
    await expect(prepare({ ...value.source, checkpoints: [], parentCheckpointDigest: null }))
      .rejects.toThrow('exact post-seal completion failure')
    const laterPaid = structuredClone(value.definition)
    laterPaid.stages = [...laterPaid.stages, { ...laterPaid.stages.at(-1)!, id: 'later', kind: 'verification' }]
    const alteredSource = { ...value.source, definitionDigest: await sha256(laterPaid) }
    await expect(prepare(alteredSource, laterPaid)).rejects.toThrow('final all-deterministic path')
    await expect(RunMachine.resume(
      value.definition, value.checkpoint, 'ordinary-cross-runtime', new Set(),
      new Date().toISOString(), undefined, targetRuntime,
    )).rejects.toThrow('resume runtime release mismatch')
  })
})
