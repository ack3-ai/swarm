import { parseRunCommand } from '../src/run-commands.js'
const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/

export interface Audit0Request {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  timingField?: 'dispatchMs'
}

function runId(value: string | undefined, label: string): string {
  if (!runIdPattern.test(value ?? '')) throw new Error(`${label} must be a valid fresh run ID`)
  return value as string
}

export function audit0Request(
  command: string | undefined,
  args: string[],
  experimentId = 'audit0-hello-vault',
): Audit0Request {
  if (!runIdPattern.test(experimentId)) throw new Error('ACK3_EXPERIMENT_ID must be a valid experiment ID')
  const experimentPath = encodeURIComponent(experimentId)
  if (command === 'start') {
    const id = runId(args[0], 'run ID')
    if (args.length !== 1) throw new Error('usage: audit0 start RUN_ID')
    return { method: 'POST', path: `/v1/experiments/${experimentPath}/runs`, body: { runId: id }, timingField: 'dispatchMs' }
  }
  if (command === 'status') {
    const id = runId(args[0], 'run ID')
    if (args.length !== 1) throw new Error('usage: audit0 status RUN_ID')
    return { method: 'GET', path: `/v1/runs/${id}` }
  }
  if (command === 'control') {
    const id = runId(args[0], 'audit ID')
    if (args.length !== 2) throw new Error('usage: audit0 control AUDIT_ID COMMAND_JSON')
    return { method: 'POST', path: `/v1/experiments/${experimentPath}/audits/${id}/commands`,
      body: parseRunCommand(JSON.parse(args[1]!)) }
  }
  if (command === 'controls') {
    const id = runId(args[0], 'audit ID')
    if (args.length < 1 || args.length > 2) throw new Error('usage: audit0 controls AUDIT_ID [COMMAND_ID]')
    const suffix = args[1] === undefined ? '' : `/${runId(args[1], 'command ID')}`
    return { method: 'GET', path: `/v1/experiments/${experimentPath}/audits/${id}/commands${suffix}` }
  }
  throw new Error('usage: audit0 start|status|control|controls ...')
}

export function operationLatency(field: string, providerMs: unknown, endToEndMs: number): {
  endToEndMs: number
  latencyTargetMs: number
  latencyTargetMet: boolean
} {
  if (typeof providerMs !== 'number' || !Number.isFinite(providerMs)) throw new Error(`${field} is missing from the control response`)
  if (!Number.isFinite(endToEndMs) || endToEndMs < 0) throw new Error('end-to-end timing is invalid')
  const latencyTargetMs = 1_000
  return { endToEndMs, latencyTargetMs, latencyTargetMet: providerMs < latencyTargetMs && endToEndMs < latencyTargetMs }
}

/** A pending dispatch is accepted; the coordinator delivers it later, so it has no dispatch timing yet. */
export function withOperationLatency(field: string, result: Record<string, unknown>, endToEndMs: number): Record<string, unknown> {
  if (result.dispatchPending === true) return { ...result, endToEndMs }
  return { ...result, ...operationLatency(field, result[field], endToEndMs) }
}

export function summarizeStatus(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('state' in payload)) return payload
  const record = payload as { state?: unknown, workflow?: unknown }
  if (record.state === null) return { status: 'starting', workflow: record.workflow }
  if (typeof record.state !== 'object') return payload
  const state = record.state as Record<string, unknown>
  const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : []
  const rejected = Array.isArray(state.rejectedAttempts) ? state.rejectedAttempts : []
  return {
    runId: state.runId,
    status: state.status,
    cursor: state.cursor,
    stateGeneration: state.stateGeneration,
    controls: state.controls,
    forkOrigin: state.forkOrigin,
    modelStartedAt: state.modelStartedAt,
    checkpoints: checkpoints.map(checkpoint => {
      const item = checkpoint as { digest?: unknown, body?: Record<string, unknown> }
      return { digest: item.digest, cursor: item.body?.cursor, sealedAt: item.body?.sealedAt }
    }),
    stageEndReceipts: state.stageEndReceipts,
    budget: state.budget,
    artifactCount: Array.isArray(state.artifacts) ? state.artifacts.length : null,
    rejectedAttemptCount: Array.isArray(state.rejectedAttempts) ? state.rejectedAttempts.length : null,
    recentRejections: rejected.slice(-5).map(attempt => {
      const item = attempt as Record<string, unknown>
      return { taskId: item.taskId, attempt: item.attempt, formatRepairOrdinal: item.formatRepairOrdinal,
        rejectedAt: item.rejectedAt, diagnostics: item.diagnostics,
        // A provider outage: the next launch waits until rejectedAt + delayMs (P2-06).
        ...(item.providerBackoff === undefined ? {} : { providerBackoff: item.providerBackoff }) }
    }),
    terminalReason: state.terminalReason,
    updatedAt: state.updatedAt,
    workflow: record.workflow,
  }
}
