import type { AgentRequest, ExperimentDefinition, RunState } from './contracts.js'
import type { AgentLogRequest, R2AgentExecutionLogStore } from './agent-execution-log.js'
import type { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { canonicalJson, sha256 } from './canonical.js'
import { composePrompt } from './prompts.js'
import { providerIdentity } from './provider-identity.js'

const missingResult = 'sandbox agent process failed (1) before writing result: result read: file read failed: /workspace/private/agent-result.json: cat: /workspace/private/agent-result.json: No such file or directory\n'

/** One schema-rejected review followed by two failed correction launches. */
export function assertQuarantinedReviewSource(
  definition: ExperimentDefinition, source: RunState, selection: { taskId: string, outputDigest: string },
) {
  const stage = definition.stages[source.cursor.stageIndex]
  const wave = stage?.waves[source.cursor.waveIndex]
  const task = wave?.tasks.find(value => value.id === selection.taskId)
  const accepted = source.artifacts.filter(value => value.stageId === stage?.id && value.waveId === wave?.id)
  const rejections = source.rejectedAttempts.filter(value => value.stageId === stage?.id && value.waveId === wave?.id
    && value.taskId === selection.taskId && (value.repairScopeRunId ?? source.runId) === source.runId)
    .toSorted((a, b) => a.attempt - b.attempt)
  const rejection = rejections[0]
  if (source.status !== 'failed' || (source.inFlightAgentAttempts ?? []).length !== 0
    || stage?.kind !== 'negative-review' || wave?.tasks.length !== 2
    || task?.promptKind !== 'negative-review' || task.providerClass !== 'additive'
    || task.backend !== 'dsh-chat-completions' || task.retryPolicy !== 'fresh-repair'
    || task.workspaceMode !== 'fresh-pristine'
    || source.failedWaveRecovery?.quarantinedRepair?.taskId === task.id
    || accepted.length !== 1 || accepted[0]!.taskId === task.id || accepted[0]!.status !== 'accepted'
    || source.terminalReason !== `${task.id}: ${missingResult}`
    || rejections.length !== 3 || rejection?.attempt !== 1
    || rejection.outputDigest !== selection.outputDigest || rejection.quarantineUri === null
    || rejection.sessionId === null || rejection.continuationMode !== 'new' || rejection.freshContext
    || rejection.formatRepairOrdinal !== undefined || rejection.usage.modelCalls !== 1
    || rejection.diagnostics.length === 0
    || rejections.slice(1).some((value, index) => value.attempt !== index + 2
      || value.outputDigest !== null || value.quarantineUri !== null
      || value.sessionId !== rejection.sessionId || value.continuationMode !== 'resume' || value.freshContext
      || value.formatRepairOrdinal !== 1 || value.formatRepairSourceDigest !== rejection.outputDigest
      || value.includeDiagnosticsInRepair !== true || value.nativeTransport !== undefined
      || value.operatorWaiver !== undefined
      || canonicalJson(value.usage) !== canonicalJson({ modelCalls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0 })
      || canonicalJson(value.diagnostics) !== canonicalJson([missingResult]))) {
    throw new Error('quarantined review requires one rejected output and exhausted correction launches')
  }
  const failed = source.journal.filter(event => event.type === 'task.failed'
    && canonicalJson(event.payload) === canonicalJson({ taskId: task.id, error: source.terminalReason,
      category: 'agent-repair-exhausted', retryable: false }))
  let previousSequence = -1
  if (failed.length !== 1) throw new Error('quarantined review terminal journal differs')
  for (const value of rejections) {
    const recorded = source.journal.filter(event => event.type === 'task.attempt-rejected'
      && canonicalJson(event.payload) === canonicalJson(value) && event.at === value.rejectedAt)
    if (recorded.length !== 1 || recorded[0]!.sequence <= previousSequence
      || recorded[0]!.sequence >= failed[0]!.sequence) throw new Error('quarantined review rejection journal differs')
    previousSequence = recorded[0]!.sequence
  }
  return { stage, wave, task, rejection }
}

export async function verifyReviewCorrectionRequests(input: {
  definition: ExperimentDefinition, source: RunState,
  requests: Pick<R2AgentExecutionLogStore, 'getRequest'> & Partial<Pick<R2AgentExecutionLogStore, 'listRequests'>>,
  receipts: Pick<R2AgentExecutionReceiptStore, 'get'>,
  stage: AgentRequest['stage'], wave: AgentRequest['wave'], task: AgentRequest['task'],
  rejection: RunState['rejectedAttempts'][number], visibleArtifacts: AgentRequest['visibleArtifacts'],
}) {
  if (input.requests.listRequests === undefined) throw new Error('quarantined review correction requests missing')
  const { source, stage, wave, task, rejection } = input
  const prompt = await composePrompt({ definition: input.definition, runId: source.runId,
    stage, wave, task, visibleArtifacts: input.visibleArtifacts, releaseDigest: source.releaseDigest,
    diagnostics: rejection.diagnostics, formatRepairOnly: true })
  // Linux's single-argument bound, distinct from total ARG_MAX or model context.
  if (new TextEncoder().encode(prompt.prompt).byteLength < 131072) {
    throw new Error('quarantined review correction did not exceed the native argv limit')
  }
  const requests = await input.requests.listRequests(source.runId, task.id)
  for (const attempt of [2, 3]) {
    const matches = requests.filter(value => value.attempt === attempt)
    const logged: AgentLogRequest | undefined = matches[0]
    const rejected = source.rejectedAttempts.find(value => value.taskId === task.id && value.attempt === attempt
      && (value.repairScopeRunId ?? source.runId) === source.runId)
    const admitted = source.journal.filter(event => event.type === 'agent.attempt-admitted'
      && (event.payload as { taskId?: string })?.taskId === task.id
      && (event.payload as { attempt?: number }).attempt === attempt
      && (event.payload as { promptDigest?: string }).promptDigest === prompt.promptDigest)
    if (matches.length !== 1 || logged === undefined || rejected === undefined || admitted.length !== 1
      || logged.runId !== source.runId || logged.stageId !== stage.id || logged.waveId !== wave.id
      || logged.taskId !== task.id || logged.provider !== providerIdentity(task) || logged.model !== task.model
      || !/^[0-9a-f]{64}$/.test(logged.requestDigest)
      || logged.prompt !== prompt.prompt || logged.promptDigest !== prompt.promptDigest
      || await sha256(logged.prompt) !== rejected.promptDigest
      || !Number.isFinite(Date.parse(logged.startedAt))
      || Date.parse(logged.startedAt) < Date.parse(admitted[0]!.at)
      || Date.parse(logged.startedAt) > Date.parse(rejected.rejectedAt)
      || await input.receipts.get(source.runId, logged.requestDigest) !== null) {
      throw new Error('quarantined review correction request or missing receipt differs')
    }
  }
}
