import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { acceptedTaskExecutionId } from './task-occurrences.js'
import { birthMutationOwner, type WorkspaceMutationOwner } from './workspace-mutation-owner.js'
import { assertStageForkSelection, stageForkOrigin, type StageForkSeed } from './stage-fork-origin.js'
import { nativeWorkspaceKey, workspaceAllocationName } from './native-workspace.js'
import type { ArtifactExecution, ExecutionConfiguration, ExperimentDefinition, RunState, TaskDefinition } from './contracts.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { admittedTaskOccurrence } from './task-occurrences.js'
import { assertExecutionWorkspace, executionConfiguration } from './artifact-execution.js'
import { compareText } from './text-order.js'

export interface RecordedWorkspaceTask {
  task: TaskDefinition
  workspaceKey: string
  stageId: string
  waveId: string
  configuration: ExecutionConfiguration
  execution?: ArtifactExecution
  taskExecutionId?: string
  mutationOwner?: WorkspaceMutationOwner
  /** Native request/preflight recorded in flight, not physical process proof. */
  active: boolean
  evidenced: boolean
  /** Unfinished selected obligation, including before/between provider calls. */
  admitted: boolean
}

/** Resolve recorded native ownership and unfinished admissions, not every task
 * mentioned in configurations. Candidates never prove a physical allocation. */
export async function recordedWorkspaceTasks(definition: ExperimentDefinition, state: RunState,
  seed?: StageForkSeed): Promise<readonly RecordedWorkspaceTask[]> {
  assertCurrentExecutionFormat(state)
  if (canonicalJson(state.forkOrigin) !== canonicalJson(seed === undefined ? undefined : stageForkOrigin(seed))) {
    throw new Error('workspace ownership requires its verified fork seed')
  }
  if (seed !== undefined) assertStageForkSelection(seed, state)
  const imported = new Set(seed === undefined ? [] : [...seed.artifacts, ...seed.rejectedAttempts].map(record => canonicalJson(record)))
  if (await sha256(definition) !== state.definitionDigest) throw new Error('workspace definition differs from the selected release')
  const currentConfiguration = canonicalJson(executionConfiguration(state))
  const assertCurrentConfiguration = (configuration: ExecutionConfiguration) => {
    if (canonicalJson(configuration) !== currentConfiguration) throw new Error('workspace configuration differs from the selected release')
  }
  const result: RecordedWorkspaceTask[] = []
  const append = async (task: TaskDefinition, configuration: ExecutionConfiguration,
    record: { stageId: string; waveId: string; execution?: ArtifactExecution; taskExecutionId?: string | undefined; mutationOwner?: WorkspaceMutationOwner | undefined },
    active: boolean, evidenced: boolean, admitted = false) => {
    // These execute in the supervisor before sandbox selection. Preflight does
    // allocate a native process and follows the same admission path as agents.
    if (['coverage-union', 'review-union', 'final-seal'].includes(task.promptKind)) return
    result.push({ task, configuration, workspaceKey: await nativeWorkspaceKey(task),
      stageId: record.stageId, waveId: record.waveId,
      ...(record.execution === undefined ? {} : { execution: record.execution }),
      ...(record.taskExecutionId === undefined ? {} : { taskExecutionId: record.taskExecutionId }),
      ...(record.mutationOwner === undefined ? {} : { mutationOwner: record.mutationOwner }), active, evidenced, admitted })
  }
  const add = async (record: { stageId: string; waveId: string; taskId: string; execution?: ArtifactExecution },
    active: boolean, evidenced: boolean) => {
    const configuration = executionConfiguration(record.execution ?? state)
    assertCurrentConfiguration(configuration)
    const task = definition.stages.find(stage => stage.id === record.stageId)?.waves
      .find(wave => wave.id === record.waveId)?.tasks.find(task => task.id === record.taskId)
    if (task === undefined) throw new Error('recorded workspace task is missing from its original configuration')
    if (record.execution !== undefined) await assertExecutionWorkspace(record.execution, task)
    await append(task, configuration, { ...record, taskExecutionId: record.execution?.taskExecutionId, mutationOwner: record.execution?.mutationOwner }, active, evidenced)
  }
  for (const record of state.artifacts) if (!imported.has(canonicalJson(record))) await add(record, false, true)
  for (const record of state.rejectedAttempts) if (!imported.has(canonicalJson(record))) await add(record, false, true)
  for (const record of state.inFlightAgentAttempts ?? []) await add(record, true, false)
  // An admitted peer can be between attempts or waiting for its first provider
  // call. It still owns its lane even when no request is currently inFlight.
  const admissions = [
    ...(state.waveAdmission == null ? [] : [state.waveAdmission]),
    ...(state.discoveryScheduler?.admissions ?? []),
  ]
  for (const admission of admissions) {
    const configuration = admission.configuration ?? executionConfiguration(state)
    assertCurrentConfiguration(configuration)
    const wave = definition.stages.find(stage => stage.id === admission.stageId)?.waves.find(wave => wave.id === admission.waveId)
    if (wave === undefined) throw new Error('admitted workspace wave is missing from its original configuration')
    const taskIds = 'taskIds' in admission ? admission.taskIds : wave.tasks.map(task => task.id)
    for (const taskId of taskIds) {
      if (seed?.artifacts.some(record => record.taskId === taskId)) continue
      const occurrence = admittedTaskOccurrence(admission, taskId)
      const selectedConfiguration = occurrence.configuration
      assertCurrentConfiguration(selectedConfiguration)
      const task = wave.tasks.find(value => value.id === taskId)
      if (task === undefined) throw new Error('selected workspace task is missing from its original configuration')
      const completed = state.artifacts.some(record => record.stageId === admission.stageId && record.waveId === admission.waveId
        && record.taskId === taskId && acceptedTaskExecutionId(record) === occurrence.taskExecutionId)
      if (!completed) await append(task, selectedConfiguration, { stageId: admission.stageId, waveId: admission.waveId,
        taskExecutionId: occurrence.taskExecutionId, mutationOwner: occurrence.mutationOwner }, task.promptKind === 'preflight', false, true)
    }
  }
  return result
}


/** Physical grouping must not collapse legacy and covered actors sharing a lane. */
export async function groupWorkspaceAllocations(records: readonly RecordedWorkspaceTask[], runId: string) {
  const groups = new Map<string, RecordedWorkspaceTask[]>()
  for (const record of records) {
    const sandboxName = await workspaceAllocationName({ runId: record.mutationOwner?.authority.executionId ?? runId,
      workspaceKey: record.workspaceKey, mutationOwner: record.mutationOwner })
    groups.set(sandboxName, [...(groups.get(sandboxName) ?? []), record])
  }
  return [...groups].sort(([a], [b]) => compareText(a, b)).map(([sandboxName, members]) => ({
    sandboxName, workspaceKey: members[0]!.workspaceKey, members,
  }))
}

/** Cleanup requires the exact birth owner on every current-execution record. */
export async function selectedMutationOwner(records: readonly RecordedWorkspaceTask[]) {
  records = deepClone(records)
  const owner = records[0]?.mutationOwner
  if (owner === undefined) {
    if (records.some(record => record.mutationOwner !== undefined)) throw new Error('workspace cleanup ownership differs')
    return undefined
  }
  for (const record of records) {
    const captured = record.mutationOwner
    if (captured === undefined || captured.workspaceKey !== record.workspaceKey
      || canonicalJson(captured) !== canonicalJson(owner)
      || canonicalJson(captured) !== canonicalJson(await birthMutationOwner(captured.authority, captured.workspaceKey))) throw new Error('workspace cleanup ownership differs')
  }
  return owner
}


export type OwnedWorkspaceResolver = (state: RunState) => Promise<readonly RecordedWorkspaceTask[]>

/** Plain in-memory runs need no database. Inherited physical ownership requires
 * the shared retirement verifier supplied by the Workflow boundary. */
export async function cleanupWorkspaceTasks(definition: ExperimentDefinition, state: RunState,
  seed?: StageForkSeed, owned?: OwnedWorkspaceResolver) {
  assertCurrentExecutionFormat(state)
  if (owned !== undefined) return owned(state)
  const records = await recordedWorkspaceTasks(definition, state, seed)
  if (records.some(record => record.execution !== undefined ? record.execution.runId !== state.runId
    || canonicalJson(record.execution.runtimeRelease) !== canonicalJson(state.runtimeRelease)
    : record.mutationOwner !== undefined && canonicalJson(record.mutationOwner.authority) !== canonicalJson(state.executionAuthority))) {
    throw new Error('inherited workspace cleanup requires verified retirement')
  }
  return records
}
