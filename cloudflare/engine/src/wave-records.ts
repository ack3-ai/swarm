import type { ArtifactRecord, TaskDefinition, WaveDefinition } from './contracts.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'

export function assertWaveRecordsComplete(records: readonly ArtifactRecord[], stageId: string, wave: WaveDefinition, tasks: readonly TaskDefinition[] = wave.tasks): void {
  const expectedTaskIds = new Set(wave.tasks.map(task => task.id))
  if (tasks.length !== expectedTaskIds.size || new Set(tasks.map(task => task.id)).size !== tasks.length
    || tasks.some(task => !expectedTaskIds.has(task.id))) throw new Error('selected contracts differ from wave obligations')
  const recordTaskIds = new Set<string>()
  for (const record of records) {
    if (!expectedTaskIds.has(record.taskId)) throw new Error(`wave ${stageId}/${wave.id} contains an unexpected result for ${record.taskId}`)
    if (recordTaskIds.has(record.taskId)) throw new Error(`wave ${stageId}/${wave.id} repeats a terminal result for ${record.taskId}`)
    recordTaskIds.add(record.taskId)
  }
  for (const task of tasks) {
    const record = records.find(value => value.taskId === task.id)
    if (record === undefined) throw new Error(`wave ${stageId}/${wave.id} lacks a terminal result for ${task.id}`)
    if (record.model !== task.model) throw new Error(`task ${task.id} checkpoint model differs from its contract`)
    if (task.optional !== true && record.status !== 'accepted') {
      throw new Error(`required task ${task.id} is unavailable`)
    }
    if (record.status === 'additive-unavailable' && (task.optional !== true || record.unavailableReason === undefined)) {
      throw new Error(`task ${task.id} has invalid additive unavailability`)
    }
  }
  const accepted = records.filter(record => record.status === 'accepted')
  if (accepted.length < wave.minSuccessfulTasks) throw new Error(`wave ${stageId}/${wave.id} lacks successful tasks`)
  if (new Set(accepted.map((record) => record.actorId)).size < wave.minDistinctActors) {
    throw new Error(`wave ${stageId}/${wave.id} lacks independent actors`)
  }
  if (wave.replication !== undefined) {
    const replicated = accepted.filter(record => wave.replication?.taskIds.includes(record.taskId))
    const waived = wave.replication.taskIds.some(taskId => records.some(record => (
      record.taskId === taskId && record.status === 'additive-unavailable'
    )))
    if (!waived && (replicated.length < wave.replication.minSuccessfulAgents
      || new Set(replicated.map(record => record.provider)).size < wave.replication.minDistinctProviders
      || new Set(replicated.map(record => record.model)).size < wave.replication.minDistinctModels)) {
      throw new Error(`wave ${stageId}/${wave.id} lacks required replicated providers and models`)
    }
  }
}

export function assertDiscoveryCohortRecordsComplete(
  records: readonly ArtifactRecord[],
  stageId: string,
  wave: WaveDefinition,
  poolId: string,
): void {
  const tasks = wave.tasks.filter(task => configuredResearchTaskPoolId(task) === poolId)
  if (tasks.length === 0) throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} has no tasks`)
  const expectedTaskIds = new Set(tasks.map(task => task.id))
  if (records.length !== tasks.length || records.some(record => !expectedTaskIds.has(record.taskId))) {
    throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} has an invalid terminal set`)
  }
  for (const task of tasks) {
    const record = records.find(candidate => candidate.taskId === task.id)
    if (record === undefined || record.model !== task.model) {
      throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} lacks ${task.id}`)
    }
    if (task.optional !== true && record.status !== 'accepted') {
      throw new Error(`required discovery task ${task.id} is unavailable`)
    }
    if (record.status === 'additive-unavailable' && (task.optional !== true || record.unavailableReason === undefined)) {
      throw new Error(`discovery task ${task.id} has invalid additive unavailability`)
    }
  }
  const required = tasks.filter(task => task.optional !== true)
  const acceptedRequired = records.filter(record => (
    record.status === 'accepted' && required.some(task => task.id === record.taskId)
  ))
  if (acceptedRequired.length !== required.length
    || new Set(acceptedRequired.map(record => record.actorId)).size !== required.length) {
    throw new Error(`discovery cohort ${stageId}/${wave.id}/${poolId} lacks independent required actors`)
  }
}
