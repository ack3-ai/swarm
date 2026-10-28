import { describe, expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { AgentProvider, AgentRequest, NativeTransportEvidence } from '../src/contracts.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave, createAudit0RunPolicy, disposeTerminalWorkspaces } from '../src/runner.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { sealReleasePackage } from '../src/release.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { sha256 } from '../src/canonical.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { instruction } from './support/instructions.js'

const startedAt = '2026-09-30T00:00:00.000Z'

function requiredReview() {
  const manifest = structuredClone(document) as any
  manifest.maxDiscoveryWaves = 4
  manifest.modelPools = manifest.modelPools.map((pool: any) => ({
    ...pool, agents: pool.id === 'luna' ? 3 : 1,
  }))
  return compileExperimentConfig(manifest)
}

function transport(request: AgentRequest, workState: NativeTransportEvidence['workState']): AgentAttemptFailure {
  return new AgentAttemptFailure('synthetic native transport failure', {
    includeDiagnosticsInRepair: false,
    nativeTransport: {
      code: 'TRANSPORT', sourceRunId: request.runId, requestDigest: 'a'.repeat(64),
      sessionId: 'session-11111111-1111-4111-8111-111111111111',
      snapshotDigest: 'b'.repeat(64), workState,
    },
  })
}

describe('required additive negative review', () => {
  it('resumes one failed native reviewer in its exact source allocation while importing the accepted peer', async () => {
    const body = requiredReview(), release = await sealReleasePackage(body)
    const sourceRuntime = { schemaVersion: 1 as const, id: 'runtime-retained-review',
      frameworkCommit: 'a'.repeat(40), workerService: 'runtime-retained-review',
      workerVersionId: '11111111-1111-4111-8111-111111111111',
      workflowName: 'audit-retained-review', containerImageDigest: `sha256:${'a'.repeat(64)}` }
    const targetRuntime = { ...sourceRuntime, frameworkCommit: 'b'.repeat(40),
      workerVersionId: '22222222-2222-4222-8222-222222222222' }
    const sourceRunId = 'retained-review-source'
    const machine = await RunMachine.create(body.definition, release.digest, sourceRunId, startedAt, sourceRuntime)
    const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
    await expect(runExperiment({ definition: body.definition, machine, artifactStore: store,
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
      provider: { async run(request) {
        if (request.task.id !== 'negative-review-replica') return base.run(request)
        throw new AgentAttemptFailure('synthetic server outage', {
          includeDiagnosticsInRepair: false,
          nativeTransport: { code: 'SERVER', sourceRunId, requestDigest: String(request.attempt).repeat(64),
            sessionId: 'session-11111111-1111-4111-8111-111111111111',
            snapshotDigest: String(request.attempt + 2).repeat(64), workState: 'present' },
        })
      } },
    })).rejects.toThrow('negative-review-replica')
    const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
    const latest = source.rejectedAttempts.filter(value => value.taskId === 'negative-review-replica').at(-1)!
    const native = latest.nativeTransport!
    const selection = { taskId: 'negative-review-replica', requestDigest: native.requestDigest,
      snapshotDigest: native.snapshotDigest, sandboxObjectId: 'c'.repeat(64) }
    const read = { async read(record: { uri: string }) { return JSON.parse(store.contents.get(record.uri)!) } }
    const prepared = await prepareFailedWaveRecovery({ definition: body.definition, checkpoint, source,
      sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
      targetRuntimeRelease: targetRuntime, artifacts: read, retainNative: selection })
    expect(prepared.evidence.retainedNative?.nativeTransport).toEqual(native)
    expect(prepared.importedArtifacts.map(value => value.taskId)).toContain('negative-review-primary')
    await expect(prepareFailedWaveRecovery({ definition: body.definition, checkpoint, source,
      sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
      targetRuntimeRelease: targetRuntime, artifacts: read,
      retainNative: { ...selection, snapshotDigest: 'f'.repeat(64) } })).rejects.toThrow('selection')
    const child = await RunMachine.recoverFailedWave(body.definition, checkpoint, source,
      'retained-review-child', prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
    const reviewerRequests: AgentRequest[] = [], disposals: string[] = []
    const provider: AgentProvider = { async run(request) {
        if (request.task.id === 'negative-review-replica') {
          reviewerRequests.push(request)
          if (request.attempt === 1) {
            throw new AgentAttemptFailure('synthetic child server retry', {
              includeDiagnosticsInRepair: false,
              nativeTransport: { code: 'SERVER', sourceRunId: request.runId,
                requestDigest: 'd'.repeat(64), sessionId: native.sessionId,
                snapshotDigest: 'e'.repeat(64), workState: 'present' },
            })
          }
        }
        return base.run(request)
      }, async disposeWorkspace(input) { disposals.push(`${input.runId}:${input.workspaceKey}`) } }
    await advanceExperimentOneWave({ definition: body.definition, machine: child, artifactStore: store, provider })
    expect(child.snapshot().rejectedAttempts).toHaveLength(source.rejectedAttempts.length + 1)
    await expect(RunMachine.fromState(body.definition, child.snapshot())).resolves.toBeDefined()
    const outcome = await runExperiment({ definition: body.definition, machine: child, artifactStore: store,
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000), provider,
    })
    expect(outcome.state.status).toBe('completed')
    expect(reviewerRequests).toHaveLength(2)
    expect(reviewerRequests[0]).toMatchObject({ attempt: 1, continuationMode: 'resume',
      freshContext: false, sessionId: native.sessionId, nativeTransport: native,
      workspaceAllocationRunId: sourceRunId, retainedSandboxObjectId: selection.sandboxObjectId })
    expect(disposals).toContain(`${sourceRunId}:negative-review-replica`)
    expect(reviewerRequests[1]).toMatchObject({ attempt: 2, continuationMode: 'resume',
      freshContext: false, sessionId: native.sessionId, workspaceAllocationRunId: sourceRunId,
      retainedSandboxObjectId: selection.sandboxObjectId,
      nativeTransport: { sourceRunId: 'retained-review-child' } })
    expect(outcome.state.rejectedAttempts).toHaveLength(source.rejectedAttempts.length + 1)
    await expect(RunMachine.fromState(body.definition, outcome.state)).resolves.toBeDefined()
    expect(outcome.state.artifacts.filter(value => value.taskId === 'negative-review-primary')).toHaveLength(1)

    const correctingChild = await RunMachine.recoverFailedWave(body.definition, checkpoint, source,
      'retained-review-correction-child', prepared.importedArtifacts,
      prepared.inheritedRejectedAttempts, prepared.evidence)
    const correctionRequests: AgentRequest[] = []
    const corrected = await runExperiment({ definition: body.definition, machine: correctingChild,
      artifactStore: store, policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
      provider: { async run(request) {
        const result = await base.run(request)
        if (request.task.id !== 'negative-review-replica') return result
        correctionRequests.push(request)
        expect(request.task.providerClass).toBe('additive')
        const sameSession = { ...result, sessionId: native.sessionId }
        return request.formatRepairOrdinal === undefined
          ? { ...sameSession, files: { ...sameSession.files, [SUBMISSION_PATH]: '{' } }
          : sameSession
      } },
    })
    expect(corrected.state.status).toBe('completed')
    expect(correctionRequests).toHaveLength(2)
    expect(correctionRequests[0]).toMatchObject({ attempt: 1, continuationMode: 'resume',
      sessionId: native.sessionId, workspaceAllocationRunId: sourceRunId })
    expect(correctionRequests[1]).toMatchObject({ attempt: 2, formatRepairOrdinal: 1,
      continuationMode: 'resume', freshContext: false, sessionId: native.sessionId,
      workspaceAllocationRunId: sourceRunId, retainedSandboxObjectId: selection.sandboxObjectId })
    expect(correctionRequests[1]?.prompt).toContain(instruction(body.definition, 'correctionFormat'))
    await expect(RunMachine.fromState(body.definition, corrected.state)).resolves.toBeDefined()
  })
  it.each(['present', 'unknown', 'none'] as const)(
    'fails instead of sealing a %s transport outage and preserves only possible work', async workState => {
      const body = requiredReview()
      const release = await sealReleasePackage(body)
      const machine = await RunMachine.create(body.definition, release.digest, `required-review-${workState}`, startedAt)
      const base = new DeterministicAuditProvider()
      const disposed: string[] = []
      const reviewRequests: AgentRequest[] = []
      const provider: AgentProvider = {
        async run(request) {
          if (request.task.id === 'negative-review-replica') {
            reviewRequests.push(request)
            throw transport(request, workState)
          }
          return base.run(request)
        },
        async disposeWorkspace({ workspaceKey }) { disposed.push(workspaceKey) },
      }
      await expect(runExperiment({
        definition: body.definition, machine, provider, artifactStore: new MemoryArtifactStore(),
        policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
      })).rejects.toThrow('negative-review-replica')
      const state = machine.snapshot()
      expect(state.status).toBe('failed')
      expect(state.artifacts.some(artifact => artifact.taskId === 'reporter')).toBe(false)
      expect(state.artifacts.some(artifact => artifact.taskId === 'negative-review-replica')).toBe(false)
      expect(state.rejectedAttempts.filter(rejection => rejection.taskId === 'negative-review-replica')).toHaveLength(2)
      expect(reviewRequests.map(request => request.continuationMode))
        .toEqual(workState === 'none' ? ['new', 'new'] : ['new', 'resume'])
      if (workState !== 'none') {
        expect(reviewRequests[1]?.sessionId).toBe('session-11111111-1111-4111-8111-111111111111')
      }
      await expect(RunMachine.fromState(body.definition, state)).resolves.toBeDefined()
      const replica = body.definition.stages.find(stage => stage.kind === 'negative-review')!
        .waves[0]!.tasks.find(task => task.id === 'negative-review-replica')!
      expect(disposed.includes(replica.workspaceKey)).toBe(workState === 'none')
      const cleanup = await disposeTerminalWorkspaces(provider, body.definition, state)
      expect(cleanup.retainedWorkspaceKeys.includes(replica.workspaceKey)).toBe(workState !== 'none')
      expect(disposed.includes(replica.workspaceKey)).toBe(workState === 'none')
    },
  )

  it('still completes when both reviewers are accepted and disposes the completed workspace', async () => {
    const body = requiredReview()
    const release = await sealReleasePackage(body)
    const machine = await RunMachine.create(body.definition, release.digest, 'required-review-success', startedAt)
    const disposed: string[] = []
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      run: request => base.run(request),
      async disposeWorkspace({ workspaceKey }) { disposed.push(workspaceKey) },
    }
    const outcome = await runExperiment({
      definition: body.definition, machine, provider, artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })
    const replica = body.definition.stages.find(stage => stage.kind === 'negative-review')!
      .waves[0]!.tasks.find(task => task.id === 'negative-review-replica')!
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.artifacts.find(artifact => artifact.taskId === replica.id)?.status).toBe('accepted')
    expect(disposed).toContain(replica.workspaceKey)
  })
})
