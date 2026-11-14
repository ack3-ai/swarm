import { memoryR2 } from './memory-r2.js'
import { createControlledMachine } from './controlled-machine.js'
import { canonicalJson, sha256 } from '../../src/canonical.js'
import { CloudflareRunStore } from '../../src/cloudflare-storage.js'
import { ExecutionAuthorityStore } from '../../src/execution-authority.js'
import { RunCommandJournal } from '../../src/run-command-journal.js'
import { RunMachine } from '../../src/machine.js'
import type { RuntimeRelease } from '../../src/contracts.js'
import { audit0PackageBody } from './audit0-config.js'
import { sqliteD1 } from './sqlite-d1.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../../src/runner.js'
import { DeterministicAuditProvider } from './deterministic-audit-provider.js'
import { MemoryArtifactStore } from './memory-runner.js'

export const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-source', workflowName: 'runtime-source', containerImageDigest: `sha256:${'b'.repeat(64)}`,
  workerVersionId: '11111111-1111-4111-8111-111111111111' }
export const target: RuntimeRelease = { ...runtime, id: 'runtime-target', workerService: 'runtime-target', workflowName: 'runtime-target',
  frameworkCommit: 'c'.repeat(40), workerVersionId: '22222222-2222-4222-8222-222222222222' }
export const proof = { inventoryDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64), physicalZeroVerified: true as const, claimsSettled: true as const }
export async function createExecutorSourceFixture(registerClose: (close: () => void) => void, failed = false, environmentImage?: string, waves = 1, configure?: (body: typeof audit0PackageBody) => void) {
  const db = sqliteD1(); registerClose(() => db.sqlite.close())
  const { objects, bucket } = memoryR2()
  const store = new CloudflareRunStore(bucket, bucket, db.d1)
  await store.ensureSchema()
  const body = structuredClone(audit0PackageBody)
  configure?.(body)
  if (environmentImage !== undefined) body.environment = { image: environmentImage }
  const release = await store.putRelease(body)
  const authority = await store.activateRootExecution('replacement-audit', runtime, { test: 'root' })
  const machine = await createControlledMachine(release.body.definition, release.digest, authority.auditId, undefined, runtime, authority)
  await machine.start()
  for (let wave = 0; wave < waves; wave++) await advanceExperimentOneWave({ definition: release.body.definition, machine, provider: new DeterministicAuditProvider(),
    artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy })
  if (failed) await machine.fail('synthetic framework fault')
  const source = machine.view()
  await store.putState(source, null)
  const journal = new RunCommandJournal(db.d1, authority.auditId), owners = new ExecutionAuthorityStore(db.d1)
  const command = { id: 'replace-executor', expectedRevision: 0, reason: 'synthetic correction', action: 'restart' as const,
    scope: { kind: 'audit' as const }, session: 'fresh' as const, runtimeRelease: target }
  return { ...db, bucket, objects, store, release, authority, source, journal, owners, machine, command }
}
