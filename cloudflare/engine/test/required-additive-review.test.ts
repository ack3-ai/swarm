import { nativeWorkspaceKey } from '../src/native-workspace.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { describe, expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { AgentProvider, AgentRequest, NativeTransportEvidence } from '../src/contracts.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { createAudit0RunPolicy, disposeTerminalWorkspaces } from '../src/runner.js'
import { sealReleasePackage } from '../src/release.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

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
  it.each(['present', 'unknown', 'none'] as const)(
    'fails instead of sealing a %s transport outage and preserves only possible work', async workState => {
      const body = requiredReview()
      const release = await sealReleasePackage(body)
      const machine = await createControlledMachine(body.definition, release.digest, `required-review-${workState}`, startedAt)
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
      const state = machine.view()
      expect(state.status).toBe('failed')
      expect(state.artifacts.some(artifact => artifact.taskId === 'reporter')).toBe(false)
      expect(state.artifacts.some(artifact => artifact.taskId === 'negative-review-replica')).toBe(false)
      expect(state.rejectedAttempts.filter(rejection => rejection.taskId === 'negative-review-replica')).toHaveLength(2)
      expect(reviewRequests.map(request => request.continuationMode))
        .toEqual(workState === 'none' ? ['new', 'new'] : ['new', 'resume'])
      if (workState !== 'none') {
        expect(reviewRequests[1]?.sessionId).toBe('session-11111111-1111-4111-8111-111111111111')
      }
      await expect(restoreSelected(machine)).resolves.toBeDefined()
      const replica = body.definition.stages.find(stage => stage.kind === 'negative-review')!
        .waves[0]!.tasks.find(task => task.id === 'negative-review-replica')!
      expect(disposed.includes(await nativeWorkspaceKey(replica))).toBe(workState === 'none')
      await expect(disposeTerminalWorkspaces(provider, body.definition, state)).rejects.toThrow('cancel control')
      expect(disposed.includes(await nativeWorkspaceKey(replica))).toBe(workState === 'none')
    },
  )

  it('still completes when both reviewers are accepted and disposes the completed workspace', async () => {
    const body = requiredReview()
    const release = await sealReleasePackage(body)
    const machine = await createControlledMachine(body.definition, release.digest, 'required-review-success', startedAt)
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
    expect(disposed).toContain(await nativeWorkspaceKey(replica))
  })
})
