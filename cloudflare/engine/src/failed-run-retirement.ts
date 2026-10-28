import type { RuntimeRelease, UnobservableNativeRecoveryEvidence } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

const digest = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** Operator evidence for a terminally failed run with zero physical work. */
export interface FailedRunRetirementProof {
  schemaVersion: 1
  kind: 'terminal-failed-custody'
  runId: string
  experimentId: string
  runtimeRelease: RuntimeRelease
  stateKey: string
  stateGeneration: number
  stateDigest: string
  workflow: Readonly<Record<string, unknown>>
  terminalReasonDigest: string
  acceptedArtifactManifestDigest: string
  sandboxNamespaceId: string
  containerApplicationId: string
  containerInventoryDigest: string
  activePhysicalCount: 0
  assignedPhysicalCount: 0
  startingPhysicalCount: 0
  inactiveActorCount: number
  inventoryComplete: true
  ephemeralWorkspaceStatus: 'retained' | 'unavailable'
  observedAt: string
  /** Full operator-read native inventory plus the one lost admitted request. */
  unobservableNative?: Omit<UnobservableNativeRecoveryEvidence, 'fenceProofDigest'> & {
    inventory: unknown
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export function assertUnobservableNativeInventory(proof: FailedRunRetirementProof): void {
  const lost = proof.unobservableNative
  if (lost === undefined) return
  const inventory = lost.inventory
  if (!record(inventory) || inventory.inventoryComplete !== true
    || inventory.observedAt !== proof.observedAt
    || inventory.app !== proof.containerApplicationId
    || inventory.namespace !== proof.sandboxNamespaceId
    || !Array.isArray(inventory.instances) || inventory.instances.length !== 0
    || !Array.isArray(inventory.actors) || !Array.isArray(inventory.pages)
    || inventory.pages.length === 0 || inventory.pages.length > 100
    || inventory.actors.length !== proof.inactiveActorCount
    || !record(inventory.info) || inventory.info.id !== proof.containerApplicationId
    || inventory.info.name !== `${proof.runtimeRelease.workerService}-sandbox`
    || !record(inventory.info.durable_objects)
    || inventory.info.durable_objects.namespace_id !== proof.sandboxNamespaceId
    || !record(inventory.info.health) || !record(inventory.info.health.instances)
    || ['active', 'assigned', 'starting'].some(key => {
      const info = inventory.info
      return !record(info) || !record(info.health) || !record(info.health.instances)
        || info.health.instances[key] !== 0
    })
    || inventory.actors.some(actor => !record(actor) || typeof actor.id !== 'string'
      || actor.deployment_id != null || actor.placement_id != null)) {
    throw new Error('unobservable native inventory is not complete and physically empty')
  }
  const actors: unknown[] = []
  const instances: unknown[] = []
  let next: unknown = null
  for (const page of inventory.pages) {
    if (!record(page) || page.success !== true || !record(page.result)
      || !Array.isArray(page.result.instances) || !Array.isArray(page.result.durable_objects)
      || !record(page.result_info) || page.result_info.per_page !== 100
      || (page.result_info.page_token ?? null) !== next) {
      throw new Error('unobservable native inventory pagination is invalid')
    }
    actors.push(...page.result.durable_objects)
    instances.push(...page.result.instances)
    next = page.result_info.next_page_token ?? null
  }
  if (next !== null || instances.length !== 0
    || new Set(actors.map(actor => record(actor) ? actor.id : null)).size !== actors.length
    || canonicalJson(actors) !== canonicalJson(inventory.actors)) {
    throw new Error('unobservable native inventory pages differ')
  }
}

export function assertFailedRunRetirementProof(value: unknown): asserts value is FailedRunRetirementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('failed custody proof is invalid')
  const proof = value as Partial<FailedRunRetirementProof>
  const allowed = [
    'schemaVersion', 'kind', 'runId', 'experimentId', 'runtimeRelease', 'stateKey',
    'stateGeneration', 'stateDigest', 'workflow', 'terminalReasonDigest',
    'acceptedArtifactManifestDigest', 'sandboxNamespaceId', 'containerApplicationId',
    'containerInventoryDigest', 'activePhysicalCount', 'assignedPhysicalCount',
    'startingPhysicalCount', 'inactiveActorCount', 'inventoryComplete',
    'ephemeralWorkspaceStatus', 'observedAt', 'unobservableNative',
  ]
  if (Object.keys(proof).length !== allowed.length - (proof.unobservableNative === undefined ? 1 : 0)
    || Object.keys(proof).some(key => !allowed.includes(key))
    || proof.schemaVersion !== 1 || proof.kind !== 'terminal-failed-custody'
    || !runIdPattern.test(proof.runId ?? '') || !runIdPattern.test(proof.experimentId ?? '')
    || typeof proof.stateKey !== 'string' || !proof.stateKey.startsWith(`runs/${proof.runId}/states/`)
    || !Number.isSafeInteger(proof.stateGeneration) || (proof.stateGeneration ?? 0) < 1
    || !digest.test(proof.stateDigest ?? '') || !digest.test(proof.terminalReasonDigest ?? '')
    || !digest.test(proof.acceptedArtifactManifestDigest ?? '')
    || proof.workflow === null || typeof proof.workflow !== 'object' || Array.isArray(proof.workflow)
    || proof.workflow.status !== 'errored' || canonicalJson(proof.workflow).length > 16_384
    || typeof proof.sandboxNamespaceId !== 'string' || !/^[a-f0-9]{32}$/.test(proof.sandboxNamespaceId)
    || typeof proof.containerApplicationId !== 'string' || !uuid.test(proof.containerApplicationId)
    || !digest.test(proof.containerInventoryDigest ?? '')
    || proof.activePhysicalCount !== 0 || proof.assignedPhysicalCount !== 0
    || proof.startingPhysicalCount !== 0 || !Number.isSafeInteger(proof.inactiveActorCount)
    || (proof.inactiveActorCount ?? -1) < 0 || proof.inventoryComplete !== true
    || !['retained', 'unavailable'].includes(proof.ephemeralWorkspaceStatus ?? '')
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw new Error('failed custody proof is invalid')
  }
  assertRuntimeRelease(proof.runtimeRelease)
  const lost = proof.unobservableNative
  if (lost !== undefined && (typeof lost.stageId !== 'string' || typeof lost.waveId !== 'string'
    || typeof lost.taskId !== 'string' || !Number.isSafeInteger(lost.attempt) || lost.attempt < 1
    || !digest.test(lost.promptDigest) || !digest.test(lost.requestDigest))) {
    throw new Error('unobservable native attempt is invalid')
  }
  assertUnobservableNativeInventory(proof as FailedRunRetirementProof)
}

export async function retireFailedRun(input: {
  runId: string
  proof: unknown
  now: number
  store: {
    retiredRunWorkflow(runId: string): Promise<{ fenceProofDigest: string | null } | null>
    runRuntime(runId: string): Promise<RuntimeRelease | null>
    archiveTerminalFailedRunAndReleaseLease(proof: FailedRunRetirementProof): Promise<string>
  }
  liveRun: (runtimeRelease: RuntimeRelease, runId: string) => Promise<{ state: unknown, workflow: unknown }>
}): Promise<{ runId: string, proofDigest: string, retired: true }> {
  assertFailedRunRetirementProof(input.proof)
  const proof = input.proof
  if (proof.runId !== input.runId) throw new Error('failed retirement identity differs')
  const proofDigest = await sha256(canonicalJson(proof))
  const prior = await input.store.retiredRunWorkflow(input.runId)
  if (prior !== null) {
    if (prior.fenceProofDigest !== proofDigest) throw new Error('failed run was retired with different proof')
    await input.store.archiveTerminalFailedRunAndReleaseLease(proof)
    return { runId: input.runId, proofDigest, retired: true }
  }
  if (input.now - Date.parse(proof.observedAt) > 120_000
    || Date.parse(proof.observedAt) > input.now + 10_000) throw new Error('failed inventory observation is stale')
  if (proof.unobservableNative !== undefined) {
    const inventory = proof.unobservableNative.inventory as { completedAt?: unknown }
    if (typeof inventory.completedAt !== 'string'
      || !Number.isFinite(Date.parse(inventory.completedAt))
      || Date.parse(inventory.completedAt) < Date.parse(proof.observedAt)
      || Date.parse(inventory.completedAt) > input.now + 10_000) {
      throw new Error('unobservable native inventory completion is invalid')
    }
  }
  const runtime = await input.store.runRuntime(input.runId)
  if (runtime === null || !sameRuntimeRelease(runtime, proof.runtimeRelease)) {
    throw new Error('failed run route changed')
  }
  const live = await input.liveRun(runtime, input.runId)
  if (canonicalJson(live.workflow) !== canonicalJson(proof.workflow)
    || await sha256(live.state) !== proof.stateDigest) {
    throw new Error('failed native state or Workflow differs from proof')
  }
  await input.store.archiveTerminalFailedRunAndReleaseLease(proof)
  return { runId: input.runId, proofDigest, retired: true }
}
