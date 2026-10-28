import type { RunState, TaskDefinition } from './contracts.js'
import type { DashboardDefinition } from './dashboard-release.js'
import { acceptedMountMode } from './accepted-mounts.js'

/** Allocation history, not an assertion that a physical container or its files survived. */
export function dashboardFilesystem(state: Pick<RunState, 'runId' | 'journal' | 'failedWaveRecovery'>, definition: DashboardDefinition,
  task: TaskDefinition, scope: { stageId: string; waveId: string; attempt?: number; promptDigest?: string } | null) {
  const members = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks
    .filter(peer => peer.workspaceKey === task.workspaceKey && peer.providerClass !== 'deterministic')
    .map(peer => ({ stageId: stage.id, waveId: wave.id, taskId: peer.id }))))
  const keys = new Set(members.map(member => JSON.stringify([member.stageId, member.waveId, member.taskId])))
  const uses = (state.journal ?? []).flatMap(event => {
    if (event.type !== 'agent.attempt-admitted' || !event.payload || typeof event.payload !== 'object') return []
    const p = event.payload as Record<string, unknown>
    if (!keys.has(JSON.stringify([p.stageId, p.waveId, p.taskId])) || !Number.isSafeInteger(p.attempt)) return []
    return [{ stageId: String(p.stageId), waveId: String(p.waveId), taskId: String(p.taskId), attempt: Number(p.attempt),
      at: event.at, selected: scope !== null && p.stageId === scope.stageId && p.waveId === scope.waveId
        && p.taskId === task.id && p.attempt === scope.attempt && p.promptDigest === scope.promptDigest }]
  })
  const selected = uses.map((use, index) => use.selected ? index : -1).filter(index => index >= 0)
  const before = selected.length === 1 ? uses.slice(0, selected[0]) : []
  const retained = state.failedWaveRecovery?.retainedNative
  const allocationRunId = retained?.stageId === scope?.stageId && retained?.waveId === scope?.waveId
    && retained?.taskId === task.id && retained?.workspaceKey === task.workspaceKey
    ? retained.workspaceAllocationRunId : state.runId
  const retainedAllocation = allocationRunId !== state.runId
  const usage = scope === null ? 'not-recorded' : selected.length !== 1 ? 'unknown'
    : retainedAllocation ? 'retained-from-parent'
    : before.some(use => use.taskId !== task.id || use.stageId !== scope.stageId || use.waveId !== scope.waveId)
      ? 'reused-across-tasks' : before.length > 0 ? 'reused-attempt' : 'first-recorded-use'
  return { workspaceKey: task.workspaceKey, sourceRunId: allocationRunId,
    allocationId: `${allocationRunId}/${task.workspaceKey}`,
    policy: ['continuation', 'fresh-pristine', 'control'].includes(task.workspaceMode) ? task.workspaceMode : 'unknown',
    usage, configuredTaskCount: members.length, priorUses: selected.length === 1 && !retainedAllocation ? before.length : null,
    uses: uses.slice(0, 256), usesTruncated: uses.length > 256, importedEvidence: acceptedMountMode(task) }
}
