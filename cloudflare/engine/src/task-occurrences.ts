import { birthMutationOwner } from './workspace-mutation-owner.js'
import { nativeWorkspaceKey, taskUsesSandbox } from './native-workspace.js'
import type { ArtifactRecord, ArtifactExecution, DiscoveryCohortAdmission, ExecutionConfiguration, RunState, TaskDefinition, TaskOccurrence, WaveAdmission } from './contracts.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { taskExecutionIdentity, type ExecutionAuthority } from './execution-authority.js'
import { compareText } from './text-order.js'

/** In-place task dispositions belong to the historical app version. */
export function assertNoUnprovenTaskAbandonment(value: unknown): void {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, 'abandonedTasks')) {
    throw new Error('task abandonment requires its verified control effect')
  }
}

/** Admission evidence, not configuration: each entry points to its original whole release. */
export async function initialTaskOccurrences(authority: ExecutionAuthority, configuration: ExecutionConfiguration,
  tasks: readonly TaskDefinition[], peerPredecessors: Readonly<Record<string, string>> = {}): Promise<readonly TaskOccurrence[]> {
  return Promise.all([...tasks].sort((a, b) => compareText(a.id, b.id)).map(async configured => {
    const peer = peerPredecessors[configured.id]
    const task = peer === undefined || configured.research === undefined ? configured
      : { ...configured, research: { ...configured.research, buildsOn: peer } }
    return { taskId: task.id, taskExecutionId: await taskExecutionIdentity(authority, task.id),
      ...(!taskUsesSandbox(task) ? {} : { mutationOwner: await birthMutationOwner(authority, await nativeWorkspaceKey(task)) }),
      origin: { authority: deepClone(authority), ordinal: 0 }, configuration: deepClone(configuration), taskDigest: await sha256(task) }
  }))
}

export function admittedTaskOccurrence(admission: Pick<WaveAdmission, 'taskOccurrences'> | undefined | null,
  taskId: string): TaskOccurrence {
  const matches = admission?.taskOccurrences?.filter(value => value.taskId === taskId) ?? []
  if (matches.length !== 1) throw new Error(`task occurrence is missing or duplicated: ${taskId}`)
  return matches[0]!
}

export function selectedTaskOccurrence(state: Pick<RunState, 'waveAdmission' | 'discoveryScheduler'>,
  taskId: string): TaskOccurrence {
  const admission: WaveAdmission | DiscoveryCohortAdmission | undefined | null =
    state.discoveryScheduler?.admissions.find(value => value.taskIds.includes(taskId)) ?? state.waveAdmission
  assertNoUnprovenTaskAbandonment(admission)
  return admittedTaskOccurrence(admission, taskId)
}

/** Current admissions only. Historical receipts never authorize more native work. */
export function selectedTaskExecutionIds(state: Pick<RunState, 'waveAdmission' | 'discoveryScheduler'>): readonly string[] {
  const admissions = [...(state.waveAdmission == null ? [] : [state.waveAdmission]),
    ...(state.discoveryScheduler?.admissions ?? [])]
  const ids = new Set<string>(), seen = new Set<string>(), tasks = new Set<string>()
  for (const admission of admissions) {
    assertNoUnprovenTaskAbandonment(admission)
    if (admission.taskOccurrences === undefined) throw new Error('controlled admission lacks task occurrences')
    for (const occurrence of admission.taskOccurrences) {
      if (typeof occurrence.taskExecutionId !== 'string' || occurrence.taskExecutionId.length === 0
        || seen.has(occurrence.taskExecutionId) || tasks.has(occurrence.taskId)) {
        throw new Error('selected task occurrence identity is invalid or duplicated')
      }
      ids.add(occurrence.taskExecutionId)
      seen.add(occurrence.taskExecutionId)
      tasks.add(occurrence.taskId)
    }
  }
  return [...ids].sort()
}

/** Initial admission validation proves the identity once; outcomes must match that selection. */
export function assertTaskOccurrenceExecution(occurrence: TaskOccurrence,
  execution: ArtifactExecution): void {
  if (Object.hasOwn(execution, 'retainedSession') || Object.hasOwn(occurrence, 'retainedSession')
    || Object.hasOwn(execution, 'configurationRevision') || Object.hasOwn(occurrence.configuration, 'configurationRevision')) {
    throw new Error('execution record belongs to its historical app version')
  }
  if (canonicalJson(execution.mutationOwner) !== canonicalJson(occurrence.mutationOwner)
    || execution.taskExecutionId !== occurrence.taskExecutionId || execution.taskDigest !== occurrence.taskDigest
    || execution.releaseDigest !== occurrence.configuration.releaseDigest
    || execution.definitionDigest !== occurrence.configuration.definitionDigest) {
    throw new Error('execution differs from its selected task occurrence')
  }
}

export function acceptedTaskExecutionId(record: ArtifactRecord): string | undefined {
  return record.execution?.taskExecutionId
}

export function assertAcceptedTaskOccurrence(occurrence: TaskOccurrence, record: ArtifactRecord): void {
  if (Object.hasOwn(record, 'acceptance')) throw new Error('output acceptance belongs to its historical app version')
  if (record.execution === undefined) throw new Error('accepted artifact lacks its producer execution')
  assertTaskOccurrenceExecution(occurrence, record.execution)
}
