import type { RuntimeRelease } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

const digest = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/

/** Fresh operator custody for a stopped run. It is not a successful audit. */
interface StoppedRunRetirementBase {
  schemaVersion: 1
  runId: string
  experimentId: string
  runtimeRelease: RuntimeRelease
  stateKey: string
  stateGeneration: number
  stateDigest: string
  workflow: Readonly<Record<string, unknown>>
  acceptedArtifactManifestDigest: string
  sandboxNamespaceId: string
  containerApplicationId: string
  containerInventoryDigest: string
  activePhysicalCount: 0
  assignedPhysicalCount: 0
  startingPhysicalCount: 0
  inactiveActorCount: number
  inventoryComplete: true
  observedAt: string
}

export type StoppedRunRetirementProof = StoppedRunRetirementBase & (
  | { kind: 'sealed-stopped-custody', checkpointDigest: string }
  | { kind: 'terminal-stopped-custody', checkpointDigest: string | null }
)

export function assertStoppedRunRetirementProof(value: unknown): asserts value is StoppedRunRetirementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('stopped run custody proof is invalid')
  }
  const proof = value as Partial<StoppedRunRetirementProof>
  const allowed = [
    'schemaVersion', 'kind', 'runId', 'experimentId', 'runtimeRelease', 'stateKey',
    'stateGeneration', 'stateDigest', 'workflow', 'checkpointDigest',
    'acceptedArtifactManifestDigest', 'sandboxNamespaceId', 'containerApplicationId',
    'containerInventoryDigest', 'activePhysicalCount', 'assignedPhysicalCount',
    'startingPhysicalCount', 'inactiveActorCount', 'inventoryComplete', 'observedAt',
  ]
  if (Object.keys(proof).length !== allowed.length
    || Object.keys(proof).some(key => !allowed.includes(key))
    || proof.schemaVersion !== 1
    || !['sealed-stopped-custody', 'terminal-stopped-custody'].includes(proof.kind ?? '')
    || !runIdPattern.test(proof.runId ?? '') || !runIdPattern.test(proof.experimentId ?? '')
    || typeof proof.stateKey !== 'string' || !proof.stateKey.startsWith(`runs/${proof.runId}/states/`)
    || !Number.isSafeInteger(proof.stateGeneration) || (proof.stateGeneration ?? 0) < 1
    || !digest.test(proof.stateDigest ?? '')
    || (proof.kind === 'sealed-stopped-custody' && !digest.test(proof.checkpointDigest ?? ''))
    || (proof.kind === 'terminal-stopped-custody'
      && proof.checkpointDigest !== null && !digest.test(proof.checkpointDigest ?? ''))
    || !digest.test(proof.acceptedArtifactManifestDigest ?? '')
    || proof.workflow === null || typeof proof.workflow !== 'object' || Array.isArray(proof.workflow)
    || (proof.kind === 'sealed-stopped-custody' && proof.workflow.status !== 'complete')
    || (proof.kind === 'terminal-stopped-custody' && proof.workflow.status !== 'terminated')
    || canonicalJson(proof.workflow).length > 16_384
    || typeof proof.sandboxNamespaceId !== 'string' || !/^[a-f0-9]{32}$/.test(proof.sandboxNamespaceId)
    || typeof proof.containerApplicationId !== 'string' || !uuid.test(proof.containerApplicationId)
    || !digest.test(proof.containerInventoryDigest ?? '')
    || proof.activePhysicalCount !== 0 || proof.assignedPhysicalCount !== 0
    || proof.startingPhysicalCount !== 0 || !Number.isSafeInteger(proof.inactiveActorCount)
    || (proof.inactiveActorCount ?? -1) < 0 || proof.inventoryComplete !== true
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw new Error('stopped run custody proof is invalid')
  }
  assertRuntimeRelease(proof.runtimeRelease)
}

export async function retireStoppedRun(input: {
  runId: string
  proof: unknown
  now: number
  store: {
    retiredRunWorkflow(runId: string): Promise<{ fenceProofDigest: string | null } | null>
    runRuntime(runId: string): Promise<RuntimeRelease | null>
    archiveStoppedRunAndReleaseLease(proof: StoppedRunRetirementProof): Promise<string>
  }
  liveRun: (runtimeRelease: RuntimeRelease, runId: string) => Promise<{ state: unknown, workflow: unknown }>
}): Promise<{ runId: string, proofDigest: string, retired: true }> {
  assertStoppedRunRetirementProof(input.proof)
  const proof = input.proof
  if (proof.runId !== input.runId) throw new Error('stopped retirement identity differs')
  const proofDigest = await sha256(canonicalJson(proof))
  const prior = await input.store.retiredRunWorkflow(input.runId)
  if (prior !== null) {
    if (prior.fenceProofDigest !== proofDigest) throw new Error('stopped run was retired with different proof')
    await input.store.archiveStoppedRunAndReleaseLease(proof)
    return { runId: input.runId, proofDigest, retired: true }
  }
  if (input.now - Date.parse(proof.observedAt) > 120_000
    || Date.parse(proof.observedAt) > input.now + 10_000) {
    throw new Error('stopped inventory observation is stale')
  }
  const runtime = await input.store.runRuntime(input.runId)
  if (runtime === null || !sameRuntimeRelease(runtime, proof.runtimeRelease)) {
    throw new Error('stopped run route changed')
  }
  const live = await input.liveRun(runtime, input.runId)
  if (canonicalJson(live.workflow) !== canonicalJson(proof.workflow)
    || await sha256(live.state) !== proof.stateDigest) {
    throw new Error('stopped native state or Workflow differs from proof')
  }
  await input.store.archiveStoppedRunAndReleaseLease(proof)
  return { runId: proof.runId, proofDigest, retired: true }
}
