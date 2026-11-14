import { PermanentRunFailure } from '../../src/run-errors.js'
import { expect, vi } from 'vitest'
import { canonicalJson, sha256 } from '../../src/canonical.js'
import { CloudflareRunStore, R2ArtifactStore } from '../../src/cloudflare-storage.js'
import type { RunState } from '../../src/contracts.js'
import { ExecutionAuthorityStore } from '../../src/execution-authority.js'
import { RunMachine } from '../../src/machine.js'
import { RunCommandJournal } from '../../src/run-command-journal.js'
import type { StageForkCommand } from '../../src/run-commands.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../../src/runner.js'
import manifest from '../fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './compile-config.js'
import { DeterministicAuditProvider } from './deterministic-audit-provider.js'
import { memoryR2 } from './memory-r2.js'
import { runExperiment } from './memory-runner.js'
import { restoreSqlite, sqliteContent, sqliteD1, type SqliteContent } from './sqlite-d1.js'
import { createExecutorSourceFixture, target } from './successor-fixture.js'
import { referenceShape } from './object-graph.js'
import { NativeCommandEvidence } from '../../src/native-command-evidence.js'

export type ForkFixtureFailure = false | 'failed' | 'stopped' | 'partial'
type ExecutorFixture = Awaited<ReturnType<typeof createExecutorSourceFixture>>
type AdmittedStop = Awaited<ReturnType<RunCommandJournal['admit']>>
/** The built audit before the per-test helpers are attached. */
interface ForkFixtureParts extends Pick<ExecutorFixture, 'sqlite' | 'onAfterRun' | 'd1' | 'bucket' | 'objects' | 'store' | 'release' | 'authority' | 'owners'> {
  machine: RunMachine
  source: RunState
  command: ReturnType<typeof forkCommand>
  admittedStop: AdmittedStop | undefined
}

const stopCommand = () => ({ id: 'settle-source', action: 'cancel' as const, scope: { kind: 'audit' as const }, expectedRevision: 0, reason: 'synthetic native retirement' })
const forkCommand = (source: RunState, sourceDigest: string, releaseDigest: string, terminalFailure: ForkFixtureFailure) => {
  const command: StageForkCommand = { action: 'fork', id: 'change-reviewers', expectedRevision: terminalFailure ? 1 : 0,
    reason: 'Use the published replacement reviewers from the saved boundary', stageId: 'negative-review',
    source: { runId: source.runId, state: { generation: source.stateGeneration, digest: sourceDigest } },
    releaseDigest, runtimeRelease: target }
  return command
}

export async function completedForkFixture(registerClose: (close: () => void) => void, terminalFailure: ForkFixtureFailure = false, environmentImage?: string) {
  return attachForkHelpers(await buildForkFixture(registerClose, terminalFailure, environmentImage))
}

async function buildForkFixture(registerClose: (close: () => void) => void, terminalFailure: ForkFixtureFailure, environmentImage?: string): Promise<ForkFixtureParts> {
  const f = await createExecutorSourceFixture(registerClose, false, environmentImage, 0)
  const stop = stopCommand()
  let admittedStop: AdmittedStop | undefined
  let persisted = f.source
  const machine = f.machine, artifacts = new R2ArtifactStore(f.bucket), provider = new DeterministicAuditProvider()
  if (terminalFailure === 'stopped') {
    while (machine.view().phase !== 'negative-review') await advanceExperimentOneWave({ machine,
      definition: machine.definition, artifactStore: artifacts, provider, policy: audit0RunPolicy })
    await f.store.putState(machine.view(), { generation: persisted.stateGeneration, digest: await sha256(persisted) })
    persisted = machine.snapshot()
    admittedStop = await f.journal.admit(stop, f.authority)
    admittedStop = await f.journal.beginEffect(stop.id, admittedStop.version, machine.snapshot())
    admittedStop = await f.journal.beginNativeEffect(stop.id, admittedStop.version, 'd'.repeat(64))
    await machine.cancelAudit(admittedStop, { inventoryDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64), physicalZeroVerified: true, claimsSettled: true })
  } else {
    await runExperiment({ machine, definition: machine.definition, artifactStore: artifacts, provider: terminalFailure === 'partial' ? { run: request => {
        if (request.task.id === 'negative-review-replica') throw new PermanentRunFailure('synthetic provider failure', 'integrity-failed')
        return provider.run(request)
      } } : provider,
      policy: terminalFailure === 'failed' ? { ...audit0RunPolicy, assessCompletion: () => ['synthetic completion defect'] } : audit0RunPolicy })
      .catch(error => { if (terminalFailure !== 'failed' && terminalFailure !== 'partial') throw error })
  }
  const source = machine.view()
  await f.store.putState(source, { generation: persisted.stateGeneration, digest: await sha256(persisted) })
  for (const checkpoint of source.checkpoints) await f.store.putCheckpoint(checkpoint)
  const config = structuredClone(manifest)
  config.modelPools.push({ ...config.modelPools.find(pool => pool.id === 'luna')!, id: 'second-reviewer', agents: 0 })
  config.stageModelPools['negative-review'] = ['luna', 'second-reviewer']
  const body = compileExperimentConfig(config)
  if (environmentImage !== undefined) body.environment = { image: environmentImage }
  const release = await f.store.putRelease(body)
  const { sqlite, onAfterRun, d1, bucket, objects, store, owners } = f
  return { sqlite, onAfterRun, d1, bucket, objects, store, release: f.release, authority: f.authority, owners,
    machine, source, admittedStop, command: forkCommand(source, await sha256(source), release.digest, terminalFailure) }
}

function attachForkHelpers(parts: ForkFixtureParts) {
  const { admittedStop, ...f } = parts, { machine, source, command } = f, auditId = source.rootRunId
  const artifacts = new R2ArtifactStore(f.bucket), stop = stopCommand()
  const journal = new RunCommandJournal(f.d1, auditId)
  const retire = async () => {
    const admitted = admittedStop ?? await journal.admit(stop, source.executionAuthority!)
    let operation = admittedStop ?? await journal.beginEffect(stop.id, admitted.version, source)
    if (operation.nativeEffect === undefined) operation = await journal.beginNativeEffect(stop.id, operation.version, 'd'.repeat(64))
    await f.owners.fence(source.executionAuthority!, operation.commandDigest)
    await f.owners.retire(source.executionAuthority!, 'e'.repeat(64))
    const original = NativeCommandEvidence.prototype.stop
    vi.spyOn(NativeCommandEvidence.prototype, 'stop').mockImplementation(async function (this: NativeCommandEvidence, ...args) {
      if (args[0] !== auditId || args[1] !== stop.id) return original.apply(this, args)
      return { operation, source, proofDigest: 'e'.repeat(64), physicalZeroVerified: true, claimsSettled: true } as Awaited<ReturnType<typeof original>>
    })
    return { authority: source.executionAuthority!, commandDigest: operation.commandDigest, proofDigest: 'e'.repeat(64) }
  }
  // Fixture-owned source version; production uses its pinned runtime service.
  const admit = f.store.admitStageFork.bind(f.store)
  f.store.admitStageFork = (...args) => admit(args[0], args[1], args[2], args[3], args[4],
    args[5] ?? (command => f.store.exportStageFork(command, source.runtimeRelease!)))
  const loadState = f.store.executionSources(), loadRelease = f.store.getRelease.bind(f.store)
  return { ...f, machine, artifacts, source, auditId, command, journal, loadState, loadRelease, retire,
    admit: (value = command, at?: string) => f.store.admitStageFork(auditId, value, at),
    publication: (id: string) => Object.fromEntries(['audit_execution_authority', 'experiment_runs', 'run_runtime_routes', 'runtime_slot_run_leases']
      .map(table => [table, Number(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${table === 'audit_execution_authority' ? 'execution_id' : 'run_id'} = ?`).get(id)!.n)])),
  }
}

/** A built audit as data: database content, bucket objects and the values the build returned.
 * Tests never see it; each gets its own restored copy. */
interface ForkFixtureSnapshot {
  readonly terminalFailure: ForkFixtureFailure
  readonly database: SqliteContent
  readonly objects: ExecutorFixture['objects']
  readonly release: ExecutorFixture['release']
  readonly authority: ExecutorFixture['authority']
  readonly source: RunState
  readonly sourceDigest: string
  readonly releaseDigest: string
  readonly admittedStop: AdmittedStop | undefined
}

/** Build once and capture; the first restore must equal the build it came from. */
async function snapshotForkFixture(terminalFailure: ForkFixtureFailure, environmentImage?: string): Promise<ForkFixtureSnapshot> {
  const closes: (() => void)[] = []
  try {
    const built = await buildForkFixture(close => closes.push(close), terminalFailure, environmentImage)
    const snapshot: ForkFixtureSnapshot = { terminalFailure, database: sqliteContent(built.sqlite), objects: structuredClone(built.objects),
      release: structuredClone(built.release), authority: structuredClone(built.authority), source: built.source,
      sourceDigest: built.command.source.state.digest, releaseDigest: built.command.releaseDigest,
      admittedStop: structuredClone(built.admittedStop) }
    const copy = await restoreForkParts(snapshot, close => closes.push(close))
    expect(sqliteContent(copy.sqlite)).toStrictEqual(sqliteContent(built.sqlite))
    const values = ({ objects, release, authority, machine, source, command, admittedStop }: ForkFixtureParts) =>
      ({ objects, release, authority, machine, source, command, admittedStop })
    expect(values(copy)).toStrictEqual(values(built))
    expect(referenceShape(values(copy))).toStrictEqual(referenceShape(values(built)))
    return snapshot
  } finally { closes.splice(0).forEach(close => close()) }
}

async function restoreForkParts(snapshot: ForkFixtureSnapshot, registerClose: (close: () => void) => void): Promise<ForkFixtureParts> {
  const db = sqliteD1(restoreSqlite(snapshot.database)); registerClose(() => db.sqlite.close())
  const { objects, bucket } = memoryR2()
  for (const [key, object] of structuredClone(snapshot.objects)) objects.set(key, object)
  const store = new CloudflareRunStore(bucket, bucket, db.d1)
  // The build's database already ran the routing schema through this call, which marks it ready
  // for later calls; on the restored copy it creates nothing (checked against the build above).
  await store.ensureRoutingSchema()
  const release = structuredClone(snapshot.release), authority = structuredClone(snapshot.authority)
  // The machine reloads its state through the production path, from the restored selected copy.
  const machine = await RunMachine.fromState(release.body.definition, snapshot.source, digest => store.getRelease(digest), store.executionSources())
  const source = machine.view()
  return { ...db, bucket, objects, store, release, authority, owners: new ExecutionAuthorityStore(db.d1), machine, source,
    admittedStop: structuredClone(snapshot.admittedStop),
    command: forkCommand(source, snapshot.sourceDigest, snapshot.releaseDigest, snapshot.terminalFailure) }
}

/** Build each fixture variant once per test file and give every test its own exact copy:
 * a new database, bucket, store and machine restored from the snapshot. Call `prepare` in
 * `beforeAll`, so no test's mocks or clock reach a build. */
export function forkFixtures() {
  const snapshots = new Map<string, Promise<ForkFixtureSnapshot>>()
  const key = (terminalFailure: ForkFixtureFailure, environmentImage?: string) => canonicalJson([terminalFailure, environmentImage ?? null])
  return {
    async prepare(...variants: [ForkFixtureFailure, string?][]) {
      for (const [terminalFailure, environmentImage] of variants) {
        if (!snapshots.has(key(terminalFailure, environmentImage))) {
          const built = snapshotForkFixture(terminalFailure, environmentImage)
          snapshots.set(key(terminalFailure, environmentImage), built)
          await built
        }
      }
    },
    async restore(registerClose: (close: () => void) => void, terminalFailure: ForkFixtureFailure = false, environmentImage?: string) {
      const snapshot = snapshots.get(key(terminalFailure, environmentImage))
      if (snapshot === undefined) throw new Error('fixture variant was not prepared before the tests')
      return attachForkHelpers(await restoreForkParts(await snapshot, registerClose))
    },
  }
}

/** What a fork fixture holds, copied: database content, bucket objects, machine state and values. */
export function forkFixtureContent(f: Awaited<ReturnType<typeof completedForkFixture>>) {
  return structuredClone({ database: sqliteContent(f.sqlite), objects: f.objects, state: f.machine.snapshot(), source: f.source,
    command: f.command, release: f.release, authority: f.authority })
}
