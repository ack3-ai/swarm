import { readFileSync } from 'node:fs'
import { reconcileRunControls, settleTerminalAdmissionControls } from '../src/run-control-reconcile.js'
import { bootstrapExecution, executionWorkflowPayload } from '../src/root-execution.js'
import { startupEnvironment } from './support/successor-dispatch-fixture.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { parseRunCommand, type StageForkCommand } from '../src/run-commands.js'
import type { ExperimentDefinition, RunState } from '../src/contracts.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { assertForkDiscoveryWindow, loadAdmittedStageFork, loadPreparedStageFork, stageForkAuthority } from '../src/stage-fork-command.js'
import { rootExecutionMachine } from '../src/root-execution.js'
import { runControlResponse } from '../src/run-control-api.js'
import { forkFixtureContent, forkFixtures } from './support/stage-fork-command-fixture.js'
import { sharedMutableObjects } from './support/object-graph.js'
import { target } from './support/successor-fixture.js'

const close: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); close.splice(0).forEach(fn => fn()) })
// Each variant is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures(), imageSource = `registry.cloudflare.com/00000000000000000000000000000000/swarm-sandbox@sha256:${'b'.repeat(64)}`
beforeAll(() => forks.prepare([false], ['failed'], ['stopped'], [false, imageSource]), 120_000)
const fixture = () => forks.restore(fn => close.push(fn))
const unselected = { audit_execution_authority: 0, experiment_runs: 0, run_runtime_routes: 0, runtime_slot_run_leases: 0 }

it.each([true])('admits one prepared fork and leaves the completed source immutable (controlled=%s)', async controlled => {
  const f = await fixture()
  const before = canonicalJson(await f.store.getState(f.source.runId)), publication = f.publication(f.source.runId)
  const operation = await f.admit()
  expect(operation).toMatchObject({ status: 'accepted', revision: 1, version: 1, command: f.command })
  expect(operation.source).toBeUndefined(); expect(operation.nativeEffect).toBeUndefined()
  const state = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  expect(state.artifacts).toEqual(f.source.artifacts.filter(record => f.source.checkpoints
    .find(checkpoint => checkpoint.body.cursor.stageIndex === state.cursor.stageIndex && checkpoint.body.cursor.waveIndex === 0)!
    .body.acceptedArtifacts.some(imported => imported.id === record.id)))
  expect(state.controls).toBeUndefined()
  expect(state.budget).toEqual(f.source.budget)
  expect(state.executionAuthority).toMatchObject({ auditId: state.runId, executionId: state.runId, epoch: 0 })
  expect(state.runId).not.toBe(f.source.runId)
  expect(f.publication(state.runId)).toEqual(unselected)
  expect(f.publication(f.source.runId)).toEqual(publication)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(before)
  await expect(f.journal.admit(f.command, f.source.executionAuthority!)).rejects.toThrow('verified saved-stage evidence')
  await expect(f.journal.beginEffect(f.command.id, 1, f.source)).rejects.toThrow()
  await expect(f.journal.advance(f.command.id, 1, { status: 'applying' })).rejects.toThrow('publication transition')
}, 60_000)

it('parent terminal cleanup preserves an admitted immutable fork', async () => {
  const f = await fixture(), operation = await f.admit()
  const before = canonicalJson(f.source)
  await settleTerminalAdmissionControls(f.source, f.journal)
  expect(await f.journal.get(f.command.id)).toEqual(operation)
  expect(canonicalJson(f.source)).toBe(before)
  await f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)
  expect((await f.journal.get(f.command.id))?.status).toBe('applied')
}, 60_000)

it('reconciles a lost admission response from the selected command and its original timestamp', async () => {
  const f = await fixture()
  f.onAfterRun(sql => { if (sql.includes('INSERT INTO audit_run_commands')) { f.onAfterRun(); throw new Error('reply lost') } })
  await expect(f.admit()).rejects.toThrow('reply lost')
  const selected = await f.journal.get(f.command.id)
  expect(selected).not.toBeNull()
  const retried = await f.admit(f.command, '2099-01-01T00:00:00.000Z')
  expect(retried).toEqual(selected)
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_run_commands').get()!.n).toBe(1)
  expect(f.publication(retried.prepared!.authority.executionId)).toEqual(unselected)
}, 60_000)

it('concurrent copies select the same initial child instead of competing timestamps', async () => {
  const f = await fixture()
  const results = await Promise.all([f.admit(f.command, '2099-01-01T00:00:00.000Z'), f.admit(f.command, '2099-01-01T00:01:00.000Z')])
  expect(results[0]).toEqual(results[1])
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_run_commands').get()!.n).toBe(1)
  await expect(f.admit({ ...f.command, reason: 'changed request with the same id' })).rejects.toThrow('different request')
}, 60_000)

it('revalidates the archive when a different same-command preparation wins the admission race', async () => {
  const f = await fixture()
  const winner = await f.admit(f.command, '2099-01-01T00:00:00.000Z'), digest = await sha256(winner)
  // Hold the competing winner out of the journal until this request reaches
  // its INSERT. Its prepared archive is distinct because its timestamp differs.
  f.sqlite.prepare('DELETE FROM audit_run_commands').run()
  const prepare = f.d1.prepare.bind(f.d1)
  let raced = false
  vi.spyOn(f.d1, 'prepare').mockImplementation(sql => {
    if (!raced && sql.startsWith('INSERT INTO audit_run_commands')) {
      raced = true
      f.sqlite.prepare('INSERT INTO audit_run_commands VALUES (?, ?, ?, ?, ?, ?)')
        .run(f.auditId, winner.revision, f.command.id, winner.version, canonicalJson(winner), digest)
      const saved = winner.prepared!
      const key = `runs/${saved.authority.executionId}/states/${String(saved.state.generation).padStart(12, '0')}-${saved.state.digest}.json`
      f.objects.get(key)!.content = 'corrupt competing archive'
    }
    return prepare(sql)
  })
  await expect(f.admit(f.command, '2099-01-01T00:01:00.000Z')).rejects.toThrow('run state object digest mismatch')
  expect(raced).toBe(true)
  expect(await f.journal.get(f.command.id)).toEqual(winner)
  expect(f.publication(winner.prepared!.authority.executionId)).toEqual(unselected)
}, 60_000)

it('competing commands compare the source decision revision atomically', async () => {
  const f = await fixture()
  const result = await Promise.allSettled([f.admit(), f.admit({ ...f.command, id: 'other-fork' })])
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1)
  expect(result.filter(value => value.status === 'rejected')).toHaveLength(1)
  expect(await f.journal.revision()).toBe(1)
  for (const id of ['change-reviewers', 'other-fork']) {
    const authority = await stageForkAuthority(f.auditId, await sha256({ ...f.command, id }), f.command.runtimeRelease)
    expect(f.publication(authority.executionId)).toEqual(unselected)
  }
}, 60_000)

it('verifies selected child bytes without reloading source history, and rejects changed identity or bytes', async () => {
  const f = await fixture(), operation = await f.admit(), prepared = operation.prepared!
  const read = vi.fn(async (id: string, pointer: typeof prepared.state) => {
    expect(id).toBe(prepared.authority.executionId)
    return f.loadState(id, pointer)
  })
  const child = await loadAdmittedStageFork(operation, read)
  expect(await sha256(child)).toBe(prepared.state.digest)
  expect(read).toHaveBeenCalledOnce()
  for (const state of [{ ...prepared.state, generation: prepared.state.generation + 1 },
    { ...prepared.state, digest: 'a'.repeat(64) }]) {
    await expect(loadAdmittedStageFork({ ...operation, prepared: { ...prepared, state } }, read)).rejects.toThrow()
  }
  await expect(loadAdmittedStageFork({ ...operation, commandDigest: 'b'.repeat(64) }, read)).rejects.toThrow()
  await expect(loadAdmittedStageFork(operation, async () => ({ ...child, runId: 'wrong-child' }))).rejects.toThrow('fork prepared state differs')
  const key = `runs/${child.runId}/states/${String(prepared.state.generation).padStart(12, '0')}-${prepared.state.digest}.json`
  f.objects.get(key)!.content = 'corrupt admitted archive'
  await expect(loadAdmittedStageFork(operation, f.loadState)).rejects.toThrow('run state object digest mismatch')
}, 60_000)

it('does not activate unselected archived fork bytes', async () => {
  const f = await fixture(), operation = await f.admit()
  f.sqlite.prepare('DELETE FROM audit_run_commands').run()
  const reads = vi.spyOn(f.store, 'getStateAt')
  await expect(f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)).rejects.toThrow('execution command is missing')
  expect(reads).not.toHaveBeenCalled()
  expect(f.publication(operation.prepared!.authority.executionId)).toEqual(unselected)
}, 60_000)

it.each(['source-pointer', 'source-status', 'source-owner', 'pending-launch', 'child-route'])
  ('rejects a %s race at SQL admission without publishing or mutating an audit', async change => {
    const f = await fixture(), authority = await stageForkAuthority(f.auditId, await sha256(f.command), f.command.runtimeRelease)
    const prepare = f.d1.prepare.bind(f.d1)
    let raced = false
    vi.spyOn(f.d1, 'prepare').mockImplementation(sql => {
      if (!raced && sql.startsWith('INSERT INTO audit_run_commands')) {
        raced = true
        if (change === 'source-pointer') f.sqlite.prepare('UPDATE experiment_runs SET state_key = ?, state_generation = state_generation + 1 WHERE run_id = ?').run('orphan-key', f.source.runId)
        if (change === 'source-status') f.sqlite.prepare("UPDATE experiment_runs SET status = 'running' WHERE run_id = ?").run(f.source.runId)
        if (change === 'source-owner') f.sqlite.prepare('UPDATE audit_execution_authority SET authority_json = ? WHERE execution_id = ?').run('{}', f.source.runId)
        if (change === 'pending-launch') f.sqlite.prepare('INSERT INTO audit_execution_launches (audit_id, epoch, task_execution_id, request_digest, admitted_at) VALUES (?, 0, ?, ?, ?)')
          .run(f.auditId, 'unsettled-task', 'd'.repeat(64), f.source.updatedAt)
        if (change === 'child-route') f.sqlite.prepare('INSERT INTO run_runtime_routes VALUES (?, ?, ?, ?)')
          .run(authority.executionId, f.source.experimentId, canonicalJson(f.command.runtimeRelease), f.source.updatedAt)
      }
      return prepare(sql)
    })
    await expect(f.admit()).rejects.toThrow('changed before admission')
    expect(raced).toBe(true)
    expect(await f.journal.get(f.command.id)).toBeNull()
    expect(f.publication(authority.executionId)).toEqual({ ...unselected, run_runtime_routes: change === 'child-route' ? 1 : 0 })
  }, 60_000)

it.each(['artifact', 'inputs'])('requires retained %s bytes before any command admission', async kind => {
  const f = await fixture(), record = f.source.artifacts[0]!
  const key = kind === 'artifact' ? record.uri.replace('r2://ARTIFACTS/', '') : `execution-inputs/sha256/${record.execution!.inputDigest}.json`
  f.objects.get(key)!.content = 'changed bytes'
  await expect(f.admit()).rejects.toThrow(/digest mismatch/)
  expect(await f.journal.revision()).toBe(0)
}, 60_000)

it('refuses an ordinary start payload for a fork that has not been published', async () => {
  const f = await fixture(), operation = await f.admit()
  const state = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  await expect(rootExecutionMachine({ mode: 'start', experimentId: state.experimentId, runId: state.runId,
    releaseDigest: state.releaseDigest, runtimeRelease: state.runtimeRelease! }, f.store, state)).rejects.toThrow(/selection/)
}, 60_000)

it('rearms a prepared fork with its saved source instead of an ordinary owner marker', async () => {
  const f = await fixture(), delivery = vi.fn()
  await f.admit()
  const response = await runControlResponse(new Request('https://example.invalid/commands', {
    method: 'POST', body: JSON.stringify(f.command), headers: { 'content-type': 'application/json' },
  }), f.store, f.d1, f.source.experimentId, f.auditId, undefined, delivery)
  expect(response.status).toBe(202)
  expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fork', source: f.command.source }))
  expect(delivery.mock.calls[0]![0]).not.toHaveProperty('authority')
  expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
}, 60_000)

it('accepts only manifest references and exact source identities in a fork command', async () => {
  const f = await fixture()
  expect(parseRunCommand(f.command)).toEqual(f.command)
  for (const extra of [{ model: 'different' }, { prompts: {} }, { budget: 10 }, { pools: ['different'] }]) {
    expect(() => parseRunCommand({ ...f.command, ...extra })).toThrow('fields')
  }
  expect(() => parseRunCommand({ ...f.command, source: { ...f.command.source, latest: true } })).toThrow('fields')
  expect(() => parseRunCommand({ ...f.command, source: { ...f.command.source, state: { generation: 0, digest: 'a'.repeat(64) } } })).toThrow('generation')
}, 60_000)


async function retiredFixture(kind: 'failed' | 'stopped') {
  const f = await forks.restore(fn => close.push(fn), kind)
  const checkpoint = f.source.checkpoints.find(value => value.body.cursor.stageIndex === f.machine.definition.stages.findIndex(stage => stage.id === 'negative-review') && value.body.cursor.waveIndex === 0)!
  return { ...f, checkpoint }
}

it('failed-source reconciliation leaves a pending fork to its publication owner', async () => {
  const f = await retiredFixture('failed'); await f.retire()
  const operation = await f.admit(), before = canonicalJson(f.machine.view())
  // Isolate the fork decision from this fixture's synthetic retirement command.
  // The real admitted operation, source, archive and activation CAS remain intact.
  const read = vi.spyOn(f.journal, 'atRevision').mockResolvedValue(operation)
  const persist = vi.fn(async () => { throw new Error('source must remain immutable') })
  expect(await reconcileRunControls({ machine: f.machine, journal: f.journal, persist })).toBe(false)
  expect(read).toHaveBeenCalledOnce()
  expect(persist).not.toHaveBeenCalled()
  expect(canonicalJson(f.machine.view())).toBe(before)
  expect(await f.journal.get(f.command.id)).toEqual(operation)
  read.mockRestore()
  await f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)
  expect((await f.journal.get(f.command.id))?.status).toBe('applied')
}, 60_000)

it.each(['failed', 'stopped'] as const)('requires native retirement before exporting a %s source', async kind => {
  const f = await retiredFixture(kind)
  await expect(f.admit()).rejects.toThrow()
  expect(await f.journal.get(f.command.id)).toBeNull()
  await f.retire()
  const operation = await f.admit()
  const prepared = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  expect(prepared.artifacts).toEqual(f.checkpoint.body.acceptedArtifacts)
  expect(prepared.budget).toEqual(f.source.budget)
  expect(prepared.modelStartedAt).toBe(f.source.modelStartedAt)
  await f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(canonicalJson(f.source))
}, 60_000)

it.each(['authority', 'fence', 'proof', 'status'] as const)('rejects changed source %s at the activation transaction', async damage => {
  const f = await retiredFixture('stopped'); await f.retire()
  const operation = await f.admit(), prepared = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  const verify = f.store.assertForkDisposition.bind(f.store)
  vi.spyOn(f.store, 'assertForkDisposition').mockImplementationOnce(async state => {
    await verify(state)
    const assignments = { authority: "authority_json = '{}'", fence: "fence_command_digest = 'changed'", proof: "retirement_digest = 'changed'", status: "status = 'active'" }
    f.sqlite.prepare(`UPDATE audit_execution_authority SET ${assignments[damage]} WHERE execution_id = ?`).run(f.source.runId)
  })
  await expect(f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)).rejects.toThrow()
  expect(f.publication(prepared.runId)).toEqual(unselected)
  expect((await f.journal.get(f.command.id))!.prepared?.activatedAt).toBeUndefined()
}, 60_000)

it('parses exactly one fork boundary without accepting model overrides', () => {
  const base = { action: 'fork', id: 'saved-frontier', expectedRevision: 0, reason: 'retry saved suffix',
    source: { runId: 'source', state: { generation: 1, digest: 'a'.repeat(64) } }, releaseDigest: 'b'.repeat(64),
    runtimeRelease: { schemaVersion: 1, id: 'runtime-test', frameworkCommit: 'a'.repeat(40), workerService: 'runtime-test',
      workflowName: 'runtime-test', containerImageDigest: `sha256:${'b'.repeat(64)}`, workerVersionId: '11111111-1111-4111-8111-111111111111' } }
  expect(parseRunCommand({ ...base, checkpointDigest: 'c'.repeat(64) })).toMatchObject({ checkpointDigest: 'c'.repeat(64) })
  expect(() => parseRunCommand(base)).toThrow('exactly one')
  expect(() => parseRunCommand({ ...base, checkpointDigest: 'c'.repeat(64), stageId: 'reporting' })).toThrow('exactly one')
  expect(() => parseRunCommand({ ...base, checkpointDigest: 'c'.repeat(64), model: 'replacement' })).toThrow('fields')
})

it('refuses to export source state from another runtime version', async () => {
  const f = await fixture()
  await expect(f.store.exportStageFork(f.command, f.command.runtimeRelease)).rejects.toThrow('producer does not own source version')
  expect(await f.journal.get(f.command.id)).toBeNull()
})

it('reads the selected source once during public fork admission', async () => {
  const f = await fixture(), reads = vi.spyOn(f.store, 'getStateAt')
  const response = await runControlResponse(new Request('https://internal/commands', {
    method: 'POST', body: JSON.stringify(f.command),
  }), f.store, f.d1, f.source.experimentId, f.auditId, undefined, async () => {})
  expect(response.status).toBe(202)
  expect(reads.mock.calls.filter(([id, pointer]) => id === f.source.runId
    && pointer.digest === f.command.source.state.digest)).toHaveLength(1)
}, 60_000)

it('rejects a fork through another experiment, or a discovery rerun after its window, before delivery', async () => {
  const f = await fixture(), delivery = vi.fn()
  const post = (command: object, experimentId = f.source.experimentId) => runControlResponse(new Request('https://internal/commands', {
    method: 'POST', body: JSON.stringify(command),
  }), f.store, f.d1, experimentId, f.auditId, undefined, delivery)
  const response = await post(f.command, 'other-experiment')
  expect(response.status).toBe(404)
  expect(delivery).not.toHaveBeenCalled()
  expect(await f.journal.revision()).toBe(0)
  // E9: the child keeps the source's discovery clock, so after the window it would admit no research.
  // That holds for a stage fork from discovery and for a checkpoint fork at its start.
  const rerun = { ...f.command, id: 'rerun-discovery', stageId: 'discovery' }
  const discoveryIndex = f.machine.definition.stages.findIndex(stage => stage.kind === 'discovery')
  const { stageId: _stage, ...base } = f.command
  const atDiscovery = { ...base, id: 'rerun-discovery-checkpoint', checkpointDigest: f.source.checkpoints.find(value =>
    value.body.cursor.stageIndex === discoveryIndex && value.body.cursor.waveIndex === 0)!.digest }
  const ended = Date.parse(f.source.modelStartedAt!) + f.machine.definition.limits.phaseMinutes.discovery * 60_000
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(ended + 60 * 60_000)
    // No fork reruns preflight (whose end starts the clock), so none from before discovery inherits it.
    const preflight = await post({ ...f.command, id: 'rerun-preflight', stageId: 'preflight' })
    expect(preflight.status).toBe(422)
    expect((await preflight.json() as { code: string }).code).toBe('fork-stage-unavailable')
    for (const command of [rerun, atDiscovery]) {
      const late = await post(command)
      expect(late.status).toBe(422)
      const body = await late.json() as { code: string; error: string }
      expect(body.code).toBe('fork-discovery-window-elapsed')
      expect(body.error).toContain(new Date(ended).toISOString())
      expect(body.error).toContain('limits.maxDiscoveryRuntimeMs')
      expect(body.error).toContain(`at least ${2 * 300 * 60_000 + 60 * 60_000} in the fork's manifest`)
      expect(body.error).toContain(`so ${2 * 300 * 60_000 + 75 * 60_000} leaves a 15-minute margin`)
    }
    expect(delivery).not.toHaveBeenCalled()
    expect(await f.journal.revision()).toBe(0)
  } finally { vi.useRealTimers() }
  expect((await post(rerun)).status).toBe(202)
  expect((await post({ ...atDiscovery, expectedRevision: 1 })).status).toBe(202)
  expect(delivery).toHaveBeenCalledTimes(2)
}, 60_000)

it('checks the inherited discovery window only for a fork that reruns discovery with it', () => {
  // The Step 0 recon release: preflight, recon, discovery, then the later stages.
  const definition = JSON.parse(readFileSync(new URL('./fixtures/sealed-ca54217e/recon.definition.json', import.meta.url), 'utf8')) as ExperimentDefinition
  const index = (kind: string) => definition.stages.findIndex(stage => stage.kind === kind)
  const startedAt = '2026-01-01T00:00:00.000Z', reconEnded = '2026-01-01T00:30:00.000Z'
  const now = '2026-01-02T00:00:00.000Z', window = definition.limits.phaseMinutes.discovery * 60_000
  const child = (stageIndex: number, endedAt: string[]) => ({ cursor: { stageIndex, waveIndex: 0 },
    rootCreatedAt: startedAt, modelStartedAt: startedAt, artifacts: [], rejectedAttempts: [],
    stageEndReceipts: endedAt.map((at, stage) => ({ stageIndex: stage, endedAt: at })) }) as unknown as RunState
  const fork = (boundary: object) => ({ action: 'fork', id: 'fork', expectedRevision: 0, reason: 'test', ...boundary }) as StageForkCommand
  const check = (command: StageForkCommand, state: RunState) => () => assertForkDiscoveryWindow(command, definition, state, [], now)
  // From discovery (stage id or checkpoint): the window ended 30 minutes + 5 hours after the start.
  for (const boundary of [{ stageId: 'discovery' }, { checkpointDigest: 'c'.repeat(64) }]) {
    expect(check(fork(boundary), child(index('discovery'), [startedAt, reconEnded])))
      .toThrow(expect.objectContaining({ code: 'fork-discovery-window-elapsed' }))
  }
  // N6: the exact minimum (elapsed + one window, whole minutes) and a value 15 minutes above it.
  // 18 h 30 min have passed since the window ended at 05:30; the window is 300 minutes.
  const message = (at: string) => {
    try { assertForkDiscoveryWindow(fork({ stageId: 'discovery' }), definition, child(index('discovery'), [startedAt, reconEnded]), [], at) }
    catch (error) { return (error as Error).message }
    throw new Error('fork was accepted')
  }
  expect(message(now)).toBe('the source audit\'s discovery window ended at 2026-01-01T05:30:00.000Z, so a fork from discovery '
    + 'would admit no research; to rerun discovery with a full window from now, set limits.maxDiscoveryRuntimeMs to at least '
    + '102600000 in the fork\'s manifest; this minimum grows by one minute every minute, so 103500000 leaves a 15-minute '
    + 'margin for publishing the release and sending the fork')
  // Both values round up to a whole minute.
  const late = message('2026-01-02T00:00:20.000Z')
  expect(late).toContain('at least 102660000 in the fork\'s manifest')
  expect(late).toContain('so 103560000 leaves a 15-minute margin')
  // From recon: recon runs again, and its new end starts a full window.
  expect(check(fork({ stageId: 'recon' }), child(index('recon'), [startedAt]))).not.toThrow()
  expect(discoveryDeadline(definition, child(index('discovery'), [startedAt, now]))).toBe(Date.parse(now) + window)
  // A frontier fork and a fork after discovery are not checked.
  expect(check(fork({ sourceFrontier: true }), child(index('discovery'), [startedAt, reconEnded]))).not.toThrow()
  expect(check(fork({ stageId: 'synthesis' }), child(index('synthesis'), [startedAt, reconEnded, reconEnded]))).not.toThrow()
})

it.each(['stage', 'checkpoint'])('forks a sealed %s onto the manifest image without relabeling retained evidence', async boundary => {
  const sourceImage = `registry.cloudflare.com/00000000000000000000000000000000/swarm-sandbox@sha256:${'b'.repeat(64)}`
  const f = await forks.restore(fn => close.push(fn), false, sourceImage), before = canonicalJson(f.source)
  const original = (await f.loadRelease(f.command.releaseDigest)).body
  const image = `sha256:${'e'.repeat(64)}`
  const release = await f.store.putRelease({ ...original, environment: { image: `registry.cloudflare.com/00000000000000000000000000000000/swarm-sandbox@${image}` } })
  const seal = f.source.checkpoints.find(value => value.body.cursor.stageIndex === original.definition.stages.findIndex(stage => stage.id === 'negative-review') && value.body.cursor.waveIndex === 0)!
  const { stageId: _stage, ...base } = f.command
  const command = { ...base, ...(boundary === 'stage' ? { stageId: 'negative-review' } : { checkpointDigest: seal.digest }),
    releaseDigest: release.digest, runtimeRelease: { ...f.command.runtimeRelease, containerImageDigest: image } }
  const operation = await f.store.admitStageFork(f.auditId, command)
  const child = await loadPreparedStageFork(operation, f.loadRelease, f.loadState)
  expect(child.releaseDigest).toBe(release.digest)
  expect(child.runtimeRelease?.containerImageDigest).toBe(image)
  expect(child.artifacts).toEqual(seal.body.acceptedArtifacts)
  expect((await f.loadState.readSavedWork!(child.forkOrigin!.savedWorkDigest)).checkpoint!.digest).toBe(seal.digest)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(before)
}, 60_000)

it('rejects a sealed fork with a mismatched runtime image before selecting a command', async () => {
  const f = await fixture(), original = (await f.loadRelease(f.command.releaseDigest)).body
  const release = await f.store.putRelease({ ...original, environment: { image: `registry.cloudflare.com/00000000000000000000000000000000/swarm-sandbox@sha256:${'e'.repeat(64)}` } })
  await expect(f.admit({ ...f.command, releaseDigest: release.digest })).rejects.toThrow(/environment image/)
  expect(await f.journal.get(f.command.id)).toBeNull()
  expect(await f.journal.revision()).toBe(0)
}, 60_000)


it.each(['failed', 'stopped'] as const)('admits, activates and boots an exported %s source without historical state reads', async kind => {
  const f = await retiredFixture(kind)
  await f.retire()
  const digest = await f.store.exportStageFork(f.command, f.source.runtimeRelease!)
  const original = f.store.getStateAt.bind(f.store)
  vi.spyOn(f.store, 'getStateAt').mockImplementation((id, pointer) => {
    if (id === f.source.runId) throw new Error('historical version owns the source record')
    return original(id, pointer)
  })
  const operation = await f.store.admitStageFork(f.auditId, f.command, undefined, undefined, undefined, async () => digest)
  const activated = await f.store.activatePreparedExecution(f.auditId, f.command.id, f.command.runtimeRelease)
  const selected = await f.store.getState(activated.prepared!.authority.executionId)
  const { env } = startupEnvironment(f, selected.runId)
  const machine = await bootstrapExecution(await executionWorkflowPayload(selected, f.store), f.store, env)
  expect(machine.snapshot().artifacts).toEqual(f.checkpoint.body.acceptedArtifacts)
  expect(machine.snapshot().budget).toEqual(f.source.budget)
  expect(machine.snapshot().modelStartedAt).toBe(f.source.modelStartedAt)
}, 60_000)

it('rejects mixed historical and current prepared envelopes even with a valid journal checksum', async () => {
  const f = await fixture(), operation = await f.admit()
  for (const mixed of [
    { ...operation, successor: operation.prepared },
    { ...operation, fork: { ...operation.fork, prepared: operation.prepared } },
    { ...operation, fork: { ...operation.fork, activatedAt: operation.acceptedAt } },
  ]) {
    f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ?')
      .run(canonicalJson(mixed), await sha256(mixed))
    await expect(f.journal.get(f.command.id)).rejects.toThrow()
  }
}, 60_000)

it.each([false, 'stopped'] as const)('gives every test its own copy of the built audit (failure=%s)', async variant => {
  const first = await forks.restore(fn => close.push(fn), variant), second = await forks.restore(fn => close.push(fn), variant)
  // Nothing a test can change is reachable from two copies. `target` is the module constant that
  // every fork command has referenced since before snapshots, as tests import it directly.
  expect(sharedMutableObjects(first, second, [target])).toEqual([])
  const content = forkFixtureContent(second)
  expect(forkFixtureContent(first)).toStrictEqual(content)
  // Change the first copy everywhere: the database through the store and directly, the bucket, the values.
  if (variant === 'stopped') await first.retire()
  await first.admit()
  first.sqlite.prepare("UPDATE experiment_runs SET status = 'changed'").run()
  first.sqlite.prepare('DELETE FROM audit_run_commands').run()
  const [stateKey, ...others] = [...first.objects.keys()].filter(key => key.includes('/states/'))
  first.objects.get(stateKey!)!.content = 'changed'
  for (const key of others) first.objects.delete(key)
  first.command.reason = 'changed'; first.release.digest = 'changed'; first.authority.epoch = 99
  expect(forkFixtureContent(first)).not.toStrictEqual(content)
  // Neither the other copy nor a later one sees any of it.
  expect(forkFixtureContent(second)).toStrictEqual(content)
  expect(forkFixtureContent(await forks.restore(fn => close.push(fn), variant))).toStrictEqual(content)
}, 60_000)
