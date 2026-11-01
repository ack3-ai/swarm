import type { AgentRequest, AgentResult, ProviderUsage } from './contracts.js'
import type { AgentExecutionReceipt } from './agent-execution-receipt.js'
import { canonicalJson } from './canonical.js'
import { classifyDeepSeekUnavailability } from './deepseek-provider.js'
import { providerDiagnosticsAreAgentActionable } from './provider-failure.js'
import { providerIdentity } from './provider-identity.js'
import { validateAgentResult } from './protocol-validation.js'
import { AgentAttemptFailure, PermanentRunFailure } from './run-errors.js'
import { readSubmission } from './submission.js'

function attemptUsage(result: AgentExecutionReceipt): ProviderUsage {
  return {
    modelCalls: 1,
    ...(result.subscriptionWaits === undefined ? {} : { subscriptionWaits: result.subscriptionWaits }),
    inputTokens: result.inputTokens,
    ...(result.rawInputTokens === undefined ? {} : { rawInputTokens: result.rawInputTokens }),
    ...(result.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.cachedInputTokens }),
    ...(result.cacheAccountingComplete === undefined
      ? {}
      : { cacheAccountingComplete: result.cacheAccountingComplete }),
    ...(result.costAccountingComplete === undefined
      ? {} : { costAccountingComplete: result.costAccountingComplete }),
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
  }
}

function additiveFailureMessage(result: AgentExecutionReceipt): string {
  const request = result.providerRequests?.at(-1)
  const requestEvidence = request === undefined ? 'none' : canonicalJson({
    provider: request.provider,
    model: request.model,
    thinking: request.thinking,
    reasoningEffort: request.reasoningEffort,
    durationMs: request.durationMs,
    timeToFirstByteMs: request.timeToFirstByteMs,
    providerHttpStatus: request.providerHttpStatus,
    requestId: request.requestId,
    finishReason: request.finishReason,
    inputTokens: request.inputTokens,
    outputTokens: request.outputTokens,
    reasoningTokens: request.reasoningTokens,
    costUsd: request.costUsd,
    abortedByClient: request.abortedByClient,
    errorCategory: request.errorCategory ?? null,
  })
  const stderr = result.stderr.trim().slice(-4_000)
  return [
    `sandbox additive agent failed (${result.exitCode}; http=${result.providerHttpStatus ?? 'none'}; code=${result.providerErrorCode ?? 'none'})`,
    `providerRequest=${requestEvidence}`,
    ...(stderr === '' ? [] : [`stderr=${stderr}`]),
  ].join('; ')
}

const lateUpstreamHandoffStatuses = new Set([502, 504])

function hasOnlyExpectedOutputs(request: AgentRequest, result: AgentExecutionReceipt): boolean {
  const expected = new Set(request.task.output.requiredFiles)
  return Object.keys(result.files).every(path => expected.has(path))
}

function exhaustedUpstreamHandoff(request: AgentRequest, result: AgentExecutionReceipt, digest: string): boolean {
  const limit = request.task.retryPolicy === 'none' ? 1
    : request.task.retryPolicy === 'redirect-then-fresh-replacement' ? 3 : 2
  const last = result.providerRequests?.at(-1)
  const nativeUpstreamFailure = request.task.backend === 'dsh-chat-completions'
    && result.providerRequests?.length === 0
    && (['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'EMPTY_RESPONSE'].includes(result.providerErrorCode ?? '')
      && result.providerHttpStatus === null
      || result.providerErrorCode === 'SERVER'
        && (result.providerHttpStatus ?? 0) >= 500 && (result.providerHttpStatus ?? 600) <= 599
      || result.providerErrorCode === 'RATE_LIMIT' && result.providerHttpStatus === 429)
  const recordedUpstreamFailure = last?.provider === providerIdentity(request.task)
    && last.model === request.task.model && last.abortedByClient === false
    && (last.errorCategory === 'transport' && last.providerHttpStatus === null
      || last.errorCategory === undefined && [502, 503, 504].includes(last.providerHttpStatus ?? 0))
  return request.task.providerClass === 'additive'
    && request.attempt === limit && result.requestDigest === digest && result.exitCode === 1
    && hasOnlyExpectedOutputs(request, result)
    && (recordedUpstreamFailure || nativeUpstreamFailure)
}

/**
 * A model process may finish its exact handoff before its final upstream turn
 * times out. The execution receipt remains failure evidence; this predicate
 * only decides whether its request-bound files may enter the normal result
 * validation/quarantine path instead of being discarded before validation.
 */
export function isLateUpstreamHandoffCandidate(
  request: AgentRequest,
  result: AgentExecutionReceipt,
  expectedRequestDigest: string,
): boolean {
  if (request.task.providerClass !== 'additive'
    || result.requestDigest !== expectedRequestDigest
    || result.exitCode !== 1
    || !lateUpstreamHandoffStatuses.has(result.providerHttpStatus ?? 0)
    || !hasOnlyExpectedOutputs(request, result)) return false
  const lastRequest = result.providerRequests?.at(-1)
  return lastRequest?.provider === providerIdentity(request.task)
    && lastRequest.providerHttpStatus === result.providerHttpStatus
    && lastRequest.abortedByClient === false
    && lastRequest.errorCategory === undefined
}

async function acceptedAgentResult(request: AgentRequest, result: AgentExecutionReceipt): Promise<AgentResult> {
  const submission = await readSubmission(request.task, result.files, request.visibleArtifacts).catch(error => {
    throw new AgentAttemptFailure(error instanceof Error ? error.message : String(error), {
      cause: error,
      usage: attemptUsage(result),
    })
  })
  return {
    ...(result.subscriptionWaits === undefined ? {} : { subscriptionWaits: result.subscriptionWaits }),
    status: 'accepted', actorId: result.actorId, model: request.task.model,
    provider: providerIdentity(request.task),
    files: result.files, assertions: [], protocol: submission.protocol,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd,
    ...(result.rawInputTokens === undefined ? {} : { rawInputTokens: result.rawInputTokens }),
    ...(result.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.cachedInputTokens }),
    ...(result.cacheAccountingComplete === undefined
      ? {}
      : { cacheAccountingComplete: result.cacheAccountingComplete }),
    ...(result.costAccountingComplete === undefined
      ? {} : { costAccountingComplete: result.costAccountingComplete }),
    sessionId: result.actorId,
    ...(result.nativeSearchEvidence === undefined ? {} : { nativeSearchEvidence: result.nativeSearchEvidence }),
  }
}

export async function agentResultFromExecutionReceipt(
  request: AgentRequest,
  result: AgentExecutionReceipt,
  expectedRequestDigest: string,
  executionSuccess = result.exitCode === 0,
  observeCandidate?: (fields: Readonly<Record<string, unknown>>) => void,
): Promise<AgentResult> {
  const unavailableReason = request.task.providerClass === 'additive' && request.task.optional === true
    ? classifyDeepSeekUnavailability(result)
    : null
  if (unavailableReason !== null) {
    return {
      status: 'additive-unavailable', actorId: result.actorId, model: request.task.model,
      provider: providerIdentity(request.task), files: {}, assertions: [], protocol: {},
      inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd,
      ...(result.rawInputTokens === undefined ? {} : { rawInputTokens: result.rawInputTokens }),
      ...(result.cachedInputTokens === undefined ? {} : { cachedInputTokens: result.cachedInputTokens }),
      ...(result.cacheAccountingComplete === undefined
        ? {} : { cacheAccountingComplete: result.cacheAccountingComplete }),
      ...(result.costAccountingComplete === undefined
        ? {} : { costAccountingComplete: result.costAccountingComplete }),
      unavailableReason,
    }
  }
  if (!executionSuccess || result.exitCode !== 0) {
    if (exhaustedUpstreamHandoff(request, result, expectedRequestDigest)) {
      // Completed evidence still takes precedence over a late provider failure.
      // Required review evidence must not be discarded by a final transport failure.
      let candidate: AgentResult | undefined
      try { candidate = await acceptedAgentResult(request, result) } catch (error) {
        if (!(error instanceof AgentAttemptFailure)) throw error
      }
      if (candidate !== undefined
        && (await validateAgentResult(request.task, candidate, request.visibleArtifacts)).length === 0) return candidate
      if (request.task.optional === true) {
        const { modelCalls: _, ...usage } = attemptUsage(result)
        return {
          status: 'additive-unavailable', actorId: result.actorId, model: request.task.model,
          provider: providerIdentity(request.task), files: {}, assertions: [], protocol: {},
          ...usage, unavailableReason: 'platform-interruption',
        }
      }
    }
    if (isLateUpstreamHandoffCandidate(request, result, expectedRequestDigest)) {
      const lastRequest = result.providerRequests!.at(-1)!
      observeCandidate?.({
        runId: request.runId,
        taskId: request.task.id,
        attempt: request.attempt,
        requestDigest: expectedRequestDigest,
        exitCode: result.exitCode,
        provider: lastRequest.provider,
        providerHttpStatus: lastRequest.providerHttpStatus,
        providerRequestId: lastRequest.requestId,
        providerRequestCount: result.providerRequests!.length,
      })
      return acceptedAgentResult(request, result)
    }
    if (request.task.providerClass === 'core' && result.subscriptionLimits?.exhausted === true) {
      throw new PermanentRunFailure('subscription quota exhausted; execution receipt preserved', 'provider-rejected', {
        cause: new AgentAttemptFailure('subscription quota exhausted', { usage: attemptUsage(result),
          includeDiagnosticsInRepair: false }),
      })
    }
    if (request.task.providerClass === 'additive') {
      throw new AgentAttemptFailure(additiveFailureMessage(result), {
        usage: attemptUsage(result),
        includeDiagnosticsInRepair: providerDiagnosticsAreAgentActionable(result),
      })
    }
    throw new AgentAttemptFailure(`sandbox agent failed (${result.exitCode}): ${result.stderr.slice(-2_000)}`, {
      usage: attemptUsage(result),
    })
  }
  return acceptedAgentResult(request, result)
}
