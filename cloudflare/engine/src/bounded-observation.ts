async function boundedOperation<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<{ expired: false, value: T } | { expired: true }> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) return { expired: true }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(operation).then(value => ({ expired: false, value }) as const),
      new Promise<{ expired: true }>(resolve => {
        timer = setTimeout(() => resolve({ expired: true }), remaining)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Bound a read-only SDK observation without treating silence as process loss. */
export const boundedReadOnlyObservation = boundedOperation

/** Bound one idempotent lifetime-setting RPC; a late result cannot start an agent. */
export const boundedLaunchPrerequisite = boundedOperation

/** Give optional log work a wall bound and fence writes after the caller returns. */
export async function boundedTerminalLogDrain(
  operation: (active: () => boolean) => Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('log drain timeout is invalid')
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(() => active)).then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => { active = false; resolve(false) }, timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
