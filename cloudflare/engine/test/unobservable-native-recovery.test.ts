import { expect, it, vi } from 'vitest'
import type { ArtifactRecord, RunState, RuntimeRelease } from '../src/contracts.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { R2AgentExecutionReceiptStore } from '../src/agent-execution-receipt.js'
import { assertFailedRunRetirementProof, type FailedRunRetirementProof } from '../src/failed-run-retirement.js'
import { recoveryPromptMatches } from '../src/failed-wave-recovery.js'
import { exactUnobservableAttempt } from '../src/unobservable-native-recovery.js'
import { composePrompt } from '../src/prompts.js'
import { audit0Definition } from './support/audit0-config.js'

const runtime: RuntimeRelease = {
  schemaVersion: 1,
  id: 'runtime-lost', frameworkCommit: 'a'.repeat(40),
  workerService: 'swarm-runtime-lost',
  workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'audit-runtime-lost',
  containerImageDigest: `sha256:${'b'.repeat(64)}`,
}
const lost = {
  stageId: 'discovery', waveId: 'wave-2', taskId: 'core-wave-2-research-1',
  attempt: 1, promptDigest: 'c'.repeat(64), requestDigest: 'd'.repeat(64),
}

function failedSource(): RunState {
  return {
    runId: 'lost-run', stateGeneration: 1,
    status: 'failed', inFlightAgentAttempts: [{ ...lost, admittedAt: '2026-10-09T00:00:00.000Z',
      continuationMode: 'new', freshContext: false, sessionId: null }],
    artifacts: [], rejectedAttempts: [], journal: [{
      sequence: 1, type: 'task.failed', at: '2026-10-09T00:10:00.000Z',
      payload: { taskId: lost.taskId, category: 'session-recovery-unavailable', retryable: false },
    }],
  } as unknown as RunState
}

function proof(): FailedRunRetirementProof {
  const app = '22222222-2222-4222-8222-222222222222'
  const namespace = 'e'.repeat(32)
  const actor = { id: 'actor-one', name: 'lost-agent' }
  const inventory = {
    observedAt: '2026-10-09T00:11:00.000Z', completedAt: '2026-10-09T00:11:01.000Z',
    app, namespace, inventoryComplete: true,
    info: { id: app, name: `${runtime.workerService}-sandbox`,
      durable_objects: { namespace_id: namespace },
      health: { instances: { active: 0, assigned: 0, starting: 0 } } },
    pages: [{ success: true, result: { instances: [], durable_objects: [actor] },
      result_info: { per_page: 100 } }],
    instances: [], actors: [actor],
  }
  return {
    schemaVersion: 1, kind: 'terminal-failed-custody', runId: 'lost-run',
    experimentId: 'audit', runtimeRelease: runtime,
    stateKey: 'runs/lost-run/states/1.json', stateGeneration: 1,
    stateDigest: '1'.repeat(64), workflow: { status: 'errored' },
    terminalReasonDigest: '2'.repeat(64), acceptedArtifactManifestDigest: '3'.repeat(64),
    sandboxNamespaceId: namespace, containerApplicationId: app,
    containerInventoryDigest: '4'.repeat(64), activePhysicalCount: 0,
    assignedPhysicalCount: 0, startingPhysicalCount: 0,
    inactiveActorCount: 1, inventoryComplete: true,
    ephemeralWorkspaceStatus: 'unavailable', observedAt: inventory.observedAt,
    unobservableNative: { ...lost, inventory },
  }
}

it('identifies only one exact terminally unobservable admitted attempt', () => {
  const source = failedSource()
  expect(exactUnobservableAttempt(source, lost)).toBe(true)
  expect(exactUnobservableAttempt(source, { ...lost, promptDigest: 'f'.repeat(64) })).toBe(false)
  expect(exactUnobservableAttempt({ ...source, journal: [] }, lost)).toBe(false)
  expect(exactUnobservableAttempt({ ...source, rejectedAttempts: [{ taskId: lost.taskId,
    stageId: lost.stageId, waveId: lost.waveId }] } as unknown as RunState, lost)).toBe(false)
  expect(exactUnobservableAttempt({ ...source, inFlightAgentAttempts: [
    ...source.inFlightAgentAttempts!, source.inFlightAgentAttempts![0]!,
  ] }, lost)).toBe(false)
})

it('binds the exact archived fence and rejects a late terminal receipt', async () => {
  const source = failedSource()
  const saved = { ...proof(), stateDigest: await sha256(source) }
  const content = canonicalJson(saved)
  const digest = await sha256(content)
  const store = Object.create(CloudflareRunStore.prototype) as CloudflareRunStore
  const mutable = store as unknown as Record<string, unknown>
  mutable.artifacts = { get: async (key: string) => key === `runtime-retirements/sha256/${digest}.json`
    ? { text: async () => content, checksums: { toJSON: () => ({ sha256: digest }) },
      customMetadata: { run: source.runId } } : null }
  mutable.retiredRunWorkflow = async () => ({ disposition: 'retired-fenced',
    fenceProofDigest: digest, workflow: saved.workflow })
  const receipt = vi.spyOn(R2AgentExecutionReceiptStore.prototype, 'get').mockResolvedValue(null)
  try {
    await expect(store.fencedUnobservableNativeEvidence(source)).resolves.toEqual({
      ...lost, fenceProofDigest: digest,
    })
    receipt.mockResolvedValueOnce({} as Awaited<ReturnType<R2AgentExecutionReceiptStore['get']>>)
    await expect(store.fencedUnobservableNativeEvidence(source))
      .rejects.toThrow('acquired a terminal execution receipt')
    await expect(store.fencedUnobservableNativeEvidence({ ...source, stateGeneration: 2 }))
      .rejects.toThrow('retirement differs')
  } finally { receipt.mockRestore() }
})

it('requires full paginated zero-placement native inventory for lost work', () => {
  const valid = proof()
  expect(() => assertFailedRunRetirementProof(valid)).not.toThrow()
  const inventory = valid.unobservableNative!.inventory as ReturnType<typeof proof>['unobservableNative'] & {
    pages: Array<{ result_info: Record<string, unknown> }>, instances: unknown[], actors: unknown[]
  }
  for (const damaged of [
    { ...inventory, inventoryComplete: false },
    { ...inventory, instances: [{ id: 'still-running' }] },
    { ...inventory, pages: [{ ...inventory.pages[0], result_info: { per_page: 100, next_page_token: 'more' } }] },
    { ...inventory, actors: [{ id: 'actor-one', deployment_id: 'placed' }] },
  ]) {
    expect(() => assertFailedRunRetirementProof({ ...valid,
      unobservableNative: { ...lost, inventory: damaged } })).toThrow()
  }
})

it('validates a same-session correction prompt against its admitted rejected output', async () => {
  const definition = audit0Definition
  const stage = definition.stages.find(candidate => candidate.kind === 'discovery')!
  const wave = stage.waves[0]!
  const task = wave.tasks[0]!
  const diagnostics = ['repair this exact structured output']
  const input = {
    definition, runId: 'correction-source', stage, wave, task,
    visibleArtifacts: [], releaseDigest: 'a'.repeat(64), deadline: '2026-10-09T01:00:00.000Z',
  }
  const { promptDigest } = await composePrompt({ ...input, diagnostics, formatRepairOnly: true })
  const record = { stageId: stage.id, waveId: wave.id, taskId: task.id,
    promptDigest } as ArtifactRecord
  const admitted = { stageId: stage.id, waveId: wave.id, taskId: task.id,
    promptDigest, attempt: 2, formatRepairOrdinal: 1, formatRepairSourceDigest: 'f'.repeat(64) }
  const source = { runId: input.runId, journal: [
    { type: 'agent.attempt-admitted', payload: admitted },
    { type: 'agent.attempt-finished', payload: admitted },
  ], rejectedAttempts: [{ stageId: stage.id, waveId: wave.id, taskId: task.id,
    attempt: 1, outputDigest: admitted.formatRepairSourceDigest, diagnostics }],
  } as unknown as RunState
  expect(await recoveryPromptMatches(input, record, source)).toBe(true)
  expect(await recoveryPromptMatches(input, record, { ...source, rejectedAttempts: [] })).toBe(false)
  expect(await recoveryPromptMatches(input, record, { ...source, journal: [] })).toBe(false)
})
