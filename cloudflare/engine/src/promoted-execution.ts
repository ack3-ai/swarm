import type {
  AgentProvider,
  AgentRequest,
  AgentResult,
  ExperimentDefinition,
  PromotedExecutionEvidence,
  ProviderUsage,
  RunState,
} from './contracts.js'
import type { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import type { R2AgentExecutionLogStore } from './agent-execution-log.js'
import type { R2ArtifactStore } from './cloudflare-storage.js'
import { canonicalJson, sha256 } from './canonical.js'
import { agentResultFromExecutionReceipt } from './late-upstream-handoff.js'
import { providerIdentity } from './provider-identity.js'
import { validateAgentResult } from './protocol-validation.js'
import { selectVisibleArtifacts } from './prompts.js'

export interface PromotedExecutionSelection {
  taskId: string
  sourceAttempt: number
  requestDigest: string
  /** Explicit zero-model revalidation of one already quarantined output. */
  quarantineOutputDigest?: string
}

type ReceiptReader = Pick<R2AgentExecutionReceiptStore, 'get'>
type RequestReader = Pick<R2AgentExecutionLogStore, 'getRequest'>

function receiptUsage(result: {
  subscriptionWaits?: ProviderUsage['subscriptionWaits']
  inputTokens: number
  rawInputTokens?: number
  cachedInputTokens?: number
  cacheAccountingComplete?: boolean
  costAccountingComplete?: boolean
  outputTokens: number
  costUsd: number
}): ProviderUsage {
  return {
    modelCalls: 1,
    ...(result.subscriptionWaits === undefined ? {} : { subscriptionWaits: result.subscriptionWaits }),
    inputTokens: result.inputTokens,
    ...(result.rawInputTokens === undefined ? {} : { rawInputTokens: result.rawInputTokens }),
    ...(result.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.cachedInputTokens }),
    ...(result.cacheAccountingComplete === undefined
      ? {} : { cacheAccountingComplete: result.cacheAccountingComplete }),
    ...(result.costAccountingComplete === undefined
      ? {} : { costAccountingComplete: result.costAccountingComplete }),
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  }
}

function exactVisibleArtifacts(source: RunState, refs: readonly { id: string, contentDigest: string }[]) {
  const artifacts = refs.map(reference => source.artifacts.find(artifact => (
    artifact.id === reference.id && artifact.contentDigest === reference.contentDigest
  )))
  if (artifacts.some(artifact => artifact === undefined)) {
    throw new Error('promoted execution input frontier is incomplete')
  }
  return artifacts as NonNullable<(typeof artifacts)[number]>[]
}

async function loadBoundResult(input: {
  sourceRunId: string
  stageId: string
  waveId: string
  taskId: string
  sourceAttempt: number
  requestDigest: string
  promptDigest: string
  request: AgentRequest
  receipts: ReceiptReader
  requests: RequestReader
  executionSuccess?: boolean
}): Promise<AgentResult> {
  const recorded = await input.requests.getRequest(input.sourceRunId, input.taskId, input.requestDigest)
  if (recorded === null
    || recorded.runId !== input.sourceRunId
    || recorded.stageId !== input.stageId
    || recorded.waveId !== input.waveId
    || recorded.taskId !== input.taskId
    || recorded.attempt !== input.sourceAttempt
    || recorded.requestDigest !== input.requestDigest
    || recorded.promptDigest !== input.promptDigest
    || await sha256(recorded.prompt) !== recorded.promptDigest
    || recorded.model !== input.request.task.model
    || recorded.provider !== providerIdentity(input.request.task)) {
    throw new Error('promoted execution request provenance mismatch')
  }
  const receipt = await input.receipts.get(input.sourceRunId, input.requestDigest)
  if (receipt === null) throw new Error('promoted execution receipt is unavailable')
  return agentResultFromExecutionReceipt(
    { ...input.request, attempt: input.sourceAttempt }, receipt, input.requestDigest, input.executionSuccess ?? false,
  )
}

export async function preparePromotedExecution(input: {
  definition: ExperimentDefinition
  source: RunState
  selection: PromotedExecutionSelection
  receipts: ReceiptReader
  requests: RequestReader
  quarantined?: Pick<R2ArtifactStore, 'readRejected'>
}): Promise<PromotedExecutionEvidence> {
  const scheduler = input.source.discoveryScheduler
  const admission = scheduler?.admissions.find(candidate => candidate.taskIds.includes(input.selection.taskId))
  const waveAdmission = input.source.waveAdmission
  const stage = admission === undefined
    ? input.definition.stages[input.source.cursor.stageIndex]
    : input.definition.stages.find(candidate => candidate.id === admission.stageId)
  const wave = admission === undefined
    ? stage?.waves[input.source.cursor.waveIndex]
    : stage?.waves[admission.waveIndex]
  const task = wave?.tasks.find(candidate => candidate.id === input.selection.taskId)
  const globalAdmissionMatches = admission === undefined
    && waveAdmission !== undefined && waveAdmission !== null
    && waveAdmission.stageId === stage?.id
    && waveAdmission.waveId === wave?.id
    && waveAdmission.cursor.stageIndex === input.source.cursor.stageIndex
    && waveAdmission.cursor.waveIndex === input.source.cursor.waveIndex
  if (stage?.kind !== 'discovery'
    || (admission === undefined ? !globalAdmissionMatches : wave?.id !== admission.waveId)
    || wave === undefined || task === undefined || task.providerClass !== 'additive') {
    throw new Error('promoted execution does not match an admitted additive discovery task')
  }
  const rejections = input.source.rejectedAttempts.filter(rejection => (
    rejection.stageId === stage.id
      && rejection.waveId === wave.id
      && rejection.taskId === task.id
      && rejection.attempt === input.selection.sourceAttempt
      && (rejection.repairScopeRunId ?? input.source.runId) === input.source.runId
  ))
  if (rejections.length !== 1) throw new Error('promoted execution rejection is missing or ambiguous')
  const rejection = rejections[0]!
  const quarantined = input.selection.quarantineOutputDigest !== undefined
  if (quarantined) {
    if (rejection.outputDigest !== input.selection.quarantineOutputDigest
      || rejection.quarantineUri === null || input.quarantined === undefined
      || rejection.usage.modelCalls !== 1 || rejection.sessionId === null) {
      throw new Error('quarantined promotion source is invalid')
    }
  } else if (rejection.outputDigest !== null || rejection.quarantineUri !== null || rejection.usage.modelCalls !== 1) {
    throw new Error('promoted execution is not an exhausted transport result')
  }
  const visibleArtifacts = admission === undefined
    ? selectVisibleArtifacts(
      task,
      input.source.artifacts,
      input.source.waveReceipts,
      input.source.cursor.stageIndex,
      input.source.cursor.waveIndex,
      input.definition,
    )
    : exactVisibleArtifacts(input.source, admission.inputArtifacts)
  const inputDigest = admission?.inputDigest
  const request: AgentRequest = {
    experimentId: input.definition.id,
    runId: input.source.runId,
    stage,
    wave,
    task,
    prompt: '',
    promptDigest: rejection.promptDigest,
    visibleArtifacts,
    ...(inputDigest === undefined ? {} : { inputDigest }),
    releaseDigest: input.source.releaseDigest,
    attempt: rejection.attempt,
    diagnostics: rejection.diagnostics,
    repairFiles: {},
    freshContext: rejection.freshContext,
    continuationMode: rejection.continuationMode,
    sessionId: rejection.sessionId,
  }
  const result = await loadBoundResult({
    sourceRunId: input.source.runId,
    stageId: stage.id,
    waveId: wave.id,
    taskId: task.id,
    sourceAttempt: rejection.attempt,
    requestDigest: input.selection.requestDigest,
    promptDigest: rejection.promptDigest,
    request,
    receipts: input.receipts,
    requests: input.requests,
    executionSuccess: quarantined,
  })
  if (quarantined) {
    if ((result.sessionId ?? result.actorId) !== rejection.sessionId) {
      throw new Error('quarantined output session differs from its rejected source')
    }
    const files = await input.quarantined!.readRejected(rejection.quarantineUri!, rejection.outputDigest!, task.id)
    if (await sha256(canonicalJson(files)) !== await sha256(canonicalJson(result.files))) {
      throw new Error('quarantined output differs from its immutable execution receipt')
    }
  }
  const issues = await validateAgentResult(task, result, visibleArtifacts)
  if (issues.length > 0) throw new Error(`promoted execution failed protocol validation: ${issues.join('; ')}`)
  const usage = receiptUsage(result)
  if (canonicalJson(usage) !== canonicalJson(rejection.usage)) {
    throw new Error('promoted execution usage differs from its recorded rejection')
  }
  return {
    sourceRunId: input.source.runId,
    stageId: stage.id,
    waveId: wave.id,
    taskId: task.id,
    sourceAttempt: rejection.attempt,
    requestDigest: input.selection.requestDigest,
    promptDigest: rejection.promptDigest,
    outputDigest: await sha256(canonicalJson(result.files)),
    ...(quarantined ? { quarantineOutputDigest: rejection.outputDigest! } : {}),
    ...(inputDigest === undefined ? {} : { inputDigest }),
    releaseDigest: input.source.releaseDigest,
    usage,
  }
}

export class PromotedExecutionProvider implements AgentProvider {
  constructor(
    private readonly fallback: AgentProvider,
    private readonly receipts: ReceiptReader,
    private readonly requests: RequestReader,
    private readonly evidence?: PromotedExecutionEvidence,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    const evidence = this.evidence
    if (evidence === undefined
      || request.stage.id !== evidence.stageId
      || request.wave.id !== evidence.waveId
      || request.task.id !== evidence.taskId) return this.fallback.run(request)
    if (request.releaseDigest !== evidence.releaseDigest || request.inputDigest !== evidence.inputDigest) {
      throw new Error('promoted execution current frontier differs from its source')
    }
    const result = await loadBoundResult({
      ...evidence,
      request,
      receipts: this.receipts,
      requests: this.requests,
      executionSuccess: evidence.quarantineOutputDigest !== undefined,
    })
    if (await sha256(canonicalJson(result.files)) !== evidence.outputDigest
      || canonicalJson(receiptUsage(result)) !== canonicalJson(evidence.usage)) {
      throw new Error('promoted execution result differs from prepared evidence')
    }
    return {
      ...result,
      assertions: [...result.assertions, `promoted-execution:${evidence.sourceRunId}:${evidence.requestDigest}`],
      modelCalls: 0,
      inputTokens: 0,
      rawInputTokens: 0,
      cachedInputTokens: 0,
      cacheAccountingComplete: true,
      costAccountingComplete: true,
      outputTokens: 0,
      costUsd: 0,
    }
  }

  async disposeWorkspace(input: { runId: string, workspaceKey: string, freshSuffix?: string }) {
    return this.fallback.disposeWorkspace?.(input)
  }


}
