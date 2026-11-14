import { describe, expect, it } from 'vitest'
import { dashboardFilesystem } from '../src/dashboard-filesystem.js'
import type { RunState, TaskDefinition } from '../src/contracts.js'
import type { DashboardDefinition } from '../src/dashboard-release.js'

const task = (id: string, key = 'lane-1', mode = 'continuation') => ({ id, workspaceKey: key,
  workspaceMode: mode, providerClass: 'core', promptKind: 'research' }) as TaskDefinition
const first = task('research-0'), later = task('research-1'), other = task('other', 'lane-2')
const definition = { stages: [{ id: 'discovery', waves: [
  { id: 'wave-0', tasks: [first, other] }, { id: 'wave-1', tasks: [later] },
] }] } as unknown as DashboardDefinition
const admission = (waveId: string, taskId: string, attempt = 1, promptDigest = 'digest') => ({
  type: 'agent.attempt-admitted', at: '2026-10-05T00:00:00Z', payload: {
    stageId: 'discovery', waveId, taskId, attempt, promptDigest, continuationMode: 'new',
    execution: { workspaceKey: [first, later, other].find(task => task.id === taskId)!.workspaceKey },
  },
})
const state = (...journal: ReturnType<typeof admission>[]) => ({ runId: 'source-run', journal }) as unknown as RunState
const scope = (waveId: string, attempt = 1) => ({ stageId: 'discovery', waveId, attempt, promptDigest: 'digest' })

describe('dashboard filesystem allocation evidence', () => {
  const recovered = (...journal: ReturnType<typeof admission>[]) => ({ ...state(...journal), runId: 'child-run',
    failedWaveRecovery: { sourceRunId: 'source-run', retainedNative: { stageId: 'discovery', waveId: 'wave-0',
      taskId: first.id, workspaceKey: first.workspaceKey, workspaceAllocationRunId: 'source-run' } },
  }) as RunState
  it('leaves historical retained allocations to their owning app version', () => {
    expect(() => dashboardFilesystem(recovered(admission('wave-0', first.id)), definition, first, scope('wave-0')))
      .toThrow('historical app version')
  })
  it('shows same-lane reuse even when every model conversation is fresh, excluding another lane', () => {
    const result = dashboardFilesystem(state(admission('wave-0', first.id), admission('wave-0', other.id),
      admission('wave-1', later.id)), definition, later, scope('wave-1'))
    expect(result).toMatchObject({ allocationId: 'source-run/lane-1', usage: 'reused-across-tasks', priorUses: 1,
      configuredTaskCount: 2, importedEvidence: 'research-frontier' })
    expect(result.uses.map(use => use.taskId)).toEqual([first.id, later.id])
    expect(result.uses[1]!.selected).toBe(true)
  })
  it('distinguishes first use from same-task retry and does not count later waves as earlier reuse', () => {
    const journal = state(admission('wave-0', first.id), admission('wave-0', first.id, 2), admission('wave-1', later.id))
    expect(dashboardFilesystem(journal, definition, first, scope('wave-0')).usage).toBe('first-recorded-use')
    expect(dashboardFilesystem(journal, definition, first, scope('wave-0', 2)).usage).toBe('reused-attempt')
  })
  it('does not infer continuity from missing, ambiguous or differently scoped admissions', () => {
    const event = admission('wave-0', first.id)
    for (const journal of [state(), state(admission('wave-0', first.id, 1, 'different')), state(event, event)]) {
      expect(dashboardFilesystem(journal, definition, first, scope('wave-0'))).toMatchObject({ usage: 'unknown', priorUses: null })
    }
    expect(dashboardFilesystem(state(event), definition, first, null).usage).toBe('not-recorded')
    expect(dashboardFilesystem({ ...state(event), runId: 'another-run' }, definition, first, scope('wave-0')).allocationId)
      .not.toBe('source-run/lane-1')
  })
  it('keeps isolated workspace policy separate from imported evidence', () => {
    const review = { ...first, workspaceMode: 'fresh-pristine', promptKind: 'negative-review' } as TaskDefinition
    expect(dashboardFilesystem(state(admission('wave-0', first.id)), definition, review, scope('wave-0')))
      .toMatchObject({ policy: 'fresh-pristine', usage: 'first-recorded-use', importedEvidence: 'negative-review-packet-only' })
  })
})


it('uses recorded physical allocations across account amendments, not the current logical lane', () => {
  const one = admission('wave-0', first.id), two = admission('wave-1', later.id)
  Object.assign(one.payload, { execution: { workspaceKey: 'native-old-account' } })
  Object.assign(two.payload, { execution: { workspaceKey: 'native-new-account' } })
  const current = { ...state(one, two), executionAuthority: { auditId: 'source-run', executionId: 'source-run',
    epoch: 0, runtimeDigest: 'a'.repeat(64) } }
  expect(dashboardFilesystem(current, definition, later, scope('wave-1'))).toMatchObject({
    allocationId: 'source-run/native-new-account', usage: 'first-recorded-use', priorUses: 0,
  })
  expect(dashboardFilesystem(current, definition, first, scope('wave-0'))).toMatchObject({
    allocationId: 'source-run/native-old-account', usage: 'first-recorded-use', priorUses: 0,
  })
  // The prior route is no longer present in the current manifest. Its recorded
  // allocation remains useful, but missing allocation evidence stays unknown.
  const missing = admission('wave-0', first.id)
  delete (missing.payload as Partial<typeof missing.payload>).execution
  expect(dashboardFilesystem({ ...current, journal: state(missing).journal }, definition, first, scope('wave-0')))
    .toMatchObject({ allocationId: null, usage: 'unknown', priorUses: null })
})
