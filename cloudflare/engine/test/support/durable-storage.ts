/** Serialized, rollback-capable storage transactions; alarm execution consumes
 * its scheduled timestamp, like the coordinator's native alarm invocation. */
export function durableStorage() {
  let data = new Map<string, unknown>(), alarm: number | null = null, queue: Promise<unknown> = Promise.resolve()
  const storage = { transaction<T>(fn: (tx: DurableObjectTransaction) => Promise<T>): Promise<T> {
    const pending = queue.then(async () => {
      const next = new Map(data); let nextAlarm = alarm
      const tx = { get: async (key: string) => structuredClone(next.get(key)),
        put: async (key: string, value: unknown) => { next.set(key, structuredClone(value)) },
        delete: async (key: string) => next.delete(key), getAlarm: async () => nextAlarm,
        setAlarm: async (at: number) => { nextAlarm = at }, deleteAlarm: async () => { nextAlarm = null },
        list: async (options: { prefix: string; limit: number; startAfter?: string }) => new Map([...next]
          .filter(([key]) => key.startsWith(options.prefix) && (options.startAfter === undefined || key > options.startAfter))
          .sort(([a], [b]) => a.localeCompare(b)).slice(0, options.limit)) }
      const result = await fn(tx as unknown as DurableObjectTransaction)
      data = next; alarm = nextAlarm; return result
    })
    queue = pending.catch(() => {}); return pending
  } } as DurableObjectStorage
  return { storage, scheduled: () => alarm, values: () => [...data.values()],
    pending: () => [...data.keys()].filter(key => key.startsWith('run-control-delivery:')).length,
    consumeAlarm: () => { alarm = null } }
}
