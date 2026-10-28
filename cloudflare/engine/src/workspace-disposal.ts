export interface WorkspaceDisposalReceipt {
  status: 'destroyed' | 'deferred'
  timeoutMs: number
}

export async function boundedWorkspaceDisposal(
  destroy: (expired: () => boolean) => Promise<void>,
  timeoutMs = 5_000,
): Promise<WorkspaceDisposalReceipt> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('workspace disposal timeout is invalid')
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const destruction = destroy(() => expired).then(() => 'destroyed' as const)
  // Keep a rejection handler attached after the bounded caller returns. The
  // Sandbox SDK permits destroy() to remain pending when its control plane is unavailable.
  destruction.catch(() => {})
  const status = await Promise.race([
    destruction,
    new Promise<'deferred'>(resolve => {
      timer = setTimeout(() => { expired = true; resolve('deferred') }, timeoutMs)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  return { status, timeoutMs }
}
