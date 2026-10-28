import type { RuntimeRelease } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

const digest = /^[a-f0-9]{64}$/
const namespace = /^[a-f0-9]{32}$/
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const missing = new Set(['instance-not-found', 'definition-not-found'])
const terminal = new Set(['complete', 'errored', 'terminated'])

export interface TerminalFixtureRetirementProof {
  schemaVersion: 1
  kind: 'retired-terminal-fixture'
  runId: string
  experimentId: 'runtime-isolation'
  runtimeRelease: RuntimeRelease
  auditWorkflowStatus: 'instance-not-found' | 'definition-not-found'
  isolationWorkflowStatus: 'complete' | 'errored' | 'terminated'
  isolationWorkflow: Readonly<Record<string, unknown>>
  sandboxNamespaceId: string
  containerApplicationId: string
  containerInventoryDigest: string
  containerInstanceCount: 0
  containerInventoryComplete: true
  observedAt: string
}

export function assertTerminalFixtureRetirementProof(value: unknown): asserts value is TerminalFixtureRetirementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('terminal fixture proof is invalid')
  const proof = value as Partial<TerminalFixtureRetirementProof>
  const keys = Object.keys(proof)
  if (keys.length !== 14 || keys.some(key => ![
    'schemaVersion', 'kind', 'runId', 'experimentId', 'runtimeRelease',
    'auditWorkflowStatus', 'isolationWorkflowStatus', 'isolationWorkflow',
    'sandboxNamespaceId', 'containerApplicationId', 'containerInventoryDigest', 'containerInstanceCount',
    'containerInventoryComplete', 'observedAt',
  ].includes(key))
    || proof.schemaVersion !== 1 || proof.kind !== 'retired-terminal-fixture'
    || typeof proof.runId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(proof.runId)
    || proof.experimentId !== 'runtime-isolation'
    || !missing.has(proof.auditWorkflowStatus ?? '')
    || !terminal.has(proof.isolationWorkflowStatus ?? '')
    || proof.isolationWorkflow === null || typeof proof.isolationWorkflow !== 'object'
    || Array.isArray(proof.isolationWorkflow)
    || proof.isolationWorkflow.status !== proof.isolationWorkflowStatus
    || typeof proof.sandboxNamespaceId !== 'string' || !namespace.test(proof.sandboxNamespaceId)
    || typeof proof.containerApplicationId !== 'string' || !uuid.test(proof.containerApplicationId)
    || typeof proof.containerInventoryDigest !== 'string' || !digest.test(proof.containerInventoryDigest)
    || proof.containerInstanceCount !== 0 || proof.containerInventoryComplete !== true
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw new Error('terminal fixture proof is invalid')
  }
  assertRuntimeRelease(proof.runtimeRelease)
  if (canonicalJson(proof.isolationWorkflow).length > 16_384) throw new Error('terminal fixture Workflow receipt is too large')
}

export async function retireTerminalFixture(input: {
  fixtureId: string
  proof: unknown
  now: number
  store: {
    retiredUnmaterializedRoute(runId: string): Promise<{ proofDigest: string } | null>
    runRuntime(runId: string): Promise<RuntimeRelease | null>
    archiveTerminalFixtureAndReleaseLease(proof: TerminalFixtureRetirementProof): Promise<string>
  }
  liveFixture: (runtimeRelease: RuntimeRelease, fixtureId: string) => Promise<{
    fixtureId: string, workflow: unknown
  }>
}): Promise<{ fixtureId: string, proofDigest: string, retired: true }> {
  assertTerminalFixtureRetirementProof(input.proof)
  const proof = input.proof
  if (proof.runId !== input.fixtureId) throw new Error('fixture retirement identity differs')
  const requestedDigest = await sha256(canonicalJson(proof))
  const alreadyRetired = await input.store.retiredUnmaterializedRoute(input.fixtureId)
  if (alreadyRetired !== null) {
    if (alreadyRetired.proofDigest !== requestedDigest) throw new Error('fixture was retired with different proof')
    const proofDigest = await input.store.archiveTerminalFixtureAndReleaseLease(proof)
    return { fixtureId: input.fixtureId, proofDigest, retired: true }
  }
  if (input.now - Date.parse(proof.observedAt) > 120_000
    || Date.parse(proof.observedAt) > input.now + 10_000) {
    throw new Error('fixture inventory observation is stale')
  }
  const runtimeRelease = await input.store.runRuntime(input.fixtureId)
  if (runtimeRelease === null || !sameRuntimeRelease(runtimeRelease, proof.runtimeRelease)) {
    throw new Error('fixture runtime route changed')
  }
  const observed = await input.liveFixture(runtimeRelease, input.fixtureId)
  if (observed.fixtureId !== input.fixtureId
    || canonicalJson(observed.workflow) !== canonicalJson(proof.isolationWorkflow)) {
    throw new Error('native fixture Workflow differs from retirement proof')
  }
  const proofDigest = await input.store.archiveTerminalFixtureAndReleaseLease(proof)
  return { fixtureId: input.fixtureId, proofDigest, retired: true }
}
