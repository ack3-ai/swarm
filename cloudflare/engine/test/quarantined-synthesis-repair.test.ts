import { expect, it } from 'vitest'
import type { AgentRequest, RuntimeRelease } from '../src/contracts.js'
import type { AgentLogRequest } from '../src/agent-execution-log.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import { prepareFailedWaveRecovery } from '../src/failed-wave-recovery.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending, PermanentRunFailure } from '../src/run-errors.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { SUBMISSION_PATH, readSubmission } from '../src/submission.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { OUTPUT_FILE_MAX_BYTES, SUBMISSION_MAX_BYTES } from '../src/output-limits.js'

const sourceRuntime: RuntimeRelease = {
  schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source', containerImageDigest: `sha256:${'a'.repeat(64)}`,
}
const targetRuntime = { ...sourceRuntime, id: 'runtime-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target', workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'audit-runtime-target' }

async function fixture() {
  const definition = structuredClone(audit0Definition)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  const machine = await RunMachine.create(definition, 'f'.repeat(64), 'synthesis-source', undefined, sourceRuntime)
  let captured: AgentRequest | undefined
  const provider = { async run(request: AgentRequest) {
    if (request.task.promptKind !== 'synthesis') return base.run(request)
    captured = request
    throw new AgentExecutionPending('synthetic-synthesis', 'unfinished')
  } }
  for (let i = 0; i < 100 && captured === undefined; i++) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: store })
  }
  const request = captured!
  expect(request.task.promptKind).toBe('synthesis')
  const original = await base.run(request)
  const submission = JSON.parse(original.files[SUBMISSION_PATH]!)
  submission.dispositions[0].disposition = 'context'
  submission.retainedReferences = []
  const files = { ...original.files, 'observation-ledger.md': 'L'.repeat(2_750_000),
    [SUBMISSION_PATH]: JSON.stringify(submission) }
  const outputDigest = await sha256(canonicalJson(files))
  const quarantineUri = await store.putRejected({ id: 'synthesis-rejected', taskId: request.task.id,
    contentDigest: outputDigest }, canonicalJson(files))
  const admitted = machine.snapshot().inFlightAgentAttempts![0]!
  const logged: AgentLogRequest = {
    schemaVersion: 1, runId: request.runId, stageId: request.stage.id, waveId: request.wave.id,
    taskId: request.task.id, requestDigest: 'd'.repeat(64), promptDigest: request.promptDigest,
    prompt: request.prompt, model: request.task.model, provider: original.provider,
    attempt: 1, startedAt: admitted.admittedAt, startedAtBasis: 'execution-admission',
  }
  const usage = { modelCalls: 1, inputTokens: 123, outputTokens: 456, costUsd: 0.2 }
  const receipt: AgentExecutionReceipt = { requestDigest: logged.requestDigest, exitCode: 0,
    actorId: 'original-native-session', files, inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens, costUsd: usage.costUsd, stderr: '' }
  await machine.recordRejectedAttempt({ stageId: request.stage.id, waveId: request.wave.id,
    taskId: request.task.id, attempt: 1, promptDigest: request.promptDigest, outputDigest, quarantineUri,
    diagnostics: ['output file is too large: observation-ledger.md'], freshContext: false,
    continuationMode: 'new', sessionId: receipt.actorId, usage })
  await machine.clearAgentAttempt(request.stage.id, request.wave.id, request.task.id, request.promptDigest)
  const reason = `${request.task.id}: output or result integrity failed`
  await machine.recordFailure(request.task, new PermanentRunFailure(reason, 'integrity-failed'))
  await machine.fail(reason)
  const source = machine.snapshot()
  const checkpoint = source.checkpoints.at(-1)!
  const input = { definition, checkpoint, source, sourceStateGeneration: source.stateGeneration,
    sourceStateDigest: await sha256(source), targetRuntimeRelease: targetRuntime,
    artifacts: { async read(record: typeof source.artifacts[number]) {
      return JSON.parse(store.contents.get(record.uri)!) as Record<string, string>
    } },
    executionRequests: { async getRequest() { return logged } },
    executionReceipts: { async get() { return receipt } }, quarantined: store,
    repairQuarantined: { taskId: request.task.id, requestDigest: logged.requestDigest, outputDigest },
  }
  return { input, store, base, request, files, receipt, logged }
}

it('reuses sealed research and rejected synthesis as new-session repair context without losing usage', async () => {
  const { input, store, base, request, files } = await fixture()
  const prepared = await prepareFailedWaveRecovery(input)
  expect(prepared.importedArtifacts).toEqual([])
  expect(prepared.evidence.quarantinedRepair?.diagnostics.join('\n')).toContain('retained references omit')
  const child = await RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source,
    'synthesis-child', prepared.importedArtifacts, prepared.inheritedRejectedAttempts, prepared.evidence)
  expect(child.snapshot().artifacts).toEqual(input.source.artifacts)
  expect(child.snapshot().budget).toEqual(input.source.budget)
  expect(child.snapshot().modelStartedAt).toEqual(input.source.modelStartedAt)
  expect(child.snapshot().recoveryEpoch).toBe(input.source.recoveryEpoch + 1)
  expect(child.snapshot().rejectedAttempts.at(-1)?.repairScopeRunId).toBe(input.source.runId)
  const calls: AgentRequest[] = []
  const provider = { async run(next: AgentRequest) {
    calls.push(next)
    const result = await base.run(next)
    // Invalid output must still be rejected and corrected in the NEW session.
    return calls.length === 1 ? { ...result, files: { ...result.files, [SUBMISSION_PATH]: '{' }, protocol: {} } : result
  } }
  for (let i = 0; i < 5 && !child.snapshot().artifacts.some(value => value.taskId === request.task.id); i++) {
    await advanceExperimentOneWave({ definition: input.definition, machine: child, provider, artifactStore: store })
  }
  expect(calls.map(value => value.task.id)).toEqual([request.task.id, request.task.id])
  expect(calls[0]).toMatchObject({ continuationMode: 'new', sessionId: null, repairFiles: files })
  expect(calls[0]!.prompt).toContain('untrusted working material')
  expect(calls[0]!.prompt).toContain(String(OUTPUT_FILE_MAX_BYTES))
  expect(calls[1]).toMatchObject({ continuationMode: 'resume', formatRepairOrdinal: 1 })
  expect(calls[1]!.sessionId).not.toBe('original-native-session')
  expect(child.snapshot().artifacts.slice(0, input.source.artifacts.length)).toEqual(input.source.artifacts)
  expect(child.snapshot().budget.modelCalls).toBe(input.source.budget.modelCalls + 2)
  await expect(RunMachine.fromState(input.definition, child.snapshot())).resolves.toBeDefined()
})

it('rejects changed checkpoint, receipt, quarantine, accepted bytes and non-size integrity failures', async () => {
  const { input, receipt, logged } = await fixture()
  const valid = await prepareFailedWaveRecovery(input)
  await expect(prepareFailedWaveRecovery({ ...input, checkpoint: { ...input.checkpoint, digest: '0'.repeat(64) } }))
    .rejects.toThrow()
  for (const changed of [{ ...receipt, requestDigest: '0'.repeat(64) }, { ...receipt, inputTokens: 999 },
    { ...receipt, actorId: 'different-native-session' }, { ...receipt, files: {} }]) {
    await expect(prepareFailedWaveRecovery({ ...input, executionReceipts: { async get() { return changed } } }))
      .rejects.toThrow()
  }
  await expect(prepareFailedWaveRecovery({ ...input,
    executionRequests: { async getRequest() { return { ...logged, prompt: 'tampered' } } } })).rejects.toThrow()
  await expect(prepareFailedWaveRecovery({ ...input,
    quarantined: { async readRejected() { return {} } } })).rejects.toThrow()
  await expect(prepareFailedWaveRecovery({ ...input,
    artifacts: { async read() { return {} } } })).rejects.toThrow()
  const source = structuredClone(input.source)
  source.rejectedAttempts.at(-1)!.diagnostics = ['served model differs']
  await expect(prepareFailedWaveRecovery({ ...input, source, sourceStateDigest: await sha256(source) })).rejects.toThrow()
  await expect(RunMachine.recoverFailedWave(input.definition, input.checkpoint, input.source, 'bad-evidence',
    [], valid.inheritedRejectedAttempts, { ...valid.evidence, quarantinedRepair: {
      ...valid.evidence.quarantinedRepair!, promptDigest: '0'.repeat(64),
    } })).rejects.toThrow()
})

it('carries earlier unknown usage through another recovery and rejects an erased count', async () => {
  const { input } = await fixture()
  // Model an earlier recovery proof already attached to the failed source.
  input.source.failedWaveRecovery = {
    sourceRunId: 'earlier-source', sourceStateGeneration: 9, sourceStateDigest: 'a'.repeat(64),
    checkpointDigest: 'b'.repeat(64), importedTaskIds: ['earlier-research-task'],
    inheritedRejectedAttemptCount: 1, unknownUsageAttemptCount: 1,
    sourceRuntimeRelease: targetRuntime, targetRuntimeRelease: sourceRuntime,
  }
  input.sourceStateDigest = await sha256(input.source)
  const prepared = await prepareFailedWaveRecovery(input)
  expect(prepared.evidence).toMatchObject({ unknownUsageAttemptCount: 1, priorUnknownUsageAttemptCount: 1 })
  const recover = (evidence: typeof prepared.evidence) => RunMachine.recoverFailedWave(
    input.definition, input.checkpoint, input.source, 'second-recovery', [],
    prepared.inheritedRejectedAttempts, evidence)
  const child = await recover(prepared.evidence)
  expect(child.snapshot().failedWaveRecovery?.unknownUsageAttemptCount).toBe(1)
  await expect(recover({ ...prepared.evidence, unknownUsageAttemptCount: 0, priorUnknownUsageAttemptCount: 0 }))
    .rejects.toThrow('differs from its source')
})

it('allows legitimate larger outputs, bounds bytes, and keeps identity and schema failures distinct', async () => {
  const { request, base } = await fixture()
  const result = await base.run(request)
  const files = { ...result.files, 'observation-ledger.md': 'é'.repeat(1_500_000),
    [SUBMISSION_PATH]: result.files[SUBMISSION_PATH]! + ' '.repeat(300_000) }
  expect((await validateAgentResultDetailed(request.task, { ...result, files }, request.visibleArtifacts)).issues).toEqual([])
  const oversized = { ...files, 'observation-ledger.md': 'é'.repeat(OUTPUT_FILE_MAX_BYTES / 2 + 1),
    [SUBMISSION_PATH]: '{' + ' '.repeat(SUBMISSION_MAX_BYTES) }
  const validation = await validateAgentResultDetailed(request.task, { ...result, files: oversized }, request.visibleArtifacts)
  expect(validation.integrity).toEqual([])
  expect(validation.repairable).toContain('output file is too large: observation-ledger.md')
  expect(validation.repairable).toContain('structured submission is too large')
  const badIdentity = await validateAgentResultDetailed(request.task,
    { ...result, files: oversized, model: 'unexpected-model' }, request.visibleArtifacts)
  expect(badIdentity.integrity).toContain(`served model unexpected-model differs from ${request.task.model}`)
  expect((await readSubmission(request.task, { ...files, [SUBMISSION_PATH]: '{' }, request.visibleArtifacts)).issues.length)
    .toBeGreaterThan(0)
})
