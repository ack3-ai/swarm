import type { RunState, TaskDefinition, WaveDefinition, WaveReceipt } from './contracts.js'
import type { DashboardDefinition } from './dashboard-release.js'

// Read-only projection of the durable runtime contract. Old pinned runtimes
// omit pool metadata and retain their original whole-wave views.
export type DashboardRunState = Omit<RunState, 'waveReceipts' | 'discoveryScheduler'> & {
  waveReceipts: readonly (WaveReceipt & { poolId?: string })[]
  discoveryScheduler?: {
    stageId: string
    admissions: readonly {
      stageId: string; waveId: string; poolId: string; taskIds: readonly string[]; admittedAt: string
    }[]
  }
}

export function dashboardTaskBoundary(
  state: DashboardRunState, stageId: string, waveId: string, task: TaskDefinition,
) {
  const independent = state.discoveryScheduler?.stageId === stageId
  const receipt = state.waveReceipts.find(item => item.stageId === stageId && item.waveId === waveId
    && (!independent || item.poolId === task.modelPool))
  const admission = independent ? state.discoveryScheduler?.admissions.find(item => (
    item.stageId === stageId && item.waveId === waveId && item.poolId === task.modelPool && item.taskIds.includes(task.id)
  )) : state.waveAdmission?.stageId === stageId && state.waveAdmission.waveId === waveId ? state.waveAdmission : null
  return { receipt, startedAt: receipt?.startedAt ?? admission?.admittedAt ?? null, admitted: admission != null }
}

export function dashboardWaveViews(state: DashboardRunState, definition: DashboardDefinition) {
  return definition.stages.flatMap((stage, stageIndex) => stage.waves.flatMap((original, localIndex) => {
    const independent = state.discoveryScheduler?.stageId === stage.id
    const pools = independent ? [...new Set(original.tasks.map(task => task.modelPool))] : [undefined]
    return pools.map(modelPool => {
      const tasks = independent ? original.tasks.filter(task => task.modelPool === modelPool) : original.tasks
      const id = independent && modelPool !== undefined ? `${original.id}@${modelPool}` : original.id
      const wave: WaveDefinition = { ...original, id, tasks }
      const boundary = tasks[0] ? dashboardTaskBoundary(state, stage.id, original.id, tasks[0])
        : { receipt: undefined, startedAt: null, admitted: false }
      return { stage, stageIndex, localIndex, wave, sourceWaveId: original.id,
        modelPool: independent ? modelPool : undefined, independent, ...boundary }
    })
  }))
}
