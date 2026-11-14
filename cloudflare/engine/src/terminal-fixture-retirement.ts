import type { RuntimeRelease } from './contracts.js'
import { canonicalJson, sha256 } from './canonical.js'
import { assertRuntimeRelease, sameRuntimeRelease } from './runtime-release.js'

const digest = /^[a-f0-9]{64}$/
const namespace = /^[a-f0-9]{32}$/
const applicationId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/i
const missing = new Set(['instance-not-found', 'definition-not-found'])
const terminal = new Set(['complete', 'errored', 'terminated'])

export interface TerminalFixtureRetirementProof {
  schemaVersion: 1
  kind: 'retired-terminal-fixture'
  runId: string
  experimentId: 'runtime-isolation'
  runtimeRelease: RuntimeRelease
  auditWorkflowStatus: 'instance-not-found' | 'definition-not-found'
  isolationWorkflowStatus: 'complete' | 'errored' | 'terminated' | 'instance-not-found'
  isolationWorkflow: Readonly<Record<string, unknown>>
  sandboxNamespaceId: string
  containerApplicationId: string
  containerInventoryDigest: string
  containerInstanceCount: 0
  containerInventoryComplete: true
  observedAt: string
  /** Authenticated operator evidence after native Workflow retention has expired. */
  postRetention?: {
    accountId: string
    checkpointDigest: string
    audit: { path: string, httpStatus: number, body: unknown }
    isolation: { path: string, httpStatus: number, body: unknown }
    inventory: { application: unknown, pages: { pageToken: string | null, response: unknown }[] }
  }
}

export function assertTerminalFixtureRetirementProof(value: unknown): asserts value is TerminalFixtureRetirementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('terminal fixture proof is invalid')
  const proof = value as Partial<TerminalFixtureRetirementProof>
  const keys = Object.keys(proof)
  if (keys.length !== (proof.postRetention === undefined ? 14 : 15) || keys.some(key => ![
    'schemaVersion', 'kind', 'runId', 'experimentId', 'runtimeRelease',
    'auditWorkflowStatus', 'isolationWorkflowStatus', 'isolationWorkflow',
    'sandboxNamespaceId', 'containerApplicationId', 'containerInventoryDigest', 'containerInstanceCount',
    'containerInventoryComplete', 'observedAt', 'postRetention',
  ].includes(key))
    || proof.schemaVersion !== 1 || proof.kind !== 'retired-terminal-fixture'
    || typeof proof.runId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(proof.runId)
    || proof.experimentId !== 'runtime-isolation'
    || !missing.has(proof.auditWorkflowStatus ?? '')
    || !(proof.postRetention === undefined ? terminal.has(proof.isolationWorkflowStatus ?? '')
      : proof.isolationWorkflowStatus === 'instance-not-found')
    || proof.isolationWorkflow === null || typeof proof.isolationWorkflow !== 'object'
    || Array.isArray(proof.isolationWorkflow)
    || proof.isolationWorkflow.status !== proof.isolationWorkflowStatus
    || typeof proof.sandboxNamespaceId !== 'string' || !namespace.test(proof.sandboxNamespaceId)
    || typeof proof.containerApplicationId !== 'string' || !applicationId.test(proof.containerApplicationId)
    || typeof proof.containerInventoryDigest !== 'string' || !digest.test(proof.containerInventoryDigest)
    || proof.containerInstanceCount !== 0 || proof.containerInventoryComplete !== true
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw new Error('terminal fixture proof is invalid')
  }
  assertRuntimeRelease(proof.runtimeRelease)
  if (proof.postRetention !== undefined) assertPostRetentionEvidence(proof as TerminalFixtureRetirementProof)
  if (canonicalJson(proof.isolationWorkflow).length > 16_384) throw new Error('terminal fixture Workflow receipt is too large')
}

export async function retireTerminalFixture(input: {
  fixtureId: string
  accountId?: string | undefined
  proof: unknown
  now: number
  observeExpired?: ((proof: TerminalFixtureRetirementProof) => Promise<
    Omit<NonNullable<TerminalFixtureRetirementProof['postRetention']>, 'checkpointDigest'>
  >) | undefined
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
  if (proof.postRetention !== undefined) {
    if (input.accountId !== proof.postRetention.accountId
      || await sha256(proof.postRetention.inventory) !== proof.containerInventoryDigest) {
      throw new Error('expired fixture account or native inventory differs')
    }
    if (input.observeExpired === undefined) throw new Error('authenticated native fixture observation is required')
    const live = await input.observeExpired(proof)
    const { checkpointDigest: _, ...claimed } = proof.postRetention
    if (canonicalJson(live) !== canonicalJson(claimed)) {
      throw new Error('expired fixture native evidence differs from authenticated observation')
    }
    // The store verifies the sealed checkpoint and route before archiving this
    // missing-native disposition. Never manufacture a completed Workflow status.
    const proofDigest = await input.store.archiveTerminalFixtureAndReleaseLease(proof)
    return { fixtureId: input.fixtureId, proofDigest, retired: true }
  }
  const observed = await input.liveFixture(runtimeRelease, input.fixtureId)
  if (observed.fixtureId !== input.fixtureId
    || canonicalJson(observed.workflow) !== canonicalJson(proof.isolationWorkflow)) {
    throw new Error('native fixture Workflow differs from retirement proof')
  }
  const proofDigest = await input.store.archiveTerminalFixtureAndReleaseLease(proof)
  return { fixtureId: input.fixtureId, proofDigest, retired: true }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function assertPostRetentionEvidence(proof: TerminalFixtureRetirementProof): void {
  const evidence = proof.postRetention!
  if (!record(evidence) || !namespace.test(evidence.accountId ?? '')
    || !digest.test(evidence.checkpointDigest ?? '') || proof.auditWorkflowStatus !== 'instance-not-found'
    || canonicalJson(proof.isolationWorkflow) !== canonicalJson({ status: 'instance-not-found' })) {
    throw new Error('expired fixture evidence is invalid')
  }
  for (const [receipt, workflow] of [[evidence.audit, proof.runtimeRelease.workflowName],
    [evidence.isolation, `${proof.runtimeRelease.workflowName}-isolation`]] as const) {
    if (!record(receipt) || receipt.httpStatus !== 404
      || receipt.path !== `/accounts/${evidence.accountId}/workflows/${workflow}/instances/${proof.runId}`
      || !record(receipt.body) || receipt.body.success !== false
      || !Array.isArray(receipt.body.errors) || receipt.body.errors.length !== 1
      || !record(receipt.body.errors[0]) || receipt.body.errors[0].code !== 10400) {
      throw new Error('expired fixture requires exact native instance-not-found receipts')
    }
  }
  const inventory = evidence.inventory
  if (!record(inventory) || !record(inventory.application)
    || inventory.application.id !== proof.containerApplicationId
    || ![`${proof.runtimeRelease.workerService}-sandbox`, `${proof.runtimeRelease.workerService}-agent-sandbox`]
      .includes(String(inventory.application.name))
    || !record(inventory.application.durable_objects)
    || inventory.application.durable_objects.namespace_id !== proof.sandboxNamespaceId
    || !record(inventory.application.health) || !record(inventory.application.health.instances)
    || inventory.application.health.instances.active !== 0 || inventory.application.health.instances.starting !== 0
    || (inventory.application.health.instances.assigned != null && inventory.application.health.instances.assigned !== 0)
    || !Array.isArray(inventory.pages) || inventory.pages.length === 0 || inventory.pages.length > 100) {
    throw new Error('expired fixture native application identity differs')
  }
  let next: string | null = null
  const actors = new Set<string>()
  for (const [index, page] of inventory.pages.entries()) {
    if ((index > 0 && next === null) || !record(page) || page.pageToken !== next || !record(page.response)
      || page.response.success !== true || !record(page.response.result)
      || !record(page.response.result_info) || page.response.result_info.per_page !== 100
      || !Array.isArray(page.response.result.instances) || page.response.result.instances.length !== 0
      || !Array.isArray(page.response.result.durable_objects)) {
      throw new Error('expired fixture inventory is incomplete or has physical work')
    }
    for (const actor of page.response.result.durable_objects) {
      if (!record(actor) || typeof actor.id !== 'string' || !digest.test(actor.id) || actors.has(actor.id)
        || actor.deployment_id != null || actor.placement_id != null) {
        throw new Error('expired fixture inventory has assigned or duplicate actors')
      }
      actors.add(actor.id)
    }
    const cursor = page.response.result_info.next_page_token
    if (cursor != null && (typeof cursor !== 'string' || cursor.length === 0)) {
      throw new Error('expired fixture inventory pagination is invalid')
    }
    next = (cursor as string | null | undefined) ?? null
  }
  if (next !== null) throw new Error('expired fixture inventory has more pages')
}
