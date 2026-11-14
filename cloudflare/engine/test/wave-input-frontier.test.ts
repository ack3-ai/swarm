import { createControlledMachine } from './support/controlled-machine.js'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { sha256 } from '../src/canonical.js'
import * as canonical from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { artifactReferences } from '../src/artifact-execution.js'
import { selectedSnapshots } from './support/selected-snapshots.js'
import { verifyRegisteredCheckpoint } from '../src/checkpoint-evidence.js'
import type { AgentRequest, ArtifactRecord, InFlightAgentAttempt, RunState } from '../src/contracts.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'

const selected = selectedSnapshots()
afterAll(() => selected.close())

let fixture: Awaited<ReturnType<typeof pendingReview>>
async function pendingReview() {
  const release = await sealReleasePackage(compileExperimentConfig(manifest)), id = 'wave-input-frontier'
  let machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const provider = new DeterministicAuditProvider(), store = new MemoryArtifactStore()
  for (let tick = 0; machine.view().phase !== 'negative-review' && tick < 20; tick++) {
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store, provider })
  }
  expect(machine.view().phase).toBe('negative-review')
  const tasks = machine.definition.stages[machine.view().cursor.stageIndex]!.waves[0]!.tasks
  expect(tasks.length).toBe(2)
  const requests: AgentRequest[] = []
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store, provider: {
    async run(request) {
      requests.push(request)
      if (request.task.id === tasks[1]!.id) throw new AgentExecutionPending(request.task.id)
      return provider.run(request)
    },
  } })
  machine = await RunMachine.fromState(machine.definition, await selected.select(machine), undefined, selected.load)
  expect(machine.view().artifacts.filter(value => value.stageId === 'negative-review')).toHaveLength(1)
  return { machine, state: machine.snapshot(), release, store, provider, requests, pendingId: tasks[1]!.id }
}
beforeAll(async () => { fixture = await pendingReview() })

it('retains the admitted packet across sibling acceptance, reload, and native polling', async () => {
  const f = fixture, machine = await RunMachine.fromState(f.machine.definition, structuredClone(f.state), undefined, selected.load)
  const first = f.requests.find(request => request.task.id === f.pendingId)!, calls: AgentRequest[] = []
  const admission = structuredClone(machine.view().waveAdmission!)
  expect(admission.inputDigest).toBe(await sha256(admission.inputArtifacts))
  expect(admission.inputArtifacts!.length).toBe(machine.view().artifacts.length - 1)
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: f.store, provider: {
    async run(request) { calls.push(request); return f.provider.run(request) },
  } })
  expect(calls.map(value => value.task.id)).toEqual([f.pendingId])
  expect(calls[0]!.visibleArtifacts).toEqual(first.visibleArtifacts)
  expect(calls[0]!.execution).toEqual(first.execution)
  expect(calls[0]!.visibleArtifacts.some(value => value.stageId === 'negative-review')).toBe(false)
  const receipt = machine.view().waveReceipts.find(value => value.stageId === 'negative-review')!
  expect(receipt.taskOccurrences).toEqual(admission.taskOccurrences)
  expect(admission.taskOccurrences!.find(value => value.taskId === f.pendingId)!.taskExecutionId).toBe(first.taskExecutionId)
  expect(receipt.inputArtifacts).toEqual(admission.inputArtifacts)
  expect(receipt.inputDigest).toBe(admission.inputDigest)
  const checkpoint = await machine.seal()
  await verifyRegisteredCheckpoint(checkpoint, machine.view())
})

async function rehash(state: RunState) {
  let previousDigest: string | null = null
  for (const event of state.journal) {
    event.previousDigest = previousDigest
    const { digest: _, ...unsigned } = event
    event.digest = await sha256(unsigned); previousDigest = event.digest
  }
}

it.each(['missing', 'removed-upstream', 'added-sibling', 'changed-digest'] as const)(
  'rejects a %s frontier even when the admission journal is rehashed', async kind => {
    const state = structuredClone(fixture.state), admission = state.waveAdmission!
    if (kind === 'missing') { Reflect.deleteProperty(admission, 'inputArtifacts'); Reflect.deleteProperty(admission, 'inputDigest') }
    if (kind === 'removed-upstream') admission.inputArtifacts = admission.inputArtifacts!.slice(1)
    if (kind === 'added-sibling') admission.inputArtifacts = artifactReferences(state.artifacts)
    if (kind === 'changed-digest') admission.inputArtifacts = admission.inputArtifacts!.map((value, index) =>
      index === 0 ? { ...value, contentDigest: 'f'.repeat(64) } : value)
    if (kind !== 'missing') admission.inputDigest = await sha256(admission.inputArtifacts)
    state.journal.findLast(event => event.type === 'wave.admitted')!.payload = structuredClone(admission)
    await rehash(state)
    await expect(RunMachine.fromState(fixture.machine.definition, state, undefined, selected.load)).rejects.toThrow(/snapshot/)
  },
)

it('rejects an attempt with a different input contract despite a matching outcome and rehashed journal', async () => {
  const machine = await RunMachine.fromState(fixture.machine.definition, structuredClone(fixture.state), undefined, selected.load)
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: fixture.store, provider: fixture.provider })
  const state = await selected.select(machine), emptyDigest = await sha256([])
  for (const event of state.journal) {
    const record = event.type === 'task.accepted' ? (event.payload as { artifact: ArtifactRecord }).artifact
      : event.type === 'agent.attempt-admitted' ? event.payload as InFlightAgentAttempt : undefined
    if (record?.taskId === fixture.pendingId) { record.execution!.inputCount = 0; record.execution!.inputDigest = emptyDigest }
  }
  for (const artifact of state.artifacts) if (artifact.taskId === fixture.pendingId) {
    artifact.execution!.inputCount = 0; artifact.execution!.inputDigest = emptyDigest
  }
  await rehash(state)
  await expect(RunMachine.fromState(machine.definition, state, undefined, selected.load)).rejects.toThrow('no matching state selection')
})

it('does not overwrite a concurrent state change while hashing a new wave admission', async () => {
  const release = fixture.release, id = 'admission-race'
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await machine.start()
  let entered!: () => void, releaseHash!: () => void
  const entering = new Promise<void>(resolve => { entered = resolve }), barrier = new Promise<void>(resolve => { releaseHash = resolve })
  const real = canonical.sha256
  const spy = vi.spyOn(canonical, 'sha256').mockImplementation(async value => {
    if (Array.isArray(value) && value.length === 0) { entered(); await barrier }
    return real(value)
  })
  try {
    const stage = machine.definition.stages[0]!, wave = stage.waves[0]!
    const pending = machine.admitWave(stage.id, wave.id), rejected = expect(pending).rejects.toThrow('predecessor changed')
    await entering
    await machine.recordFailure(wave.tasks[0]!, new Error('concurrent synthetic event'))
    const state = machine.snapshot()
    releaseHash(); await rejected
    expect(machine.snapshot()).toEqual(state)
    expect(machine.view().waveAdmission).toBeNull()
  } finally { releaseHash(); spy.mockRestore() }
})
