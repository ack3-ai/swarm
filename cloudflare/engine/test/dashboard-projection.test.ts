import { dashboardTaskBoundary } from '../src/dashboard-waves.js'
import { describe, expect, it } from 'vitest'
import { buildDashboardSnapshot, sumDashboardUsage } from '../src/dashboard-projection.js'
import { reconcileDashboardStatus } from '../src/dashboard-status.js'
import type { ArtifactRecord, ExperimentDefinition, ProviderUsage, RunState, TaskDefinition } from '../src/contracts.js'
import type { LiveCompletion } from '../src/dashboard-types.js'
import { DEFAULT_INSTRUCTIONS } from '../src/methods/system-prompts.js'

const at = '2026-09-22T12:00:00.000Z'
const usage = (inputTokens: number, overrides: Partial<ProviderUsage> = {}): ProviderUsage => ({
  modelCalls: 1, inputTokens, outputTokens: 2, costUsd: 0.01, ...overrides,
})
const task = (id: string, workspaceKey: string, promptKind: TaskDefinition['promptKind'] = 'research'): TaskDefinition => ({
  id, workspaceKey, promptKind, logicalRole: promptKind, objective: 'Inspect a generic document inventory',
  providerClass: 'core', model: 'fixture-model', reasoning: 'max', visibility: 'accepted-frontier',
  workspaceMode: 'continuation', output: { schema: 'fixture', requiredFiles: ['result.md'] }, retryPolicy: 'none',
})
const definition: ExperimentDefinition = {
  schemaVersion: 2, id: 'dashboard-fixture', target: {
    repository: 'fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40), sourcePackageVersion: 2,
    production: false, resettable: true,
    runtime: { environmentBindings: {}, preflightCommands: ['true'] },
  },
  limits: { maxWallTimeMs: 60_000, maxModelCalls: 100, maxInputTokens: 100_000, maxOutputTokens: 100_000, maxCostUsd: 100,
    phaseMinutes: { discovery: 1 } },
  policy: { authorization: '', outcome: '', doneWhen: [], notDoneWhen: [], evidenceRules: [], completionRules: [] },
  prompts: { ...DEFAULT_INSTRUCTIONS },
  stagePrompts: {}, roles: [], pools: [], discoverySafetyCeiling: 2,
  stages: [
    { id: 'discovery', kind: 'discovery', objective: 'Discovery', waves: [
      { id: 'wave-0', tasks: [task('a', 'lane-a'), task('b', 'lane-b'), task('negative', 'lane-negative')], minSuccessfulTasks: 1, minDistinctActors: 1 },
      { id: 'wave-1', tasks: [task('a-next', 'lane-a'), task('c', 'lane-c')], minSuccessfulTasks: 1, minDistinctActors: 1 },
    ] },
    { id: 'synthesis', kind: 'synthesis', objective: 'Synthesis', waves: [
      { id: 'wave-0', tasks: [task('synth', 'synth', 'synthesis')], minSuccessfulTasks: 1, minDistinctActors: 1 },
    ] },
    { id: 'review', kind: 'negative-review', objective: 'Review', waves: [
      { id: 'wave-0', tasks: [task('review-a', 'review-a', 'negative-review'), task('review-b', 'review-b', 'negative-review'),
        task('union', 'union', 'review-union')], minSuccessfulTasks: 1, minDistinctActors: 1 },
    ] },
    { id: 'reporting', kind: 'reporting', objective: 'Reporting', waves: [
      { id: 'wave-0', tasks: [task('reporter', 'reporter', 'reporting'), task('seal-final', 'seal', 'final-seal')], minSuccessfulTasks: 1, minDistinctActors: 1 },
    ] },
  ],
}
function artifact(taskId: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return { id: `artifact-${taskId}`, stageId: 'discovery', waveId: 'wave-0', taskId, status: 'accepted',
    actorId: `actor-${taskId}`, model: 'fixture-model', provider: 'openai-codex-subscription', promptDigest: `prompt-${taskId}`,
    contentDigest: `output-${taskId}`, uri: `memory://${taskId}`, files: ['result.md'], assertions: [], protocol: {}, usage: usage(10), ...overrides }
}
function state(overrides: Partial<RunState> = {}): RunState {
  const value: RunState = { schemaVersion: 2, experimentId: definition.id, runId: 'child', stateGeneration: 10,
    rootRunId: 'root', rootCreatedAt: at, modelStartedAt: at, phase: 'discovery', recoveryEpoch: 1,
    parentRunId: 'root', parentCheckpointDigest: 'checkpoint', releaseDigest: 'release', definitionDigest: 'definition',
    status: 'running', cursor: { stageIndex: 0, waveIndex: 1 }, artifacts: [], rejectedAttempts: [], stageEndReceipts: [],
    waveReceipts: [], availabilityBoundaries: [], checkpoints: [], budget: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    journal: [], createdAt: at, updatedAt: at, terminalReason: null, ...overrides }
  if (overrides.budget === undefined) value.budget = sumDashboardUsage([...value.artifacts, ...value.rejectedAttempts].map(item => item.usage))
  return value
}
const receipt = (taskId: string, overrides: Partial<LiveCompletion> = {}): LiveCompletion => ({
  requestDigest: `request-${taskId}`, stageId: 'discovery', waveId: 'wave-0', taskId, attempt: 1,
  model: 'fixture-model', provider: 'openai-codex-subscription', actorId: `actor-${taskId}`, promptDigest: `prompt-${taskId}`,
  outputDigest: `output-${taskId}`, recordedAt: at, usage: usage(7), ...overrides,
})
const emptyLive = { entries: [], legacyCount: 0, truncated: false }
const research = (id: string): ArtifactRecord['protocol'] => ({ research: { role: 'researcher', buildsOn: 'none', nextExperiment: 'none',
  materialHighCriticalDelta: false, observations: [{ id, statement: `Recorded document observation ${id}`, conditions: ['Fixture input'],
    consequence: 'A document needs review', evidence: ['fixture.md:1'] }] } })
const rejection = (taskId: string, overrides: Partial<RunState['rejectedAttempts'][number]> = {}): RunState['rejectedAttempts'][number] => ({
  stageId: 'discovery', waveId: 'wave-0', taskId, attempt: 1, promptDigest: `prompt-${taskId}`,
  outputDigest: `output-${taskId}`, quarantineUri: 'memory://quarantine', diagnostics: ['Fixture validation failure'],
  freshContext: false, continuationMode: 'new', sessionId: null, usage: usage(5), rejectedAt: at, ...overrides,
})

describe('read-only dashboard projection', () => {
  it('never certifies cost when a zero-token or legacy constituent has missing pricing', () => {
    const complete = usage(10, { costAccountingComplete: true })
    expect(sumDashboardUsage([complete, {
      modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      costAccountingComplete: false,
    }]).costAccountingComplete).toBe(false)
    expect(sumDashboardUsage([complete, {
      modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.01,
    }]).costAccountingComplete).toBe(false)
    expect(sumDashboardUsage([complete, {
      modelCalls: 0, inputTokens: 0, rawInputTokens: 2, cachedInputTokens: 2,
      outputTokens: 0, costUsd: 0,
    }]).costAccountingComplete).toBe(false)
    expect(sumDashboardUsage([complete, {
      modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    }]).costAccountingComplete).toBe(true)
  })
  const minute = (n: number) => new Date(Date.parse(at) + n * 60_000).toISOString()
  const admission = { stageId: 'discovery', waveId: 'wave-0', cursor: { stageIndex: 0, waveIndex: 0 }, admittedAt: at }
  const sealed = { stageId: 'discovery', waveId: 'wave-0', startedAt: at, completedAt: minute(10), durationMs: 600_000, artifactDigests: ['output-a'] }

  it.each([0, 1432])('uses a sealed single-task supervisor boundary (%i ms) without inventing provider usage', elapsedMs => {
    const configured = structuredClone(definition)
    const wave = configured.stages[1]!.waves[0]!
    wave.tasks = [{ ...wave.tasks[0]!, providerClass: 'deterministic', model: 'deterministic' }]
    const output = artifact('synth', { stageId: 'synthesis', model: 'deterministic', provider: 'deterministic-supervisor',
      usage: usage(0, { modelCalls: 0, outputTokens: 0, costUsd: 0 }) })
    const end = new Date(Date.parse(at) + elapsedMs).toISOString()
    const source = state({ artifacts: [output], cursor: { stageIndex: 2, waveIndex: 0 }, waveReceipts: [
      { ...sealed, stageId: 'synthesis', completedAt: end, durationMs: elapsedMs, artifactDigests: [output.contentDigest] },
    ] })
    const before = structuredClone(source)
    const project = () => buildDashboardSnapshot(source, configured, emptyLive, minute(20)).waves[2]!.tasks[0]!
    expect(project()).toMatchObject({ status: 'accepted', throughput: null, lastReceiptAt: null,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
      timing: { startedAt: at, finishedAt: end, elapsedMs, live: false, basis: 'single-task-wave' } })
    expect(source).toEqual(before)
    source.waveReceipts[0]!.artifactDigests = ['different-result']
    expect(project().timing?.elapsedMs).toBeNull()
    source.waveReceipts[0]!.artifactDigests = [output.contentDigest]
    wave.tasks = [...wave.tasks, task('another', 'another')]
    expect(project().timing?.elapsedMs).toBeNull()
    wave.tasks = wave.tasks.slice(0, 1)
    wave.tasks[0]!.providerClass = 'core'
    expect(project().timing?.elapsedMs).toBeNull()
    wave.tasks[0]!.providerClass = 'deterministic'
    source.waveReceipts = []
    expect(project().timing?.elapsedMs).toBeNull()
  })

  it('retains the last rejection boundary for unavailable agents without using wave seal time', () => {
    const source = state({ artifacts: [artifact('a', { status: 'additive-unavailable' })],
      waveReceipts: [sealed], rejectedAttempts: [rejection('a', { attempt: 2, rejectedAt: minute(4) })] })
    const result = buildDashboardSnapshot(source, definition, emptyLive, minute(20))
    expect(result.waves[0]!.tasks[0]).toMatchObject({ status: 'unavailable', throughput: null,
      timing: { startedAt: at, finishedAt: minute(4), elapsedMs: 240000, basis: 'last-rejection', live: false } })
    expect(result.recordedUsage).toMatchObject(source.budget)
    source.rejectedAttempts = []
    expect(buildDashboardSnapshot(source, definition, emptyLive, minute(20)).waves[0]!.tasks[0]!.timing?.elapsedMs).toBeNull()
  })

  it.each(['terminated', 'errored', 'complete'])('reconciles %s with stale saved running without fabricating end times or acceptance', native => {
    const source = state({ cursor: admission.cursor, waveAdmission: admission, artifacts: [artifact('a')] })
    const before = structuredClone(source)
    const snapshot = buildDashboardSnapshot(source, definition, { ...emptyLive,
      entries: [receipt('a', { recordedAt: minute(2) }), receipt('b', { recordedAt: minute(3) })] }, minute(100))
    const accepted = structuredClone(snapshot.waves[0]!.tasks[0])
    const returned = structuredClone(snapshot.waves[0]!.tasks[1])
    const usage = structuredClone(snapshot.recordedUsage)
    const result = reconcileDashboardStatus(snapshot, { status: native })
    const status = native === 'terminated' ? 'stopped' : native === 'errored' ? 'failed' : 'incomplete'
    expect(result.executionStatus).toBe(status)
    expect(result.run.status).toBe('running')
    expect(result.stages.map(stage => stage.status)).toEqual([status, 'not-run', 'not-run', 'not-run'])
    expect(result.waves[0]?.status).toBe(status)
    expect(result.waves[0]?.tasks[0]).toEqual(accepted)
    expect(result.waves[0]?.tasks[1]).toEqual(returned)
    expect(result.waves[0]?.tasks[2]).toMatchObject({ status: 'interrupted', throughput: null,
      timing: { live: false, elapsedMs: null, finishedAt: null } })
    for (const item of [result, result.stages[0]!, result.waves[0]!]) {
      expect(item.timing).toMatchObject({ live: false, elapsedMs: null, finishedAt: null })
      expect(item.throughput).toBeNull()
    }
    expect(result.waves.slice(1).every(wave => wave.status === 'not-run' && wave.tasks.every(t => t.status === 'not-run'))).toBe(true)
    expect(result.recordedUsage).toEqual(usage)
    expect(source).toEqual(before)
  })

  it('keeps sealed stages, accepted unavailable outcomes and known failed-run timing', () => {
    const snapshot = buildDashboardSnapshot(state({ status: 'failed', updatedAt: minute(7),
      cursor: { stageIndex: 1, waveIndex: 0 }, waveReceipts: [sealed],
      artifacts: [artifact('a'), artifact('b', { status: 'additive-unavailable' })] }), definition, emptyLive, minute(100))
    const timing = structuredClone(snapshot.timing)
    const tasks = structuredClone(snapshot.waves[0]!.tasks)
    const result = reconcileDashboardStatus(snapshot, { status: 'errored' })
    expect(result.timing).toEqual(timing)
    expect(result.stages.map(stage => stage.status)).toEqual(['complete', 'failed', 'not-run', 'not-run'])
    expect(result.waves[0]?.status).toBe('complete')
    expect(result.waves[0]?.tasks).toEqual(tasks)
  })

  it.each([{ status: 'running' }, { status: 'waitingForPause' }])('preserves live observations for nonterminal Workflow status %j', workflow => {
    const snapshot = buildDashboardSnapshot(state({ cursor: admission.cursor, waveAdmission: admission }), definition, emptyLive, minute(5))
    const before = structuredClone(snapshot)
    expect(reconcileDashboardStatus(snapshot, workflow)).toEqual({ ...before, executionStatus: 'running' })
  })

  it('shows a paused Workflow without declaring its in-flight container work terminated', () => {
    const snapshot = buildDashboardSnapshot(state({ cursor: admission.cursor, waveAdmission: admission,
      artifacts: [artifact('a')] }), definition, emptyLive, minute(5))
    const before = structuredClone(snapshot)
    expect(reconcileDashboardStatus(snapshot, { status: 'paused' })).toEqual({ ...before, executionStatus: 'paused' })
    expect(reconcileDashboardStatus(snapshot, { status: 'running' })).toEqual({ ...before, executionStatus: 'running' })
    snapshot.run.status = 'completed'
    expect(reconcileDashboardStatus(snapshot, { status: 'paused' }).executionStatus).toBe('completed')
  })

  it.each([null, {}, { status: 'unknown' }])('marks unavailable Workflow status %j unknown without declaring termination or discarding saved progress', workflow => {
    for (const status of ['created', 'running', 'completed', 'failed', 'stopped'] as const) {
      const snapshot = buildDashboardSnapshot(state({ status, cursor: admission.cursor,
        waveAdmission: admission, artifacts: [artifact('a')] }), definition, emptyLive, minute(5))
      const before = structuredClone(snapshot)
      const result = reconcileDashboardStatus(snapshot, workflow)
      expect(result.executionStatus).toBe(['created', 'running'].includes(status) ? 'unknown' : status)
      expect(result.run).toEqual(before.run)
      expect(result.recordedUsage).toEqual(before.recordedUsage)
      expect(result.waves[0]!.tasks[0]).toEqual(before.waves[0]!.tasks[0])
      if (['created', 'running'].includes(status)) expect(result).toEqual({ ...before, executionStatus: 'unknown' })
    }
  })

  it('requires saved completion for a finished audit and preserves all measured completed timing', () => {
    const snapshot = buildDashboardSnapshot(state({ status: 'completed', updatedAt: minute(10),
      cursor: { stageIndex: definition.stages.length, waveIndex: 0 }, waveReceipts: [sealed] }), definition, emptyLive, minute(100))
    const before = structuredClone(snapshot)
    expect(reconcileDashboardStatus(snapshot, { status: 'complete' })).toEqual({ ...before, executionStatus: 'completed' })
  })

  it('uses original task receipt timing in recovered waves without adding parent usage or provisional work', () => {
    const source = state({ artifacts: [artifact('a')], waveReceipts: [{ ...sealed, startedAt: minute(20), completedAt: minute(25) }] })
    const result = buildDashboardSnapshot(source, definition, emptyLive, minute(30), [
      { ...receipt('a', { recordedAt: minute(2) }), originTiming: { runId: 'root', startedAt: at, endedAt: minute(10) } },
      { ...receipt('b', { recordedAt: minute(4) }), originTiming: { runId: 'root', startedAt: at, endedAt: minute(10) } },
    ])
    expect(result.waves[0]?.tasks[0]?.timing).toMatchObject({ elapsedMs: 120000, sourceRunId: 'root', live: false })
    expect(result.waves[0]?.tasks[0]?.throughput?.totalTokensPerSecond).toBeCloseTo(12 / 120)
    expect(result.waves[0]?.timing).toMatchObject({ startedAt: at, elapsedMs: 25 * 60_000 })
    expect(result.waves[0]?.throughput?.totalTokensPerSecond).toBeCloseTo(12 / (25 * 60))
    expect(result.stages[0]?.timing).toMatchObject({ startedAt: at, elapsedMs: 30 * 60_000 })
    expect(result.stages[0]?.throughput?.totalTokensPerSecond).toBeCloseTo(12 / (30 * 60))
    expect(result.recordedUsage).toMatchObject(source.budget)
    expect(result.provisionalCompletions).toHaveLength(0)
    const wrongActor = buildDashboardSnapshot(source, definition, emptyLive, minute(30), [
      { ...receipt('a', { recordedAt: minute(2), actorId: 'unrelated-actor' }), originTiming: { runId: 'root', startedAt: at, endedAt: minute(10) } },
    ])
    expect(wrongActor.waves[0]?.tasks[0]?.timing?.elapsedMs).toBeNull()
    expect(wrongActor.waves[0]?.timing).toMatchObject({ startedAt: minute(20), elapsedMs: 5 * 60_000 })
  })

  it('shows separate return times before the wave seals and a live clock for the remaining agent', () => {
    const result = buildDashboardSnapshot(state({ cursor: admission.cursor, waveAdmission: admission, artifacts: [artifact('a')] }), definition,
      { ...emptyLive, entries: [receipt('b', { recordedAt: minute(4) }), receipt('a', { recordedAt: minute(2) })] }, minute(10))
    expect(result.waves[0]?.tasks.map(t => [t.status, t.timing?.elapsedMs, t.timing?.live])).toEqual([
      ['accepted', 120_000, false], ['returned', 240_000, false], ['awaiting-result', 600_000, true],
    ])
    expect(result.waves[0]?.timing).toMatchObject({ elapsedMs: 600_000, live: true })
    expect(result.stages[0]?.timing).toMatchObject({ elapsedMs: 600_000, live: true })
    expect(result.provisionalCompletions.map(t => t.taskId)).toEqual(['b'])
    expect(result.waves[1]?.timing?.elapsedMs).toBeNull()
    expect(result.waves[0]?.tasks[0]?.throughput?.totalTokensPerSecond).toBeCloseTo(12 / 120)
    expect(result.waves[0]?.tasks[1]?.throughput).toMatchObject({ totalTokensPerSecond: 9 / 240, provisional: true })
    expect(result.waves[0]?.tasks[2]?.throughput).toBeNull()
    // Sum recorded + unvalidated receipts once, then divide by the common elapsed span.
    for (const rate of [result.throughput, result.waves[0]?.throughput, result.stages[0]?.throughput]) {
      expect(rate).toMatchObject({ totalTokensPerSecond: 21 / 600, partial: true, provisional: true })
    }
  })

  it('retains completed-agent times without timing missing or inherited receipts as zero', () => {
    const result = buildDashboardSnapshot(state({ status: 'completed', cursor: { stageIndex: definition.stages.length, waveIndex: 0 }, waveReceipts: [sealed], artifacts: [artifact('a'), artifact('b')] }), definition,
      { ...emptyLive, entries: [receipt('a', { recordedAt: minute(2) }), receipt('b', { recordedAt: minute(50) })] }, minute(100))
    expect(result.waves[0]?.tasks[0]?.timing).toMatchObject({ elapsedMs: 120_000, live: false })
    expect(result.waves[0]?.tasks[1]?.timing).toMatchObject({ elapsedMs: null, live: false })
    expect(result.waves[0]?.tasks[1]?.throughput).toBeNull()
    expect(result.waves[0]?.timing).toMatchObject({ elapsedMs: 600_000, live: false })
    expect(result.stages[0]?.timing).toMatchObject({ elapsedMs: 600_000, live: false })
  })

  it.each(['failed', 'stopped'] as const)('freezes interrupted clocks at the recorded %s time', status => {
    const result = buildDashboardSnapshot(state({ status, cursor: admission.cursor, waveAdmission: admission, updatedAt: minute(7) }), definition, emptyLive, minute(100))
    expect(result.waves[0]?.tasks.every(t => t.timing?.elapsedMs === 420_000 && !t.timing.live)).toBe(true)
    expect(result.waves[0]?.timing).toMatchObject({ elapsedMs: 420_000, live: false })
    expect(result.stages[0]?.timing).toMatchObject({ elapsedMs: 420_000, live: false })
  })

  it('does not divide historical untimed wave usage by a later wave duration', () => {
    const result = buildDashboardSnapshot(state({
      waveAdmission: { ...admission, waveId: 'wave-1', cursor: { stageIndex: 0, waveIndex: 1 }, admittedAt: minute(8) },
      artifacts: [artifact('a'), artifact('c', { waveId: 'wave-1' })],
    }), definition, emptyLive, minute(10))
    expect(result.waves[0]?.throughput).toBeNull()
    expect(result.waves[1]?.throughput?.totalTokensPerSecond).toBeCloseTo(12 / 120)
    expect(result.stages[0]?.throughput).toBeNull()
    expect(result.throughput?.totalTokensPerSecond).toBeCloseTo(24 / 600)
  })

  it('requires the accepted output identity and bounds receipt times to their own wave', () => {
    const result = buildDashboardSnapshot(state({ waveReceipts: [sealed], artifacts: [artifact('a')] }), definition,
      { ...emptyLive, entries: [receipt('a', { outputDigest: 'wrong-output', recordedAt: minute(2) }),
        receipt('a', { requestDigest: 'future', recordedAt: minute(11) }),
        receipt('a', { requestDigest: 'old', recordedAt: minute(-1) })] }, minute(100))
    expect(result.waves[0]?.tasks[0]?.timing?.elapsedMs).toBeNull()
  })

  it('measures the latest returned attempt from admission including time spent on retries', () => {
    const input = state({ cursor: admission.cursor, waveAdmission: admission, rejectedAttempts: [rejection('a', { rejectedAt: minute(2) })] })
    const live = { ...emptyLive, entries: [receipt('a', { attempt: 2, outputDigest: 'new-output', recordedAt: minute(6) }),
      receipt('a', { requestDigest: 'earlier', recordedAt: minute(1) })] }
    const result = buildDashboardSnapshot(input, definition, live, minute(10))
    expect(result.waves[0]?.tasks[0]).toMatchObject({ status: 'returned', timing: { elapsedMs: 360_000, live: false, basis: 'result' } })
  })

  it('does not start clocks from the cursor or run creation when admission is unrecorded', () => {
    const result = buildDashboardSnapshot(state({ cursor: admission.cursor }), definition, emptyLive, minute(10))
    expect(result.waves[0]?.tasks.every(t => t.timing?.elapsedMs === null && !t.timing.live)).toBe(true)
    expect(result.stages[0]?.timing?.elapsedMs).toBeNull()
  })

  it('projects assignment metadata from the saved definition without renumbering workspaces', () => {
    const saved = structuredClone(definition)
    const entry = saved.stages[0]!.waves[0]!.tasks[0]!
    Object.assign(entry, { workspaceKey: 'custom-workspace-99', providerClass: 'additive',
      modelPool: 'deepseek-endpoint-a',
      research: { wave: 0, researcher: 3, role: 'researcher', buildsOn: 'none', laneScratchPath: '/fixture' } })
    const result = buildDashboardSnapshot(state(), saved, emptyLive, at)
    expect(result.waves[0]?.tasks[0]).toMatchObject({ agentId: 'custom-workspace-99', modelPool: 'deepseek-endpoint-a', localWave: 0,
      promptKind: 'research', providerClass: 'additive', researcher: 3 })
    expect(result.waves[2]?.tasks[0]).not.toHaveProperty('researcher')
  })

  it('shows every current lane before the barrier seals without promoting provisional output', () => {
    const input = state({ cursor: { stageIndex: 0, waveIndex: 0 }, artifacts: [artifact('a')] })
    const result = buildDashboardSnapshot(input, definition, { ...emptyLive, entries: [receipt('b'), receipt('b')] }, at)
    expect(result.waves[0]?.tasks.map(t => [t.agentId, t.status])).toEqual([
      ['lane-a', 'accepted'], ['lane-b', 'returned'], ['lane-negative', 'awaiting-result'],
    ])
    expect(result.waves[0]?.status).toBe('current')
    expect(result.waves[0]?.tasks[1]).toMatchObject({ model: 'fixture-model', lastAttempt: 1,
      lastReceiptAt: at, usage: { modelCalls: 0 }, provisionalUsage: { modelCalls: 1 } })
    expect(result.waves[1]?.tasks.every(t => t.status === 'pending')).toBe(true)
    expect(result.nodes).toEqual([])
    expect(result.findings).toEqual([])
    expect(result.provisionalUsage.modelCalls).toBe(1)
  })

  it('separates repeated lanes and wave IDs across stages, including inherited accepted work', () => {
    const result = buildDashboardSnapshot(state({ artifacts: [artifact('a')] }), definition,
      { ...emptyLive, entries: [receipt('a'), receipt('synth', { stageId: 'synthesis' })] }, at)
    expect(result.waves[0]?.tasks[0]?.status).toBe('accepted')
    expect(result.waves[1]?.tasks[0]).toMatchObject({ agentId: 'lane-a', status: 'awaiting-result' })
    expect(result.waves[2]?.tasks[0]).toMatchObject({ taskId: 'synth', status: 'returned' })
    expect(result.waves[0]?.tasks[0]?.provisionalUsage.modelCalls).toBe(0)
  })

  it('uses the accepted retry receipt for context after usage deduplication', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    const input = state({ artifacts: [artifact('a', { actorId: id })], waveReceipts: [sealed],
      rejectedAttempts: [rejection('a')], journal: [{ sequence: 0, at, type: 'agent.attempt-admitted',
        digest: 'journal', previousDigest: null, payload: { stageId: 'discovery', waveId: 'wave-0', taskId: 'a',
          attempt: 2, promptDigest: 'prompt-a', continuationMode: 'resume', sessionId: id, freshContext: false } }] })
    const result = buildDashboardSnapshot(input, definition,
      { ...emptyLive, entries: [receipt('a', { actorId: id, attempt: 2, recordedAt: minute(3) })] }, minute(10))
    expect(result.waves[0]?.tasks[0]).toMatchObject({ lastAttempt: 2, context: { mode: 'resume', sessionId: id, mismatch: false } })
  })

  it('distinguishes a rejected attempt, a newer return, and an unavailable lane', () => {
    const input = state({ cursor: { stageIndex: 0, waveIndex: 0 }, rejectedAttempts: [rejection('a'), rejection('b')],
      artifacts: [artifact('negative', { status: 'additive-unavailable' })] })
    const result = buildDashboardSnapshot(input, definition, { ...emptyLive, entries: [receipt('a'),
      receipt('b', { requestDigest: 'retry-b', attempt: 2, outputDigest: 'new-output', recordedAt: '2026-09-22T12:01:00.000Z' })] }, at)
    expect(result.waves[0]?.tasks.map(t => t.status)).toEqual(['rejected', 'returned', 'unavailable'])
    expect(result.waves[0]?.tasks[1]).toMatchObject({ lastAttempt: 2, rejectedAttempts: 1,
      usage: { modelCalls: 1 }, provisionalUsage: { modelCalls: 1 } })
    // A late listing of an earlier, unaccounted receipt cannot hide a newer rejection.
    const stale = buildDashboardSnapshot(state({ rejectedAttempts: [rejection('a', { attempt: 2 })] }), definition,
      { ...emptyLive, entries: [receipt('a')] }, at)
    expect(stale.waves[0]?.tasks[0]?.status).toBe('rejected')
  })

  it('uses recovery admission for status while retaining inherited rejection accounting', () => {
    const input = state({ cursor: admission.cursor, waveAdmission: { ...admission, admittedAt: minute(10) },
      rejectedAttempts: [rejection('a'), rejection('a', { attempt: 2, rejectedAt: minute(2) })],
      inFlightAgentAttempts: [{ ...admission, taskId: 'a', attempt: 1, promptDigest: 'fresh-prompt',
        freshContext: true, continuationMode: 'new', sessionId: null, admittedAt: minute(10) }] })
    const pending = buildDashboardSnapshot(input, definition, emptyLive, minute(15))
    expect(pending.waves[0]?.tasks[0]).toMatchObject({ status: 'awaiting-result', lastAttempt: 1,
      rejectedAttempts: 2, timing: { elapsedMs: 300_000, finishedAt: null, live: true }, usage: { modelCalls: 2 } })
    expect(pending.recordedUsage).toMatchObject(input.budget)
    const returned = buildDashboardSnapshot(input, definition, { ...emptyLive,
      entries: [receipt('a', { promptDigest: 'fresh-prompt', recordedAt: minute(14) })] }, minute(15))
    expect(returned.waves[0]?.tasks[0]).toMatchObject({ status: 'returned', lastAttempt: 1,
      rejectedAttempts: 2, timing: { elapsedMs: 240_000, live: false } })
    const rejected = buildDashboardSnapshot({ ...input, inFlightAgentAttempts: [],
      rejectedAttempts: [...input.rejectedAttempts, rejection('a', { promptDigest: 'fresh-prompt', rejectedAt: minute(14) })] },
      definition, emptyLive, minute(15))
    expect(rejected.waves[0]?.tasks[0]).toMatchObject({ status: 'rejected', lastAttempt: 1,
      rejectedAttempts: 3, timing: { elapsedMs: 240_000, live: false } })
  })

  it('shows an admitted retry as pending and stops its clock when the run terminates', () => {
    const input = state({ cursor: admission.cursor, waveAdmission: admission,
      rejectedAttempts: [rejection('a', { rejectedAt: minute(2) })],
      inFlightAgentAttempts: [{ ...admission, taskId: 'a', attempt: 2, promptDigest: 'retry-prompt',
        freshContext: true, continuationMode: 'new', sessionId: null, admittedAt: minute(3) }] })
    expect(buildDashboardSnapshot(input, definition, emptyLive, minute(5)).waves[0]?.tasks[0])
      .toMatchObject({ status: 'awaiting-result', lastAttempt: 2, timing: { elapsedMs: 300_000, live: true } })
    for (const status of ['failed', 'stopped'] as const) {
      expect(buildDashboardSnapshot({ ...input, status, updatedAt: minute(5) }, definition, emptyLive, minute(5)).waves[0]?.tasks[0])
        .toMatchObject({ status: 'interrupted', timing: { elapsedMs: 300_000, live: false } })
    }
  })

  it.each(['failed', 'stopped'] as const)('does not claim agents are running after the run is %s', status => {
    const result = buildDashboardSnapshot(state({ status, cursor: { stageIndex: 0, waveIndex: 0 } }), definition,
      { entries: [receipt('b')], truncated: true, legacyCount: 1 }, at)
    expect(result.waves[0]?.tasks.map(t => t.status)).toEqual(['interrupted', 'returned', 'interrupted'])
    expect(result.waves[1]?.tasks.every(t => t.status === 'not-run')).toBe(true)
    expect(result.freshness).toMatchObject({ receiptsTruncated: true, legacyReceipts: 1 })
  })

  it('keeps created tasks planned and skipped waves not run', () => {
    const created = buildDashboardSnapshot(state({ status: 'created', cursor: { stageIndex: 0, waveIndex: 0 } }), definition, emptyLive, at)
    expect(created.waves[0]?.tasks.every(t => t.status === 'pending')).toBe(true)
    const completed = buildDashboardSnapshot(state({ status: 'completed' }), definition, emptyLive, at)
    expect(completed.waves.every(w => w.tasks.every(t => t.status === 'not-run'))).toBe(true)
  })

  it('does not convert advisory static-analysis output into an audit finding', () => {
    const preflight = artifact('static-analysis-advisory', {
      stageId: 'preflight',
      files: ['detector-output.txt'],
      assertions: ['synthetic detector alert: possible reentrancy'],
      protocol: {},
    })
    const result = buildDashboardSnapshot(state({ artifacts: [preflight] }), definition, emptyLive, at)

    expect(result.findings).toEqual([])
    expect(result.nodes.filter(node => node.kind === 'observation')).toEqual([])
  })

  it('exposes an accepted report independently of findings and excludes unavailable report output', () => {
    const result = buildDashboardSnapshot(state({ status: 'completed', artifacts: [
      artifact('reporter', { stageId: 'reporting', protocol: { retainedReferences: [] } }),
      artifact('reporter', { id: 'unavailable-report', stageId: 'reporting', status: 'additive-unavailable' }),
    ] }), definition, emptyLive, at)
    expect(result.findings).toEqual([])
    expect(result.nodes.filter(node => node.kind === 'report').map(node => node.artifactId)).toEqual(['artifact-reporter'])
  })
  it('includes accepted and rejected usage once across inherited work and continuing workspace tasks', () => {
    const input = state({ artifacts: [artifact('a', { usage: usage(20, { rawInputTokens: 30, cachedInputTokens: 10, cacheAccountingComplete: true }) }),
      artifact('a-next', { waveId: 'wave-1', usage: usage(3) })], rejectedAttempts: [rejection('a')],
    waveReceipts: [{ stageId: 'discovery', waveId: 'wave-0', startedAt: at, completedAt: at, durationMs: 0, artifactDigests: ['output-a'] }] })
    const before = structuredClone(input)
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.recordedUsage).toMatchObject({ modelCalls: 3, inputTokens: 28, outputTokens: 6, costUsd: 0.03,
      rawInputTokens: 38, cachedInputTokens: 10, cacheAccountingComplete: false,
      costAccountingComplete: false })
    expect(result.agents.find(agent => agent.id === 'lane-a')).toMatchObject({ acceptedTasks: 2, rejectedAttempts: 1,
      usage: { inputTokens: 28 } })
    expect(result.activity.filter(item => item.agentId === 'lane-a').map(item => item.usage.inputTokens)).toEqual([25, 3])
    expect(result.stages[0]).toMatchObject({ usage: { inputTokens: 28 }, completedWaves: 1 })
    expect(result.waves[0]).toMatchObject({ usage: { inputTokens: 25 }, status: 'complete' })
    expect(result.waves[1]).toMatchObject({ status: 'current', usage: { inputTokens: 3 }, startedAt: null })
    expect(result.run).toMatchObject({ rootRunId: 'root', parentRunId: 'root', recoveryEpoch: 1 })
    expect(input).toEqual(before)
  })

  it('deduplicates terminal tasks and exact rejected receipts while keeping unmatched attempts provisional', () => {
    const accepted = receipt('a', { requestDigest: 'accepted-without-stored-attempt', attempt: 3, promptDigest: 'another-prompt' })
    const rejected = receipt('b')
    const provisional = receipt('b', { requestDigest: 'next-attempt', attempt: 2, usage: usage(13) })
    const input = state({ artifacts: [artifact('a')], rejectedAttempts: [rejection('b')] })
    const result = buildDashboardSnapshot(input, definition, { entries: [accepted, rejected, provisional, { ...provisional }],
      legacyCount: 2, truncated: true }, at)
    expect(result.recordedUsage.inputTokens).toBe(15)
    expect(result.provisionalUsage.inputTokens).toBe(13)
    expect(result.provisionalCompletions.map(item => item.requestDigest)).toEqual(['next-attempt'])
    expect(result.freshness).toMatchObject({ liveReceipts: 3, legacyReceipts: 2, receiptsTruncated: true, inFlightTokensKnown: false })
    expect(result.findings).toEqual([])
    expect(result.limitations.join(' ')).toMatch(/truncated/)
  })

  it('marks unexecuted planned waves as not run after their stage ends', () => {
    const result = buildDashboardSnapshot(state({ cursor: { stageIndex: 1, waveIndex: 0 },
      waveReceipts: [{ stageId: 'discovery', waveId: 'wave-0', startedAt: at, completedAt: at, durationMs: 0, artifactDigests: [] }],
    }), definition, emptyLive, at)
    expect(result.waves.slice(0, 3).map(wave => wave.status)).toEqual(['complete', 'not-run', 'current'])
  })

  it('preserves tied explicit contributors, many-to-many mappings, refutations and replicated review dissent', () => {
    const decisions = [
      { observationId: 'OBS-A', action: 'uphold' as const, finalDisposition: 'candidate' as const, finalReference: 'C-1', rationale: 'Fixture reviewer preserves candidate' },
      { observationId: 'OBS-A', action: 'unresolved' as const, finalDisposition: 'unresolved' as const, finalReference: 'U-1', rationale: 'Fixture reviewer retains uncertainty' },
    ]
    const input = state({ artifacts: [
      artifact('a', { protocol: research('OBS-A') }), artifact('b', { protocol: research('OBS-B') }),
      artifact('c', { waveId: 'wave-1', protocol: research('OBS-C') }), artifact('negative', { protocol: research('OBS-NEG') }),
      artifact('synth', { stageId: 'synthesis', protocol: { synthesisDispositions: [
        ...['OBS-A', 'OBS-B', 'OBS-C'].map(id => ({ id, disposition: 'candidate' as const, reference: 'C-1', rationale: 'Fixture link' })),
        { id: 'OBS-NEG', disposition: 'refuted', reference: 'none', rationale: 'Fixture evidence refutes observation' },
      ] } }),
      artifact('review-a', { stageId: 'review', protocol: { reviewDecisions: [decisions[0]!] } }),
      artifact('review-b', { stageId: 'review', protocol: { reviewDecisions: [decisions[1]!] } }),
      artifact('union', { stageId: 'review', protocol: { reviewUnion: [{ observationId: 'OBS-A', dissent: true,
        retainedReferences: ['C-1', 'U-1'], decisions: decisions.map((decision, index) => ({ ...decision,
          reviewerTaskId: index === 0 ? 'review-a' : 'review-b', actorId: index === 0 ? 'actor-review-a' : 'actor-review-b',
          model: 'fixture-model', provider: 'openai-codex-subscription' })) }] } }),
      artifact('reporter', { stageId: 'reporting', protocol: { retainedReferences: ['C-1', 'U-1', 'REF-UNATTRIBUTED'] } }),
    ] })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.findings.find(finding => finding.id === 'C-1')).toMatchObject({ observationIds: ['OBS-A', 'OBS-B', 'OBS-C'],
      contributors: ['lane-a', 'lane-b', 'lane-c'], firstContributors: ['lane-a', 'lane-b'], earliestWave: 0,
      disposition: 'unresolved', dissent: true, inReport: true, confirmation: 'not-recorded', severity: 'not-recorded' })
    expect(result.findings.find(finding => finding.id === 'U-1')).toMatchObject({ observationIds: ['OBS-A'], inReport: true })
    expect(result.findings.find(finding => finding.id === 'OBS-NEG')).toMatchObject({ disposition: 'refuted', inReport: false })
    expect(result.findings.find(finding => finding.id === 'REF-UNATTRIBUTED')).toMatchObject({ contributors: [],
      firstContributors: [], earliestWave: null, disposition: 'unresolved', inReport: true })
    expect(result.nodes.filter(node => node.kind === 'review')).toHaveLength(2)
    expect(result.nodes.filter(node => node.kind === 'review').map(node => node.detail)).toEqual(expect.arrayContaining([
      expect.stringContaining('candidate | C-1'), expect.stringContaining('unresolved | U-1'),
    ]))
    const nodeIds = new Set(result.nodes.map(node => node.id))
    expect(result.edges.every(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true)
    expect(result.agents.find(agent => agent.id === 'lane-c')?.linkedReportItems).toBe(1)
    expect(result.agents.find(agent => agent.id === 'review-a')?.linkedReportItems).toBe(0)
    expect(result.agents.find(agent => agent.id === 'lane-a')?.firstRecordedItems).toBe(2)
    expect(result.agents.find(agent => agent.id === 'lane-b')?.firstRecordedItems).toBe(1)
    expect(result.agents.find(agent => agent.id === 'lane-c')?.firstRecordedItems).toBe(0)
    expect(result.agents.find(agent => agent.id === 'lane-negative')?.firstRecordedItems).toBe(0)
  })

  it('uses recorded review outcomes over earlier primary disposition and retains unknown source nodes', () => {
    const input = state({ artifacts: [artifact('a', { protocol: research('OBS-A') }),
      artifact('synth', { stageId: 'synthesis', protocol: { synthesisDispositions: [
        { id: 'OBS-A', disposition: 'candidate', reference: 'C-1', rationale: 'Fixture primary candidate' },
      ] } }),
      artifact('review-a', { stageId: 'review', protocol: { reviewDecisions: [
        { observationId: 'OBS-A', action: 'narrow', finalDisposition: 'refuted', finalReference: 'none', rationale: 'Fixture refutation' },
        { observationId: 'OBS-MISSING', action: 'unresolved', finalDisposition: 'unresolved', finalReference: 'U-2', rationale: 'Fixture missing source' },
      ] } }),
    ] })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.findings.find(finding => finding.id === 'C-1')).toMatchObject({ disposition: 'refuted', dissent: false })
    expect(result.findings.find(finding => finding.id === 'U-2')).toMatchObject({ contributors: [], earliestWave: null })
    expect(result.nodes.find(node => node.id === 'observation:OBS-MISSING')).toMatchObject({ agentId: null, artifactId: null })
  })

  it('retains every observation while bounding long display text and preserves the authoritative budget on gaps', () => {
    const long = 'Document detail '.repeat(1000)
    const protocol = research('OBS-LONG')
    protocol.research = { ...protocol.research!, observations: Array.from({ length: 40 }, (_, index) => ({
      id: `OBS-${index}`, statement: long, conditions: [long], consequence: long, evidence: [long],
    })) }
    const input = state({ artifacts: [artifact('a', { protocol })], budget: { modelCalls: 7, inputTokens: 123, outputTokens: 9, costUsd: 0.2 } })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.nodes.filter(node => node.kind === 'observation')).toHaveLength(40)
    expect(result.findings).toHaveLength(40)
    expect(result.nodes.every(node => node.label.length <= 240 && node.detail.length <= 3000)).toBe(true)
    expect(result.recordedUsage).toMatchObject(input.budget)
    expect(result.recordedUsage.rawInputTokens).toBeUndefined()
    expect(result.recordedUsage.cacheAccountingComplete).toBe(false)
    expect(result.limitations.join(' ')).toMatch(/Receipt sums differ/)
  })

  it('preserves custody-only refutations as evidence without counting them as retained report items', () => {
    const input = state({ artifacts: [
      artifact('synth', { stageId: 'synthesis', protocol: { coverageUnion: [{
        sourceTaskId: 'a', actorId: 'actor-a', model: 'fixture-model', provider: 'openai-codex-subscription',
        observation: { id: 'UNION-OBS', perspective: 'architecture', disposition: 'refuted', reference: 'none',
          rationale: 'Fixture union preserves a refuted observation', referenceEvidence: null },
      }] } }),
      artifact('reporter', { stageId: 'reporting' }),
      artifact('seal-final', { stageId: 'reporting', protocol: { finalCustody: { schemaVersion: 1,
        sourceReportArtifactDigest: 'output-reporter', negativeReviewUnionArtifactDigest: 'output-union',
        retainedReferences: [], decisionDissentObservationIds: [], observations: [{ observationId: 'UNION-OBS',
          observationDigest: 'observation-digest', primaryDispositionDigest: 'disposition-digest', retainedReferences: [], decisionDissent: false }],
      } } }),
    ] })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.nodes.find(node => node.id === 'observation:UNION-OBS')).toMatchObject({ agentId: 'lane-a', artifactId: null, model: 'fixture-model' })
    expect(result.findings.find(finding => finding.id === 'UNION-OBS')).toMatchObject({ disposition: 'refuted',
      inReport: false, contributors: ['lane-a'], firstContributors: ['lane-a'], confirmation: 'not-recorded' })
    expect(result.agents.find(agent => agent.id === 'lane-a')).toMatchObject({ linkedReportItems: 0, firstRecordedItems: 0 })
    expect(result.edges).toContainEqual({ from: 'observation:UNION-OBS', to: 'report:artifact-seal-final', kind: 'report' })
    expect(result.findings.find(finding => finding.id === 'UNION-OBS')?.nodeIds).toContain('report:artifact-seal-final')
    expect(result.edges).toContainEqual({ from: 'report:artifact-reporter', to: 'report:artifact-seal-final', kind: 'report' })
  })

  it('counts explicitly retained observation identifiers even when no candidate reference exists', () => {
    const input = state({ artifacts: [artifact('a', { protocol: research('OBS-A') }),
      artifact('reporter', { stageId: 'reporting', protocol: { retainedReferences: ['OBS-A'] } }),
    ] })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.findings.find(finding => finding.id === 'OBS-A')).toMatchObject({ inReport: true, disposition: 'unresolved',
      confirmation: 'not-recorded', firstContributors: ['lane-a'] })
    expect(result.agents.find(agent => agent.id === 'lane-a')).toMatchObject({ linkedReportItems: 1, firstRecordedItems: 1 })
  })

  it('preserves independently retained observations alongside their grouped references', () => {
    const input = state({ artifacts: [artifact('a', { protocol: research('OBS-A') }),
      artifact('synth', { stageId: 'synthesis', protocol: { synthesisDispositions: [
        { id: 'OBS-A', disposition: 'candidate', reference: 'C-1', rationale: 'Fixture grouping' },
      ] } }),
      artifact('reporter', { stageId: 'reporting', protocol: { retainedReferences: ['C-1', 'OBS-A'] } }),
    ] })
    const result = buildDashboardSnapshot(input, definition, emptyLive, at)
    expect(result.findings.filter(finding => finding.inReport).map(finding => finding.id)).toEqual(['C-1', 'OBS-A'])
    expect(result.findings.find(finding => finding.id === 'OBS-A')).toMatchObject({ observationIds: ['OBS-A'], contributors: ['lane-a'] })
    expect(result.agents.find(agent => agent.id === 'lane-a')).toMatchObject({ linkedReportItems: 2, firstRecordedItems: 2 })
  })

  it('reads optional structured verification outcomes without inferring confirmation from old prose', () => {
    // Historical JSON is read from storage before the dashboard validates optional fields.
    const protocol: ArtifactRecord['protocol'] = JSON.parse(JSON.stringify({ retainedReferences: ['C-1'], verificationOutcomes: [
      { reference: 'C-1', behavior: 'reproduced', exploitability: 'supported', evidence: 'Fixture document receipt A' },
      { reference: 'C-1', behavior: 'reproduced', exploitability: 'unresolved',
        evidenceMethod: 'prior-execution-reviewed', evidence: 'Fixture document receipt B' },
      { reference: 'C-1', behavior: 'invented', exploitability: 'supported', evidence: 'Invalid record' },
    ] }))
    const result = buildDashboardSnapshot(state({ artifacts: [artifact('reporter', { stageId: 'reporting', protocol })] }),
      definition, emptyLive, at)
    const finding = result.findings.find(value => value.id === 'C-1')!
    expect(finding).toMatchObject({ inReport: true, confirmation: 'axes-recorded', severity: 'not-recorded', dissent: true })
    expect(finding.verification).toHaveLength(2)
    expect(finding.verification.map(value => value.exploitability)).toEqual(['supported', 'unresolved'])
    expect(finding.verification.map(value => value.evidenceMethod)).toEqual([undefined, 'prior-execution-reviewed'])
    expect(result.nodes.filter(node => node.kind === 'verification')).toHaveLength(2)
    expect(result.nodes.filter(node => node.kind === 'verification').map(node => node.detail)).toEqual([
      expect.stringContaining('Evidence method: not recorded'),
      expect.stringContaining('Evidence method: prior-execution-reviewed'),
    ])
    expect(result.edges).toContainEqual({ from: finding.verification[0]!.nodeId, to: 'report:artifact-reporter', kind: 'report' })
    expect(result.limitations.join(' ')).toContain('invalid structured verification')
  })

  it('preserves the complete structured frontier above 512 records through review, verification and reporting', () => {
    const total = 513
    const researchers = Array.from({ length: 9 }, (_, index) => task(`research-${index}`, `lane-${index}`))
    const expanded: ExperimentDefinition = { ...definition, stages: [
      { ...definition.stages[0]!, waves: [
        { ...definition.stages[0]!.waves[0]!, tasks: researchers }, ...definition.stages[0]!.waves.slice(1),
      ] }, ...definition.stages.slice(1),
    ] }
    const ids = Array.from({ length: total }, (_, index) => `OBS-${index + 1}`)
    const references = ids.map((_, index) => `C-${index + 1}`)
    const researchArtifacts = researchers.map((researcher, index) => artifact(researcher.id, { protocol: { research: {
      role: 'researcher', buildsOn: 'none', nextExperiment: 'none', materialHighCriticalDelta: false,
      observations: ids.slice(index * 64, (index + 1) * 64).map(id => ({ id, statement: `Document record ${id}`,
        conditions: ['Synthetic document inventory'], consequence: 'Requires document review', evidence: ['fixture.md:1'] })),
    } } }))
    const input = state({ artifacts: [...researchArtifacts,
      artifact('synth', { stageId: 'synthesis', protocol: { synthesisDispositions: ids.map((id, index) => ({
        id, disposition: 'candidate', reference: references[index]!, rationale: 'Explicit document grouping',
      })) } }),
      artifact('review-a', { stageId: 'review', protocol: { reviewDecisions: ids.map((observationId, index) => ({
        observationId, action: 'uphold', finalDisposition: 'candidate', finalReference: references[index]!,
        rationale: 'Independent document review retains this record',
      })) } }),
      artifact('review-b', { stageId: 'review', protocol: { verificationOutcomes: references.map(reference => ({
        reference, behavior: 'reproduced', exploitability: 'unresolved', evidence: 'Synthetic document check',
      })) } }),
      artifact('reporter', { stageId: 'reporting', protocol: { retainedReferences: references } }),
    ] })
    const result = buildDashboardSnapshot(input, expanded, emptyLive, at)
    expect(result.findings.filter(finding => finding.inReport)).toHaveLength(total)
    expect(result.nodes.filter(node => node.kind === 'observation')).toHaveLength(total)
    expect(result.nodes.filter(node => node.kind === 'review')).toHaveLength(total)
    expect(result.nodes.filter(node => node.kind === 'verification')).toHaveLength(total)
    expect(result.findings.find(finding => finding.id === 'C-513')).toMatchObject({
      observationIds: ['OBS-513'], contributors: ['lane-8'], firstContributors: ['lane-8'],
      confirmation: 'axes-recorded', verification: [{ behavior: 'reproduced', exploitability: 'unresolved' }],
    })
    const nodeIds = new Set(result.nodes.map(node => node.id))
    expect(result.edges.every(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))).toBe(true)
    expect(result.recordedUsage).toMatchObject(input.budget)
  })
})

describe('independent discovery views', () => {
  const minute = (n: number) => new Date(Date.parse(at) + n * 60_000).toISOString()
  const pools = structuredClone(definition)
  for (const [index, wave] of pools.stages[0]!.waves.entries()) for (const item of wave.tasks) {
    item.modelPool = ['negative', 'c'].includes(item.id) ? 'endpoint-b' : 'endpoint-a'
    item.research = { wave: index, researcher: 1, role: 'researcher', buildsOn: 'none', laneScratchPath: '/workspace/scratch' }
  }
  const cohort = (poolId: string, waveId: string, started: number, ended: number) => ({
    stageId: 'discovery', poolId, waveId, startedAt: minute(started), completedAt: minute(ended),
    durationMs: (ended - started) * 60_000, artifactDigests: [],
  })

  it('shows fast wave1 and slow wave0 concurrently with their own clocks, usage and original API identities', () => {
    const input = { ...state({ cursor: { stageIndex: 0, waveIndex: 0 }, artifacts: [artifact('a'), artifact('b')] }),
      waveReceipts: [cohort('endpoint-a', 'wave-0', 0, 10)],
      discoveryScheduler: { stageId: 'discovery', admissions: [
        { stageId: 'discovery', waveId: 'wave-1', poolId: 'endpoint-a', taskIds: ['a-next'], admittedAt: minute(10) },
        { stageId: 'discovery', waveId: 'wave-0', poolId: 'endpoint-b', taskIds: ['negative'], admittedAt: minute(0) },
      ] } }
    const result = buildDashboardSnapshot(input, pools, { ...emptyLive, entries: [receipt('negative', { recordedAt: minute(20) })] }, minute(30))
    const waves = result.waves.filter(wave => wave.stageId === 'discovery')
    expect(waves.map(wave => [wave.id, wave.status, wave.timing?.elapsedMs])).toEqual([
      ['wave-0@endpoint-a', 'complete', 600_000], ['wave-0@endpoint-b', 'current', 1_800_000],
      ['wave-1@endpoint-a', 'current', 1_200_000], ['wave-1@endpoint-b', 'pending', null],
    ])
    expect(waves[0]?.sourceWaveId).toBe('wave-0')
    expect(waves[1]?.tasks[0]).toMatchObject({ taskId: 'negative', modelPool: 'endpoint-b', status: 'returned', timing: { elapsedMs: 1_200_000 } })
    expect(waves[0]?.usage.modelCalls).toBe(2)
    expect(waves[1]?.usage.modelCalls).toBe(0)
    expect(waves[0]?.throughput?.provisional).toBe(false)
    expect(waves[1]?.throughput?.provisional).toBe(true)
    expect(result.activity.every(row => row.waveId === 'wave-0@endpoint-a')).toBe(true)
    expect(result.stages[0]).toMatchObject({ completedWaves: 1, waveCount: 4, waveUnit: 'pool waves', timing: { elapsedMs: 1_800_000 } })
    expect(result.recordedUsage.modelCalls).toBe(2)
  })

  it('credits publication order across pools rather than treating slow wave0 as earlier than fast wave1', () => {
    const input = { ...state({ artifacts: [
      artifact('a-next', { waveId: 'wave-1', protocol: research('OBS-FAST') }),
      artifact('negative', { protocol: research('OBS-SLOW') }),
      artifact('synth', { stageId: 'synthesis', protocol: { synthesisDispositions: ['OBS-FAST', 'OBS-SLOW'].map(id => ({
        id, disposition: 'candidate' as const, reference: 'C-1', rationale: 'Fixture link',
      })) } }),
    ] }), waveReceipts: [cohort('endpoint-b', 'wave-0', 0, 30), cohort('endpoint-a', 'wave-1', 10, 20)],
      discoveryScheduler: { stageId: 'discovery', admissions: [] } }
    let result = buildDashboardSnapshot(input, pools, emptyLive, minute(40))
    expect(result.findings.find(finding => finding.id === 'C-1')).toMatchObject({ firstContributors: ['lane-a'], contributors: ['lane-a', 'lane-negative'] })
    expect(result.nodes.find(node => node.id === 'observation:OBS-FAST')?.waveId).toBe('wave-1@endpoint-a')
    input.waveReceipts[0] = cohort('endpoint-b', 'wave-0', 0, 20)
    result = buildDashboardSnapshot(input, pools, emptyLive, minute(40))
    expect(result.findings.find(finding => finding.id === 'C-1')?.firstContributors).toEqual(['lane-a', 'lane-negative'])
  })

  it('joins inherited receipt clocks by pool and task, including same-model endpoints', () => {
    const input = { ...state(), waveReceipts: [cohort('endpoint-a', 'wave-0', 1, 2), cohort('endpoint-b', 'wave-0', 5, 20)],
      discoveryScheduler: { stageId: 'discovery', admissions: [] } }
    expect(dashboardTaskBoundary(input, 'discovery', 'wave-0', pools.stages[0]!.waves[0]!.tasks[2]!))
      .toMatchObject({ startedAt: minute(5), receipt: { poolId: 'endpoint-b', completedAt: minute(20) } })
  })

  it('does not infer publication or a timer from another pool sharing the same numeric wave', () => {
    const input = { ...state({ artifacts: [artifact('negative', { protocol: research('OBS-SLOW') })] }),
      waveReceipts: [cohort('endpoint-a', 'wave-0', 0, 10)], discoveryScheduler: { stageId: 'discovery', admissions: [] } }
    const result = buildDashboardSnapshot(input, pools, emptyLive, minute(30))
    expect(result.waves.find(wave => wave.id === 'wave-0@endpoint-b')).toMatchObject({ status: 'pending', startedAt: null })
    expect(result.findings.find(finding => finding.id === 'OBS-SLOW')).toMatchObject({ firstContributors: [], earliestWave: null })
  })
})
