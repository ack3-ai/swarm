import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest } from '../src/contracts.js'
import {
  RunMachine, createAudit0RunPolicy, runNextWave, sealReleasePackage,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const startedAt = '2026-09-19T00:00:00.000Z'

function capturingProvider(requests: AgentRequest[]): AgentProvider {
  const provider = new DeterministicAuditProvider()
  return {
    async run(request) {
      requests.push(structuredClone(request))
      return provider.run(request)
    },
  }
}

describe('portable recovery contracts', () => {
  it('quarantines a partial open wave and replays every lane from the preceding seal', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const root = await RunMachine.create(audit0Definition, release.digest, 'partial-wave-root', startedAt)
    const store = new MemoryArtifactStore()
    const preflight = await runNextWave({
      definition: audit0Definition,
      machine: root,
      provider: new DeterministicAuditProvider(),
      artifactStore: store,
    })
    expect(preflight).not.toBeNull()

    const base = new DeterministicAuditProvider()
    const rootRequests: AgentRequest[] = []
    const failing: AgentProvider = {
      async run(request) {
        rootRequests.push(structuredClone(request))
        if (request.task.id === 'core-wave-0-research-1') {
          throw new Error('sanitized lane transport loss')
        }
        return base.run(request)
      },
    }
    await expect(runNextWave({
      definition: audit0Definition, machine: root, provider: failing, artifactStore: store,
    })).resolves.toBeNull()

    const partial = root.snapshot().artifacts.filter(artifact => artifact.stageId === 'discovery')
    const discoveryLaneCount = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks.length
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.length).toBeLessThan(discoveryLaneCount)
    expect(preflight!.body.acceptedArtifacts.some(artifact => artifact.stageId === 'discovery')).toBe(false)

    const child = await RunMachine.resume(audit0Definition, preflight!, 'partial-wave-child')
    const childRequests: AgentRequest[] = []
    await runNextWave({
      definition: audit0Definition,
      machine: child,
      provider: capturingProvider(childRequests),
      artifactStore: store,
    })
    expect(childRequests).toHaveLength(discoveryLaneCount)
    expect(child.snapshot().artifacts.filter(artifact => artifact.stageId === 'discovery')).toHaveLength(discoveryLaneCount)
    for (const replay of childRequests) {
      const original = rootRequests.find(request => request.task.id === replay.task.id && request.attempt === 1)
      expect(original).toBeDefined()
      expect(replay.prompt).toBe(original?.prompt)
      expect(replay.promptDigest).toBe(original?.promptDigest)
      expect(replay.visibleArtifacts).toEqual(original?.visibleArtifacts)
    }
  })

  it('replays an interrupted open wave with exact sealed assignments in fresh child contexts', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const root = await RunMachine.create(audit0Definition, release.digest, 'replay-root', startedAt)
    const store = new MemoryArtifactStore()
    const preflight = await runNextWave({
      definition: audit0Definition,
      machine: root,
      provider: new DeterministicAuditProvider(),
      artifactStore: store,
    })
    expect(preflight).not.toBeNull()

    const child = await RunMachine.resume(audit0Definition, preflight!, 'replay-child')
    const rootRequests: AgentRequest[] = []
    const childRequests: AgentRequest[] = []
    await runNextWave({
      definition: audit0Definition,
      machine: root,
      provider: capturingProvider(rootRequests),
      artifactStore: store,
    })
    await runNextWave({
      definition: audit0Definition,
      machine: child,
      provider: capturingProvider(childRequests),
      artifactStore: store,
    })

    const discoveryLaneCount = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks.length
    expect(rootRequests).toHaveLength(discoveryLaneCount)
    expect(childRequests).toHaveLength(discoveryLaneCount)
    for (const original of rootRequests) {
      const replay = childRequests.find(request => request.task.id === original.task.id)
      expect(replay).toBeDefined()
      expect(replay?.runId).toBe('replay-child')
      expect(replay?.runId).not.toBe(original.runId)
      expect(replay?.prompt).toBe(original.prompt)
      expect(replay?.promptDigest).toBe(original.promptDigest)
      expect(replay?.visibleArtifacts).toEqual(original.visibleArtifacts)
      expect(replay?.freshContext).toBe(false)
      expect(replay?.prompt).not.toMatch(/Recovery retry control:|Source snapshot:|Discovery cutoff:/)
    }
  })

  it('does not attach an expiring execution deadline to delayed completion work', async () => {
    const release = await sealReleasePackage(audit0PackageBody)
    const root = await RunMachine.create(audit0Definition, release.digest, 'delayed-completion-root', startedAt)
    const store = new MemoryArtifactStore()
    const outcome = await runExperiment({
      definition: audit0Definition,
      machine: root,
      provider: new DeterministicAuditProvider(),
      artifactStore: store,
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })
    const afterDiscovery = outcome.checkpoints.find(checkpoint => (
      checkpoint.body.cursor.stageIndex === 2 && checkpoint.body.cursor.waveIndex === 0
    ))!
    const resumedAt = new Date(Date.parse(afterDiscovery.body.sealedAt) + 24 * 60 * 60 * 1_000).toISOString()
    const child = await RunMachine.resume(
      audit0Definition, afterDiscovery, 'delayed-completion-child', new Set(), resumedAt,
    )
    const requests: AgentRequest[] = []
    await runNextWave({
      definition: audit0Definition,
      machine: child,
      provider: capturingProvider(requests),
      artifactStore: store,
    })
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request).not.toHaveProperty('executionDeadlineAt')
      expect(request).not.toHaveProperty('phaseDeadlineAt')
    }
  })

})
