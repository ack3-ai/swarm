import { createControlledMachine } from './support/controlled-machine.js'
import { beforeAll, expect, it } from 'vitest'
import type { InFlightAgentAttempt, RejectedAttempt } from '../src/contracts.js'
import { sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { ExecutionReleases } from '../src/execution-releases.js'
import { sealReleasePackage } from '../src/release.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../src/run-errors.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

function settlement(machine: RunMachine, attempt: Omit<InFlightAgentAttempt, 'admittedAt'>) {
  const event = machine.view().journal.findLast(event => event.type === 'agent.attempt-admitted'
    && (event.payload as InFlightAgentAttempt).taskId === attempt.taskId)!
  return { ...attempt, admissionDigest: event.digest }
}

async function audit(interruptions = 0) {
  const release = await sealReleasePackage(audit0PackageBody), id = 'attempt-policy-evidence'
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const base = new DeterministicAuditProvider(), store = new MemoryArtifactStore()
  const corrected = new Set<string>()
  const provider = { async run(request: Parameters<typeof base.run>[0]) {
    if (request.task.id === 'core-wave-0-research-1' && interruptions-- > 0) {
      throw new AgentAttemptFailure('synthetic interruption before provider dispatch', {
        usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, includeDiagnosticsInRepair: false,
      })
    }
    const result = await base.run(request)
    if ((request.task.id === 'core-wave-0-research-1' || request.task.promptKind === 'negative-review')
      && request.attempt === 1) {
      corrected.add(request.task.id)
      return { ...result, files: { ...result.files, [SUBMISSION_PATH]: '{' }, protocol: {} }
    }
    return result
  } }
  let ticks = 0
  while (machine.view().phase !== 'complete' && ticks++ < 40) {
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store, provider })
  }
  expect(machine.view().phase).toBe('complete')
  await machine.complete()
  const state = machine.snapshot(), checkpoint = state.checkpoints.at(-1)!
  const releases = await ExecutionReleases.create(machine.definition, state)
  expect(corrected.size).toBeGreaterThan(1)
  return { machine, state, checkpoint, releases }
}
let fixture: Awaited<ReturnType<typeof audit>>
beforeAll(async () => { fixture = await audit() })

it('certifies research and required-review corrections from their chronological admissions without another provider call', async () => {
  for (const checkpoint of fixture.state.checkpoints) await fixture.machine.verifyCheckpoint(checkpoint)
  expect(fixture.state.rejectedAttempts.some(value => value.stageId === 'negative-review')).toBe(true)
  expect(fixture.state.journal.filter(event => event.type === 'agent.attempt-admitted')
    .some(event => (event.payload as InFlightAgentAttempt).formatRepairOrdinal === 1)).toBe(true)
})

it('reconciles repeated identical non-consuming observations without inventing usage or exhausting a retry', async () => {
  const result = await audit(2)
  expect(result.state.budget).toEqual(fixture.state.budget)
  for (const checkpoint of result.state.checkpoints) await result.machine.verifyCheckpoint(checkpoint)
})

it('does not clear an admitted controlled attempt before an exact outcome is recorded', async () => {
  const release = await sealReleasePackage(audit0PackageBody), id = 'attempt-clear-outcome'
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const store = new MemoryArtifactStore(), provider = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store, provider })
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  const before = machine.snapshot(), attempt = before.inFlightAgentAttempts![0]!
  await expect(machine.clearAgentAttempt(settlement(machine, attempt)))
    .rejects.toThrow('no recorded outcome')
  expect(machine.snapshot()).toEqual(before)
  const { admittedAt: _, ...request } = attempt
  await machine.recordRejectedAttempt({ ...request, outputDigest: null, quarantineUri: null,
    diagnostics: ['synthetic interruption before a model request'],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  await machine.clearAgentAttempt(settlement(machine, attempt))
  // Re-observing a non-consuming interruption is allowed, but its old receipt
  // cannot settle the new admission occurrence.
  await machine.admitAgentAttempt(request)
  const readmitted = machine.snapshot()
  await expect(machine.clearAgentAttempt(settlement(machine, attempt)))
    .rejects.toThrow('no recorded outcome')
  expect(machine.snapshot()).toEqual(readmitted)
})

it.each(['session', 'mode'] as const)('rejects re-observation after changing the requested %s without mutating state', async changed => {
  const release = await sealReleasePackage(audit0PackageBody), id = `observation-${changed}`
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const store = new MemoryArtifactStore()
  await advanceExperimentOneWave({ machine, definition: machine.definition, artifactStore: store, provider: new DeterministicAuditProvider() })
  await advanceExperimentOneWave({ machine, definition: machine.definition, artifactStore: store,
    provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  const attempt = machine.snapshot().inFlightAgentAttempts!.find(value => value.taskId.startsWith('core-'))!
  const { admittedAt: _, ...request } = attempt
  await machine.recordRejectedAttempt({ ...request, outputDigest: null, quarantineUri: null,
    diagnostics: ['synthetic transport'], sessionId: 'session-original', usage: { modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 } })
  await machine.clearAgentAttempt(settlement(machine, request))
  const second = { ...request, attempt: 2, execution: { ...request.execution!, attempt: 2 },
    continuationMode: 'resume' as const, freshContext: false, sessionId: 'session-original' }
  await machine.admitAgentAttempt(second)
  const rejection = { ...second, outputDigest: null, quarantineUri: null, diagnostics: ['not dispatched'],
    usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  await machine.recordRejectedAttempt(rejection)
  await machine.clearAgentAttempt(settlement(machine, second))
  await machine.admitAgentAttempt(changed === 'session' ? { ...second, sessionId: 'session-other' }
    : { ...second, continuationMode: 'new', freshContext: true, sessionId: null })
  const before = machine.snapshot()
  await expect(machine.recordRejectedAttempt(rejection)).rejects.toThrow('request differs')
  expect(machine.snapshot()).toEqual(before)
  await expect(machine.clearAgentAttempt(settlement(machine, second)))
    .rejects.toThrow('no recorded outcome')
})


async function pendingAttempt(id: string) {
  const release = await sealReleasePackage(audit0PackageBody)
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const store = new MemoryArtifactStore()
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: new DeterministicAuditProvider() })
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  const attempt = machine.view().inFlightAgentAttempts![0]!
  const { admittedAt, ...request } = attempt
  const rejection = { ...request, outputDigest: null, quarantineUri: null,
    diagnostics: ['synthetic interruption'], usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  return { machine, attempt, request, rejection, admittedAt }
}

it('rejects a delayed settlement after identical re-admission, even with the same timestamp and a recorded outcome', async () => {
  const f = await pendingAttempt('identical-admission-settlement'), old = settlement(f.machine, f.attempt)
  // An ambiguous admission ACK reconciles to the same event, without appending another admission.
  expect(await f.machine.admitAgentAttempt(f.request)).toBe(old.admissionDigest)
  await f.machine.recordRejectedAttempt(f.rejection)
  await f.machine.clearAgentAttempt(old)
  const budget = f.machine.view().budget
  const admissionDigest = await f.machine.admitAgentAttempt(f.request, f.admittedAt)
  expect(admissionDigest).not.toBe(old.admissionDigest)
  expect(f.machine.view().inFlightAgentAttempts!.find(value => value.taskId === f.attempt.taskId)).toEqual(f.attempt)
  await f.machine.recordRejectedAttempt(f.rejection)
  const machine = f.machine, before = machine.snapshot()
  await expect(machine.clearAgentAttempt(old)).rejects.toThrow('completion differs')
  expect(machine.snapshot()).toEqual(before)
  expect(machine.view().budget).toEqual(budget)
  await machine.clearAgentAttempt({ ...f.request, admissionDigest })
  const finished = machine.view().journal.at(-1)!
  expect(finished.type).toBe('agent.attempt-finished')
  expect((finished.payload as { admissionDigest: string }).admissionDigest).toBe(admissionDigest)
})

it.each(['missing-execution', 'different-attempt', 'different-occurrence', 'missing-admission'] as const)(
  'rejects a %s settlement despite a matching prompt and current outcome', async corruption => {
    const f = await pendingAttempt(`settlement-${corruption}`)
    await f.machine.recordRejectedAttempt(f.rejection)
    const completion = settlement(f.machine, f.attempt)
    if (corruption === 'missing-execution') delete completion.execution
    if (corruption === 'different-attempt') completion.execution = { ...completion.execution!, attempt: 2 }
    if (corruption === 'different-occurrence') completion.execution = { ...completion.execution!, taskExecutionId: `task-${'f'.repeat(48)}` }
    const malformed = corruption === 'missing-admission' ? f.request : completion
    const before = f.machine.snapshot()
    await expect(f.machine.clearAgentAttempt(malformed)).rejects.toThrow('completion differs')
    expect(f.machine.snapshot()).toEqual(before)
  },
)
