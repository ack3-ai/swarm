import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import { acceptedTaskExecutionId } from './task-occurrences.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { executionConfiguration } from './artifact-execution.js'
import { canonicalJson, sha256 } from './canonical.js'
import type { ExperimentDefinition, RunState, TaskDefinition } from './contracts.js'
import { assertReleaseProviderCredentials } from './release-provider-credentials.js'
import { admittedTaskOccurrence } from './task-occurrences.js'
import type { StageForkSeed } from './stage-fork-origin.js'

/** Readiness follows the verified execution frontier. Retained results need no
 * provider credentials; unfinished admissions use this execution’s immutable manifest. */
export async function assertRemainingProviderCredentials(definition: ExperimentDefinition, state: RunState,
  env: Parameters<typeof assertReleaseProviderCredentials>[1],
  seed?: StageForkSeed): Promise<void> {
  assertCurrentExecutionFormat(state)
  if (await sha256(definition) !== state.definitionDigest) throw new Error('remaining definition digest differs')
  const tasks: TaskDefinition[] = [], current = executionConfiguration(state)
  const scheduler = state.discoveryScheduler
  const assertCurrent = (configuration: typeof current) => {
    if (canonicalJson(configuration) !== canonicalJson(current)) throw new Error('remaining task references a different configuration')
  }
  const admissions = [...(state.waveAdmission == null ? [] : [state.waveAdmission]),
    ...(state.discoveryScheduler?.admissions ?? [])]
  for (const admission of admissions) {
    assertCurrent(admission.configuration ?? current)
    const wave = definition.stages.find(stage => stage.id === admission.stageId)?.waves.find(wave => wave.id === admission.waveId)
    if (wave === undefined) throw new Error('remaining admission is missing from its pinned configuration')
    const ids = 'taskIds' in admission ? admission.taskIds : wave.tasks.map(task => task.id)
    for (const id of ids) {
      if (seed?.artifacts.some(record => record.stageId === admission.stageId && record.waveId === admission.waveId && record.taskId === id)) continue
      const occurrence = admittedTaskOccurrence(admission, id)
      assertCurrent(occurrence.configuration)
      const accepted = state.artifacts.some(record => record.stageId === admission.stageId && record.waveId === admission.waveId
        && record.taskId === id && acceptedTaskExecutionId(record) === occurrence.taskExecutionId)
      if (!accepted) {
        const task = wave.tasks.find(task => task.id === id)
        if (task === undefined) throw new Error('remaining task is missing from its pinned configuration')
        tasks.push(task)
      }
    }
  }
  for (const [stageIndex, stage] of definition.stages.entries()) {
    if (stageIndex < state.cursor.stageIndex) continue
    for (const [waveIndex, wave] of stage.waves.entries()) {
      if (stage.kind !== 'discovery' && stageIndex === state.cursor.stageIndex && waveIndex < state.cursor.waveIndex) continue
      const admitted = admissions.filter(value => value.stageId === stage.id && value.waveId === wave.id)
      for (const task of wave.tasks) {
        if (stage.kind === 'discovery' && scheduler?.stageId === stage.id) {
          const progress = scheduler.pools.find(pool => pool.poolId === configuredResearchTaskPoolId(task))
          if (progress !== undefined && waveIndex < progress.nextWaveIndex) continue
        }
        // An ordinary wave is fully pinned at admission. Independent discovery
        // cohorts pin only their members, leaving future admissions on current config.
        if (admitted.some(value => !('taskIds' in value) || value.taskIds.includes(task.id))) continue
        if (state.artifacts.some(record => record.stageId === stage.id && record.waveId === wave.id && record.taskId === task.id)) continue
        tasks.push(task)
      }
    }
  }
  await assertReleaseProviderCredentials(definition, env, tasks)
}
