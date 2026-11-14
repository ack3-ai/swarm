import { createControlledMachine } from './support/controlled-machine.js'
import { currentExecutionWorkspaceTasks } from '../src/owned-execution-workspaces.js'
import { syntheticSourceFence } from './support/source-fence.js'
import { forkWithSavedWork } from './support/saved-work.js'
import { applicableAvailabilityBoundaries } from '../src/execution-availability.js'
import { assertStageForkSelection } from '../src/stage-fork-origin.js'
import { assertNativeTaskAdmission } from '../src/native-launch-authority.js'
import { recordedWorkspaceTasks } from '../src/execution-workspaces.js'
import { disposeTerminalWorkspaces } from '../src/runner.js'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { selectedSnapshots, type SelectedSnapshotsContent } from './support/selected-snapshots.js'
import { referenceShape, sharedMutableObjects } from './support/object-graph.js'
const closes: Array<() => void> = []
afterEach(() => closes.splice(0).forEach(close => close()))
import manifest from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { sealReleasePackage } from '../src/release.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { RunMachine } from '../src/machine.js'
import type { AgentRequest, ReleasePackage, RunState, RuntimeRelease, SealedCheckpoint } from '../src/contracts.js'
import { prepareStageForkSource } from '../src/stage-fork-source.js'
import { AgentAttemptFailure, PermanentRunFailure } from '../src/run-errors.js'
import type { ExecutionSourceLoader } from '../src/execution-lineage.js'
import type { RunOperation } from '../src/run-command-journal.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../src/runner.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-source', workflowName: 'runtime-source', containerImageDigest: `sha256:${'b'.repeat(64)}`,
  workerVersionId: '11111111-1111-4111-8111-111111111111' }
const target: RuntimeRelease = { ...runtime, id: 'runtime-target', workerService: 'runtime-target', workflowName: 'runtime-target',
  frameworkCommit: 'c'.repeat(40), workerVersionId: '22222222-2222-4222-8222-222222222222' }

type SourceData = { before: ReleasePackage; after: ReleasePackage; releases: Map<string, ReleasePackage>; states: Map<string, RunState>
  checkpoints: Map<string, SealedCheckpoint>; saved: Map<string, RunState>; source: RunState; boundary: SealedCheckpoint
  reference: { runId: string; state: { generation: number; digest: string } }; stageIndex: number }
type SourceParts = { selections: ReturnType<typeof selectedSnapshots>; artifacts: MemoryArtifactStore; data: SourceData }
type SourceSnapshot = { selections: SelectedSnapshotsContent; artifacts: ReturnType<typeof artifactMaps>; data: SourceData }

function savedStates(selections: ReturnType<typeof selectedSnapshots>, saved: Map<string, RunState>) {
  const save = async (state: RunState) => saved.set(`${state.runId}/${state.stateGeneration}/${await sha256(state)}`, structuredClone(state))
  const stateAt: ExecutionSourceLoader = async (id, pointer) => {
    const value = saved.get(`${id}/${pointer.generation}/${pointer.digest}`)
    if (!value) throw new Error('missing immutable saved state')
    return structuredClone(value)
  }
  stateAt.assertSelected = selections.load.assertSelected!
  const select = async (machine: RunMachine) => { const state = await selections.select(machine); await save(state); return state }
  return { save, stateAt, select }
}

async function buildSource(terminalFailure: boolean, unavailablePool: boolean, registerClose: (close: () => void) => void): Promise<SourceParts> {
  const config = structuredClone(manifest), modified = structuredClone(manifest)
  modified.modelPools.push({ ...modified.modelPools.find(pool => pool.id === 'luna')!, id: 'second-reviewer', agents: 0 })
  modified.stageModelPools['negative-review'] = ['luna', 'second-reviewer']
  const before = await sealReleasePackage(compileExperimentConfig(config)), after = await sealReleasePackage(compileExperimentConfig(modified))
  const releases = new Map([[before.digest, before], [after.digest, after]])
  const selections = selectedSnapshots(); registerClose(selections.close)
  const states = new Map<string, RunState>(), checkpoints = new Map<string, SealedCheckpoint>(), saved = new Map<string, RunState>()
  const { save, select } = savedStates(selections, saved)
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  const provider = { run: async (request: AgentRequest) => {
    if (unavailablePool && request.task.promptKind === 'research' && request.task.modelPool === 'deepseek') return {
      status: 'additive-unavailable' as const, actorId: `unavailable-${request.task.id}`, model: request.task.model,
      provider: request.task.provider!, files: {}, assertions: [], protocol: {}, inputTokens: 0, outputTokens: 0,
      costUsd: 0, modelCalls: 1 as const, unavailableReason: 'provider-credit' as const }
    return base.run(request)
  } }
  const authority = { auditId: 'fork-source', executionId: 'fork-source', epoch: 0, runtimeDigest: await sha256(runtime) }
  let machine = await createControlledMachine(before.body.definition, before.digest, authority.auditId, undefined, runtime, authority)
  const stageIndex = before.body.definition.stages.findIndex(stage => stage.id === 'negative-review')
  await machine.start()
  while (machine.view().cursor.stageIndex < stageIndex) await advanceExperimentOneWave({ definition: machine.definition, machine, artifactStore: artifacts, provider, policy: audit0RunPolicy })
  const boundary = machine.view().checkpoints.at(-1)!
  const outcome = terminalFailure
    ? await runExperiment({ definition: machine.definition, machine, artifactStore: artifacts, provider,
      policy: { ...audit0RunPolicy, assessCompletion: () => ['synthetic completion defect'] } }).then(() => { throw new Error('fixture must fail') }, () => ({ state: machine.snapshot() }))
    : await runExperiment({ definition: machine.definition, machine, artifactStore: artifacts, provider, policy: audit0RunPolicy })
  await select(machine)
  states.set(outcome.state.runId, outcome.state)
  for (const state of states.values()) for (const checkpoint of state.checkpoints) checkpoints.set(checkpoint.digest, checkpoint)
  for (const state of states.values()) await save(state)
  const reference = { runId: outcome.state.runId, state: { generation: outcome.state.stateGeneration, digest: await sha256(outcome.state) } }
  return { selections, artifacts, data: { before, after, releases, states, checkpoints, saved, source: outcome.state, boundary, reference, stageIndex } }
}

function attachSource({ selections, artifacts, data }: SourceParts) {
  const { before, after, releases, states, checkpoints, saved, source, boundary, reference, stageIndex } = data
  const { stateAt, select } = savedStates(selections, saved)
  const read = {
    stateAt,
    state: async (id: string) => { const value = states.get(id); if (!value) throw new Error('missing owner state'); return structuredClone(value) },
    checkpoint: async (digest: string) => { const value = checkpoints.get(digest); if (!value) throw new Error('missing checkpoint'); return structuredClone(value) },
    release: async (digest: string) => { const value = releases.get(digest); if (!value) throw new Error('missing release'); return structuredClone(value) },
  }
  const input = { source: reference, releaseDigest: after.digest, stageId: 'negative-review', read,
    readArtifact: async (record: { uri: string }) => { const value = artifacts.contents.get(record.uri); if (value === undefined) throw new Error('missing artifact'); return value },
    readInputs: (digest: string) => artifacts.readExecutionInputs(digest),
  }
  return { input, before, after, states, saved, select, releases, checkpoints, artifacts, source, boundary, stageIndex, selections }
}

// Each variant is built once; every test gets its own restored copy (P2-12): a new selection
// database, artifact store and copies of the saved data, with the build's aliases.
const artifactMaps = ({ contents, executionInputs, rejectedMetadata }: MemoryArtifactStore) => ({ contents, executionInputs, rejectedMetadata })
function restoreSource(snapshot: SourceSnapshot, registerClose: (close: () => void) => void): SourceParts {
  const selections = selectedSnapshots(snapshot.selections); registerClose(selections.close)
  const artifacts = new MemoryArtifactStore(), maps = structuredClone(snapshot.artifacts)
  for (const [key, value] of maps.contents) artifacts.contents.set(key, value)
  for (const [key, value] of maps.executionInputs) artifacts.executionInputs.set(key, value)
  for (const [key, value] of maps.rejectedMetadata) artifacts.rejectedMetadata.set(key, value)
  const data = structuredClone(snapshot.data)
  // The build's boundary is part of a machine view, which the machine froze.
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
    Object.freeze(value); for (const child of Object.values(value)) freeze(child)
  }
  freeze(data.boundary)
  return { selections, artifacts, data }
}
async function snapshotSource(terminalFailure: boolean, unavailablePool: boolean): Promise<SourceSnapshot> {
  const built: (() => void)[] = []
  try {
    const source = await buildSource(terminalFailure, unavailablePool, close => built.push(close))
    const snapshot = { selections: source.selections.content(), artifacts: structuredClone(artifactMaps(source.artifacts)), data: structuredClone(source.data) }
    const copy = restoreSource(snapshot, close => built.push(close))
    expect(copy.selections.content()).toStrictEqual(source.selections.content())
    const values = ({ artifacts, data }: SourceParts) => ({ artifacts, data })
    expect(values(copy)).toStrictEqual(values(source))
    expect(referenceShape(values(copy))).toStrictEqual(referenceShape(values(source)))
    return snapshot
  } finally { built.splice(0).forEach(close => close()) }
}
const snapshots = new Map<string, Promise<SourceSnapshot>>()
beforeAll(async () => {
  for (const unavailablePool of [false, true]) {
    const snapshot = snapshotSource(false, unavailablePool)
    snapshots.set(`false/${unavailablePool}`, snapshot)
    await snapshot
  }
}, 120_000)
async function fixture(_controlled = true, terminalFailure = false, unavailablePool = false) {
  const snapshot = snapshots.get(`${terminalFailure}/${unavailablePool}`)
  if (snapshot === undefined) throw new Error('fixture variant was not prepared before the tests')
  return attachSource(restoreSource(await snapshot, close => closes.push(close)))
}

it.each([true])('verifies a sealed stage prefix without relabeling source work (controlled=%s)', async controlled => {
  const f = await fixture(controlled), original = canonicalJson(f.source)
  const prepared = await prepareStageForkSource(f.input)
  expect(prepared.checkpoint).toEqual(f.boundary)
  expect(prepared.artifacts).toEqual(f.boundary.body.acceptedArtifacts)
  expect(prepared.artifacts.some(value => value.stageId === 'negative-review')).toBe(false)
  expect(prepared.release.digest).toBe(f.after.digest)
  expect(prepared.source.budget).toEqual(f.source.budget)
  expect(prepared.source.modelStartedAt).toBe(f.source.modelStartedAt)
  expect(prepared.artifacts.every(value => controlled ? value.execution !== undefined : value.execution === undefined)).toBe(true)
  expect(canonicalJson(f.states.get(f.source.runId))).toBe(original)
})

it.each(['source-hash', 'artifact-bytes', 'input-bytes', 'release-bytes', 'upstream-contract'])
  ('refuses %s instead of constructing an import from unchecked evidence', async change => {
    const f = await fixture()
    if (change === 'source-hash') f.input.source.state.digest = 'a'.repeat(64)
    if (change === 'artifact-bytes') f.input.readArtifact = async () => '{}'
    if (change === 'input-bytes') f.input.readInputs = async () => [{ id: 'fabricated', contentDigest: 'b'.repeat(64) }]
    if (change === 'release-bytes') f.after.body.definition.id = 'substituted'
    if (change === 'upstream-contract') {
      const changed = structuredClone(f.after.body)
      changed.definition.prompts.researcherProtocol += '\nDifferent research instructions.'
      const release = await sealReleasePackage(changed)
      f.releases.set(release.digest, release); f.input.releaseDigest = release.digest
    }
    await expect(prepareStageForkSource(f.input)).rejects.toThrow()
  })

it.each([true])('runs a controlled fork from the retained prefix through a new final seal (source controlled=%s)', async controlled => {
  const f = await fixture(controlled), prepared = await prepareStageForkSource(f.input)
  const sourceBytes = canonicalJson(f.source), artifactBytes = new Map(f.artifacts.contents), calls: AgentRequest[] = []
  const childArtifacts = new MemoryArtifactStore('independent-fork')
  let child = await forkWithSavedWork(prepared, 'independent-fork', target, f.input.read.release, f.input.read.stateAt)
  expect(child.view().rootRunId).toBe('independent-fork')
  expect(child.view().parentRunId).toBeNull()
  expect(child.view().checkpoints).toEqual([])
  expect(child.view().rejectedAttempts).toEqual([])
  expect(child.view().artifacts).toEqual(prepared.artifacts)
  expect(child.view().budget).toEqual(f.source.budget)
  await child.start()
  await child.seal()
  const provider = new DeterministicAuditProvider()
  let nativeCheck: unknown, checked = false, checkedAfterOutcome = false
  for (let guard = 0; child.view().cursor.stageIndex < child.definition.stages.length; guard++) {
    expect(guard).toBeLessThan(20)
    child = await RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.input.read.stateAt)
    await advanceExperimentOneWave({ definition: child.definition, machine: child, artifactStore: childArtifacts,
      provider: { run: async request => {
        calls.push(request)
        const afterOutcome = child.view().artifacts.length > prepared.artifacts.length
        if ((!checked || afterOutcome && !checkedAfterOutcome) && request.task.providerClass !== 'deterministic') {
          checked = true; checkedAfterOutcome ||= afterOutcome
          try {
            await assertNativeTaskAdmission(await f.select(child), request, f.input.read.release, f.input.read.stateAt)
            const undercharged = child.snapshot(); undercharged.budget = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
            await expect(RunMachine.fromState(child.definition, undercharged, f.input.read.release, f.input.read.stateAt)).rejects.toThrow('no matching state selection')
            await expect(assertNativeTaskAdmission(undercharged, request, f.input.read.release, f.input.read.stateAt)).rejects.toThrow('no matching state selection')
            const tampered = child.snapshot(); tampered.artifacts[0]!.contentDigest = '0'.repeat(64)
            await expect(assertNativeTaskAdmission(tampered, request, f.input.read.release, f.input.read.stateAt)).rejects.toThrow('no matching state selection')
          } catch (error) { nativeCheck = error; throw error }
        }
        return provider.run(request)
      } }, policy: audit0RunPolicy })
    if (nativeCheck !== undefined) throw nativeCheck
    for (const checkpoint of child.view().checkpoints) await child.verifyCheckpoint(checkpoint)
  }
  await child.complete()
  await expect(RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.input.read.stateAt)).resolves.toBeDefined()
  expect(child.view().status).toBe('completed')
  const reviews = calls.filter(request => request.stage.id === 'negative-review' && request.task.providerClass !== 'deterministic')
  expect(reviews).toHaveLength(2)
  expect(checkedAfterOutcome).toBe(true)
  // Reviewers execute concurrently; their start order is not part of the contract.
  expect(reviews.map(request => request.task).toSorted((a, b) => a.id.localeCompare(b.id)))
    .toEqual([...child.definition.stages[prepared.stageIndex]!.waves[0]!.tasks].sort((a, b) => a.id.localeCompare(b.id)))
  expect(reviews.every(request => request.runId === 'independent-fork' && request.sessionId === null && request.continuationMode === 'new')).toBe(true)
  expect(reviews[0]!.visibleArtifacts).toEqual(reviews[1]!.visibleArtifacts)
  const oldSuffix = new Set(f.source.artifacts.filter(record => !prepared.artifacts.some(value => value.id === record.id)).map(record => canonicalJson(record)))
  expect(calls.every(request => request.visibleArtifacts.every(record => !oldSuffix.has(canonicalJson(record))))).toBe(true)
  expect(calls.every(request => child.definition.stages.findIndex(stage => stage.id === request.stage.id) >= prepared.stageIndex)).toBe(true)
  const inheritedIds = new Set(prepared.artifacts.map(record => record.id))
  expect(child.view().artifacts.filter(record => inheritedIds.has(record.id))).toEqual(prepared.artifacts)
  expect(canonicalJson(f.source)).toBe(sourceBytes)
  expect(f.artifacts.contents).toEqual(artifactBytes)
  expect(child.view().budget.modelCalls).toBeGreaterThan(f.source.budget.modelCalls)
}, 60_000)

it('rejects altered imports, unpinned ancestry and rewinding into inherited work', async () => {
  const f = await fixture(true), prepared = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(prepared, 'fork-tampering', target, f.input.read.release, f.input.read.stateAt)
  for (const mutate of [
    (state: RunState) => { state.artifacts[0]!.contentDigest = '0'.repeat(64) },
    (state: RunState) => { state.artifacts = [...state.artifacts, state.artifacts[0]!] },
    (state: RunState) => { state.waveReceipts = [] },
    (state: RunState) => { state.budget = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    (state: RunState) => { state.cursor = { stageIndex: 1, waveIndex: 0 }; state.phase = 'discovery' },
    (state: RunState) => { state.modelStartedAt = new Date().toISOString() },
    (state: RunState) => { delete state.forkOrigin },
  // @ts-expect-error Deliberately remove required ownership to test rejection.
    (state: RunState) => { delete state.executionAuthority },
  ]) {
    const changed = child.snapshot(); mutate(changed)
    await expect(RunMachine.fromState(child.definition, changed, f.input.read.release, f.input.read.stateAt)).rejects.toThrow()
  }
  const changed = child.snapshot()
  changed.forkOrigin!.savedWorkDigest = '0'.repeat(64)
  const { digest: _digest, ...origin } = changed.journal[0]!
  const rewritten = { ...origin, payload: { ...(origin.payload as Record<string, unknown>), forkOrigin: changed.forkOrigin } }
  changed.journal = [{ ...rewritten, digest: await sha256(rewritten) }]
  await expect(RunMachine.fromState(child.definition, changed, f.input.read.release, f.input.read.stateAt)).rejects.toThrow('no matching state selection')
}, 30_000)

it.each([false, true])('cancels a fork and cleans only its own allocations (review ran=%s)', async reviewRan => {
  const f = await fixture(true), prepared = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(prepared, 'fork-cleanup', target, f.input.read.release, f.input.read.stateAt)
  await child.start()
  const provider = new DeterministicAuditProvider()
  if (reviewRan) await advanceExperimentOneWave({ definition: child.definition, machine: child,
    artifactStore: new MemoryArtifactStore('fork-cleanup'), provider, policy: audit0RunPolicy })
  const state = child.snapshot(), command = { id: 'cancel-fork', expectedRevision: 0, reason: 'synthetic cancellation',
    action: 'cancel' as const, scope: { kind: 'audit' as const } }
  const proof = { inventoryDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
  const operation: RunOperation = { auditId: state.rootRunId, command, commandDigest: await sha256(command),
    revision: 1, version: 1, status: 'applying', acceptedAt: state.updatedAt, updatedAt: state.updatedAt,
    source: { authority: state.executionAuthority!, state: { generation: state.stateGeneration, digest: await sha256(state) } },
    nativeEffect: { kind: 'revoke-admission', inventoryDigest: proof.inventoryDigest } }
  const owned = await recordedWorkspaceTasks(child.definition, state, child.importedSeed)
  expect(await currentExecutionWorkspaceTasks(child.view(), { getRelease: f.input.read.release,
    executionSources: () => f.input.read.stateAt })).toEqual(owned)
  expect(owned).toHaveLength(reviewRan ? 2 : 0)
  expect(owned.every(record => record.execution?.runId === child.view().runId)).toBe(true)
  await child.cancelAudit(operation, proof)
  await expect(RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.input.read.stateAt)).resolves.toBeDefined()
  const disposeWorkspace = vi.fn(async (_input: { runId: string; workspaceKey: string }) => {})
  await expect(disposeTerminalWorkspaces({ run: provider.run.bind(provider), disposeWorkspace }, child.definition, child.snapshot(),
    { loadRelease: f.input.read.release, loadExecution: f.input.read.stateAt })).rejects.toThrow('cancel control')
  expect(disposeWorkspace).not.toHaveBeenCalled()
  expect(child.view().artifacts.slice(0, prepared.artifacts.length)).toEqual(prepared.artifacts)
})

it('can fork a completed fork using pinned nested ancestry without authorizing source manifests for new work', async () => {
  const f = await fixture(true), prepared = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(prepared, 'first-fork', target, f.input.read.release, f.input.read.stateAt)
  await child.start()
  await runExperiment({ definition: child.definition, machine: child, provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore('first-fork'), policy: audit0RunPolicy })
  const source = await f.select(child), digest = await sha256(source)
  f.saved.set(`${source.runId}/${source.stateGeneration}/${digest}`, source); f.states.set(source.runId, source)
  for (const checkpoint of source.checkpoints) f.checkpoints.set(checkpoint.digest, checkpoint)
  // There is a real boundary seal before the first new wave, not a reconstructed one.
  // Starting the fork seals this import boundary before any new model call.
  const boundary = source.checkpoints.find(checkpoint => checkpoint.body.cursor.stageIndex === prepared.stageIndex && checkpoint.body.cursor.waveIndex === 0)
  expect(boundary).toBeDefined()
  const inheritedReads = vi.spyOn(f.input.read.stateAt, 'readSavedWork')
  const next = await prepareStageForkSource({ ...f.input, source: { runId: source.runId, state: { generation: source.stateGeneration, digest } } })
  // One machine import and one independent accounting read; no second manifest/seed resolver.
  expect(inheritedReads).toHaveBeenCalledTimes(2)
  inheritedReads.mockRestore()
  const descendant = await forkWithSavedWork(next, 'second-fork', target, f.input.read.release, f.input.read.stateAt)
  await descendant.start(); await descendant.seal()
  await expect(RunMachine.fromState(descendant.definition, await f.select(descendant), f.input.read.release, f.input.read.stateAt)).resolves.toBeDefined()
  expect(descendant.view().artifacts).toEqual(prepared.artifacts)
  expect(descendant.view().budget).toEqual(source.budget)
  await expect(descendant.executionDefinition({ releaseDigest: f.before.digest, definitionDigest: await sha256(f.before.body.definition) })).rejects.toThrow('unauthorized configuration')
  const owned = await recordedWorkspaceTasks(descendant.definition, descendant.snapshot(), descendant.importedSeed)
  expect(owned).toEqual([])
  const exportsOnly = Object.assign(async () => { throw new Error('historical source unavailable') },
    { readSavedWork: f.input.read.stateAt.readSavedWork!, assertSelected: f.input.read.stateAt.assertSelected! })
  await expect(RunMachine.fromState(descendant.definition, await f.select(descendant), f.input.read.release, exportsOnly)).resolves.toBeDefined()
}, 60_000)

it('forks a failed fork without rewriting imported history', async () => {
  const f = await fixture(true), prepared = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(prepared, 'failed-fork', target, f.input.read.release, f.input.read.stateAt)
  await child.start(); await child.fail('synthetic framework failure')
  const source = await f.select(child), digest = await sha256(source)
  f.states.set(source.runId, source)
  for (const checkpoint of source.checkpoints) f.checkpoints.set(checkpoint.digest, checkpoint)
  const { stageId: _, ...input } = f.input
  const retained = await prepareStageForkSource({ ...input, sourceFrontier: true, sourceFence: syntheticSourceFence(source),
    source: { runId: source.runId, state: { generation: source.stateGeneration, digest } } })
  const replacement = await forkWithSavedWork(retained, 'continued-fork', target, f.input.read.release, f.input.read.stateAt)
  expect(replacement.view().rootRunId).not.toBe(source.rootRunId)
  expect(replacement.view().artifacts).toEqual(source.artifacts)
  expect(replacement.view().budget).toEqual(source.budget)
  expect(replacement.view().rootCreatedAt).toBe(source.rootCreatedAt)
  expect(replacement.view().modelStartedAt).toBe(source.modelStartedAt)
  await replacement.start()
  await runExperiment({ definition: replacement.definition, machine: replacement, artifactStore: new MemoryArtifactStore('continued-fork'),
    provider: new DeterministicAuditProvider(), policy: audit0RunPolicy })
  for (const checkpoint of replacement.view().checkpoints) await replacement.verifyCheckpoint(checkpoint)
  await expect(RunMachine.fromState(replacement.definition, await f.select(replacement), f.input.read.release, f.input.read.stateAt)).resolves.toBeDefined()
  expect(replacement.view().artifacts.slice(0, prepared.artifacts.length)).toEqual(prepared.artifacts)
}, 60_000)

it.each([true])('forks a sealed ordinary wave without replaying its same-stage prefix (controlled=%s)', async controlled => {
  const f = await fixture(controlled)
  const checkpoint = f.source.checkpoints.find(value => value.body.cursor.stageIndex === f.before.body.definition.stages.length - 1 && value.body.cursor.waveIndex === 1)!
  expect(checkpoint).toBeDefined()
  const { stageId: _, ...input } = f.input
  const seed = await prepareStageForkSource({ ...input, releaseDigest: f.before.digest, checkpointDigest: checkpoint.digest })
  expect(seed.waveIndex).toBe(1)
  expect(seed.artifacts).toEqual(checkpoint.body.acceptedArtifacts)
  const changed = structuredClone(f.before.body)
  changed.definition.prompts.reportingInstructions += '\nChanged instructions for the already accepted report.'
  const changedRelease = await sealReleasePackage(changed)
  f.releases.set(changedRelease.digest, changedRelease)
  await expect(prepareStageForkSource({ ...input, releaseDigest: changedRelease.digest,
    checkpointDigest: checkpoint.digest })).rejects.toThrow('sealed wave')
  const child = await forkWithSavedWork(seed, 'wave-fork', target, f.input.read.release, f.input.read.stateAt)
  expect(child.view().cursor).toEqual(checkpoint.body.cursor)
  const calls: AgentRequest[] = [], provider = new DeterministicAuditProvider()
  const result = await runExperiment({ definition: child.definition, machine: child, artifactStore: new MemoryArtifactStore('wave-fork'),
    provider: { run: async request => { calls.push(request); return provider.run(request) } }, policy: audit0RunPolicy })
  expect(result.state.status).toBe('completed')
  expect(calls).not.toHaveLength(0)
  expect(calls.every(request => request.stage.id === child.definition.stages[seed.stageIndex]!.id
    && request.wave.id === child.definition.stages[seed.stageIndex]!.waves[seed.waveIndex]!.id)).toBe(true)
  expect(result.state.artifacts.slice(0, seed.artifacts.length)).toEqual(seed.artifacts)
  await RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.input.read.stateAt)
  const rewound = child.snapshot(); rewound.cursor = { stageIndex: seed.stageIndex, waveIndex: 0 }
  expect(() => assertStageForkSelection(seed, rewound)).toThrow('prefix')
  const reopened = child.snapshot(); reopened.artifacts = [...reopened.artifacts, structuredClone(seed.artifacts.at(-1)!)]
  expect(() => assertStageForkSelection(seed, reopened)).toThrow('retained prefix')
}, 60_000)

it.each([true])('retains provider availability evidence through fork, sealing and nested import (controlled=%s)', async controlled => {
  const f = await fixture(controlled, false, true)
  expect(f.source.availabilityBoundaries).toHaveLength(1)
  const review = f.source.artifacts.find(record => record.taskId === 'negative-review-replica')!
  expect(review.status).toBe('accepted')
  const boundaryBytes = canonicalJson(f.source.availabilityBoundaries), prepared = await prepareStageForkSource(f.input)
  let child = await forkWithSavedWork(prepared, 'availability-fork', target, f.input.read.release, f.input.read.stateAt)
  expect(canonicalJson(child.view().availabilityBoundaries)).toBe(boundaryBytes)
  const applicable = () => applicableAvailabilityBoundaries(child.view(), {
    releaseDigest: child.view().releaseDigest, definitionDigest: child.view().definitionDigest,
  }, child.definition, child.importedAvailability)
  expect(await applicable()).toEqual(f.source.availabilityBoundaries)
  await child.start(); await child.seal()
  child = await RunMachine.fromState(child.definition, await f.select(child), f.input.read.release, f.input.read.stateAt)
  const result = await runExperiment({ definition: child.definition, machine: child, artifactStore: new MemoryArtifactStore('availability-fork'),
    provider: new DeterministicAuditProvider(), policy: audit0RunPolicy })
  for (const checkpoint of result.state.checkpoints) await child.verifyCheckpoint(checkpoint)
  expect(canonicalJson(result.state.availabilityBoundaries)).toBe(boundaryBytes)
  const missing = child.snapshot(); missing.availabilityBoundaries = []
  await expect(RunMachine.fromState(child.definition, missing, f.input.read.release, f.input.read.stateAt)).rejects.toThrow('no matching state selection')
  const source = await f.select(child), digest = await sha256(source)
  f.saved.set(`${source.runId}/${source.stateGeneration}/${digest}`, source); f.states.set(source.runId, source)
  for (const checkpoint of source.checkpoints) f.checkpoints.set(checkpoint.digest, checkpoint)
  const nested = await prepareStageForkSource({ ...f.input, source: { runId: source.runId, state: { generation: source.stateGeneration, digest } } })
  const descendant = await forkWithSavedWork(nested, 'availability-descendant', target, f.input.read.release, f.input.read.stateAt)
  expect(canonicalJson(descendant.view().availabilityBoundaries)).toBe(boundaryBytes)
  expect(descendant.importedAvailability!.entries[0]!.route).toBe(prepared.availability.entries[0]!.route)
  await descendant.start(); await descendant.seal()
  await RunMachine.fromState(descendant.definition, await f.select(descendant), f.input.read.release, f.input.read.stateAt)
}, 60_000)

it.each([true])('keeps copied fork evidence independent from its source (controlled=%s)', async controlled => {
  const f = await fixture(controlled), original = canonicalJson(f.source), sourceDigest = await sha256(f.source)
  const prepared = await prepareStageForkSource(f.input)
  const child = await forkWithSavedWork(prepared, 'independent-copy-fork', target, f.input.read.release, f.input.read.stateAt)
  const childBefore = canonicalJson(child.view())
  const snapshot = child.snapshot()
  snapshot.artifacts[0]!.files = [...snapshot.artifacts[0]!.files, 'snapshot-only']
  prepared.artifacts[0]!.files = [...prepared.artifacts[0]!.files, 'seed-only']
  prepared.source.artifacts[0]!.files = [...prepared.source.artifacts[0]!.files, 'source-copy-only']
  prepared.checkpoint!.body.acceptedArtifacts[0]!.files = [...prepared.checkpoint!.body.acceptedArtifacts[0]!.files, 'checkpoint-copy-only']
  expect(canonicalJson(child.view())).toBe(childBefore)
  expect(canonicalJson(f.source)).toBe(original)
  expect(await sha256(f.source)).toBe(sourceDigest)
  expect(canonicalJson(f.states.get(f.source.runId))).toBe(original)
}, 60_000)

it('rejects an image change for a saved-frontier fork', async () => {
  const f = await fixture(true)
  const release = await sealReleasePackage({ ...f.after.body,
    environment: { image: `registry.cloudflare.com/00000000000000000000000000000000/swarm-sandbox@sha256:${'e'.repeat(64)}` } })
  f.releases.set(release.digest, release)
  const { stageId: _stage, ...input } = f.input
  await expect(prepareStageForkSource({ ...input, sourceFrontier: true, releaseDigest: release.digest }))
    .rejects.toThrow('saved-frontier fork changes the retained runtime environment')
}, 60_000)

it('gives every test its own copy of the built source audit', async () => {
  const first = await fixture(), second = await fixture()
  expect(sharedMutableObjects(first, second)).toEqual([])
  const content = (f: Awaited<ReturnType<typeof fixture>>) => structuredClone({ selections: f.selections.content(),
    artifacts: artifactMaps(f.artifacts), input: { source: f.input.source, releaseDigest: f.input.releaseDigest, stageId: f.input.stageId },
    before: f.before, after: f.after, releases: f.releases, states: f.states, saved: f.saved, checkpoints: f.checkpoints, source: f.source, boundary: f.boundary })
  const expected = content(second)
  expect(content(first)).toStrictEqual(expected)
  // Change the first copy everywhere: its selection database, saved states, artifacts and values.
  const other = await createControlledMachine(first.before.body.definition, first.before.digest, 'other-source', undefined, runtime,
    { auditId: 'other-source', executionId: 'other-source', epoch: 0, runtimeDigest: await sha256(runtime) })
  await first.select(other)
  first.states.clear(); first.checkpoints.clear(); first.releases.delete(first.before.digest)
  first.artifacts.contents.clear(); first.artifacts.executionInputs.clear()
  first.after.body.definition.id = 'changed'; first.source.stateGeneration += 1; first.input.source.state.digest = 'a'.repeat(64)
  expect(content(first)).not.toStrictEqual(expected)
  // Neither the other copy nor a later one sees any of it.
  expect(content(second)).toStrictEqual(expected)
  expect(content(await fixture())).toStrictEqual(expected)
})
