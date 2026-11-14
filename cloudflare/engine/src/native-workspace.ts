import { assertWorkspaceMutationOwner, mutationSandboxName, type WorkspaceMutationOwner } from './workspace-mutation-owner.js'
import { PermanentRunFailure } from './run-errors.js'
import { canonicalJson } from './canonical.js'
import type { AgentRequest, TaskDefinition } from './contracts.js'
import { sha256 } from './canonical.js'
import { providerIdentity, taskBackend } from './provider-identity.js'
import { subscriptionCredentialSource } from './subscription-credentials.js'

export function taskUsesSandbox(task: TaskDefinition): boolean {
  return !['coverage-union', 'review-union', 'final-seal'].includes(task.promptKind)
}

/** Logical lanes share scratch/native HOME only while their native route is
 * unchanged. Derive allocation from the sealed task, never from secret values or
 * the whole manifest revision (unrelated amendments must not discard sessions).
 * Historical allocation names are interpreted by their owning app version. */
export async function nativeWorkspaceKey(task: TaskDefinition): Promise<string> {
  if (taskBackend(task) === 'deterministic') return task.workspaceKey
  const connection = task.connection
  const digest = await sha256({ lane: task.workspaceKey, backend: taskBackend(task),
    provider: providerIdentity(task), model: task.model, cyberAccessProgram: task.cyberAccessProgram,
    credentialSource: subscriptionCredentialSource(task),
    connection: connection === undefined ? undefined : { baseUrl: connection.baseUrl,
      apiKeyEnv: connection.apiKeyEnv, headersEnv: connection.headersEnv },
  })
  return `native-${digest}`
}

export function assertCurrentWorkspaceRequest(request: AgentRequest): void {
  if (Object.hasOwn(request, 'workspaceAllocationRunId') || Object.hasOwn(request, 'retainedSandboxObjectId')) {
    throw new PermanentRunFailure('workspace request belongs to its historical app version', 'integrity-failed')
  }
}

/** Same allocation identity for execution and command-bound observation. */
export async function nativeSandboxName(request: AgentRequest): Promise<string> {
  assertCurrentWorkspaceRequest(request)
  const lane = await nativeWorkspaceKey(request.task)
  const mutationOwner = request.execution?.mutationOwner
  if (mutationOwner !== undefined && canonicalJson(mutationOwner.authority) !== canonicalJson(request.executionAuthority)) throw new Error('covered allocation authority differs')
  return workspaceAllocationName({ runId: request.runId, workspaceKey: lane, mutationOwner })
}

export async function nativeAllocationName(allocationRunId: string, workspaceKey: string): Promise<string> {
  return `a0-${(await sha256(`${allocationRunId}:${workspaceKey}`)).slice(0, 30)}`
}


/** One allocation projection for provider, custody and cleanup; no mutable lookup. */
export async function workspaceAllocationName(input: { runId: string; workspaceKey: string; freshSuffix?: string; mutationOwner?: WorkspaceMutationOwner | undefined }): Promise<string> {
  if (input.mutationOwner === undefined) return nativeAllocationName(input.runId, input.workspaceKey + (input.freshSuffix ?? ''))
  assertWorkspaceMutationOwner(input.mutationOwner)
  if (input.freshSuffix !== undefined || input.mutationOwner.workspaceKey !== input.workspaceKey
    || input.mutationOwner.authority.executionId !== input.runId) throw new Error('covered allocation identity differs')
  return mutationSandboxName(input.mutationOwner)
}
