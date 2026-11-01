import { expect, it } from 'vitest'
import type { AgentRequest, RuntimeRelease } from '../src/contracts.js'
import type { AgentLogRequest } from '../src/agent-execution-log.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { SUBMISSION_PATH, readSubmission } from '../src/submission.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const target = { ...runtime, id: 'runtime-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
  containerImageDigest: `sha256:${'b'.repeat(64)}` }
const missingResult = 'sandbox agent process failed (1) before writing result: result read: file read failed: /workspace/private/agent-result.json: cat: /workspace/private/agent-result.json: No such file or directory\n'

async function fixture() {
  const definition = structuredClone(audit0Definition)
  const review = definition.stages.find(stage => stage.kind === 'negative-review')!.waves[0]!
  const replica = review.tasks[1]!
  Object.assign(replica, { providerClass: 'additive', backend: 'dsh-chat-completions', retryPolicy: 'fresh-repair',
    workspaceMode: 'fresh-pristine' })
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const machine = await RunMachine.create(definition, 'f'.repeat(64), 'review-source', undefined, runtime)
  const requests: AgentLogRequest[] = []
  let receipt: AgentExecutionReceipt | undefined
  let rejectedFiles: Readonly<Record<string, string>> = {}
  const provider = { async run(request: AgentRequest) {
    const result = await base.run(request)
    if (request.task.promptKind === 'research') {
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
      submission.observations = Array.from({ length: 64 }, (_, index) => ({ ...submission.observations[0], id: `A${index + 1}` }))
      const files = { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) }
      return { ...result, files, protocol: (await readSubmission(request.task, files, request.visibleArtifacts)).protocol }
    }
    if (request.task.id !== replica.id) return result
    result.actorId = result.sessionId!
    requests.push({ schemaVersion: 1, runId: request.runId, stageId: request.stage.id, waveId: request.wave.id,
      taskId: request.task.id, requestDigest: String(request.attempt).repeat(64), promptDigest: request.promptDigest,
      prompt: request.prompt, model: request.task.model, provider: result.provider, attempt: request.attempt,
      startedAt: machine.snapshot().inFlightAgentAttempts!.find(value => value.taskId === replica.id)!.admittedAt, startedAtBasis: 'execution-admission' })
    if (request.attempt > 1) throw new AgentAttemptFailure(missingResult)
    const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
    submission.decisions = submission.decisions.map(({ finalReference: _removed, ...decision }: Record<string, unknown>) => decision)
    rejectedFiles = { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) }
    const protocol = (await readSubmission(request.task, rejectedFiles, request.visibleArtifacts)).protocol
    receipt = { requestDigest: requests[0]!.requestDigest, exitCode: 0, actorId: result.actorId,
      files: rejectedFiles, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      costUsd: result.costUsd, stderr: '' }
    return { ...result, files: rejectedFiles, protocol }
  } }
  for (let i = 0; i < 100 && machine.snapshot().status !== 'failed'; i++) {
    try { await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store }) }
    catch (error) {
      expect((error as Error).message).toBe(`${replica.id}: ${missingResult}`)
      await machine.fail((error as Error).message)
    }
  }
  const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
  expect(source.status).toBe('failed')
  expect(requests.map(request => request.attempt)).toEqual([1, 2, 3])
  expect(Buffer.byteLength(requests[1]!.prompt)).toBeGreaterThan(131072)
  const rejection = source.rejectedAttempts.find(value => value.taskId === replica.id && value.attempt === 1)!
  const input = { definition, checkpoint, source, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: target,
    artifacts: { async read(record: typeof source.artifacts[number]) {
      return JSON.parse(store.contents.get(record.uri)!) as Record<string, string>
    } }, executionRequests: {
      async getRequest(_run: string, _task: string, digest: string) { return requests.find(r => r.requestDigest === digest) ?? null },
      async listRequests() { return requests },
    }, executionReceipts: { async get(_run: string, digest: string) {
      return receipt!.requestDigest === digest ? receipt! : null
    } }, quarantined: store,
    repairQuarantined: { taskId: replica.id, requestDigest: receipt!.requestDigest, outputDigest: rejection.outputDigest! },
  }
  return { input, store, base, replica, receipt: receipt!, requests, rejectedFiles }
}

it('repairs only the missing review from quarantine, preserving peer, clock, usage and validation', async () => {
  const { input, store, base, replica, rejectedFiles } = await fixture()
  const prepared = await prepareFailedWaveRecovery(input)
  expect(prepared.importedArtifacts.map(record => record.taskId)).toEqual(['negative-review-primary'])
  expect(prepared.evidence).toMatchObject({ unknownUsageAttemptCount: 2, priorUnknownUsageAttemptCount: 0,
    quarantinedRepair: { kind: 'negative-review' } })
  const child = await RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source,
    'review-child', prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
  expect(child.snapshot().artifacts).toEqual(input.source.artifacts)
  expect(child.snapshot().budget).toEqual(input.source.budget)
  expect(child.snapshot().modelStartedAt).toBe(input.source.modelStartedAt)
  const calls: AgentRequest[] = []
  const provider = { async run(request: AgentRequest) {
    calls.push(request)
    const result = await base.run(request)
    return calls.length === 1 ? { ...result, files: { ...result.files, [SUBMISSION_PATH]: '{' }, protocol: {} } : result
  } }
  for (let i = 0; i < 5 && !child.snapshot().artifacts.some(record => record.taskId === replica.id); i++) {
    await advanceExperimentOneWave({ definition: input.definition, machine: child, provider, artifactStore: store })
  }
  expect(calls.map(request => request.task.id)).toEqual([replica.id, replica.id])
  expect(calls[0]).toMatchObject({ continuationMode: 'new', sessionId: null, repairFiles: rejectedFiles })
  expect(calls[0]!.prompt).toContain('untrusted working material')
  expect(calls[1]).toMatchObject({ continuationMode: 'resume', formatRepairOrdinal: 1 })
  expect(child.snapshot().artifacts.slice(0, input.source.artifacts.length)).toEqual(input.source.artifacts)
  await expect(RunMachine.fromState(input.definition, child.snapshot())).resolves.toBeDefined()
}, 30_000)

it('rejects changed correction requests, receipts, accepted files, quarantine and same-image retry', async () => {
  const { input, requests, receipt } = await fixture()
  await expect(prepareFailedWaveRecovery({ ...input, targetRuntimeRelease: { ...target,
    containerImageDigest: runtime.containerImageDigest } })).rejects.toThrow()
  for (const changed of [requests.slice(0, 2), [...requests, requests[1]!], requests.map((r, i) => i === 1 ? { ...r, prompt: 'short' } : r)]) {
    await expect(prepareFailedWaveRecovery({ ...input, executionRequests: {
      ...input.executionRequests, async listRequests() { return changed },
    } })).rejects.toThrow()
  }
  await expect(prepareFailedWaveRecovery({ ...input, executionReceipts: { async get() { return receipt } } })).rejects.toThrow()
  await expect(prepareFailedWaveRecovery({ ...input, artifacts: { async read() { return {} } } })).rejects.toThrow()
  await expect(prepareFailedWaveRecovery({ ...input, quarantined: { async readRejected() { return {} } } })).rejects.toThrow()
  for (const alter of [
    (s: typeof input.source) => { s.rejectedAttempts.at(-1)!.sessionId = 'different-session' },
    (s: typeof input.source) => { s.journal = s.journal.filter(event => event.type !== 'task.failed') },
    (s: typeof input.source) => { s.artifacts = s.artifacts.filter(record => record.taskId !== 'negative-review-primary') },
  ]) {
    const source = structuredClone(input.source); alter(source)
    await expect(prepareFailedWaveRecovery({ ...input, source, sourceStateDigest: await sha256(source) })).rejects.toThrow()
  }
}, 30_000)

it('retains earlier uncertainty and refuses forged recovery evidence', async () => {
  const { input } = await fixture()
  input.source.failedWaveRecovery = { sourceRunId: 'prior-source', sourceStateGeneration: 3,
    sourceStateDigest: 'a'.repeat(64), checkpointDigest: 'b'.repeat(64), importedTaskIds: ['prior-task'],
    inheritedRejectedAttemptCount: 1, unknownUsageAttemptCount: 1, sourceRuntimeRelease: target, targetRuntimeRelease: runtime }
  input.sourceStateDigest = await sha256(input.source)
  const prepared = await prepareFailedWaveRecovery(input)
  expect(prepared.evidence.unknownUsageAttemptCount).toBe(3)
  const recover = (evidence: typeof prepared.evidence) => RunMachine.recoverFailedWave(input.definition,
    input.checkpoint, input.source, 'review-child', prepared.importedArtifacts, prepared.inheritedRejectedAttempts, evidence)
  await expect(recover(prepared.evidence)).resolves.toBeDefined()
  await expect(recover({ ...prepared.evidence, unknownUsageAttemptCount: 2, priorUnknownUsageAttemptCount: 0 })).rejects.toThrow()
  await expect(recover({ ...prepared.evidence, quarantinedRepair: {
    ...prepared.evidence.quarantinedRepair!, promptDigest: '0'.repeat(64),
  } })).rejects.toThrow()
  expect(canonicalJson(input.source.artifacts)).not.toContain('untrusted working material')
}, 30_000)
