import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import type { RunState, TaskDefinition } from './contracts.js'
import type { DashboardDefinition } from './dashboard-release.js'
import { acceptedMountMode } from './accepted-mounts.js'

/** Allocation history, not an assertion that a physical container or its files survived. */
export function dashboardFilesystem(state: Pick<RunState, 'runId' | 'journal' | 'executionAuthority'>, definition: DashboardDefinition,
  task: TaskDefinition, scope: { stageId: string; waveId: string; attempt?: number; promptDigest?: string } | null) {
  assertCurrentExecutionFormat(state)
  const members = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks
    .filter(peer => peer.workspaceKey === task.workspaceKey && peer.providerClass !== 'deterministic')
    .map(peer => ({ stageId: stage.id, waveId: wave.id, taskId: peer.id }))))
  const selectedAdmission = (state.journal ?? []).filter(event => {
    const p = event.payload as Record<string, unknown> | null
    return event.type === 'agent.attempt-admitted' && p != null && scope !== null
      && p.stageId === scope.stageId && p.waveId === scope.waveId && p.taskId === task.id
      && p.attempt === scope.attempt && p.promptDigest === scope.promptDigest
  })
  const selectedExecution = selectedAdmission.length === 1
    ? (selectedAdmission[0]!.payload as { execution?: { workspaceKey?: string } }).execution : undefined
  const recordedKey = selectedExecution?.workspaceKey
  const uses = (state.journal ?? []).flatMap(event => {
    if (event.type !== 'agent.attempt-admitted' || !event.payload || typeof event.payload !== 'object') return []
    const p = event.payload as Record<string, unknown>
    const sameAllocation = recordedKey !== undefined
      && (p.execution as { workspaceKey?: string } | undefined)?.workspaceKey === recordedKey
    if (!sameAllocation || !Number.isSafeInteger(p.attempt)) return []
    return [{ stageId: String(p.stageId), waveId: String(p.waveId), taskId: String(p.taskId), attempt: Number(p.attempt),
      at: event.at, selected: scope !== null && p.stageId === scope.stageId && p.waveId === scope.waveId
        && p.taskId === task.id && p.attempt === scope.attempt && p.promptDigest === scope.promptDigest }]
  })
  const selected = uses.map((use, index) => use.selected ? index : -1).filter(index => index >= 0)
  const before = selected.length === 1 ? uses.slice(0, selected[0]) : []
  const allocationRunId = state.runId
  const usage = scope === null ? 'not-recorded' : selected.length !== 1 ? 'unknown'
    : before.some(use => use.taskId !== task.id || use.stageId !== scope.stageId || use.waveId !== scope.waveId)
      ? 'reused-across-tasks' : before.length > 0 ? 'reused-attempt' : 'first-recorded-use'
  return { workspaceKey: task.workspaceKey, sourceRunId: allocationRunId,
    allocationId: recordedKey === undefined ? null : `${allocationRunId}/${recordedKey}`,
    policy: ['continuation', 'fresh-pristine', 'control'].includes(task.workspaceMode) ? task.workspaceMode : 'unknown',
    usage, configuredTaskCount: members.length, priorUses: selected.length === 1 ? before.length : null,
    uses: uses.slice(0, 256), usesTruncated: uses.length > 256, importedEvidence: acceptedMountMode(task) }
}
