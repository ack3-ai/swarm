import { R2AgentExecutionLogStore } from '../src/agent-execution-log.js'
import { R2AgentExecutionReceiptStore } from '../src/agent-execution-receipt.js'
import { providerIdentity } from '../src/provider-identity.js'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { CloudflareRunStore, R2ArtifactStore } from '../src/cloudflare-storage.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave, createAudit0RunPolicy } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { sealReleasePackage } from '../src/release.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
import { prepareDiscoveryPoolWaiver, waiverManifest } from '../src/discovery-pool-waiver.js'
import type { AgentRequest, RunState, RuntimeRelease } from '../src/contracts.js'
import type { StoppedRunRetirementProof } from '../src/stopped-run-retirement.js'

const runtime: RuntimeRelease = { schemaVersion: 1, id: 'runtime-source', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-source', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-source', containerImageDigest: `sha256:${'a'.repeat(64)}` }
const targetRuntime = { ...runtime, id: 'runtime-target', frameworkCommit: 'b'.repeat(40),
  workerService: 'swarm-runtime-target', workerVersionId: '22222222-2222-4222-8222-222222222222', workflowName: 'audit-runtime-target' }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

async function fenceFor(source: RunState): Promise<StoppedRunRetirementProof> {
  return { schemaVersion: 1, kind: 'terminal-stopped-custody', runId: source.runId, experimentId: source.experimentId,
    runtimeRelease: runtime, stateKey: `runs/${source.runId}/states/exact.json`,
    stateGeneration: source.stateGeneration, stateDigest: await sha256(source), workflow: { status: 'terminated' },
    checkpointDigest: source.checkpoints.at(-1)!.digest,
    acceptedArtifactManifestDigest: await sha256(waiverManifest(source.artifacts.filter(a => a.status === 'accepted'))),
    sandboxNamespaceId: 'a'.repeat(32), containerApplicationId: '11111111-1111-4111-8111-111111111111',
    containerInventoryDigest: 'b'.repeat(64), activePhysicalCount: 0, assignedPhysicalCount: 0, startingPhysicalCount: 0,
    inactiveActorCount: 3, inventoryComplete: true, observedAt: source.updatedAt }
}

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const config: any = structuredClone(document)
  config.maxDiscoveryWaves = 4
  config.limits.maxCostUsd = 10_000
  config.limits.maxModelCalls = 10_000
  config.modelPools = [...config.modelPools.map((pool: any) => ({ ...pool, agents: 1 })), {
    id: 'retired', backend: 'claude', model: 'claude-fixture', reasoningEffort: 'max', agents: 1, required: true,
    credentialSource: 'CLAUDE_FIXTURE_OAUTH_TOKEN', subagents: { default: { mode: 'disabled' } },
  }]
  const release = await sealReleasePackage(compileExperimentConfig(config))
  const definition = release.body.definition
  const machine = await RunMachine.create(definition, release.digest, 'waiver-source', undefined, runtime)
  const artifacts = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, artifactStore: artifacts, provider: base })
  let releasePeers = false
  const provider = { async run(request: AgentRequest) {
    if (request.task.promptKind === 'research' && request.task.research!.wave >= 1
      && (!releasePeers || configuredResearchTaskPoolId(request.task) === 'retired')) throw new AgentExecutionPending('quota wait')
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition, machine, artifactStore: artifacts, provider })
  const beforeDrain = machine.snapshot()
  expect(beforeDrain.inFlightAgentAttempts).toHaveLength(3)
  vi.setSystemTime(new Date(discoveryDeadline(definition, beforeDrain) + 1_000))
  releasePeers = true
  await advanceExperimentOneWave({ definition, machine, artifactStore: artifacts, provider })
  expect(machine.snapshot().inFlightAgentAttempts).toHaveLength(1)
  await machine.stop('operator-requested-immediate-stop')
  const source = machine.snapshot(), checkpoint = source.checkpoints.at(-1)!
  const fence = await fenceFor(source)
  const input = { definition, source, checkpoint, fence, childRunId: 'waiver-child',
    sourceStateGeneration: source.stateGeneration, sourceStateDigest: await sha256(source),
    targetRuntimeRelease: targetRuntime, poolId: 'retired', requestDigest: 'c'.repeat(64), logCustodyDigest: 'd'.repeat(64),
    quotaWait: { provider: 'claude' as const, sessionId: 'fixture-session-001', window: 'seven_day',
      startedAt: source.updatedAt, resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
      rejectionDigest: 'e'.repeat(64), resultDigest: 'a'.repeat(64), waitDigest: 'f'.repeat(64), waitCapture: 'complete' as const } }
  return { ...input, input, artifacts, base, beforeDrain }
}

describe('post-deadline discovery pool waiver', () => {
  it('keeps every accepted byte/record and original clock, records unknown usage, then completes without replaying discovery', async () => {
    const f = await fixture()
    const evidence = await prepareDiscoveryPoolWaiver(f.input)
    const machine = await RunMachine.recoverDiscoveryPoolWaiver(f.definition, f.checkpoint, f.source, evidence, f.fence)
    const child = machine.snapshot()
    expect(child.artifacts).toEqual(f.source.artifacts)
    expect(child.rootRunId).toBe(f.source.rootRunId)
    expect(child.modelStartedAt).toBe(f.source.modelStartedAt)
    expect(child.parentRunId).toBe(f.source.runId)
    expect(child.cursor.stageIndex).toBe(f.source.cursor.stageIndex + 1)
    expect(child.discoveryScheduler?.admissions).toEqual([])
    expect(child.discoveryScheduler?.pools).toEqual(f.source.discoveryScheduler?.pools)
    expect(child.inFlightAgentAttempts).toEqual([])
    expect(child.rejectedAttempts.slice(0, -1)).toEqual(f.source.rejectedAttempts)
    expect(child.rejectedAttempts.at(-1)?.usage).toMatchObject({ modelCalls: 1, cacheAccountingComplete: false, costAccountingComplete: false })
    expect(child.budget.modelCalls).toBe(f.source.budget.modelCalls + 1)
    await expect(RunMachine.fromState(f.definition, child)).resolves.toBeDefined()
    const resume = await RunMachine.resume(f.definition, child.checkpoints.at(-1)!, 'waiver-resume', new Set(), undefined, undefined, targetRuntime)
    expect(resume.snapshot().stageEndReceipts.at(-1)?.evidence).toEqual(evidence)
    const paidTasks: string[] = []
    const outcome = await runExperiment({ definition: f.definition, machine, artifactStore: f.artifacts,
      policy: createAudit0RunPolicy(), provider: { async run(request) {
        expect(request.task.promptKind).not.toBe('research')
        expect(request.task.modelPool).not.toBe('retired')
        paidTasks.push(request.task.id)
        return f.base.run(request)
      } } })
    expect(outcome.state.status).toBe('completed')
    expect(paidTasks).toContain('negative-review-primary')
    expect(paidTasks).toContain('negative-review-replica')
    expect(outcome.state.artifacts.slice(0, f.source.artifacts.length)).toEqual(f.source.artifacts)
    await expect(RunMachine.resume(f.definition, outcome.checkpoints.at(-1)!, 'finished-resume', new Set(), undefined, undefined, targetRuntime)).resolves.toBeDefined()
  })

  it('retains partial native wait capture without inventing its missing timestamp', async () => {
    const f = await fixture()
    const input = { ...f.input, quotaWait: { ...f.quotaWait, startedAt: null, waitCapture: 'partial' as const } }
    const evidence = await prepareDiscoveryPoolWaiver(input)
    const machine = await RunMachine.recoverDiscoveryPoolWaiver(f.definition, f.checkpoint, f.source, evidence, f.fence)
    await expect(RunMachine.fromState(f.definition, machine.snapshot())).resolves.toBeDefined()
    expect((machine.snapshot().stageEndReceipts.at(-1)?.evidence as typeof evidence).quotaWait)
      .toMatchObject({ waitCapture: 'partial', startedAt: null })
  })

  it('rejects a live source, another admission, a stale fence, changed source, and premature deadline', async () => {
    const f = await fixture()
    await expect(prepareDiscoveryPoolWaiver({ ...f.input, source: f.beforeDrain })).rejects.toThrow()
    for (const patch of [
      { status: 'running' as const },
      { inFlightAgentAttempts: [...f.source.inFlightAgentAttempts!, f.source.inFlightAgentAttempts![0]!] },
      { updatedAt: new Date(discoveryDeadline(f.definition, f.source) - 1).toISOString() },
    ]) {
      const source = { ...f.source, ...patch }
      await expect(prepareDiscoveryPoolWaiver({ ...f.input, source, sourceStateDigest: await sha256(source), fence: await fenceFor(source) })).rejects.toThrow()
    }
    await expect(prepareDiscoveryPoolWaiver({ ...f.input, sourceStateDigest: '0'.repeat(64) })).rejects.toThrow()
    await expect(prepareDiscoveryPoolWaiver({ ...f.input, fence: { ...f.fence, stateDigest: '0'.repeat(64) } })).rejects.toThrow()
    await expect(prepareDiscoveryPoolWaiver({ ...f.input, targetRuntimeRelease: { ...targetRuntime, containerImageDigest: `sha256:${'b'.repeat(64)}` } })).rejects.toThrow()
  })

  it('cannot silently remove a downstream model or weaken its quorum', async () => {
    const f = await fixture()
    const definition = structuredClone(f.definition)
    definition.stages.find(s => s.kind === 'synthesis')!.waves[0]!.tasks[0]!.modelPool = 'retired'
    const source = { ...f.source, definitionDigest: await sha256(definition) }
    await expect(prepareDiscoveryPoolWaiver({ ...f.input, definition, source,
      sourceStateDigest: await sha256(source), fence: await fenceFor(source) })).rejects.toThrow('required downstream')
  })

  it('rejects forged acceptance, dropped exception accounting, and altered waiver evidence on restore', async () => {
    const f = await fixture(), evidence = await prepareDiscoveryPoolWaiver(f.input)
    const machine = await RunMachine.recoverDiscoveryPoolWaiver(f.definition, f.checkpoint, f.source, evidence, f.fence)
    const original = machine.snapshot().checkpoints.at(-1)!
    for (const mutate of [
      (b: any) => b.acceptedArtifacts.pop(),
      (b: any) => b.rejectedAttempts.pop(),
      (b: any) => b.stageEndReceipts.pop(),
      (b: any) => { b.stageEndReceipts.at(-1).evidence.poolId = 'luna' },
      (b: any) => { b.discoveryScheduler.pools.find((p: any) => p.poolId === 'retired').nextWaveIndex++ },
    ]) {
      const body = structuredClone(original.body); mutate(body)
      await expect(RunMachine.resume(f.definition, { body, digest: await sha256(body) }, 'forged-resume')).rejects.toThrow()
    }
    expect(canonicalJson(f.source.artifacts)).toBe(canonicalJson(machine.snapshot().artifacts))
  })
})


class ClaimBucket {
  readonly objects = new Map<string, { content: string, options: any }>()
  async put(key: string, content: string, options: any) {
    if (options.onlyIf?.etagDoesNotMatch === '*' && this.objects.has(key)) return null
    this.objects.set(key, { content, options }); return {}
  }
  async get(key: string) {
    const value = this.objects.get(key)
    return value === undefined ? null : { text: async () => value.content,
      customMetadata: value.options.customMetadata, checksums: { toJSON: () => ({ sha256: value.options.sha256 }) } }
  }
}

it('claims an exact source once across concurrent children and reconciles the identical retry', async () => {
  const f = await fixture(), evidence = await prepareDiscoveryPoolWaiver(f.input)
  const bucket = new ClaimBucket()
  const store = new CloudflareRunStore({} as R2Bucket, bucket as unknown as R2Bucket, {} as D1Database)
  await expect(store.claimDiscoveryWaiver(evidence)).rejects.toThrow('claim missing')
  const competing = { ...evidence, childRunId: 'competing-child' }
  const outcomes = await Promise.allSettled([
    store.claimDiscoveryWaiver(evidence, true),
    store.claimDiscoveryWaiver(competing, true),
  ])
  // Either concurrent child may win; exactly one claim succeeds.
  expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  const winner = outcomes[0]!.status === 'fulfilled' ? evidence : competing
  await expect(store.claimDiscoveryWaiver(winner, true)).resolves.toBeUndefined()
  await expect(store.claimDiscoveryWaiver(winner)).resolves.toBeUndefined()
  await expect(store.claimDiscoveryWaiver({ ...evidence, sourceStateDigest: '0'.repeat(64) }, true)).rejects.toThrow()
  expect(bucket.objects.size).toBe(1)
})

it('destination validates reservation, source fence, exclusive claim and child reconstruction before Workflow dispatch', async () => {
  const f = await fixture(), evidence = await prepareDiscoveryPoolWaiver(f.input)
  const code = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const snippet = code.slice(code.indexOf('async function createAuditDiscoveryWaiver('), code.indexOf('async function auditRunStatus('))
  const dispatched = vi.fn(async () => ({ id: 'waiver-child', reused: false }))
  const claimed = vi.fn(async () => {})
  let route: RuntimeRelease | null = targetRuntime
  let source = f.source
  const handler = new Function('runIdPattern', 'response', 'assertLocalRuntime', 'CloudflareRunStore',
    'sameRuntimeRelease', 'assertReleaseEnvironmentMatchesRuntime', 'resolveTargetEnvironment',
    'assertReleaseProviderCredentials', 'RunMachine', 'ensureAuditWorkflow', 'placement',
    `${stripTypeScriptTypes(snippet)}; return createAuditDiscoveryWaiver;`)(
    /^[a-z0-9][a-z0-9._-]{0,99}$/, (_env: unknown, body: unknown, status: number) => ({ body, status }),
    () => targetRuntime,
    class {
      async runRuntime() { return route }
      async prepareDiscoveryWaiver() { return { evidence, fence: f.fence } }
      async claimDiscoveryWaiver(value: unknown) { expect(value).toEqual(evidence); await claimed() }
      async getState() { return source }
      async getCheckpoint() { return f.checkpoint }
      async getRelease() { return { body: { definition: f.definition } } }
    }, (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b), () => {}, () => {}, async () => {},
    RunMachine, dispatched, () => ({}),
  ) as (request: { json(): Promise<unknown> }, env: unknown) => Promise<{ status: number }>
  const request = { json: async () => ({ experimentId: f.definition.id, childRunId: 'waiver-child',
    sourceRunId: f.source.runId, sourceStateGeneration: f.source.stateGeneration, sourceStateDigest: await sha256(f.source),
    checkpointDigest: f.checkpoint.digest, runtimeRelease: targetRuntime, poolId: 'retired', requestDigest: f.requestDigest }) }
  route = null
  expect((await handler(request, {})).status).toBe(409)
  expect(dispatched).not.toHaveBeenCalled()
  route = targetRuntime
  source = { ...f.source, stateGeneration: f.source.stateGeneration + 1 }
  await expect(handler(request, {})).rejects.toThrow()
  expect(dispatched).not.toHaveBeenCalled()
  source = f.source
  expect((await handler(request, {})).status).toBe(202)
  expect(dispatched).toHaveBeenCalledOnce()
})


it('storage preparation requires exact retired source, native request/log custody, no terminal receipt, and intact accepted bytes', async () => {
  const f = await fixture(), bucket = new ClaimBucket()
  const digest = await sha256(f.fence)
  await bucket.put(`runtime-retirements/sha256/${digest}.json`, canonicalJson(f.fence), {
    sha256: digest, customMetadata: { run: f.source.runId } })
  const store = new CloudflareRunStore({} as R2Bucket, bucket as unknown as R2Bucket, {} as D1Database)
  vi.spyOn(store, 'getState').mockResolvedValue(f.source)
  vi.spyOn(store, 'retiredRunWorkflow').mockResolvedValue({ disposition: 'retired-fenced', fenceProofDigest: digest,
    cleanupProofDigest: null, workflow: f.fence.workflow, retiredAt: f.source.updatedAt })
  vi.spyOn(store, 'getRelease').mockResolvedValue({ digest: f.source.releaseDigest,
    body: { definition: f.definition } } as any)
  vi.spyOn(store, 'getCheckpoint').mockResolvedValue(f.checkpoint)
  const attempt = f.source.inFlightAgentAttempts![0]!
  const task = f.definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks).find(t => t.id === attempt.taskId)!
  const nativeRequest = { runId: f.source.runId, taskId: attempt.taskId, stageId: attempt.stageId,
    waveId: attempt.waveId, attempt: attempt.attempt, promptDigest: attempt.promptDigest,
    model: task.model, provider: providerIdentity(task), startedAt: attempt.admittedAt }
  const request = vi.spyOn(R2AgentExecutionLogStore.prototype, 'getRequest').mockResolvedValue(nativeRequest as any)
  const snapshot = { requestDigest: 'e'.repeat(64), quotaWait: f.input.quotaWait,
    index: { complete: false, truncated: false }, chunkDigests: ['e'.repeat(64)] }
  vi.spyOn(R2AgentExecutionLogStore.prototype, 'custodySnapshot').mockResolvedValue(snapshot as any)
  vi.spyOn(R2AgentExecutionReceiptStore.prototype, 'getStart').mockResolvedValue({ acquired: false, claimedAt: attempt.admittedAt })
  const receipt = vi.spyOn(R2AgentExecutionReceiptStore.prototype, 'get').mockResolvedValue(null)
  const artifacts = vi.spyOn(R2ArtifactStore.prototype, 'read').mockResolvedValue({})
  const input = { sourceRunId: f.source.runId, childRunId: f.childRunId, sourceStateGeneration: f.sourceStateGeneration,
    sourceStateDigest: f.sourceStateDigest, checkpointDigest: f.checkpoint.digest,
    targetRuntimeRelease: targetRuntime, poolId: 'retired', requestDigest: f.requestDigest }
  const value = await store.prepareDiscoveryWaiver(input)
  expect(value.evidence.logCustodyDigest).toBe(await sha256(snapshot))
  expect(value.evidence.quotaWait).toEqual(f.input.quotaWait)
  expect(artifacts).toHaveBeenCalledTimes(f.source.artifacts.length)
  receipt.mockResolvedValue({} as any)
  await expect(store.prepareDiscoveryWaiver(input)).rejects.toThrow('terminal receipt')
  receipt.mockResolvedValue(null)
  request.mockResolvedValue({ ...nativeRequest, promptDigest: '0'.repeat(64) } as any)
  await expect(store.prepareDiscoveryWaiver(input)).rejects.toThrow('identity differs')
  request.mockResolvedValue(nativeRequest as any)
  artifacts.mockRejectedValue(new Error('checksum mismatch'))
  await expect(store.prepareDiscoveryWaiver(input)).rejects.toThrow('checksum mismatch')
  expect(bucket.objects.size).toBe(1) // Preparation cannot claim or mutate the source.
})
