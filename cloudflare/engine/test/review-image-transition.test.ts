import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import type { FailedWaveRecoveryEvidence, ReleasePackageBody, RuntimeRelease } from '../src/contracts.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import { canonicalJson } from '../src/canonical.js'
import { sameRuntimeRelease } from '../src/runtime-release.js'
import { PermanentRunFailure } from '../src/run-errors.js'

const original: RuntimeRelease = { schemaVersion: 1, id: 'old', frameworkCommit: 'a'.repeat(40),
  workerService: 'old', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'old', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const target: RuntimeRelease = { ...original, id: 'new', frameworkCommit: 'b'.repeat(40),
  workerService: 'new', workerVersionId: '22222222-2222-4222-8222-222222222222',
  workflowName: 'new', containerImageDigest: `sha256:${'b'.repeat(64)}` }
const evidence: FailedWaveRecoveryEvidence = {
  sourceRunId: 'source', sourceStateGeneration: 9, sourceStateDigest: 'c'.repeat(64),
  checkpointDigest: 'd'.repeat(64), importedTaskIds: ['primary'], inheritedRejectedAttemptCount: 3,
  unknownUsageAttemptCount: 2, sourceRuntimeRelease: original, targetRuntimeRelease: target,
  quarantinedRepair: { kind: 'negative-review', stageId: 'negative-review', waveId: 'review', taskId: 'replica',
    sourceAttempt: 1, requestDigest: 'e'.repeat(64), promptDigest: 'f'.repeat(64), outputDigest: '1'.repeat(64),
    quarantineUri: 'r2://ARTIFACTS/quarantine/review', diagnostics: ['missing finalReference'] },
}
const release = { digest: '2'.repeat(64), body: {
  definition: { id: 'audit', target: { runtime: { environmentBindings: {} } } },
  environment: { image: `registry.cloudflare.com/${'3'.repeat(32)}/swarm-sandbox@${original.containerImageDigest}` },
} as ReleasePackageBody }
const body = { experimentId: 'audit', childRunId: 'child', sourceRunId: 'source', sourceStateGeneration: 9,
  sourceStateDigest: evidence.sourceStateDigest, checkpointDigest: evidence.checkpointDigest,
  runtimeId: target.id, runtimeRelease: target,
  repairQuarantined: { taskId: 'replica', requestDigest: 'e'.repeat(64), outputDigest: '1'.repeat(64) } }
const withoutRepair = structuredClone(evidence)
delete withoutRepair.quarantinedRepair
const historicalRepair = structuredClone(evidence)
delete historicalRepair.quarantinedRepair!.kind
const pattern = /^[a-z0-9][a-z0-9._-]{0,99}$/
function extract(file: string, start: string, end: string) {
  const s = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
  const raw = s.slice(s.indexOf(start), s.indexOf(end, s.indexOf(start)))
  if (!start.includes('private async')) return stripTypeScriptTypes(raw)
  const code = stripTypeScriptTypes(`class Fixture { ${raw} }`)
  return code.slice(code.indexOf('{') + 1, code.lastIndexOf('}'))
}
function boundaries() {
  let verified = structuredClone(evidence), retired = true, existing = false, reserved = false
  const source = { experimentId: 'audit', runId: 'source', inFlightAgentAttempts: [] }
  const checkpoint = { digest: evidence.checkpointDigest, body: { experimentId: 'audit', releaseDigest: release.digest } }
  const prepare = vi.fn(async () => ({ evidence: verified, importedArtifacts: [], inheritedRejectedAttempts: [] }))
  const admit = vi.fn(async () => ({ admitted: true }))
  const reconstruct = vi.fn(async () => ({ reconstructed: true }))
  class Store {
    async retiredUnmaterializedRoute() { return null }
    async retiredRunWorkflow() { return retired ? { retired: true } : null }
    async getState() { return source }
    async getCheckpoint() { return checkpoint }
    async getRelease() { return release }
    async runRuntime() { return target }
    async getStateIfPresent() { return existing ? { failedWaveRecovery: verified } : null }
    async reserveRunRoute() { throw new Error('validated before route') }
  }
  const response = (_env: unknown, value: unknown, status = 200) => Response.json(value, { status })
  const bindings: Record<string, unknown> = {
    assertReleaseEnvironmentMatchesRuntime, sameRuntimeRelease, canonicalJson, PermanentRunFailure,
    CloudflareRunStore: Store, RuntimeRouter: class {},
    resolveRuntimeSelector: async () => target, assertLocalRuntime: () => target,
    engineRole: () => 'front-door', runIdPattern: pattern, digestPattern: /^[0-9a-f]{64}$/,
    prepareFailedWaveRecovery: prepare, assertIndependentDiscoveryFrontier: () => {},
    resolveTargetEnvironment: () => {}, assertReleaseProviderCredentials: async () => {},
    R2ArtifactStore: class {}, R2AgentExecutionReceiptStore: class {}, R2AgentExecutionLogStore: class {},
    RunMachine: { recoverFailedWave: admit, fromState: reconstruct }, response,
    ensureAuditWorkflow: async () => ({ id: 'child', reused: false }), placement: () => undefined,
    json: (value: unknown, status = 200) => Response.json(value, { status }),
    reservation: () => reserved ? { provenance: { mode: 'recover-failed-wave', runtimeRelease: target,
      failedWaveRecovery: verified } } : undefined,
  }
  const coordinatorCode = extract('worker.ts', '  private async recoverFailedWave(', '  private async retireUnmaterializedRecovery(')
  const C = new Function(...Object.keys(bindings), `return class { env = {}; ctx = {};
    async reservationFor() { return reservation() }
    async reserveRunId() { throw new Error('validated before reservation') }
    ${coordinatorCode}
  }`)(...Object.values(bindings))
  const runtimeCode = extract('runtime-service.ts', 'async function createAuditFailedWaveRecovery(', 'async function createAuditTerminalCompletionRecovery(')
  const runtime = new Function(...Object.keys(bindings), `${runtimeCode}; return createAuditFailedWaveRecovery;`)(...Object.values(bindings))
  const bootstrapCode = extract('worker.ts', '  private async bootstrap(', '  private async runOneWave(')
  const W = new Function(...Object.keys(bindings), `return class { env = {}; ${bootstrapCode} assertBootstrapIdentity() {} }`)(...Object.values(bindings))
  return { prepare, admit, reconstruct,
    setEvidence: (value: FailedWaveRecoveryEvidence) => { verified = value },
    setRetired: (value: boolean) => { retired = value },
    setExisting: () => { existing = true }, setReserved: () => { reserved = true },
    frontdoor: (input = body) => new C().recoverFailedWave({ json: async () => input }, 'audit'),
    runtime: (input = body) => runtime({ json: async () => input }, {}),
    bootstrap: (mode = 'recover-failed-wave') => new W().bootstrap({ mode, runId: 'child', experimentId: 'audit',
      checkpointDigest: evidence.checkpointDigest, runtimeRelease: target, failedWaveRecovery: evidence }, new Store()),
  }
}

it('keeps ordinary image pins strict and binds every target identity field for verified review repair', () => {
  expect(() => assertReleaseEnvironmentMatchesRuntime(release.body, target)).toThrow('image does not match')
  expect(() => assertReleaseEnvironmentMatchesRuntime(release.body, target, evidence)).not.toThrow()
  for (const field of Object.keys(target) as (keyof RuntimeRelease)[]) {
    const changed = { ...target, [field]: field === 'schemaVersion' ? 2 : 'different' } as RuntimeRelease
    expect(() => assertReleaseEnvironmentMatchesRuntime(release.body, changed, evidence)).toThrow('image does not match')
  }
  for (const changed of [
    withoutRepair,
    historicalRepair,
    { ...evidence, sourceRuntimeRelease: target },
    { ...evidence, retainedNative: {} as NonNullable<FailedWaveRecoveryEvidence['retainedNative']> },
    { ...evidence, promotedExecution: {} as NonNullable<FailedWaveRecoveryEvidence['promotedExecution']> },
    { ...evidence, unobservableNative: {} as NonNullable<FailedWaveRecoveryEvidence['unobservableNative']> },
  ]) expect(() => assertReleaseEnvironmentMatchesRuntime(release.body, target, changed)).toThrow('image does not match')
})

it('checks the sealed environment at frontdoor, runtime and bootstrap after custody preparation', async () => {
  const b = boundaries()
  await expect(b.frontdoor()).rejects.toThrow('validated before reservation')
  expect(b.prepare).toHaveBeenCalledOnce()
  expect(b.admit).toHaveBeenCalledOnce()
  expect((await b.runtime()).status).toBe(202)
  await expect(b.bootstrap()).resolves.toEqual({ admitted: true })
  expect(b.prepare).toHaveBeenCalledTimes(3)
  b.setReserved()
  await expect(b.frontdoor()).rejects.toThrow('validated before route')
  expect(b.prepare).toHaveBeenCalledTimes(3)
  b.setExisting()
  await expect(b.bootstrap()).resolves.toEqual({ reconstructed: true })
  expect(b.reconstruct).toHaveBeenCalledOnce()
  await expect(b.bootstrap('resume')).rejects.toThrow('image does not match')
})

it('refuses a requested exception without verified evidence or source retirement before admission', async () => {
  const b = boundaries()
  b.setRetired(false)
  await expect(b.frontdoor()).rejects.toThrow('retired')
  expect((await b.runtime()).status).toBe(409)
  await expect(b.bootstrap()).rejects.toThrow('retirement missing')
  expect(b.prepare).not.toHaveBeenCalled()
  b.setRetired(true)
  b.setEvidence(withoutRepair)
  await expect(b.frontdoor()).rejects.toThrow('image does not match')
  await expect(b.runtime()).rejects.toThrow('image does not match')
  await expect(b.bootstrap()).rejects.toThrow('evidence changed before bootstrap')
  expect(b.admit).not.toHaveBeenCalled()
  b.setReserved()
  await expect(b.frontdoor()).rejects.toThrow('image does not match')
  b.setExisting()
  await expect(b.bootstrap()).rejects.toThrow('image does not match')
})
