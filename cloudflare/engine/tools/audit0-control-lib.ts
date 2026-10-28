const runIdPattern = /^[a-z0-9][a-z0-9._-]{0,99}$/
const digestPattern = /^[0-9a-f]{64}$/

export interface Audit0Request {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  timingField?: 'dispatchMs' | 'resumeDispatchMs'
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
  if (command === 'stop') {
    const id = runId(args[0], 'run ID')
    if (args.length !== 1) throw new Error('usage: audit0 stop RUN_ID')
    return { method: 'POST', path: `/v1/runs/${id}/stop` }
  }
  if (command === 'resume') {
    const childRunId = runId(args[0], 'child run ID')
    const checkpointDigest = args[1] ?? ''
    if (args.length !== 2 || !digestPattern.test(checkpointDigest)) {
      throw new Error('usage: audit0 resume FRESH_CHILD_RUN_ID CHECKPOINT_SHA256')
    }
    return {
      method: 'POST',
      path: `/v1/experiments/${experimentPath}/resumes`,
      body: { childRunId, checkpointDigest },
      timingField: 'resumeDispatchMs',
    }
  }
  if (command === 'resume-revalidate') {
    const childRunId = runId(args[0], 'child run ID')
    const checkpointDigest = args[1] ?? ''
    const sourceRunId = runId(args[2], 'source run ID')
    const outputDigest = args[3] ?? ''
    if (args.length !== 4 || !digestPattern.test(checkpointDigest) || !digestPattern.test(outputDigest)) {
      throw new Error('usage: audit0 resume-revalidate FRESH_CHILD_RUN_ID CHECKPOINT_SHA256 FAILED_SOURCE_RUN_ID OUTPUT_SHA256')
    }
    return {
      method: 'POST',
      path: `/v1/experiments/${experimentPath}/resumes`,
      body: { childRunId, checkpointDigest, revalidate: { sourceRunId, outputDigest } },
      timingField: 'resumeDispatchMs',
    }
  }
  throw new Error('usage: audit0 start|status|stop|resume|resume-revalidate ...')
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

export function summarizeStatus(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null || !('state' in payload)) return payload
  const record = payload as { state?: unknown, workflow?: unknown }
  if (typeof record.state !== 'object' || record.state === null) return payload
  const state = record.state as Record<string, unknown>
  const checkpoints = Array.isArray(state.checkpoints) ? state.checkpoints : []
  return {
    runId: state.runId,
    status: state.status,
    cursor: state.cursor,
    recoveryEpoch: state.recoveryEpoch,
    parentRunId: state.parentRunId,
    parentCheckpointDigest: state.parentCheckpointDigest,
    modelStartedAt: state.modelStartedAt,
    timeAmendments: Array.isArray(state.journal) ? state.journal
      .filter(event => (event as { type?: unknown }).type === 'run.time-amended')
      .map(event => (event as { payload?: unknown }).payload) : [],
    checkpoints: checkpoints.map(checkpoint => {
      const item = checkpoint as { digest?: unknown, body?: Record<string, unknown> }
      return { digest: item.digest, cursor: item.body?.cursor, sealedAt: item.body?.sealedAt }
    }),
    stageEndReceipts: state.stageEndReceipts,
    budget: state.budget,
    artifactCount: Array.isArray(state.artifacts) ? state.artifacts.length : null,
    rejectedAttemptCount: Array.isArray(state.rejectedAttempts) ? state.rejectedAttempts.length : null,
    terminalReason: state.terminalReason,
    updatedAt: state.updatedAt,
    workflow: record.workflow,
  }
}
