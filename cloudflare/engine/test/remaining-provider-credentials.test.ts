import type { StageForkSeed } from '../src/stage-fork-origin.js'
import { sha256 } from '../src/canonical.js'
import { expect, it } from 'vitest'
import type { ExecutionConfiguration, ExperimentDefinition, RunState } from '../src/contracts.js'
import { assertRemainingProviderCredentials } from '../src/remaining-provider-credentials.js'

const old: ExecutionConfiguration = { releaseDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64) }
const current: ExecutionConfiguration = { releaseDigest: 'c'.repeat(64), definitionDigest: 'd'.repeat(64) }
const task = (id: string, key: string) => ({ id, providerClass: 'additive', backend: 'dsh-chat-completions',
  connection: { apiKeyEnv: key } })
const definition = (key: string, search: string) => ({ nativeSearch: { enabled: true,
  searchConnection: { provider: 'exa', apiKeyEnv: search } }, stages: [
  { id: 'retained', waves: [{ id: 'done', tasks: [task('retained-task', 'RETAINED_API_KEY')] }] },
  { id: 'review', waves: [
    { id: 'previous', tasks: [task('retained-wave', 'RETAINED_API_KEY')] },
    { id: 'current', tasks: [task('accepted', 'ACCEPTED_API_KEY'), task('unfinished', key)] },
    { id: 'future', tasks: [task('next', key)] },
  ] },
] } as unknown as ExperimentDefinition)

it('checks pinned unfinished work and future work without rechecking accepted or retained providers', async () => {
  const active = definition('NEXT_API_KEY', 'NEXT_SEARCH_API_KEY')
  const state = { ...current, definitionDigest: await sha256(active), cursor: { stageIndex: 1, waveIndex: 1 }, executionAuthority: {}, artifacts: [
    { stageId: 'review', waveId: 'current', taskId: 'accepted', execution: { taskExecutionId: 'accepted-0' } },
    // A previous occurrence cannot satisfy the renewed selected obligation.
    { stageId: 'review', waveId: 'current', taskId: 'unfinished', execution: { taskExecutionId: 'unfinished-0' } },
  ], waveAdmission: { stageId: 'review', waveId: 'current', configuration: { ...current, definitionDigest: await sha256(active) }, taskOccurrences: [
    { taskId: 'accepted', taskExecutionId: 'accepted-0', configuration: { ...current, definitionDigest: await sha256(active) } },
    { taskId: 'unfinished', taskExecutionId: 'unfinished-1', configuration: { ...current, definitionDigest: await sha256(active) } },
  ] } } as unknown as RunState
  const bound = { ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '', NEXT_API_KEY: 'new', NEXT_SEARCH_API_KEY: 'new-search' }
  await expect(assertRemainingProviderCredentials(active, state, bound)).resolves.toBeUndefined()
  for (const key of ['NEXT_API_KEY', 'NEXT_SEARCH_API_KEY']) {
    await expect(assertRemainingProviderCredentials(active, state, { ...bound, [key]: '' })).rejects.toThrow('credential is missing')
  }
  const altered = structuredClone(state)
  altered.waveAdmission!.configuration = old
  await expect(assertRemainingProviderCredentials(active, altered, bound)).rejects.toThrow('different configuration')
  altered.waveAdmission!.configuration = state.waveAdmission!.configuration!
  altered.waveAdmission!.taskOccurrences![1]!.configuration = old
  await expect(assertRemainingProviderCredentials(active, altered, bound)).rejects.toThrow('different configuration')
  await expect(assertRemainingProviderCredentials({ ...active, id: 'changed' }, state, bound)).rejects.toThrow('definition digest')
  state.artifacts[1]!.execution!.taskExecutionId = 'unfinished-1'
  await expect(assertRemainingProviderCredentials(active, state, bound))
    .resolves.toBeUndefined()
})

it('requires no model or search bindings for a remaining deterministic seal', async () => {
  const active = definition('NEXT_API_KEY', 'NEXT_SEARCH_API_KEY')
  active.stages[1]!.waves[2]!.tasks = [{ id: 'seal', providerClass: 'deterministic', promptKind: 'final-seal' } as never]
  const state = { ...current, definitionDigest: await sha256(active), cursor: { stageIndex: 1, waveIndex: 2 }, artifacts: [] } as unknown as RunState
  await expect(assertRemainingProviderCredentials(active, state, { ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '' })).resolves.toBeUndefined()
})

it('uses independent pool progress even without accepted outputs, while keeping paused or parked future work', async () => {
  const active = { stages: [{ id: 'discovery', kind: 'discovery', waves: [
    { id: 'wave-0', tasks: [{ ...task('fast-0', 'CONSUMED_API_KEY'), modelPool: 'fast' },
      { ...task('slow-0', 'SLOW_API_KEY'), modelPool: 'slow' }] },
    { id: 'wave-1', tasks: [{ ...task('fast-1', 'NEXT_API_KEY'), modelPool: 'fast' },
      { ...task('slow-1', 'SLOW_API_KEY'), modelPool: 'slow' }] },
  ] }] } as unknown as ExperimentDefinition
  const state = { ...current, definitionDigest: await sha256(active), cursor: { stageIndex: 0, waveIndex: 1 }, artifacts: [],
    controls: { pauses: [{ kind: 'audit' }] }, discoveryScheduler: { stageId: 'discovery', admissions: [], pools: [
      { poolId: 'fast', nextWaveIndex: 1, parked: true }, { poolId: 'slow', nextWaveIndex: 0, parked: true },
    ] } } as unknown as RunState
  const bound = { ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '', NEXT_API_KEY: 'next', SLOW_API_KEY: 'slow' }
  await expect(assertRemainingProviderCredentials(active, state, bound)).resolves.toBeUndefined()
  for (const key of ['NEXT_API_KEY', 'SLOW_API_KEY']) {
    await expect(assertRemainingProviderCredentials(active, state, { ...bound, [key]: '' })).rejects.toThrow('credential is missing')
  }
  for (const pool of state.discoveryScheduler!.pools) pool.nextWaveIndex = 2
  await expect(assertRemainingProviderCredentials(active, state, { ...bound, NEXT_API_KEY: '', SLOW_API_KEY: '' })).resolves.toBeUndefined()
})

it('does not require credentials for verified imported tasks whose original occurrence differs', async () => {
  const active = { nativeSearch: { enabled: true, searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_KEY' } },
    stages: [{ id: 'review', waves: [{ id: 'wave', tasks: [task('retained', 'OLD_API_KEY')] }] }] } as unknown as ExperimentDefinition
  const configuration = { ...current, definitionDigest: await sha256(active) }
  const retained = { stageId: 'review', waveId: 'wave', taskId: 'retained',
    execution: { ...old, taskExecutionId: 'old-occurrence' } }
  const state = { ...configuration, cursor: { stageIndex: 0, waveIndex: 0 }, artifacts: [retained],
    waveAdmission: { stageId: 'review', waveId: 'wave', configuration, taskOccurrences: [
      { taskId: 'retained', taskExecutionId: 'child-occurrence', configuration },
    ] } } as unknown as RunState
  const env = { ACK3_CODEX_AUTH_JSON: '', ACK3_CODEX_WORKSPACE_ID: '' }
  await expect(assertRemainingProviderCredentials(active, state, env)).rejects.toThrow('credential is missing')
  await expect(assertRemainingProviderCredentials(active, state, env,
    { artifacts: [retained] } as unknown as StageForkSeed)).resolves.toBeUndefined()
  state.artifacts[0]!.execution!.taskExecutionId = 'child-occurrence'
  await expect(assertRemainingProviderCredentials(active, state, env)).resolves.toBeUndefined()
})
