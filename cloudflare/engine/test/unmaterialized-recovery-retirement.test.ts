import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { assertUnmaterializedRecoveryRetirementProof,
  type UnmaterializedRecoveryRetirementProof } from '../src/unmaterialized-recovery-retirement.js'
import type { RuntimeRelease } from '../src/contracts.js'

it('keeps a refused recovery fenced across a partial archive and delayed exact retry', async () => {
  const text = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = text.indexOf('  private async retireUnmaterializedRecovery(')
  const end = text.indexOf('  private async recoverTerminalCompletion(', start)
  const claimStart = text.indexOf('  private async claimRecoveryDispatch(')
  const claimEnd = text.indexOf('  private async reserveRunId(', claimStart)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(claimStart).toBeGreaterThan(end)
  expect(claimEnd).toBeGreaterThan(claimStart)
  const code = stripTypeScriptTypes(`class Extracted {\n${text.slice(start, end)}\n${text.slice(claimStart, claimEnd)}\n}`)
  const runtimeRelease: RuntimeRelease = { schemaVersion: 1, id: 'runtime-a',
    frameworkCommit: 'a'.repeat(40), workerService: 'swarm-runtime-a',
    workerVersionId: '11111111-1111-4111-8111-111111111111',
    workflowName: 'ack3-audit-runtime-a', containerImageDigest: `sha256:${'b'.repeat(64)}` }
  const observedAt = new Date().toISOString()
  const proof: UnmaterializedRecoveryRetirementProof = {
    schemaVersion: 1, kind: 'retired-unmaterialized-route', runId: 'refused-child',
    experimentId: 'audit-test', runtimeRelease, sourceRunId: 'source',
    sourceStateDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64),
    reservationRequestDigest: 'e'.repeat(64),
    routeReservedAt: observedAt, leaseAdmittedAt: observedAt,
    auditWorkflowStatus: 'instance-not-found', isolationWorkflowStatus: 'instance-not-found',
    auditWorkflowReceiptDigest: 'f'.repeat(64),
    isolationWorkflowReceiptDigest: '1'.repeat(64),
    containerInventoryDigest: '2'.repeat(64), containerInstanceCount: 0,
    containerInventoryComplete: true, observedAt,
  }
  const proofDigest = await sha256(canonicalJson(proof))
  const reservation = { requestDigest: proof.reservationRequestDigest,
    provenance: { mode: 'recover-failed-wave', runtimeRelease,
      checkpointDigest: proof.checkpointDigest,
      failedWaveRecovery: { sourceRunId: proof.sourceRunId,
        sourceStateDigest: proof.sourceStateDigest } } }
  const values = new Map<string, unknown>([[`run-reservation:${proof.runId}`, reservation]])
  const storage = {
    get: async (key: string) => values.get(key),
    transaction: async (action: (tx: unknown) => Promise<unknown>) => action({
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value) },
    }),
  }
  let archiveCalls = 0
  const Handler = new Function('engineRole', 'assertUnmaterializedRecoveryRetirementProof',
    'sameRuntimeRelease', 'sha256', 'canonicalJson', 'CloudflareRunStore', 'json', 'storage',
    `${code}; return class extends Extracted { env = { ENGINE_ROLE: 'front-door' }; ctx = { storage }; }`,
  )(
    () => 'front-door', assertUnmaterializedRecoveryRetirementProof,
    (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b), sha256, canonicalJson,
    class { async archiveUnmaterializedRecoveryAndReleaseLease() {
      archiveCalls += 1
      if (archiveCalls === 1) throw new Error('synthetic R2 write interruption')
      return proofDigest
    } },
    (value: unknown) => value, storage,
  ) as new () => {
    ctx: { storage: typeof storage }
    retireUnmaterializedRecovery(request: { json(): Promise<unknown> }, experimentId: string): Promise<unknown>
    claimRecoveryDispatch(runId: string, requestDigest: string): Promise<void>
    markRecoveryDispatchRefused(runId: string, status: number): Promise<void>
  }
  const instance = new Handler()
  instance.ctx.storage = storage
  const request = { json: async () => proof }
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date(observedAt))
    await expect(instance.retireUnmaterializedRecovery(request, proof.experimentId))
      .rejects.toThrow('synthetic R2 write interruption')
    expect(values.get(`run-reservation:${proof.runId}`))
      .toMatchObject({ retirementProofDigest: proofDigest })
    await expect(instance.claimRecoveryDispatch(proof.runId, proof.reservationRequestDigest))
      .rejects.toThrow('already claimed or archived')
    vi.setSystemTime(new Date(Date.parse(observedAt) + 180_000))
    await expect(instance.retireUnmaterializedRecovery(request, proof.experimentId))
      .resolves.toEqual({ runId: proof.runId, retired: true, proofDigest })
    expect(archiveCalls).toBe(2)
    await expect(instance.retireUnmaterializedRecovery({ json: async () => ({
      ...proof, containerInventoryDigest: '3'.repeat(64),
    }) }, proof.experimentId)).rejects.toThrow('different proof')

    values.set(`run-reservation:${proof.runId}`, reservation)
    vi.setSystemTime(new Date(observedAt))
    await instance.claimRecoveryDispatch(proof.runId, proof.reservationRequestDigest)
    expect(values.get(`run-reservation:${proof.runId}`)).toMatchObject({ dispatchInProgress: true })
    await expect(instance.retireUnmaterializedRecovery(request, proof.experimentId))
      .rejects.toThrow('changed or was dispatched')
    await instance.markRecoveryDispatchRefused(proof.runId, 409)
    expect(values.get(`run-reservation:${proof.runId}`)).toMatchObject({ dispatchRefusedStatus: 409 })
    await expect(instance.claimRecoveryDispatch(proof.runId, proof.reservationRequestDigest))
      .rejects.toThrow('already claimed or archived')
    await expect(instance.retireUnmaterializedRecovery(request, proof.experimentId))
      .resolves.toEqual({ runId: proof.runId, retired: true, proofDigest })
  } finally {
    vi.useRealTimers()
  }
})

it('reconciles an already-created Workflow after a lost dispatch response without another create', async () => {
  const text = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = text.indexOf('  private async recoverFailedWave(')
  const end = text.indexOf('  private async retireUnmaterializedRecovery(', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const code = stripTypeScriptTypes(`class Extracted {\n${text.slice(start, end)}\n}`)
  const runtimeRelease: RuntimeRelease = { schemaVersion: 1, id: 'runtime-a',
    frameworkCommit: 'a'.repeat(40), workerService: 'swarm-runtime-a',
    workerVersionId: '11111111-1111-4111-8111-111111111111',
    workflowName: 'ack3-audit-runtime-a', containerImageDigest: `sha256:${'b'.repeat(64)}` }
  const recovery = { sourceRunId: 'source', sourceStateGeneration: 9,
    sourceStateDigest: 'c'.repeat(64), checkpointDigest: 'd'.repeat(64),
    targetRuntimeRelease: runtimeRelease }
  const reservation = { requestDigest: 'e'.repeat(64), dispatchInProgress: true,
    provenance: { mode: 'recover-failed-wave', runtimeRelease,
      checkpointDigest: recovery.checkpointDigest, failedWaveRecovery: recovery } }
  let nativePresent = true, proxyFailure = false, dispatched = 0, refused = 0
  let networkCalls: Array<{ method: string, path: string }> = []
  const NativeRouter = class {
    async fetch(_release: RuntimeRelease, path: string, init?: { method?: string }) {
      networkCalls.push({ method: init?.method ?? 'GET', path })
      if (proxyFailure && init?.method === 'POST') {
        return { ok: false, status: 502, headers: { get: () => null },
          json: async () => ({ error: 'upstream response lost' }) }
      }
      return { ok: nativePresent, status: nativePresent ? 200 : 409,
        json: async () => nativePresent
          ? { runId: 'child', runtimeRelease, workflow: { status: 'running' } }
          : { error: 'instance.not_found' } }
    }
  }
  const Handler = new Function('engineRole', 'runIdPattern', 'digestPattern',
    'CloudflareRunStore', 'RuntimeRouter', 'sameRuntimeRelease',
    'runtimeResponseBody', 'assertReleaseEnvironmentMatchesRuntime',
    'canonicalJson', 'json', 'performance', 'reservation', 'onDispatched', 'onRefused',
    `${code}; return class extends Extracted { env = { ENGINE_ROLE: 'front-door' };
      reservationFor = async () => reservation;
      markRunDispatched = async () => { onDispatched() };
      claimRecoveryDispatch = async () => { reservation.dispatchInProgress = true };
      markRecoveryDispatchRefused = async () => { onRefused() };
    }`,
  )(
    () => 'front-door', /^[a-z0-9][a-z0-9._-]{0,99}$/, /^[a-f0-9]{64}$/,
    class {
      async retiredUnmaterializedRoute() { return null }
      async getCheckpoint() { return { body: { releaseDigest: 'release' } } }
      async getRelease() { return { body: { definition: { id: 'audit-test' } } } }
      async reserveRunRoute() { return undefined }
      async getStateIfPresent() { return null }
    },
    NativeRouter, (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
    async (reply: { ok: boolean, json(): Promise<unknown> }) => {
      const value = await reply.json()
      if (!reply.ok) throw new Error('native Workflow is absent')
      return value
    },
    () => undefined, canonicalJson, (value: unknown, status: number) => ({ value, status }),
    performance, reservation, () => { dispatched += 1 }, () => { refused += 1 },
  ) as new () => {
    recoverFailedWave(request: { json(): Promise<unknown> }, experimentId: string): Promise<unknown>
  }
  const handler = new Handler()
  const request = { json: async () => ({ childRunId: 'child', sourceRunId: 'source',
    sourceStateGeneration: 9, sourceStateDigest: recovery.sourceStateDigest,
    checkpointDigest: recovery.checkpointDigest, runtimeId: runtimeRelease.id }) }
  await expect(handler.recoverFailedWave(request, 'audit-test'))
    .resolves.toMatchObject({ status: 202, value: { workflowInstanceId: 'child',
      reconciledExistingWorkflow: true } })
  expect(dispatched).toBe(1)
  expect(networkCalls).toEqual([{ method: 'GET', path: '/internal/runtime/audit-workflows/child' }])

  nativePresent = false
  dispatched = 0
  networkCalls = []
  await expect(handler.recoverFailedWave(request, 'audit-test'))
    .rejects.toThrow('native Workflow is absent')
  expect(dispatched).toBe(0)
  expect(networkCalls).toEqual([{ method: 'GET', path: '/internal/runtime/audit-workflows/child' }])

  reservation.dispatchInProgress = false
  nativePresent = true
  proxyFailure = true
  networkCalls = []
  await expect(handler.recoverFailedWave(request, 'audit-test'))
    .rejects.toThrow('native Workflow is absent')
  expect(reservation.dispatchInProgress).toBe(true)
  expect(refused).toBe(0)
  proxyFailure = false
  await expect(handler.recoverFailedWave(request, 'audit-test'))
    .resolves.toMatchObject({ status: 202, value: { reconciledExistingWorkflow: true } })
  expect(networkCalls).toEqual([
    { method: 'POST', path: '/internal/runtime/audit-recoveries' },
    { method: 'GET', path: '/internal/runtime/audit-workflows/child' },
  ])
  expect(refused).toBe(0)
})
