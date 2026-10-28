import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest } from '../src/contracts.js'
import {
  advanceExperimentOneWave, RunMachine, SUBMISSION_PATH, sealReleasePackage,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { instruction } from './support/instructions.js'

const formatCorrection = instruction(audit0Definition, 'correctionFormat')
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../src/run-errors.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

async function runWith(provider: AgentProvider, runId: string) {
  const release = await sealReleasePackage(audit0PackageBody)
  const machine = await RunMachine.create(audit0Definition, release.digest, runId, '2026-09-18T20:00:00.000Z')
  const store = new MemoryArtifactStore()
  const outcome = await runExperiment({ definition: audit0Definition, machine, provider, artifactStore: store })
  return { outcome, store }
}

function malformed(request: AgentRequest, result: Awaited<ReturnType<AgentProvider['run']>>) {
  return { ...result, files: { ...result.files, [SUBMISSION_PATH]: '{' }, protocol: {} }
}

describe('durable output-only correction boundary', () => {
  it('accepts the tenth correction in the original session without restarting research', async () => {
    const base = new DeterministicAuditProvider()
    const requests: AgentRequest[] = []
    const target = 'core-wave-0-research-1'
    const { outcome, store } = await runWith({ async run(request) {
      const result = await base.run(request)
      if (request.task.id !== target) return result
      requests.push(request)
      return request.attempt <= 10 ? malformed(request, result) : result
    } }, 'format-tenth-success')
    expect(outcome.state.status).toBe('completed')
    expect(requests.map(request => request.attempt)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1))
    expect(requests[0]?.formatRepairOrdinal).toBeUndefined()
    for (let ordinal = 1; ordinal <= 10; ordinal++) {
      const request = requests[ordinal]!
      expect(request.formatRepairOrdinal).toBe(ordinal)
      expect(request.continuationMode).toBe('resume')
      expect(request.freshContext).toBe(false)
      expect(request.sessionId).toBe(`session-${requests[0]?.task.workspaceKey}`)
      expect(request.prompt).toContain(formatCorrection)
      expect(request.repairFiles[SUBMISSION_PATH]).toBe('{')
    }
    const rejections = outcome.state.rejectedAttempts.filter(value => value.taskId === target)
    expect(rejections).toHaveLength(10)
    expect(rejections.every(value => value.outputDigest !== null && store.contents.has(value.quarantineUri!))).toBe(true)
    expect(rejections.map(value => value.formatRepairOrdinal)).toEqual([undefined, ...Array.from({ length: 9 }, (_, i) => i + 1)])
    await expect(RunMachine.fromState(audit0Definition, outcome.state)).resolves.toBeDefined()
    const changed = structuredClone(outcome.state)
    const correction = changed.rejectedAttempts.find(value => value.taskId === target && value.formatRepairOrdinal === 1)!
    correction.formatRepairSourceDigest = '0'.repeat(64)
    await expect(RunMachine.fromState(audit0Definition, changed)).rejects.toThrow()
    await expect(RunMachine.resume(audit0Definition, outcome.checkpoints.at(-1)!, 'format-tenth-success-resume'))
      .resolves.toBeDefined()
  })

  it('stops after ten unsuccessful corrections and retains every quarantined response', async () => {
    const base = new DeterministicAuditProvider()
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'format-ten-exhausted')
    const store = new MemoryArtifactStore()
    const attempts: number[] = []
    const target = 'core-wave-0-research-1'
    await expect(runExperiment({ definition: audit0Definition, machine, artifactStore: store,
      provider: { async run(request) {
        const result = await base.run(request)
        if (request.task.id !== target) return result
        attempts.push(request.attempt)
        return malformed(request, result)
      } },
    })).rejects.toThrow('output correction exhausted after 10 turns')
    expect(attempts).toEqual(Array.from({ length: 11 }, (_, index) => index + 1))
    const rejections = machine.snapshot().rejectedAttempts.filter(value => value.taskId === target)
    expect(rejections).toHaveLength(11)
    expect(rejections.every(value => value.outputDigest !== null && store.contents.has(value.quarantineUri!))).toBe(true)
    expect(machine.snapshot().artifacts.some(value => value.taskId === target)).toBe(false)
  })

  it('keeps a transport retry separate from correction after a resumed malformed response', async () => {
    const base = new DeterministicAuditProvider()
    const requests: AgentRequest[] = []
    const target = 'additive-wave-0-research-1'
    const sessionId = 'session-11111111-1111-4111-8111-111111111111'
    const { outcome } = await runWith({ async run(request) {
      const result = await base.run(request)
      if (request.task.id !== target) return result
      requests.push(request)
      if (request.attempt === 1) throw new AgentAttemptFailure('synthetic closed 504', {
        usage: { modelCalls: 1, inputTokens: 25, outputTokens: 4, costUsd: 0 },
        includeDiagnosticsInRepair: false,
        nativeTransport: { code: 'TRANSPORT', sourceRunId: request.runId,
          requestDigest: 'c'.repeat(64), snapshotDigest: 'd'.repeat(64), sessionId, workState: 'present' },
      })
      const sameSession = { ...result, actorId: sessionId, sessionId }
      return request.attempt === 2 ? malformed(request, sameSession) : sameSession
    } }, 'format-after-504')
    expect(outcome.state.status).toBe('completed')
    expect(requests.map(request => [request.attempt, request.formatRepairOrdinal ?? null,
      request.continuationMode, request.freshContext])).toEqual([
      [1, null, 'new', false], [2, null, 'resume', false], [3, 1, 'resume', false],
    ])
    expect(requests[2]?.sessionId).toBe(sessionId)
    expect(requests[2]?.prompt).toContain(formatCorrection)
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === target)
      .map(value => [value.outputDigest === null, value.formatRepairOrdinal ?? null]))
      .toEqual([[true, null], [false, null]])
    await expect(RunMachine.fromState(audit0Definition, outcome.state)).resolves.toBeDefined()
  })

  it('reattaches an interrupted correction to the same ordinal and prompt', async () => {
    const base = new DeterministicAuditProvider()
    const target = 'core-wave-0-research-1'
    const requests: AgentRequest[] = []
    let interrupted = false
    const { outcome } = await runWith({ async run(request) {
      const result = await base.run(request)
      if (request.task.id !== target) return result
      requests.push(request)
      if (request.attempt === 1) return malformed(request, result)
      if (!interrupted) {
        interrupted = true
        throw new AgentExecutionPending('fixture-correction', 'unfinished')
      }
      return result
    } }, 'format-pending-reattach')
    expect(outcome.state.status).toBe('completed')
    expect(requests.map(request => request.attempt)).toEqual([1, 2, 2])
    expect(requests[1]?.formatRepairOrdinal).toBe(1)
    expect(requests[2]?.formatRepairOrdinal).toBe(1)
    expect(requests[1]?.promptDigest).toBe(requests[2]?.promptDigest)
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === target)).toHaveLength(1)
  })

  it('reconstructs a persisted correction without repeating the original research turn', async () => {
    const base = new DeterministicAuditProvider()
    const release = await sealReleasePackage(audit0PackageBody)
    let machine = await RunMachine.create(audit0Definition, release.digest, 'format-persisted-reattach')
    const store = new MemoryArtifactStore()
    const requests: AgentRequest[] = []
    const provider: AgentProvider = { async run(request) {
      const result = await base.run(request)
      if (request.task.id !== 'core-wave-0-research-1') return result
      requests.push(request)
      return request.attempt === 1 ? malformed(request, result) : result
    } }
    await advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: store })
    for (let tick = 0; tick < 4 && machine.snapshot().rejectedAttempts.length === 0; tick++) {
      await advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: store })
    }
    const persisted = machine.snapshot()
    expect(persisted.rejectedAttempts.some(value => value.taskId === 'core-wave-0-research-1')).toBe(true)
    machine = await RunMachine.fromState(audit0Definition, persisted)
    const outcome = await runExperiment({ definition: audit0Definition, machine, provider, artifactStore: store })
    expect(outcome.state.status).toBe('completed')
    expect(requests.map(request => request.attempt)).toEqual([1, 2])
    expect(requests[1]?.formatRepairOrdinal).toBe(1)
  })

  it('does not spend a correction turn on a closed transport interruption', async () => {
    const base = new DeterministicAuditProvider()
    const target = 'additive-wave-0-research-1'
    const sessionId = 'session-11111111-1111-4111-8111-111111111111'
    const requests: AgentRequest[] = []
    const { outcome } = await runWith({ async run(request) {
      const result = await base.run(request)
      if (request.task.id !== target) return result
      requests.push(request)
      const sameSession = { ...result, actorId: sessionId, sessionId }
      if (request.attempt === 1) return malformed(request, sameSession)
      if (request.attempt === 2) throw new AgentAttemptFailure('synthetic correction transport', {
        usage: { modelCalls: 1, inputTokens: 25, outputTokens: 4, costUsd: 0 },
        includeDiagnosticsInRepair: false,
        nativeTransport: { code: 'TRANSPORT', sourceRunId: request.runId,
          requestDigest: 'e'.repeat(64), snapshotDigest: 'f'.repeat(64), sessionId, workState: 'present' },
      })
      return sameSession
    } }, 'format-transport-reattach')
    expect(outcome.state.status).toBe('completed')
    expect(requests.map(request => [request.attempt, request.formatRepairOrdinal ?? null])).toEqual([
      [1, null], [2, 1], [3, 1],
    ])
    expect(requests[2]?.nativeTransport?.sessionId).toBe(sessionId)
    expect(requests[2]?.promptDigest).toBe(requests[1]?.promptDigest)
    expect(outcome.state.rejectedAttempts.filter(value => value.taskId === target)).toHaveLength(2)
    await expect(RunMachine.fromState(audit0Definition, outcome.state)).resolves.toBeDefined()
  })

  it('never treats provider identity or usage corruption as agent formatting', async () => {
    const base = new DeterministicAuditProvider()
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'format-integrity-boundary')
    const store = new MemoryArtifactStore()
    const attempts: number[] = []
    await expect(runExperiment({ definition: audit0Definition, machine, artifactStore: store,
      provider: { async run(request) {
        const result = await base.run(request)
        if (request.task.id !== 'core-wave-0-research-1') return result
        attempts.push(request.attempt)
        return { ...malformed(request, result), model: 'unconfigured-model' }
      } },
    })).rejects.toThrow('output or result integrity failed')
    expect(attempts).toEqual([1])
    expect(machine.snapshot().rejectedAttempts.filter(value => value.taskId === 'core-wave-0-research-1')).toHaveLength(1)
  })

  it('retains the original quarantined output and workspace when correction transport exhausts', async () => {
    const base = new DeterministicAuditProvider()
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'format-transport-exhausted')
    const store = new MemoryArtifactStore()
    const disposed: string[] = []
    const attempts: number[] = []
    const target = 'synthesizer'
    await expect(runExperiment({ definition: audit0Definition, machine, artifactStore: store,
      provider: { async run(request) {
        const result = await base.run(request)
        if (request.task.id !== target) return result
        attempts.push(request.attempt)
        if (request.attempt === 1) return malformed(request, result)
        throw new AgentAttemptFailure('synthetic closed correction transport', {
          usage: { modelCalls: 1, inputTokens: 25, outputTokens: 4, costUsd: 0 },
          includeDiagnosticsInRepair: false,
        })
      }, async disposeWorkspace(input) { disposed.push(input.workspaceKey) } },
    })).rejects.toThrow('synthetic closed correction transport')
    expect(attempts).toEqual([1, 2, 3])
    const rejections = machine.snapshot().rejectedAttempts.filter(value => value.taskId === target)
    expect(rejections.map(value => [value.outputDigest !== null, value.formatRepairOrdinal ?? null]))
      .toEqual([[true, null], [false, 1], [false, 1]])
    expect(store.contents.has(rejections[0]?.quarantineUri ?? '')).toBe(true)
    expect(disposed).not.toContain(target)
  })

  it('does not open a model correction lane for deterministic output failure', async () => {
    const base = new DeterministicAuditProvider()
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'format-deterministic-boundary')
    const calls: number[] = []
    await expect(runExperiment({ definition: audit0Definition, machine, artifactStore: new MemoryArtifactStore(),
      provider: { async run(request) {
        const result = await base.run(request)
        if (request.task.promptKind !== 'preflight') return result
        calls.push(request.attempt)
        return { ...result, files: {} }
      } },
    })).rejects.toThrow('output or result integrity failed')
    expect(calls).toEqual([1])
  })

  it.each(['research', 'synthesis', 'coverage-challenge', 'negative-review', 'verification', 'reporting'] as const)(
    'uses a short same-session correction for %s output', async promptKind => {
      const task = audit0Definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
        .find(candidate => candidate.promptKind === promptKind && candidate.providerClass !== 'deterministic')!
      const base = new DeterministicAuditProvider()
      const requests: AgentRequest[] = []
      const { outcome } = await runWith({ async run(request) {
        const result = await base.run(request)
        if (request.task.id !== task.id) return result
        requests.push(request)
        return requests.length === 1 ? malformed(request, result) : result
      } }, `format-stage-${promptKind}`)
      expect(outcome.state.status).toBe('completed')
      expect(requests).toHaveLength(2)
      expect(requests[1]).toMatchObject({ attempt: 2, formatRepairOrdinal: 1,
        continuationMode: 'resume', freshContext: false, sessionId: requests[0]?.sessionId ?? `session-${task.workspaceKey}` })
      expect(requests[1]?.prompt).toContain(formatCorrection)
    },
  )
})
