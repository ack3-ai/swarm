import { assertCurrentWorkspaceRequest } from './native-workspace.js'
import type { AgentRequest } from './contracts.js'
import { taskBackend } from './provider-identity.js'
import { agentWorkingDirectory } from './agent-working-directory.js'
import { scratchCaptureRequest } from './poc-handoff.js'

/** Shared native wire projection. Never contains resolved process credentials. */
export function executionRequestBody(request: AgentRequest, workspaceId: string) {
  assertCurrentWorkspaceRequest(request)
  const scratchCapture = scratchCaptureRequest(request.task)
  return {
    prompt: request.prompt, model: request.task.model, providerClass: request.task.providerClass,
    backend: taskBackend(request.task),
    ...(request.task.cyberAccessProgram === undefined ? {} : { cyberAccessProgram: request.task.cyberAccessProgram }),
    ...(request.task.credentialSource === undefined ? {} : { credentialSource: request.task.credentialSource }),
    // Only with fallbacks: every Claude account binding in use order, primary first.
    ...(request.task.fallbackCredentialSources === undefined ? {} : {
      claudeAccounts: [request.task.credentialSource!, ...request.task.fallbackCredentialSources] }),
    ...(request.task.provider === undefined ? {} : { provider: request.task.provider }),
    ...(request.task.connection === undefined ? {} : { connection: request.task.connection }),
    ...(request.nativeSearchConnection === undefined ? {} : { searchConnection: request.nativeSearchConnection,
      searchAttribution: { agent: request.task.model,
        stage: request.stage.id, wave: request.wave.id, task: request.task.id } }),
    ...(request.enableNativeSearch === undefined ? {} : { enableNativeSearch: request.enableNativeSearch }),
    reasoningEffort: request.task.reasoning,
    ...(request.task.thinking === undefined ? {} : { thinking: request.task.thinking }),
    ...(request.task.subagents === undefined ? {} : { subagents: request.task.subagents }),
    expectedFiles: [...request.task.output.requiredFiles, ...(request.optionalOutputFiles ?? [])],
    ...(request.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: request.commandTimeoutMs }),
    ...(scratchCapture === undefined ? {} : { scratchCapture }),
    // Only with submitCheck: the runner reruns `ack3-submit` after the model run.
    ...(request.task.submitCheck === true ? { submitCheck: true as const } : {}),
    taskId: request.task.id, runId: request.runId,
    ...(request.executionAuthority === undefined ? {} : {
      executionAuthority: request.executionAuthority, taskExecutionId: request.taskExecutionId,
    }),
    ...(request.execution === undefined ? {} : { execution: request.execution }),
    attempt: request.attempt, freshContext: request.freshContext, workspaceId,
    ...(request.formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal: request.formatRepairOrdinal }),
    ...(request.formatRepairSourceDigest === undefined ? {} : { formatRepairSourceDigest: request.formatRepairSourceDigest }),
    workingDirectory: agentWorkingDirectory(request.task.promptKind),
    continuationMode: request.continuationMode, sessionId: request.sessionId,
    ...(request.nativeTransport === undefined ? {} : { nativeTransport: request.nativeTransport }),
    releaseDigest: request.releaseDigest,
    ...(request.inputDigest === undefined ? {} : { inputDigest: request.inputDigest }),
  }
}
