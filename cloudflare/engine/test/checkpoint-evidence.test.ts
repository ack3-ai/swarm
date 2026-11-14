import { createControlledMachine } from './support/controlled-machine.js'
import { beforeAll, expect, it } from 'vitest'
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { ExecutionReleases } from '../src/execution-releases.js'
import { verifyRegisteredCheckpoint } from '../src/checkpoint-evidence.js'
import type { CheckpointBody } from '../src/contracts.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'

let fixture: Awaited<ReturnType<typeof audit>>
async function audit() {
  const first = await sealReleasePackage(compileExperimentConfig(manifest))
  const load = async (digest: string) => {
    if (digest === first.digest) return first
    throw new Error('unknown configuration')
  }
  const id = 'checkpoint-evidence'
  const machine = await createControlledMachine(first.body.definition, first.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const provider = new DeterministicAuditProvider(), store = new MemoryArtifactStore()
  const tick = () => advanceExperimentOneWave({ definition: machine.definition, machine, provider, artifactStore: store })
  await tick()
  await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store,
    provider: { async run(request) { throw new AgentExecutionPending(request.task.id) } } })
  for (const [revision, action] of (['pause', 'continue'] as const).entries()) {
    const command = { id: `control-${revision}`, action, expectedRevision: revision,
      reason: 'test checkpoint control custody', scope: { kind: 'audit' as const } }
    const now = new Date().toISOString()
    await machine.applyAdmissionControl({ auditId: id, revision: revision + 1, version: 2, command,
      commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now })
  }
  let ticks = 0
  while (machine.view().phase !== 'complete' && ticks++ < 30) await tick()
  expect(machine.view().phase).toBe('complete')
  await machine.complete()
  const state = machine.snapshot(), releases = await ExecutionReleases.create(machine.definition, state, load)
  return { machine, state, releases, load }
}
beforeAll(async () => { fixture = await audit() })

it('verifies every registered checkpoint before and after admission controls without replaying work', async () => {
  const before = fixture.machine.snapshot()
  for (const checkpoint of before.checkpoints) await fixture.machine.verifyCheckpoint(checkpoint)
  expect(fixture.machine.snapshot()).toEqual(before)
  expect(new Set(before.checkpoints.map(value => value.body.releaseDigest)).size).toBe(1)
})

it.each(['unregistered', 'another-executor', 'missing-seal', 'repeated-seal', 'forged-successor', 'changed-time'] as const)(
  'rejects an invalid checkpoint registration: %s', async corruption => {
    const owner = structuredClone(fixture.state), checkpoint = owner.checkpoints.at(-1)!
    const seal = owner.journal.find(event => event.type === 'checkpoint.sealed'
      && (event.payload as { digest: string }).digest === checkpoint.digest)!
    if (corruption === 'unregistered') owner.checkpoints = []
    if (corruption === 'another-executor') owner.executionAuthority!.executionId = 'another-execution'
    if (corruption === 'missing-seal') owner.journal = owner.journal.filter(event => event !== seal)
    if (corruption === 'repeated-seal') owner.journal = [...owner.journal, seal]
    if (corruption === 'forged-successor') seal.payload = { digest: checkpoint.digest, cursor: { stageIndex: 0, waveIndex: 0 } }
    if (corruption === 'changed-time') { seal.at = '2026-01-01T00:00:00Z'; const { digest: _, ...unsigned } = seal; seal.digest = await sha256(unsigned) }
    await expect(verifyRegisteredCheckpoint(checkpoint, owner)).rejects.toThrow(/produced by/)
  },
)

it.each(['acceptedArtifacts', 'rejectedAttempts', 'budget', 'stageEndReceipts', 'waveReceipts', 'availabilityBoundaries',
  'schemaVersion', 'controls', 'cursor', 'modelStartedAt', 'phase', 'stateGeneration', 'rootCreatedAt', 'runtimeRelease'] as const)(
  'rejects rehashed registered bytes whose %s differs from their exact prefix', async field => {
    const owner = structuredClone(fixture.state), previous = owner.checkpoints.at(-1)!
    const body = structuredClone(previous.body)
    if (field === 'acceptedArtifacts') body.acceptedArtifacts = body.acceptedArtifacts.slice(1)
    if (field === 'rejectedAttempts') body.rejectedAttempts = [{ taskId: 'invented' }] as unknown as CheckpointBody['rejectedAttempts']
    if (field === 'budget') body.budget.modelCalls++
    if (field === 'stageEndReceipts') body.stageEndReceipts = body.stageEndReceipts.slice(1)
    if (field === 'waveReceipts') body.waveReceipts = body.waveReceipts.slice(1)
    if (field === 'availabilityBoundaries') body.availabilityBoundaries = [{ sourceTaskId: 'invented' }] as unknown as CheckpointBody['availabilityBoundaries']
    if (field === 'schemaVersion') Object.assign(body, { schemaVersion: 99 })
    if (field === 'controls') delete body.controls
    if (field === 'cursor') body.cursor = { stageIndex: 0, waveIndex: 0 }
    if (field === 'modelStartedAt') body.modelStartedAt = null
    if (field === 'phase') body.phase = 'preparation'
    if (field === 'stateGeneration') body.stateGeneration++
    if (field === 'rootCreatedAt') body.rootCreatedAt = '2026-01-01T00:00:00Z'
    if (field === 'runtimeRelease') body.runtimeRelease = { digest: 'f'.repeat(64) } as unknown as NonNullable<CheckpointBody['runtimeRelease']>
    const candidate = { body, digest: await sha256(body) }
    owner.checkpoints = owner.checkpoints.map(value => value === previous ? candidate : value)
    const index = owner.journal.findIndex(event => event.type === 'checkpoint.sealed'
      && (event.payload as { digest: string }).digest === previous.digest)
    const seal = owner.journal[index]!
    seal.payload = { digest: candidate.digest, cursor: body.cursor }
    // The attack repairs even the seal hash, not merely the untrusted candidate digest.
    const { digest: _, ...unsigned } = seal; seal.digest = await sha256(unsigned)
    await expect(verifyRegisteredCheckpoint(candidate, owner)).rejects.toThrow(/produced by/)
  },
)

it('refuses to seal a changed state while asynchronous evidence validation is in progress', async () => {
  const first = await sealReleasePackage(compileExperimentConfig(manifest)), id = 'concurrent-seal'
  const machine = await createControlledMachine(first.body.definition, first.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await machine.start()
  const pending = machine.seal()
  const rejected = expect(pending).rejects.toThrow('predecessor changed')
  await machine.fail('concurrent failure')
  await rejected
  expect(machine.view().checkpoints).toHaveLength(0)
  expect(machine.view().status).toBe('failed')
})

it('accepts zero-call optional results only when earlier evidence disabled their pool', async () => {
  const body = compileExperimentConfig(manifest)
  const review = body.definition.stages.find(stage => stage.kind === 'negative-review')!
  for (const wave of review.waves) { wave.minSuccessfulTasks = 1; wave.minDistinctActors = 1 }
  for (const task of review.waves.flatMap(wave => wave.tasks)) {
    if (task.providerClass === 'additive') task.optional = true
  }
  const release = await sealReleasePackage(body), id = 'boundary-no-native-call'
  const load = async () => release
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await machine.start()
  // A continue lifts only a matching pause (E18), so pause first; both receipts are replayed.
  for (const [revision, action] of (['pause', 'continue'] as const).entries()) {
    const command = { id: `${action}-boundary-audit`, action, scope: { kind: 'audit' as const },
      expectedRevision: revision, reason: 'Exercise controlled checkpoint replay' }
    const now = new Date().toISOString()
    await machine.applyAdmissionControl({ auditId: id, revision: revision + 1, version: 2, command,
      commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now })
  }
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const requests: string[] = []
  for (let tick = 0; machine.view().cursor.stageIndex <= release.body.definition.stages.findIndex(stage => stage.id === review.id) && tick < 30; tick++) {
    await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: store, provider: {
      run: async request => {
        requests.push(request.task.id)
        if (request.task.providerClass === 'additive' && request.stage.kind === 'discovery') return {
          status: 'additive-unavailable', actorId: 'unavailable-model', model: request.task.model,
          provider: request.task.provider!, files: {}, assertions: [], protocol: {},
          inputTokens: 0, outputTokens: 0, modelCalls: 1, costUsd: 0, unavailableReason: 'provider-credit',
        }
        return base.run(request)
      },
    } })
  }
  const state = machine.snapshot()
  const omitted = state.artifacts.find(record => record.stageId === review.id && record.unavailableReason === 'discovery-boundary')!
  expect(omitted).toBeDefined()
  expect(requests).not.toContain(omitted.taskId)
  expect(state.inFlightAgentAttempts).toEqual([])
  for (const checkpoint of state.checkpoints) await machine.verifyCheckpoint(checkpoint)
  const { isAvailabilityBoundaryAcceptance } = await import('../src/execution-availability.js')
  const task = review.waves.flatMap(wave => wave.tasks).find(task => task.id === omitted.taskId)!
  expect(await isAvailabilityBoundaryAcceptance(omitted, task, state, machine.definition)).toBe(true)
  for (const change of ['boundary', 'charged', 'content', 'required', 'actor', 'claims', 'configuration'] as const) {
    const record = structuredClone(omitted), candidate = structuredClone(task), prior = structuredClone(state)
    if (change === 'boundary') prior.availabilityBoundaries = []
    if (change === 'charged') record.usage.modelCalls = 1
    if (change === 'content') record.contentDigest = await sha256(canonicalJson({ 'invented.txt': 'output' }))
    if (change === 'required') candidate.optional = false
    if (change === 'actor') record.actorId = 'native-agent'
    if (change === 'claims') record.assertions = ['invented finding']
    if (change === 'configuration') record.execution!.releaseDigest = 'f'.repeat(64)
    expect(await isAvailabilityBoundaryAcceptance(record, candidate, prior, machine.definition)).toBe(false)
  }
})
