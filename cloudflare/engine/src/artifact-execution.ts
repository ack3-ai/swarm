import { assertWorkspaceMutationOwner } from './workspace-mutation-owner.js'
import { nativeWorkspaceKey } from './native-workspace.js'
import type { ArtifactExecution, ExecutionConfiguration, ArtifactRecord, ArtifactReference, ArtifactStore, RunState, TaskDefinition } from './contracts.js'
import { deepClone, sha256 } from './canonical.js'
import { assertRuntimeRelease } from './runtime-release.js'
import { selectedTaskOccurrence, assertTaskOccurrenceExecution } from './task-occurrences.js'
import { compareText } from './text-order.js'

export function artifactReferences(artifacts: readonly Pick<ArtifactRecord, 'id' | 'contentDigest'>[]): ArtifactReference[] {
  const refs = artifacts.map(({ id, contentDigest }) => ({ id, contentDigest }))
    .sort((a, b) => compareText(a.id, b.id) || compareText(a.contentDigest, b.contentDigest))
  if (new Set(refs.map(ref => ref.id)).size !== refs.length) throw new Error('execution inputs repeat an artifact')
  return refs
}

/** Capture the inputs actually supplied, before concurrent peers can advance the frontier. */
export async function artifactExecution(input: {
  state: Pick<RunState, 'runId' | 'releaseDigest' | 'definitionDigest' | 'runtimeRelease' | 'artifacts' | 'executionAuthority' | 'waveAdmission' | 'discoveryScheduler'>
  task: TaskDefinition
  configuration?: ExecutionConfiguration
  attempt: number
  inputArtifacts: readonly ArtifactReference[]
  store: Pick<ArtifactStore, 'putExecutionInputs'>
}): Promise<ArtifactExecution> {
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) throw new Error('execution attempt is invalid')
  const refs = artifactReferences(input.inputArtifacts)
  const available = new Map(input.state.artifacts.map(record => [record.id, record]))
  for (const ref of refs) {
    const record = available.get(ref.id)
    if (record === undefined || record.contentDigest !== ref.contentDigest
      || record.taskId === input.task.id) throw new Error(`execution input is not recorded upstream work: ${ref.id}`)
  }
  const occurrence = selectedTaskOccurrence(input.state, input.task.id)
  const inputDigest = await sha256(refs)
  if (await input.store.putExecutionInputs(refs) !== inputDigest) throw new Error('execution input storage digest mismatch')
  const configuration = executionConfiguration(input.configuration ?? input.state)
  const execution: ArtifactExecution = {
    runId: input.state.runId, ...configuration,
    taskExecutionId: occurrence.taskExecutionId,
    ...(occurrence.mutationOwner === undefined ? {} : { mutationOwner: deepClone(occurrence.mutationOwner) }),
    workspaceKey: await nativeWorkspaceKey(input.task),
    definitionDigest: configuration.definitionDigest, taskDigest: await sha256(input.task), attempt: input.attempt,
    ...(input.state.runtimeRelease === undefined ? {} : { runtimeRelease: deepClone(input.state.runtimeRelease) }),
    inputCount: refs.length, inputDigest,
  }
  assertTaskOccurrenceExecution(occurrence, execution)
  return execution
}

/** Validate one immutable execution contract, shared by attempts and accepted outputs. */
export function assertExecutionContract(execution: ArtifactExecution): void {
  if (execution === null || typeof execution !== 'object'
    || typeof execution.runId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(execution.runId)
    || [execution.releaseDigest, execution.definitionDigest, execution.taskDigest, execution.inputDigest]
      .some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    || !Number.isSafeInteger(execution.attempt) || execution.attempt < 1
    || !Number.isSafeInteger(execution.inputCount) || execution.inputCount < 0
    || (execution.taskExecutionId !== undefined && !/^task-[a-f0-9]{48}$/.test(execution.taskExecutionId))) {
    throw new Error('execution contract is invalid')
  }
  if (execution.mutationOwner !== undefined) {
    assertWorkspaceMutationOwner(execution.mutationOwner)
    if (execution.taskExecutionId === undefined || execution.mutationOwner.authority.executionId !== execution.runId
      || execution.mutationOwner.workspaceKey !== execution.workspaceKey) throw new Error('execution workspace differs from its mutation owner')
  }
  if (Object.hasOwn(execution, 'retainedSession')) throw new Error('execution record belongs to its historical app version')
  executionConfiguration(execution)
  if (execution.runtimeRelease !== undefined) assertRuntimeRelease(execution.runtimeRelease)
}

/** Acceptance validates the dispatched contract; it never restamps the latest release. */
export async function assertDispatchedExecution(execution: ArtifactExecution, input: {
  runId: string; task: TaskDefinition; attempt: number; inputArtifacts: readonly ArtifactReference[]
}): Promise<void> {
  assertExecutionContract(execution)
  await assertExecutionWorkspace(execution, input.task)
  const refs = artifactReferences(input.inputArtifacts)
  if (execution.runId !== input.runId || execution.taskDigest !== await sha256(input.task)
    || execution.attempt !== input.attempt || execution.inputCount !== refs.length
    || execution.inputDigest !== await sha256(refs)) throw new Error('result differs from its dispatched execution contract')
}

export function executionConfiguration(state: ExecutionConfiguration): ExecutionConfiguration {
  const reference = { releaseDigest: state.releaseDigest, definitionDigest: state.definitionDigest }
  if (Object.values(reference).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('execution configuration reference is invalid')
  }
  if (Object.hasOwn(state, 'configurationHistory') || Object.hasOwn(state, 'configurationRevision')) {
    throw new Error('execution record belongs to its historical app version')
  }
  return reference
}

/** An allocation recorded by a controlled executor must match its original task. */
export async function assertExecutionWorkspace(execution: Pick<ArtifactExecution, 'taskExecutionId' | 'workspaceKey'>,
  task: TaskDefinition): Promise<void> {
  if (execution.taskExecutionId === undefined && execution.workspaceKey === undefined) return
  if (execution.taskExecutionId === undefined || execution.workspaceKey !== await nativeWorkspaceKey(task)) {
    throw new Error('execution workspace differs from its original task contract')
  }
}
