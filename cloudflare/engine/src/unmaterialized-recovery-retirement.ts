import type { RuntimeRelease } from './contracts.js'
import { assertRuntimeRelease } from './runtime-release.js'

const digest = /^[a-f0-9]{64}$/
const runId = /^[a-z0-9][a-z0-9._-]{0,99}$/
const missing = new Set(['instance-not-found', 'definition-not-found'])

/** Operator evidence for a reserved recovery that never acquired a Workflow or run state. */
export interface UnmaterializedRecoveryRetirementProof {
  schemaVersion: 1
  kind: 'retired-unmaterialized-route'
  runId: string
  experimentId: string
  runtimeRelease: RuntimeRelease
  sourceRunId: string
  sourceStateDigest: string
  checkpointDigest: string
  reservationRequestDigest: string
  routeReservedAt: string
  leaseAdmittedAt: string
  auditWorkflowStatus: 'instance-not-found' | 'definition-not-found'
  isolationWorkflowStatus: 'instance-not-found' | 'definition-not-found'
  auditWorkflowReceiptDigest: string
  isolationWorkflowReceiptDigest: string
  containerInventoryDigest: string
  containerInstanceCount: 0
  containerInventoryComplete: true
  observedAt: string
}

export function assertUnmaterializedRecoveryRetirementProof(
  value: unknown,
): asserts value is UnmaterializedRecoveryRetirementProof {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('unmaterialized recovery proof is invalid')
  }
  const proof = value as Partial<UnmaterializedRecoveryRetirementProof>
  const allowed = [
    'schemaVersion', 'kind', 'runId', 'experimentId', 'runtimeRelease',
    'sourceRunId', 'sourceStateDigest', 'checkpointDigest', 'reservationRequestDigest',
    'routeReservedAt', 'leaseAdmittedAt',
    'auditWorkflowStatus', 'isolationWorkflowStatus',
    'auditWorkflowReceiptDigest', 'isolationWorkflowReceiptDigest',
    'containerInventoryDigest', 'containerInstanceCount', 'containerInventoryComplete', 'observedAt',
  ]
  if (Object.keys(proof).length !== allowed.length
    || Object.keys(proof).some(key => !allowed.includes(key))
    || proof.schemaVersion !== 1 || proof.kind !== 'retired-unmaterialized-route'
    || typeof proof.runId !== 'string' || !runId.test(proof.runId)
    || typeof proof.experimentId !== 'string' || !runId.test(proof.experimentId)
    || typeof proof.sourceRunId !== 'string' || !runId.test(proof.sourceRunId)
    || !digest.test(proof.sourceStateDigest ?? '')
    || !digest.test(proof.checkpointDigest ?? '')
    || !digest.test(proof.reservationRequestDigest ?? '')
    || typeof proof.routeReservedAt !== 'string' || !Number.isFinite(Date.parse(proof.routeReservedAt))
    || typeof proof.leaseAdmittedAt !== 'string' || !Number.isFinite(Date.parse(proof.leaseAdmittedAt))
    || !missing.has(proof.auditWorkflowStatus ?? '')
    || !missing.has(proof.isolationWorkflowStatus ?? '')
    || !digest.test(proof.auditWorkflowReceiptDigest ?? '')
    || !digest.test(proof.isolationWorkflowReceiptDigest ?? '')
    || !digest.test(proof.containerInventoryDigest ?? '')
    || proof.containerInstanceCount !== 0 || proof.containerInventoryComplete !== true
    || typeof proof.observedAt !== 'string' || !Number.isFinite(Date.parse(proof.observedAt))) {
    throw new Error('unmaterialized recovery proof is invalid')
  }
  assertRuntimeRelease(proof.runtimeRelease)
}
