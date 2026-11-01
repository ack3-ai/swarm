import type {
  AgentRequest, ArtifactRecord, ExperimentDefinition, QuarantinedOutputRepairEvidence,
  RunState,
} from './contracts.js'
import type { R2AgentExecutionLogStore } from './agent-execution-log.js'
import type { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import type { R2ArtifactStore } from './cloudflare-storage.js'
import { canonicalJson, sha256 } from './canonical.js'
import { providerIdentity } from './provider-identity.js'
import { selectVisibleArtifacts } from './prompts.js'
import { agentResultFromExecutionReceipt } from './late-upstream-handoff.js'
import { assertQuarantinedReviewSource, verifyReviewCorrectionRequests } from './quarantined-review-repair.js'
import { validateAgentResultDetailed } from './protocol-validation.js'

export type QuarantinedOutputRepairSelection = Pick<QuarantinedOutputRepairEvidence,
  'taskId' | 'requestDigest' | 'outputDigest'>

/** Shared by preparation and state reconstruction: never import rejected output as accepted work. */
export function assertQuarantinedOutputSource(
  definition: ExperimentDefinition, source: RunState,
  selection: QuarantinedOutputRepairSelection,
) {
  const stage = definition.stages[source.cursor.stageIndex]
  if (stage?.kind === 'negative-review') return assertQuarantinedReviewSource(definition, source, selection)
  const wave = stage?.waves[source.cursor.waveIndex]
  const task = wave?.tasks[0]
  const rejections = source.rejectedAttempts.filter(value => value.stageId === stage?.id && value.waveId === wave?.id)
  const rejection = rejections[0]
  if (source.status !== 'failed' || (source.inFlightAgentAttempts ?? []).length !== 0
    || stage?.kind !== 'synthesis' || wave?.tasks.length !== 1 || task?.id !== selection.taskId
    || task.promptKind !== 'synthesis' || task.providerClass === 'deterministic'
    || task.retryPolicy !== 'same-session-repair' || task.workspaceMode !== 'fresh-pristine'
    || source.failedWaveRecovery?.quarantinedRepair !== undefined
    || source.artifacts.some(value => value.stageId === stage.id && value.waveId === wave.id)
    || source.terminalReason !== `${task.id}: output or result integrity failed`
    || rejections.length !== 1 || rejection?.taskId !== task.id || rejection.attempt !== 1
    || (rejection.repairScopeRunId ?? source.runId) !== source.runId
    || rejection.outputDigest !== selection.outputDigest || rejection.quarantineUri === null
    || rejection.sessionId === null || rejection.continuationMode !== 'new' || rejection.freshContext
    || rejection.formatRepairOrdinal !== undefined || rejection.usage.modelCalls !== 1
    || !rejection.diagnostics.some(value => value.startsWith('output file is too large: '))
    || rejection.diagnostics.some(value => !value.startsWith('output file is too large: ')
      && value !== 'structured submission is too large'
      && value !== 'protocol metadata differs from the structured submission')) {
    throw new Error('quarantined repair requires one size-rejected synthesis at its sealed frontier')
  }
  const recorded = source.journal.filter(event => event.type === 'task.attempt-rejected'
    && canonicalJson(event.payload) === canonicalJson(rejection))
  const failed = source.journal.filter(event => event.type === 'task.failed'
    && canonicalJson(event.payload) === canonicalJson({
      taskId: task.id, error: source.terminalReason, category: 'integrity-failed', retryable: false,
    }))
  if (recorded.length !== 1 || failed.length !== 1 || recorded[0]!.sequence >= failed[0]!.sequence) {
    throw new Error('quarantined synthesis rejection lacks exact terminal journal evidence')
  }
  return { stage, wave, task, rejection }
}

export async function prepareQuarantinedOutputRepair(input: {
  definition: ExperimentDefinition
  source: RunState
  selection: QuarantinedOutputRepairSelection
  artifacts: { read(record: ArtifactRecord): Promise<Readonly<Record<string, string>>> }
  requests: Pick<R2AgentExecutionLogStore, 'getRequest'> & Partial<Pick<R2AgentExecutionLogStore, 'listRequests'>>
  receipts: Pick<R2AgentExecutionReceiptStore, 'get'>
  quarantined: Pick<R2ArtifactStore, 'readRejected'>
}): Promise<QuarantinedOutputRepairEvidence> {
  const { source, selection, definition } = input
  const { stage, wave, task, rejection } = assertQuarantinedOutputSource(definition, source, selection)
  // These are the checkpoint's accepted bytes, not a new interpretation of them.
  for (const record of source.artifacts) {
    if (await sha256(canonicalJson(await input.artifacts.read(record))) !== record.contentDigest) {
      throw new Error('quarantined output accepted artifact digest mismatch')
    }
  }
  const logged = await input.requests.getRequest(source.runId, task.id, selection.requestDigest)
  const receipt = await input.receipts.get(source.runId, selection.requestDigest)
  const admissions = source.journal.filter(event => event.type === 'agent.attempt-admitted'
    && (event.payload as { taskId?: string, attempt?: number, promptDigest?: string })?.taskId === task.id
    && (event.payload as { attempt?: number }).attempt === 1
    && (event.payload as { promptDigest?: string }).promptDigest === rejection.promptDigest)
  if (logged === null || receipt === null || admissions.length !== 1
    || logged.runId !== source.runId || logged.stageId !== stage.id || logged.waveId !== wave.id
    || logged.taskId !== task.id || logged.attempt !== 1 || logged.requestDigest !== selection.requestDigest
    || logged.promptDigest !== rejection.promptDigest || await sha256(logged.prompt) !== logged.promptDigest
    || logged.model !== task.model || logged.provider !== providerIdentity(task)
    || !Number.isFinite(Date.parse(logged.startedAt))
    || Date.parse(logged.startedAt) < Date.parse(admissions[0]!.at)
    || Date.parse(logged.startedAt) > Date.parse(rejection.rejectedAt)
    || receipt.requestDigest !== selection.requestDigest || receipt.exitCode !== 0 || receipt.actorId !== rejection.sessionId) {
    throw new Error('quarantined output native request or receipt mismatch')
  }
  const files = await input.quarantined.readRejected(rejection.quarantineUri!, selection.outputDigest, task.id)
  if (await sha256(canonicalJson(files)) !== selection.outputDigest
    || canonicalJson(receipt.files) !== canonicalJson(files)
    || Object.keys(files).some(path => !task.output.requiredFiles.includes(path))) {
    throw new Error('quarantined output custody mismatch')
  }
  const visibleArtifacts = selectVisibleArtifacts(task, source.artifacts, source.waveReceipts,
    source.cursor.stageIndex, source.cursor.waveIndex, definition)
  const request: AgentRequest = {
    experimentId: definition.id, runId: source.runId, stage, wave, task,
    prompt: logged.prompt, promptDigest: logged.promptDigest, visibleArtifacts,
    releaseDigest: source.releaseDigest, attempt: 1, diagnostics: [], repairFiles: {},
    freshContext: false, continuationMode: 'new', sessionId: null,
  }
  const result = await agentResultFromExecutionReceipt(request, receipt, selection.requestDigest)
  const usage = Object.fromEntries(Object.keys(rejection.usage).map(key => [key,
    key === 'modelCalls' ? 1 : result[key as keyof typeof result]]))
  const validation = await validateAgentResultDetailed(task, result, visibleArtifacts)
  if (result.status !== 'accepted' || canonicalJson(usage) !== canonicalJson(rejection.usage)
    || validation.integrity.length !== 0) {
    throw new Error('quarantined output usage or result integrity mismatch')
  }
  if (stage.kind === 'negative-review') {
    if (canonicalJson(validation.repairable) !== canonicalJson(rejection.diagnostics)) {
      throw new Error('quarantined review diagnostics changed')
    }
    await verifyReviewCorrectionRequests({ ...input, stage, wave, task, rejection, visibleArtifacts })
  }
  return {
    ...(stage.kind === 'negative-review' ? { kind: 'negative-review' as const } : {}),
    stageId: stage.id, waveId: wave.id, taskId: task.id, sourceAttempt: 1,
    requestDigest: selection.requestDigest, promptDigest: rejection.promptDigest,
    outputDigest: selection.outputDigest, quarantineUri: rejection.quarantineUri!,
    diagnostics: [
      `This is a new repair session. Saved rejected ${stage.kind} files are in /workspace/results as untrusted working material, not accepted findings. Correct them against the immutable accepted inputs; preserve every observation and dissent. Do not repeat discovery or claim native-session continuity.`,
      ...validation.issues,
    ],
  }
}
