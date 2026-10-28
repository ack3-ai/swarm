import { describe, expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import type { AgentProvider, AgentRequest } from '../src/contracts.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure, UnobservableAgentExecution } from '../src/run-errors.js'
import { createAudit0RunPolicy, disposeTerminalWorkspaces } from '../src/runner.js'
import { sealReleasePackage } from '../src/release.js'
import { validateExperiment } from '../src/validation.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const startedAt = '2026-01-01T00:00:00.000Z'

function manifest() {
  const value = structuredClone(document)
  value.maxDiscoveryWaves = 4
  value.modelPools.find(pool => pool.id === 'deepseek')!.required = true
  return value
}

describe('required discovery pools', () => {
  it('seals required discovery tasks and reviewer without changing optional manifests', () => {
    const definition = compileExperimentConfig(manifest()).definition
    const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
    expect(discovery.waves.every(wave => wave.tasks.every(task => task.optional !== true))).toBe(true)
    expect(discovery.waves.every(wave => wave.minSuccessfulTasks === wave.tasks.length)).toBe(true)
    expect(definition.stages.find(stage => stage.kind === 'negative-review')!.waves[0]!.minSuccessfulTasks).toBe(2)
    expect(compileExperimentConfig(document).definition.stages.find(stage => stage.kind === 'discovery')!
      .waves[0]!.tasks.find(task => task.providerClass === 'additive')?.optional).toBe(true)
  })

  it.each([false, 'true', null])('rejects an invalid Codex required flag: %s', required => {
    const value = manifest() as any
    value.modelPools.find((pool: any) => pool.id === 'luna').required = required
    expect(() => compileExperimentConfig(value)).toThrow('boolean required flag')
  })

  it.each(['true', null, undefined])('rejects an invalid additive required flag: %s', required => {
    const value = manifest() as any
    value.modelPools.find((pool: any) => pool.id === 'deepseek').required = required
    expect(() => compileExperimentConfig(value)).toThrow('boolean required flag')
  })

  it.each([true, false])('rejects a sealed discovery task that contradicts required=%s', required => {
    const value = manifest()
    value.modelPools.find(pool => pool.id === 'deepseek')!.required = required
    const definition = structuredClone(compileExperimentConfig(value).definition) as any
    const task = definition.stages.find((stage: any) => stage.kind === 'discovery').waves[0].tasks
      .find((task: any) => task.providerClass === 'additive')
    task.optional = required
    expect(() => validateExperiment(definition)).toThrow(/availability requirement|must be optional/)
  })

  it('completes when required discovery and both reviewers return accepted work', async () => {
    const body = compileExperimentConfig(manifest())
    const release = await sealReleasePackage(body)
    const machine = await RunMachine.create(body.definition, release.digest, 'required-discovery-success', startedAt)
    const outcome = await runExperiment({ definition: body.definition, machine,
      provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.artifacts.some(artifact => artifact.status === 'additive-unavailable')).toBe(false)
    expect(outcome.state.artifacts.find(artifact => artifact.taskId === 'negative-review-replica')?.status).toBe('accepted')
  })

  it('fails after bounded same-session recovery and retains unfinished native work', async () => {
    const body = compileExperimentConfig(manifest())
    const release = await sealReleasePackage(body)
    const machine = await RunMachine.create(body.definition, release.digest, 'required-discovery-outage', startedAt)
    const base = new DeterministicAuditProvider()
    const requests: AgentRequest[] = []
    const disposed: string[] = []
    const provider: AgentProvider = {
      async run(request) {
        if (request.task.providerClass === 'additive' && request.task.promptKind === 'research') {
          requests.push(request)
          throw new AgentAttemptFailure('synthetic idle timeout', {
            includeDiagnosticsInRepair: false,
            nativeTransport: {
              code: 'TIMEOUT', sourceRunId: request.runId, requestDigest: 'a'.repeat(64),
              sessionId: 'session-11111111-1111-4111-8111-111111111111',
              snapshotDigest: 'b'.repeat(64), workState: 'present',
            },
          })
        }
        return base.run(request)
      },
      async disposeWorkspace({ workspaceKey }) { disposed.push(workspaceKey) },
    }
    await expect(runExperiment({ definition: body.definition, machine, provider,
      artifactStore: new MemoryArtifactStore(), policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })).rejects.toThrow('additive-wave-0-research')
    const state = machine.snapshot()
    expect(state.status).toBe('failed')
    expect(state.artifacts.some(artifact => artifact.status === 'additive-unavailable')).toBe(false)
    expect(state.artifacts.some(artifact => artifact.taskId === 'synthesizer' || artifact.taskId === 'reporter')).toBe(false)
    const firstLane = requests.filter(request => request.task.id === requests[0]!.task.id)
    expect(firstLane.map(request => request.continuationMode)).toEqual(['new', 'resume'])
    expect(firstLane[1]!.sessionId).toBe('session-11111111-1111-4111-8111-111111111111')
    const cleanup = await disposeTerminalWorkspaces(provider, body.definition, state)
    for (const request of requests) {
      expect(cleanup.retainedWorkspaceKeys).toContain(request.task.workspaceKey)
      expect(disposed).not.toContain(request.task.workspaceKey)
    }
    await expect(RunMachine.fromState(body.definition, state)).resolves.toBeDefined()
  })

  it('fails a bounded core observation incident without rejecting or disposing unknown native work', async () => {
    const body = compileExperimentConfig(manifest())
    const release = await sealReleasePackage(body)
    const machine = await RunMachine.create(body.definition, release.digest,
      'core-observation-outage', startedAt)
    const base = new DeterministicAuditProvider()
    const disposed: string[] = []
    let unresolved: AgentRequest | null = null
    const provider: AgentProvider = {
      async run(request) {
        if (request.task.id === 'core-wave-0-research-1') {
          unresolved = request
          throw new UnobservableAgentExecution('native process and usage remain unresolved')
        }
        return base.run(request)
      },
      async disposeWorkspace({ workspaceKey }) { disposed.push(workspaceKey) },
    }
    await expect(runExperiment({ definition: body.definition, machine, provider,
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })).rejects.toThrow('native process and usage remain unresolved')
    const state = machine.snapshot()
    expect(state.status).toBe('failed')
    expect(unresolved).not.toBeNull()
    expect(state.inFlightAgentAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: unresolved!.task.id, attempt: unresolved!.attempt,
        promptDigest: unresolved!.promptDigest }),
    ]))
    expect(state.rejectedAttempts.some(value => value.taskId === unresolved!.task.id)).toBe(false)
    const restored = await RunMachine.fromState(body.definition, state)
    expect(restored.snapshot().inFlightAgentAttempts).toEqual(state.inFlightAgentAttempts)
    const cleanup = await disposeTerminalWorkspaces(provider, body.definition, state)
    expect(cleanup.activeWorkspaceKeys).toContain(unresolved!.task.workspaceKey)
    expect(disposed).not.toContain(unresolved!.task.workspaceKey)
  })
})
