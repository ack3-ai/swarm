import type { Env } from './env.js'

/** Optional deployment placement for new Workflow instances and the coordinator. */
export function placement(env: Pick<Env, 'LOCATION_HINT'>): { locationHint?: DurableObjectLocationHint } {
  return env.LOCATION_HINT === undefined ? {} : { locationHint: env.LOCATION_HINT }
}
