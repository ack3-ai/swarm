import { expect, it } from 'vitest'
import type { RuntimeRelease, ArtifactRecord } from '../src/contracts.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { prepareSealedWaveRetry } from '../src/sealed-wave-retry.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'retry-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'retry-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-retry-source', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const target = { ...runtime, frameworkCommit: 'b'.repeat(40), workerVersionId: '22222222-2222-4222-8222-222222222222' }

async function fixture(kind: 'verification' | 'reporting' = 'verification') {
  const definition = structuredClone(audit0Definition)
  const task = definition.stages.find(s => s.kind === kind)!.waves[0]!.tasks[0]!
  const machine = await RunMachine.create(definition, 'd'.repeat(64), 'sole-task-source', undefined, runtime)
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  for (let i = 0; i < 50 && machine.view().status !== 'failed'; i++) {
    try { await advanceExperimentOneWave({ definition, machine, artifactStore: artifacts,
      provider: { async run(request) {
        if (request.task.id !== task.id) return base.run(request)
        throw new AgentAttemptFailure('sandbox agent process failed (1) before writing result: result read: file read failed: /workspace/private/agent-result.json: missing', { includeDiagnosticsInRepair: true })
      } },
    }) } catch (error) { await machine.fail(String(error)) }
  }
  const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
  expect(source.status).toBe('failed')
  expect(source.phase).toBe(kind)
  const input = { definition, source, checkpoint, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: target, retirementProofDigest: 'f'.repeat(64),
    artifacts: { async read(record: ArtifactRecord) { return JSON.parse(artifacts.contents.get(record.uri)!) } } }
  return { input, artifacts, task }
}

it.each(['verification', 'reporting'] as const)('recovers only an exhausted sole %s task, preserving sealed work and usage', async kind => {
  const { input, task } = await fixture(kind)
  const p = await prepareFailedWaveRecovery(input)
  expect(p.importedArtifacts).toEqual([])
  expect(p.evidence.sealedWaveRetry).toMatchObject({ stageId: input.source.phase, taskId: task.id })
  expect(p.evidence.unknownUsageAttemptCount).toBe(2)
  const child = await RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source,
    'sole-task-child', p.importedArtifacts, p.inheritedRejectedAttempts, p.evidence)
  expect(child.view().artifacts).toEqual(input.source.artifacts)
  expect(child.view().budget).toEqual(input.source.budget)
  expect(child.view().modelStartedAt).toBe(input.source.modelStartedAt)
  await RunMachine.fromState(input.definition, child.snapshot())
  const calls: string[] = [], base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: input.definition, machine: child,
    artifactStore: new MemoryArtifactStore(), provider: { async run(request) { calls.push(request.task.id); return base.run(request) } } })
  expect(calls).toEqual([task.id])
  await expect(RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source,
    'forged-recovery', [], p.inheritedRejectedAttempts,
    { ...p.evidence, sealedWaveRetry: { ...p.evidence.sealedWaveRetry!, taskId: 'different' } })).rejects.toThrow()
  await expect(RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source,
    'forged-usage', [], p.inheritedRejectedAttempts,
    { ...p.evidence, unknownUsageAttemptCount: 0 })).rejects.toThrow()
})

it('rejects missing fences, unfinished work, output-bearing attempts, changed frontiers and images', async () => {
  const { input } = await fixture()
  for (const mutate of [
    (i: typeof input) => { i.retirementProofDigest = '' },
    (i: typeof input) => { i.source.inFlightAgentAttempts = [{} as never] },
    (i: typeof input) => { i.source.artifacts = i.source.artifacts.slice(1) },
    (i: typeof input) => { i.source.modelStartedAt = '2020-01-01T00:00:00Z' },
    (i: typeof input) => { i.source.rejectedAttempts = i.source.rejectedAttempts.slice(0, -1) },
    (i: typeof input) => { i.source.rejectedAttempts.at(-1)!.outputDigest = 'c'.repeat(64) },
    (i: typeof input) => { i.source.rejectedAttempts.at(-1)!.diagnostics = ['invalid submission'] },
    (i: typeof input) => { i.targetRuntimeRelease.containerImageDigest = `sha256:${'c'.repeat(64)}` },
  ]) {
    const copy = { ...input, source: structuredClone(input.source), targetRuntimeRelease: { ...target } }
    mutate(copy)
    await expect(prepareSealedWaveRetry(copy)).rejects.toThrow()
  }
})

it('inherits only the exact sealed image authorization and retains prior usage uncertainty', async () => {
  const { input } = await fixture()
  const prior = { sourceRunId: 'prior-review', sourceStateGeneration: 10, sourceStateDigest: '1'.repeat(64),
    checkpointDigest: '2'.repeat(64), importedTaskIds: ['negative-review-primary'], inheritedRejectedAttemptCount: 3,
    priorUnknownUsageAttemptCount: 1, unknownUsageAttemptCount: 3,
    sourceRuntimeRelease: { ...runtime, containerImageDigest: `sha256:${'c'.repeat(64)}` }, targetRuntimeRelease: runtime,
    quarantinedRepair: { kind: 'negative-review' as const, stageId: 'negative-review', waveId: 'review', taskId: 'replica',
      sourceAttempt: 1, requestDigest: '3'.repeat(64), promptDigest: '4'.repeat(64), outputDigest: '5'.repeat(64),
      quarantineUri: 'r2://ARTIFACTS/quarantine/review', diagnostics: ['missing decision'] } }
  input.source.failedWaveRecovery = prior
  input.checkpoint.body.failedWaveRecovery = structuredClone(prior)
  input.checkpoint.digest = await sha256(input.checkpoint.body)
  input.source.checkpoints = [input.checkpoint]
  input.sourceStateDigest = await sha256(input.source)
  const p = await prepareFailedWaveRecovery(input)
  expect(p.evidence.unknownUsageAttemptCount).toBe(5)
  expect(p.evidence.priorUnknownUsageAttemptCount).toBe(3)
  const body = { ...audit0PackageBody, environment: { ...audit0PackageBody.environment!,
    image: `registry.cloudflare.com/${'0'.repeat(32)}/swarm-sandbox@${prior.sourceRuntimeRelease.containerImageDigest}` } }
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, target, p.evidence)).not.toThrow()
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, target)).toThrow()
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, { ...target, workerVersionId: runtime.workerVersionId }, p.evidence)).toThrow()
  input.source.failedWaveRecovery = { ...prior, sourceStateDigest: '9'.repeat(64) }
  await expect(prepareSealedWaveRetry(input)).rejects.toThrow('frontier')
  expect(canonicalJson(p.evidence.sealedWaveRetry!.imageAuthorization)).toContain(await sha256(prior))
})
