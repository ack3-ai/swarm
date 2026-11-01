import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it } from 'vitest'

it('passes quarantine custody to the destination runtime before recovering a rejected output', async () => {
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const start = source.indexOf('async function createAuditFailedWaveRecovery(')
  const end = source.indexOf('async function createAuditTerminalCompletionRecovery(', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)

  const code = stripTypeScriptTypes(source.slice(start, end))
  class ArtifactStore { constructor(readonly bucket: unknown) {} }
  class ReceiptStore { constructor(readonly bucket: unknown) {} }
  class RequestStore { constructor(readonly bucket: unknown) {} }
  const artifactBucket = {}, runtimeRelease = { id: 'runtime-test' }
  const calls: unknown[] = []
  const lost = { stageId: 'discovery', waveId: 'wave-3', taskId: 'core-wave-3-research-1',
    attempt: 1, promptDigest: 'e'.repeat(64), requestDigest: 'f'.repeat(64), fenceProofDigest: 'a'.repeat(64) }
  let inFlight = false
  let retired = true
  const handler = new Function(
    'assertLocalRuntime', 'sameRuntimeRelease', 'CloudflareRunStore', 'assertReleaseEnvironmentMatchesRuntime',
    'assertIndependentDiscoveryFrontier', 'resolveTargetEnvironment', 'assertReleaseProviderCredentials',
    'prepareFailedWaveRecovery',
    'R2ArtifactStore', 'R2AgentExecutionReceiptStore', 'R2AgentExecutionLogStore',
    'runIdPattern', 'response',
    `${code}; return createAuditFailedWaveRecovery;`,
  )(
    () => runtimeRelease, (left: unknown, right: unknown) => left === right,
    class {
      async retiredUnmaterializedRoute() { return null }
      async retiredRunWorkflow() { return retired ? { status: 'errored' } : null }
      async runRuntime() { return runtimeRelease }
      async getState() { return { experimentId: 'audit-test',
        ...(inFlight ? { inFlightAgentAttempts: [{}] } : {}) } }
      async fencedUnobservableNativeEvidence() { return lost }
      async getCheckpoint() { return { body: { experimentId: 'audit-test', releaseDigest: 'release' } } }
      async getRelease() { return { body: { definition: { id: 'audit-test', target: { runtime: { environmentBindings: {} } } } } } }
    },
    () => undefined, () => undefined, () => undefined, () => undefined,
    async (input: Record<string, unknown>) => {
      calls.push(input)
      throw new Error('recovery input inspected')
    },
    ArtifactStore, ReceiptStore, RequestStore,
    /^[a-z0-9][a-z0-9._-]{0,99}$/,
    (_env: unknown, value: unknown, status: number) => ({ value, status }),
  ) as (request: { json(): Promise<unknown> }, env: unknown) => Promise<unknown>

  const promotion = {
    taskId: 'additive-wave-3-research-1', sourceAttempt: 2,
    requestDigest: 'a'.repeat(64), quarantineOutputDigest: 'b'.repeat(64),
  }
  const body = {
    experimentId: 'audit-test', childRunId: 'child', sourceRunId: 'source',
    sourceStateGeneration: 124, sourceStateDigest: 'c'.repeat(64),
    checkpointDigest: 'd'.repeat(64), runtimeRelease, promoteExecution: promotion,
  }
  await expect(handler({ json: async () => ({ ...body,
    promoteExecution: { ...promotion, quarantineOutputDigest: 'short' },
  }) }, { ARTIFACTS: artifactBucket })).resolves.toMatchObject({ status: 400 })
  expect(calls).toHaveLength(0)
  await expect(handler({ json: async () => body }, { ARTIFACTS: artifactBucket }))
    .rejects.toThrow('recovery input inspected')

  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ promoteExecution: promotion })
  const input = calls[0] as Record<string, unknown>
  expect(input.artifacts).toBeInstanceOf(ArtifactStore)
  expect(input.quarantined).toBeInstanceOf(ArtifactStore)
  expect(input.executionReceipts).toBeInstanceOf(ReceiptStore)
  expect(input.executionRequests).toBeInstanceOf(RequestStore)
  expect((input.quarantined as ArtifactStore).bucket).toBe(artifactBucket)
  inFlight = true
  await expect(handler({ json: async () => ({ ...body, promoteExecution: undefined }) },
    { ARTIFACTS: artifactBucket })).rejects.toThrow('recovery input inspected')
  expect(calls[1]).toMatchObject({ unobservableNative: lost })
  inFlight = false
  const repairQuarantined = { taskId: 'synthesizer', requestDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64) }
  const repairBody = { ...body, promoteExecution: undefined, repairQuarantined }
  retired = false
  await expect(handler({ json: async () => repairBody }, { ARTIFACTS: artifactBucket }))
    .resolves.toMatchObject({ status: 409 })
  retired = true
  await expect(handler({ json: async () => repairBody }, { ARTIFACTS: artifactBucket }))
    .rejects.toThrow('recovery input inspected')
  expect(calls[2]).toMatchObject({ repairQuarantined })
  const repairInput = calls[2] as Record<string, unknown>
  expect(repairInput.quarantined).toBeInstanceOf(ArtifactStore)
  expect(repairInput.executionReceipts).toBeInstanceOf(ReceiptStore)
  expect(repairInput.executionRequests).toBeInstanceOf(RequestStore)
})
