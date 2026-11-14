import { expect, it } from 'vitest'
import { birthMutationOwner, type WorkspaceMutationOwner } from '../src/workspace-mutation-owner.js'
import { initialTaskOccurrences, assertTaskOccurrenceExecution } from '../src/task-occurrences.js'
import { nativeWorkspaceKey } from '../src/native-workspace.js'
import { groupWorkspaceAllocations, selectedMutationOwner, type RecordedWorkspaceTask } from '../src/execution-workspaces.js'
import { audit0Definition } from './support/audit0-config.js'

const authority = { auditId: 'owner-history', executionId: 'owner-history', epoch: 0, runtimeDigest: 'a'.repeat(64) }
const configuration = { releaseDigest: 'b'.repeat(64), definitionDigest: 'c'.repeat(64) }
const stage = audit0Definition.stages.find(value => value.kind === 'negative-review')!
const wave = stage.waves[0]!, task = wave.tasks.find(value => value.providerClass === 'additive')!

function record(owner: WorkspaceMutationOwner): RecordedWorkspaceTask {
  return { task, configuration, stageId: stage.id, waveId: wave.id, workspaceKey: owner.workspaceKey,
    mutationOwner: owner, active: false, admitted: false, evidenced: true }
}

it('returns cleanup ownership without sharing mutable record state', async () => {
  const owner = await birthMutationOwner(authority, await nativeWorkspaceKey(task))
  const selected = (await selectedMutationOwner([record(owner)]))!
  expect(selected).toEqual(owner)
  selected.ordinal = 9
  expect(owner.ordinal).toBe(0)
})

it.each(['ordinal', 'origin', 'allocation'] as const)('does not adopt an owner with changed %s', async change => {
  const owner = await birthMutationOwner(authority, await nativeWorkspaceKey(task))
  if (change === 'ordinal') owner.ordinal++
  if (change === 'origin') owner.originDigest = 'f'.repeat(64)
  if (change === 'allocation') Object.assign(owner, { allocation: { ordinal: 1, originDigest: 'f'.repeat(64) } })
  await expect(selectedMutationOwner([record(owner)])).rejects.toThrow('ownership differs')
})

it('validates admitted occurrences against their original execution owner', async () => {
  const occurrences = await initialTaskOccurrences(authority, configuration, [task], {})
  const occurrence = occurrences[0]!
  const execution = { ...configuration, taskExecutionId: occurrence.taskExecutionId,
    taskDigest: occurrence.taskDigest, mutationOwner: structuredClone(occurrence.mutationOwner) } as import('../src/contracts.js').ArtifactExecution
  expect(() => assertTaskOccurrenceExecution(occurrence, execution)).not.toThrow()
  expect(() => assertTaskOccurrenceExecution(occurrence, { ...execution, configurationRevision: 1 } as typeof execution))
    .toThrow('historical app version')
  expect(() => assertTaskOccurrenceExecution({ ...occurrence, configuration: { ...configuration, configurationRevision: 1 } } as typeof occurrence, execution))
    .toThrow('historical app version')
  execution.mutationOwner!.ordinal++
  expect(() => assertTaskOccurrenceExecution(occurrence, execution)).toThrow('selected task occurrence')
  delete execution.mutationOwner
  expect(() => assertTaskOccurrenceExecution(occurrence, execution)).toThrow('selected task occurrence')
})

it('keeps whole-executor allocations separate and refuses mixed owners for one cleanup group', async () => {
  const key = await nativeWorkspaceKey(task)
  const first = await birthMutationOwner(authority, key)
  const second = await birthMutationOwner({ ...authority, executionId: 'replacement', epoch: 1 }, key)
  expect(await groupWorkspaceAllocations([record(first), record(second)], authority.executionId)).toHaveLength(2)
  expect(await selectedMutationOwner([record(first)])).toEqual(first)
  await expect(selectedMutationOwner([record(first), record(second)])).rejects.toThrow('ownership differs')
})
