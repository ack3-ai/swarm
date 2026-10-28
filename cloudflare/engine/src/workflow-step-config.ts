export const workflowAttemptTimeoutMs = 30 * 60_000
// Keep Sandbox status observation comfortably below the connection lifetime of
// its Durable Object RPC. Reaching this bound only yields the Workflow step;
// the admitted process and exact paid-request receipt remain authoritative.
export const agentProcessWaitSliceMs = 2 * 60_000

export function workflowBootstrapProgress<T>(result: T | ({ progress: T } & Record<string, unknown>)): T {
  return result !== null && typeof result === 'object' && 'progress' in result
    ? result.progress
    : result
}

export function waveStepConfig() {
  return {
    // These retries cover only transient transport failures in one bounded
    // status-polling slice. Healthy admitted work continues in a later durable
    // step using the same Sandbox process and exact execution receipt.
    retries: {
      limit: 3,
      delay: '2 seconds' as const,
      backoff: 'exponential' as const,
    },
    timeout: workflowAttemptTimeoutMs,
  }
}
