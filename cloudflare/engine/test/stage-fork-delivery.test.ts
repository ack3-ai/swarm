import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import type { Env } from '../src/env.js'
import { runControlResponse } from '../src/run-control-api.js'
import { deliverRunControl, reconcileDeliveredRunControl } from '../src/run-control-executor.js'
import { assertRunControlDelivery, type RunControlDeliveryMarker, type StageForkDeliveryMarker } from '../src/run-control-delivery.js'
import { bootstrapExecution, executionWorkflowPayload } from '../src/root-execution.js'
import { dispatchAuditWorkflow } from '../src/execution-workflow.js'
import { stageForkAuthority } from '../src/stage-fork-command.js'
import { forkFixtures, type ForkFixtureFailure } from './support/stage-fork-command-fixture.js'
import { startupEnvironment } from './support/successor-dispatch-fixture.js'
import { RunMachine } from '../src/machine.js'
import { R2ArtifactStore, stateWriter } from '../src/cloudflare-storage.js'
import { audit0RunPolicy } from '../src/runner.js'
import { runExperiment } from './support/memory-runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import type { RunCommand, StageForkCommand } from '../src/run-commands.js'
import { target, runtime } from './support/successor-fixture.js'
import { RunCommandJournal } from '../src/run-command-journal.js'

const closes: (() => void)[] = []
afterEach(() => { vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })
// Each variant is built once; every test gets its own restored copy (P2-12).
const forks = forkFixtures()
beforeAll(() => forks.prepare([false], ['partial'], ['failed'], ['stopped']), 120_000)
async function fixture(controlled = true, failed: ForkFixtureFailure = false) {
  const f = await forks.restore(close => closes.push(close), failed)
  let command: StageForkCommand = f.command
  if (failed) {
    await f.retire()
    const { stageId: _stage, ...base } = command
    const checkpoint = failed === 'stopped' ? f.source.checkpoints.at(-1)!
      : f.source.checkpoints.find(value => value.body.cursor.stageIndex === f.machine.definition.stages.length - 1 && value.body.cursor.waveIndex === 1)!
    command = failed === 'partial' ? { ...base, sourceFrontier: true, releaseDigest: f.source.releaseDigest }
      : { ...base, checkpointDigest: checkpoint.digest, releaseDigest: f.source.releaseDigest }
  }
  const child = await stageForkAuthority(f.auditId, await sha256(command), target)
  const { env, binding } = startupEnvironment(f, child.executionId)
  const destination = { fetch: vi.fn(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    let body: unknown
    if (path.endsWith('/identity')) body = target
    else if (path.endsWith('/audit-runs')) body = { workflowInstanceId: await dispatchAuditWorkflow(env, JSON.parse(init!.body as string)) }
    else if (path.includes('/audit-workflows/')) {
      const workflow = await binding.get()
      body = { runId: workflow.id, workflow: await workflow.status() }
    } else body = await reconcileDeliveredRunControl(JSON.parse(init!.body as string), env)
    return Response.json(body, { headers: { 'x-ack3-runtime-worker-version': target.workerVersionId } })
  }) }
  const { workerVersionId: _version, ...declaration } = target
  const front = { ...env, ENGINE_ROLE: 'front-door', RUNTIME_CATALOG_JSON: canonicalJson({ schemaVersion: 1,
    latest: target.id, releases: { [target.id]: { ...declaration, binding: 'RUNTIME_NEXT' } } }),
    RUNTIME_NEXT: destination } as unknown as Env
  let marker: StageForkDeliveryMarker | undefined
  const register = vi.fn(async (value: RunControlDeliveryMarker) => {
    assertRunControlDelivery(value)
    if (!('kind' in value)) throw new Error('fork was given an execution marker')
    if (marker !== undefined) expect(value).toEqual(marker)
    marker = structuredClone(value)
  })
  const api = (submitted: RunCommand = command, hook: (marker: RunControlDeliveryMarker) => Promise<void> = register) => runControlResponse(
    new Request('https://internal/', { method: 'POST', body: canonicalJson(submitted) }), f.store, f.d1,
    f.source.experimentId, f.auditId, undefined, hook)
  const deliver = () => { if (marker === undefined) throw new Error('missing delivery'); return deliverRunControl(marker, front) }
  const get = () => runControlResponse(new Request('https://internal/'), f.store, f.d1, f.source.experimentId, f.auditId, command.id)
  return { ...f, command, child, env, binding, destination, front, register, api, deliver, get, marker: () => marker! }
}

// Exercise the same persist-then-witness sequence as AuditWorkflow.bootstrap-run.
async function boot(f: Awaited<ReturnType<typeof fixture>>, payload: Parameters<typeof bootstrapExecution>[0]) {
  const before = await f.store.getState(payload.runId)
  const machine = await bootstrapExecution(payload, f.store, f.env)
  if (machine.view().stateGeneration !== before.stateGeneration) await (await stateWriter(f.store, before))(machine.view())
  await f.store.recordExecutionBootstrap(machine.view())
  return machine
}
async function selectedFork(f: Awaited<ReturnType<typeof fixture>>) {
  const operation = (await f.journal.get(f.command.id))!
  const prepared = await f.store.getState(operation.prepared!.authority.executionId)
  return { prepared, payload: await executionWorkflowPayload(prepared, f.store) }
}

it.each(['partial'] as const)('delivers an exact %s frontier and completes without replaying accepted peers', async failure => {
  const f = await fixture(false, failure), sourceBytes = canonicalJson(await f.store.getState(f.source.runId))
  expect(f.source.artifacts.length).toBeGreaterThan(f.source.checkpoints.at(-1)!.body.acceptedArtifacts.length)
  const admitted = await f.api()
  expect(admitted.status, await admitted.text()).toBe(202)
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
  const { auditId, commandId, commandDigest } = f.marker()
  const selected = await selectedFork(f)
  const machine = await boot(f, selected.payload)
  expect(machine.view().artifacts).toEqual(f.source.artifacts)
  expect(machine.view().checkpoints).toHaveLength(0)
  expect(machine.view().budget).toEqual(f.source.budget)
  expect(await f.deliver()).toBe(true)
  expect((await f.api()).status).toBe(200)
  const provider = new DeterministicAuditProvider(), run = vi.fn(provider.run.bind(provider))
  await runExperiment({ machine, definition: machine.definition, provider: { run },
    artifactStore: new R2ArtifactStore(f.bucket), policy: audit0RunPolicy })
  const result = machine.snapshot(), retained = new Set(f.source.artifacts.map(record => record.taskId))
  expect(result.status).toBe('completed')
  expect(result.artifacts.slice(0, retained.size)).toEqual(f.source.artifacts)
  expect(run.mock.calls.every(([request]) => !retained.has(request.task.id))).toBe(true)
  const failedTask = 'negative-review-replica'
  expect(run.mock.calls.filter(([request]) => request.task.id === failedTask)).toHaveLength(1)
  expect(result.rootCreatedAt).toBe(f.source.rootCreatedAt)
  expect(result.modelStartedAt).toBe(f.source.modelStartedAt)
  expect(result).not.toHaveProperty('failedWaveRecovery')
  await f.store.putState(machine.view(), { generation: selected.prepared.stateGeneration, digest: await sha256(selected.prepared) })
  for (const checkpoint of result.checkpoints) await f.store.putCheckpoint(checkpoint)
  const reloaded = await RunMachine.fromState(machine.definition, await f.store.getState(result.runId), f.loadRelease, f.loadState)
  for (const checkpoint of reloaded.view().checkpoints) await reloaded.verifyCheckpoint(checkpoint)
  expect((await boot(f, selected.payload)).snapshot()).toEqual(result)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(sourceBytes)
}, 120_000)

it.each([true, false])('delivers a completed-source fork through the API, pinned runtime and bootstrap (controlled=%s)', async controlled => {
  const f = await fixture(controlled), source = canonicalJson(await f.store.getState(f.source.runId))
  expect((await f.api()).status).toBe(202)
  const operation = (await f.journal.get(f.command.id))!
  expect(operation.status).toBe('accepted')
  expect(f.marker()).toMatchObject({ kind: 'fork', source: f.command.source })
  expect('authority' in f.marker()).toBe(false)
  expect(f.publication(f.child.executionId).experiment_runs).toBe(0)
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
  const { auditId, commandId, commandDigest } = f.marker()
  const selected = await selectedFork(f)
  expect((await boot(f, selected.payload)).snapshot()).toEqual(selected.prepared)
  f.destination.fetch.mockReset().mockRejectedValue(new Error('old runtime unavailable'))
  expect(await f.deliver()).toBe(true)
  expect(f.destination.fetch).not.toHaveBeenCalled()
  expect((await f.api()).status).toBe(200)
  expect((await (await f.get()).json<{ status: string }>()).status).toBe('applied')
  const controls = await runControlResponse(new Request('https://internal/'), f.store, f.d1, f.source.experimentId, f.auditId)
  expect(await controls.json()).toMatchObject({ stateReference: f.command.source })
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(source)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  if (controlled) {
    f.sqlite.prepare('DELETE FROM runtime_slot_run_leases WHERE run_id = ?').run(f.child.executionId)
    await expect(f.deliver()).rejects.toThrow('publication is missing')
    await expect(boot(f, selected.payload)).rejects.toThrow('publication is missing')
  }
}, 180_000) // Full API delivery, repeated startup verification and publication-loss checks.

it.each([false, true])('keeps an empty marker pending without R2 reads while admission is delayed (controlled=%s)', async controlled => {
  const f = await fixture(controlled)
  let proceed!: () => void, entered!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve }), delayed = new Promise<void>(resolve => { proceed = resolve })
  const response = f.api(f.command, async marker => { await f.register(marker); entered(); await delayed })
  await enteredPromise
  expect(await f.journal.get(f.command.id)).toBeNull()
  const get = vi.spyOn(f.bucket, 'get'), head = vi.spyOn(f.bucket, 'head')
  for (let attempt = 0; attempt < 3; attempt++) expect(await f.deliver()).toBe(false)
  expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled()
  expect(f.binding.create).not.toHaveBeenCalled()
  proceed(); expect((await response).status).toBe(202)
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
}, 90_000)

it('keeps an earlier marker pending during a slow retry archive, then delivers the selected command', async () => {
  const f = await fixture(false)
  await expect(f.api(f.command, async marker => { await f.register(marker); throw new Error('lost reply') })).rejects.toThrow('lost reply')
  let entered!: () => void, proceed!: () => void
  const enteredPromise = new Promise<void>(resolve => { entered = resolve }), delayed = new Promise<void>(resolve => { proceed = resolve })
  const put = f.bucket.put.bind(f.bucket)
  vi.spyOn(f.bucket, 'put').mockImplementation(async (...args) => {
    if (args[0].startsWith(`runs/${f.child.executionId}/states/`)) { entered(); await delayed }
    return put(...args)
  })
  const response = f.api()
  await enteredPromise
  const get = vi.spyOn(f.bucket, 'get'), head = vi.spyOn(f.bucket, 'head')
  try {
    for (let attempt = 0; attempt < 3; attempt++) expect(await f.deliver()).toBe(false)
    expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled()
    expect(await f.journal.get(f.command.id)).toBeNull()
    expect(f.binding.create).not.toHaveBeenCalled()
  } finally { proceed() }
  expect((await response).status).toBe(202)
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
}, 90_000)

it('recovers a lost admission reply and rearms from immutable command data after source metadata changes', async () => {
  const f = await fixture()
  f.onAfterRun(sql => { if (sql.startsWith('INSERT INTO audit_run_commands')) { f.onAfterRun(); throw new Error('lost admission reply') } })
  await expect(f.api()).rejects.toThrow('lost admission reply')
  const admitted = await f.journal.get(f.command.id)
  expect(admitted?.status).toBe('accepted')
  f.sqlite.prepare('UPDATE experiment_runs SET updated_at = ? WHERE run_id = ?').run(new Date(Date.parse(f.source.updatedAt) + 1000).toISOString(), f.source.runId)
  expect((await f.api()).status).toBe(202)
  expect(await f.journal.get(f.command.id)).toEqual(admitted)
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
}, 90_000)

it('does not register a marker when retained bytes fail preparation, or rearm different command bytes', async () => {
  const f = await fixture(), record = f.source.artifacts[0]!
  const object = f.objects.get(record.uri.replace('r2://ARTIFACTS/', ''))!, original = object.content
  object.content = 'wrong accepted bytes'
  await expect(f.api()).rejects.toThrow('digest mismatch')
  expect(f.register).not.toHaveBeenCalled(); expect(await f.journal.get(f.command.id)).toBeNull()
  object.content = original
  expect((await f.api()).status).toBe(202)
  f.register.mockClear()
  expect((await f.api({ ...f.command, reason: 'different command' })).status).toBe(409)
  expect(f.register).not.toHaveBeenCalled()
}, 90_000)

it('keeps transient destination failure pending but records known identity mismatch as rejection', async () => {
  const f = await fixture()
  await f.api()
  f.destination.fetch.mockRejectedValueOnce(new Error('transient destination error'))
  await expect(f.deliver()).rejects.toThrow('transient destination error')
  expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
  f.destination.fetch.mockResolvedValueOnce(Response.json(runtime, { headers: { 'x-ack3-runtime-worker-version': runtime.workerVersionId } }))
  expect(await f.deliver()).toBe(true)
  expect((await f.journal.get(f.command.id))!.status).toBe('rejected')
  expect(await f.deliver()).toBe(true)
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.publication(f.child.executionId).experiment_runs).toBe(0)
}, 90_000)

it('rejects a selected delivery marker from another experiment before activation', async () => {
  const f = await fixture(false)
  expect((await f.api()).status).toBe(202)
  f.marker().experimentId = 'another-experiment'
  await expect(f.deliver()).rejects.toThrow('fork delivery source differs')
  expect(f.destination.fetch).not.toHaveBeenCalled()
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.publication(f.child.executionId).experiment_runs).toBe(0)
}, 90_000)

it.each(['source-generation', 'revision', 'child-authority'])('clears an unadmitted marker only after a monotonic %s conflict', async conflict => {
  const f = await fixture(false)
  await expect(f.api(f.command, async marker => { await f.register(marker); throw new Error('lost registration reply') })).rejects.toThrow()
  expect(await f.journal.get(f.command.id)).toBeNull()
  const get = vi.spyOn(f.bucket, 'get'), head = vi.spyOn(f.bucket, 'head')
  expect(await f.deliver()).toBe(false)
  if (conflict === 'source-generation') f.sqlite.prepare("UPDATE experiment_runs SET state_generation = state_generation + 1, state_key = state_key || '/newer-generation' WHERE run_id = ?").run(f.source.runId)
  if (conflict === 'revision') {
    expect((await f.api({ ...f.command, id: 'competing' }, async () => {})).status).toBe(202)
    get.mockClear(); head.mockClear()
  }
  if (conflict === 'child-authority') await f.store.activateRootExecution(f.child.executionId, target, { unrelated: true })
  expect(await f.deliver()).toBe(true)
  expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled()
  expect(f.binding.create).not.toHaveBeenCalled()
}, 90_000)

it('does not clear a marker when admission appears after the empty journal read', async () => {
  const f = await fixture(false)
  expect((await f.api()).status).toBe(202)
  // Emulate a stale empty observation followed by a selected command and an
  // advanced source. Absence and conflict must be checked in one SQL statement.
  vi.spyOn(RunCommandJournal.prototype, 'get').mockResolvedValueOnce(null)
  f.sqlite.prepare("UPDATE experiment_runs SET state_generation = state_generation + 1, state_key = state_key || '/newer-generation' WHERE run_id = ?").run(f.source.runId)
  const get = vi.spyOn(f.bucket, 'get')
  expect(await f.deliver()).toBe(false)
  expect(get).not.toHaveBeenCalled()
  expect(await f.journal.get(f.command.id)).not.toBeNull()
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
}, 90_000)

it.each(['missing-source', 'status', 'source-authority'])('retains an ambiguous %s marker without source reads', async change => {
  const f = await fixture(change === 'source-authority')
  await expect(f.api(f.command, async marker => { await f.register(marker); throw new Error('lost reply') })).rejects.toThrow('lost reply')
  if (change === 'missing-source') f.sqlite.prepare('DELETE FROM experiment_runs WHERE run_id = ?').run(f.source.runId)
  if (change === 'status') f.sqlite.prepare("UPDATE experiment_runs SET status = 'running' WHERE run_id = ?").run(f.source.runId)
  if (change === 'source-authority') {
    const owner = { ...f.source.executionAuthority!, epoch: f.source.executionAuthority!.epoch + 1 }
    f.sqlite.prepare('UPDATE audit_execution_authority SET epoch = ?, authority_json = ? WHERE audit_id = ?')
      .run(owner.epoch, canonicalJson(owner), f.auditId)
  }
  const get = vi.spyOn(f.bucket, 'get'), head = vi.spyOn(f.bucket, 'head')
  expect(await f.deliver()).toBe(false)
  expect(get).not.toHaveBeenCalled(); expect(head).not.toHaveBeenCalled()
  expect(f.binding.create).not.toHaveBeenCalled()
}, 90_000)

it.each(['absent-runtime', 'slot-rotation', 'child-collision'])('distinguishes %s before publication', async failure => {
  const f = await fixture()
  await f.api()
  if (failure === 'absent-runtime') {
    const { workerVersionId: _version, ...declaration } = runtime
    f.front.RUNTIME_CATALOG_JSON = canonicalJson({ schemaVersion: 1, latest: runtime.id,
      releases: { [runtime.id]: { ...declaration, binding: 'RUNTIME_NEXT' } } })
  } else if (failure === 'slot-rotation') {
    f.sqlite.prepare('INSERT INTO runtime_slot_control (singleton, enabled, latest_slot_id, rotating_slot_id, updated_at) VALUES (1, 1, ?, ?, ?)')
      .run(target.id, target.id, f.source.updatedAt)
    f.sqlite.prepare('INSERT INTO runtime_slots (slot_id, runtime_release_json, generation, deployed_at) VALUES (?, ?, 1, ?)')
      .run(target.id, canonicalJson(target), f.source.updatedAt)
  } else await f.store.activateRootExecution(f.child.executionId, target, { unrelated: true })
  const before = f.publication(f.child.executionId)
  if (failure === 'slot-rotation') {
    await expect(f.deliver()).rejects.toThrow('lost its operation or destination')
    expect((await f.journal.get(f.command.id))!.status).toBe('accepted')
  } else {
    expect(await f.deliver()).toBe(true)
    expect((await f.journal.get(f.command.id))!.status).toBe('rejected')
  }
  expect(f.publication(f.child.executionId)).toEqual(before)
  expect(f.binding.create).not.toHaveBeenCalled()
}, 90_000)

it.each(['cancel', 'restart'])('handles child %s before startup without redirecting the source decision', async action => {
  const f = await fixture(false)
  await f.api(); await f.deliver()
  let childMarker: RunControlDeliveryMarker | undefined
  const command = { id: 'adjust-child', expectedRevision: 0, reason: 'adjust before startup', action, scope: { kind: 'audit' },
    ...(action === 'restart' ? { session: 'fresh', runtimeRelease: target } : {}) }
  const before = await f.journal.get(f.command.id), childBefore = await f.store.getState(f.child.executionId)
  const response = await runControlResponse(new Request('https://internal/', { method: 'POST', body: canonicalJson(command) }),
    f.store, f.d1, f.source.experimentId, f.child.executionId, undefined, async marker => { childMarker = marker })
  if (action === 'restart') {
    expect(response.status).toBe(400)
    expect(childMarker).toBeUndefined()
    expect(await new RunCommandJournal(f.d1, f.child.executionId).get(command.id)).toBeNull()
    expect(await f.journal.get(f.command.id)).toEqual(before)
    expect(await f.store.getState(f.child.executionId)).toEqual(childBefore)
    return
  }
  expect(response.status).toBe(202)
  // Native Workflow is still running: cancellation cannot acknowledge completed cleanup.
  expect(await deliverRunControl(childMarker!, f.front)).toBe(false)
  expect(f.sqlite.prepare('SELECT released_at FROM runtime_slot_run_leases WHERE run_id = ?')
    .get(f.child.executionId)!.released_at).toBeNull()
  const selected = await selectedFork(f)
  await boot(f, selected.payload)
  f.binding.create.mockClear()
  f.destination.fetch.mockReset().mockRejectedValue(new Error('old runtime unavailable'))
  delete f.front.RUNTIME_RELEASE_JSON
  delete f.front.VERSION_METADATA
  expect(await f.deliver()).toBe(true)
  expect(await f.journal.get(f.command.id)).toEqual(before)
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.destination.fetch).not.toHaveBeenCalled()
  expect(await f.store.getState(f.source.runId)).toEqual(f.source)
}, 90_000)

it('settles a recorded startup failure after the original runtime becomes unavailable', async () => {
  const f = await fixture()
  await f.api()
  delete (f.env as Partial<Env>).ACK3_CODEX_AUTH_JSON
  expect(await f.deliver()).toBe(false)
  const { auditId, commandId, commandDigest } = f.marker()
  const selected = await selectedFork(f)
  const machine = await boot(f, selected.payload)
  expect(machine.view().status).toBe('failed')
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(await f.store.executionBootstrapped(machine.view())).toBe(true)
  f.destination.fetch.mockReset().mockRejectedValue(new Error('old runtime unavailable'))
  expect(await f.deliver()).toBe(true)
  expect(f.destination.fetch).not.toHaveBeenCalled()
  expect(f.binding.create).toHaveBeenCalledOnce()
}, 90_000)


it('forks a retired failed checkpoint through delivery and real startup, then seals only the deterministic suffix', async () => {
  const f = await fixture(false, 'failed'), sourceBytes = canonicalJson(await f.store.getState(f.source.runId))
  delete (f.env as Partial<Env>).ACK3_CODEX_AUTH_JSON
  delete (f.env as Partial<Env>).ACK3_CODEX_WORKSPACE_ID
  delete f.env.PROVIDER_A_API_KEY
  delete f.env.EXA_API_KEY
  expect((await f.api()).status).toBe(202)
  const admitted = await f.get()
  expect(admitted.status).toBe(200)
  expect(await admitted.json()).toMatchObject({ status: 'accepted', command: f.command })
  expect(await f.deliver()).toBe(false)
  expect(f.binding.create).toHaveBeenCalledOnce()
  const { auditId, commandId, commandDigest } = f.marker()
  const selected = await selectedFork(f)
  const machine = await boot(f, selected.payload)
  expect(machine.snapshot()).toEqual(selected.prepared)
  expect(await f.deliver()).toBe(true)
  const applied = await f.get()
  expect(applied.status).toBe(200)
  expect(await applied.json()).toMatchObject({ status: 'applied' })
  const status = await runControlResponse(new Request('https://internal/'), f.store, f.d1, f.source.experimentId, f.auditId)
  expect(status.status).toBe(200)
  expect(await status.json()).toMatchObject({ auditId: f.auditId, executionId: f.source.runId,
    status: 'failed', revision: 2, settledRevision: 0, blockedTasks: [] })
  expect((await f.api({ id: 'forbidden-retired-pause', expectedRevision: 2, action: 'pause', scope: { kind: 'audit' }, reason: 'must not gain authority' })).status).toBe(409)
  expect(await f.journal.get('forbidden-retired-pause')).toBeNull()
  const run = vi.fn(new DeterministicAuditProvider().run.bind(new DeterministicAuditProvider()))
  await runExperiment({ machine, definition: machine.definition, provider: { run },
    artifactStore: new R2ArtifactStore(f.bucket), policy: audit0RunPolicy })
  const result = machine.snapshot()
  expect(result.status).toBe('completed')
  expect(result.artifacts.slice(0, selected.prepared.artifacts.length)).toEqual(selected.prepared.artifacts)
  expect(result.artifacts.at(-1)?.taskId).toBe('seal-final')
  expect(result.budget).toEqual(f.source.budget)
  expect(result.modelStartedAt).toBe(f.source.modelStartedAt)
  expect(result).not.toHaveProperty('failedWaveRecovery')
  expect(result).not.toHaveProperty('terminalCompletionRecovery')
  expect(run.mock.calls).toHaveLength(1)
  expect(run.mock.calls[0]![0].task.promptKind).toBe('final-seal')
  await f.store.putState(machine.view(), { generation: selected.prepared.stateGeneration, digest: await sha256(selected.prepared) })
  for (const checkpoint of result.checkpoints) await f.store.putCheckpoint(checkpoint)
  const reloaded = await RunMachine.fromState(machine.definition, await f.store.getState(result.runId), f.loadRelease, f.loadState)
  for (const checkpoint of reloaded.view().checkpoints) await reloaded.verifyCheckpoint(checkpoint)
  expect(reloaded.snapshot()).toEqual(result)
  expect((await boot(f, selected.payload)).snapshot()).toEqual(result)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(sourceBytes)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
}, 90_000)

it.each(['failed', 'stopped'] as const)('refuses cold fork bootstrap after %s source retirement is revoked', async source => {
  const f = await fixture(false, source)
  await f.api(); await f.deliver()
  const { auditId, commandId, commandDigest } = f.marker()
  const { payload } = await selectedFork(f)
  f.binding.create.mockClear()
  f.sqlite.prepare("UPDATE audit_execution_authority SET status = 'active' WHERE execution_id = ?").run(f.source.runId)
  await expect(boot(f, payload)).rejects.toThrow()
  expect(await f.store.executionBootstrapped(await f.store.getState(f.child.executionId))).toBe(false)
  expect(f.binding.create).not.toHaveBeenCalled()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
}, 90_000)

it('delivers a stopped checkpoint fork, bootstraps and completes the suffix without replaying retained work', async () => {
  const f = await fixture(false, 'stopped'), source = canonicalJson(f.source)
  expect((await f.api()).status).toBe(202)
  await f.deliver()
  const { auditId, commandId, commandDigest } = f.marker()
  const selected = await selectedFork(f)
  const machine = await boot(f, selected.payload)
  const run = vi.fn(new DeterministicAuditProvider().run.bind(new DeterministicAuditProvider()))
  await runExperiment({ machine, definition: machine.definition, provider: { run },
    artifactStore: new R2ArtifactStore(f.bucket), policy: audit0RunPolicy })
  const result = machine.snapshot(), retained = new Set(selected.prepared.artifacts.map(record => record.taskId))
  expect(result.status).toBe('completed')
  expect(result.artifacts.slice(0, retained.size)).toEqual(selected.prepared.artifacts)
  expect(run.mock.calls.length).toBeGreaterThan(0)
  expect(run.mock.calls.every(([request]) => !retained.has(request.task.id))).toBe(true)
  expect(result.modelStartedAt).toBe(f.source.modelStartedAt)
  for (const checkpoint of result.checkpoints) await machine.verifyCheckpoint(checkpoint)
  await f.store.putState(machine.view(), { generation: selected.prepared.stateGeneration, digest: await sha256(selected.prepared) })
  expect((await boot(f, selected.payload)).snapshot()).toEqual(result)
  expect(canonicalJson(await f.store.getState(f.source.runId))).toBe(source)
}, 90_000)
