import type { ISandbox } from '@cloudflare/sandbox'

export function agentProcessId(requestDigest: string): string {
  if (!/^[0-9a-f]{64}$/.test(requestDigest)) throw new TypeError('agent request digest is invalid')
  return `agent-${requestDigest.slice(0, 40)}`
}

function retryableStatusProbe(error: unknown, processId: string): boolean {
  if (!(error instanceof Error)) return false
  return error.message.includes('RPC stub was disposed without calling close()')
    || error.message === `Process ${processId} not found`
}

export async function waitForAgentProcess(
  process: Pick<Awaited<ReturnType<ISandbox['startProcess']>>, 'id' | 'getStatus'>,
  timeoutMs: number,
  pollIntervalMs = 1_000,
  observation?: { intervalMs: number, observe: () => Promise<void>, immediate?: boolean,
    onStatusProbe?: (outcome: 'success' | 'expired') => void },
): Promise<0 | 1 | 'running' | 'unavailable'> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('agent process wait bounds are invalid')
  }
  if (observation !== undefined && (!Number.isFinite(observation.intervalMs) || observation.intervalMs < 1)) {
    throw new TypeError('agent process observation interval is invalid')
  }
  const deadline = Date.now() + timeoutMs + 5_000
  let nextObservationAt = observation === undefined
    ? Number.POSITIVE_INFINITY
    : Date.now() + (observation.immediate === true ? 0 : observation.intervalMs)
  let observedRunning = false
  while (Date.now() < deadline) {
    try {
      const statusProbe = await settleBeforeDeadline(() => process.getStatus(), deadline)
      if (statusProbe.expired) {
        observation?.onStatusProbe?.('expired')
        break
      }
      observation?.onStatusProbe?.('success')
      const status = statusProbe.value
      if (status === 'completed') return 0
      if (status === 'failed' || status === 'killed' || status === 'error') return 1
      observedRunning = true
    } catch (error) {
      // waitForExit() holds an RPC log stream open for the full model call and
      // Cloudflare may dispose that stream while the process keeps running.
      // Short status probes are safe to repeat against the stable process ID.
      if (!retryableStatusProbe(error, process.id)) throw error
    }
    if (observation !== undefined && Date.now() >= nextObservationAt) {
      const passiveObservation = await settleBeforeDeadline(observation.observe, deadline)
      if (passiveObservation.expired) break
      nextObservationAt = Date.now() + observation.intervalMs
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, remaining)))
  }
  return observedRunning ? 'running' : 'unavailable'
}

type DeadlineResult<T> = { expired: false, value: T } | { expired: true }

async function settleBeforeDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<DeadlineResult<T>> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { expired: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(value => ({ expired: false, value }) as const),
      new Promise<DeadlineResult<T>>(resolve => {
        timer = setTimeout(() => resolve({ expired: true }), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
