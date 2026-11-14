import { assertCompletedRunDelivery, type CompletedRunDeliveryMarker } from './completed-run-delivery.js'
import { canonicalJson } from './canonical.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'
import { assertControlId, RunCommandConflict } from './run-commands.js'
import { assertSavedStateReference } from './run-commands.js'
import type { SavedStateReference } from './run-state-pointer.js'

/** Delivery identity only. The command body and its decisions remain in D1. */
interface ControlDeliveryIdentity {
  schemaVersion: 1
  experimentId: string
  auditId: string
  commandId: string
  commandDigest: string
  expectedRevision: number
}

export type ExecutionControlDeliveryMarker = ControlDeliveryIdentity & { authority: ExecutionAuthority }
export type StageForkDeliveryMarker = ControlDeliveryIdentity & { kind: 'fork'; source: SavedStateReference }
export type RunControlDeliveryMarker = ExecutionControlDeliveryMarker | StageForkDeliveryMarker

export function assertRunControlDelivery(value: unknown): asserts value is RunControlDeliveryMarker {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid command delivery')
  const marker = value as RunControlDeliveryMarker
  const fork = 'kind' in marker
  if (marker.schemaVersion !== 1 || Object.keys(marker).sort().join(',')
    !== (fork ? 'auditId,commandDigest,commandId,expectedRevision,experimentId,kind,schemaVersion,source'
      : 'auditId,authority,commandDigest,commandId,expectedRevision,experimentId,schemaVersion')
    || !/^[a-f0-9]{64}$/.test(marker.commandDigest) || !Number.isSafeInteger(marker.expectedRevision)
    || marker.expectedRevision < 0 || marker.expectedRevision >= Number.MAX_SAFE_INTEGER) throw new TypeError('invalid command delivery identity')
  assertControlId(marker.experimentId, 'experiment id'); assertControlId(marker.auditId, 'audit id')
  assertControlId(marker.commandId, 'command id')
  if ('kind' in marker) {
    if (marker.kind !== 'fork') throw new TypeError('invalid command delivery kind')
    assertSavedStateReference(marker.source)
  } else {
    assertExecutionAuthority(marker.authority)
    if (marker.authority.auditId !== marker.auditId) throw new TypeError('delivery authority differs from audit')
  }
}

export interface LaunchDeliveryMarker {
  kind: 'launch'
  auditId: string
  requestDigest: string
}
export type CoordinatorDeliveryMarker = RunControlDeliveryMarker | CompletedRunDeliveryMarker | LaunchDeliveryMarker
export function assertCoordinatorDelivery(value: unknown): asserts value is CoordinatorDeliveryMarker {
  if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'launch') {
    const marker = value as LaunchDeliveryMarker
    if (Object.keys(marker).sort().join(',') !== 'auditId,kind,requestDigest'
      || !/^[a-f0-9]{64}$/.test(marker.requestDigest)) throw new TypeError('invalid launch delivery')
    assertControlId(marker.auditId, 'audit id')
  } else if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'completed') assertCompletedRunDelivery(value)
  else assertRunControlDelivery(value)
}

const prefix = 'run-control-delivery:'
const cursorKey = 'run-control-delivery-cursor'
export const controlDeliveryRetryMs = 30_000
export const controlDeliverySliceSize = 8
const keyFor = (marker: CoordinatorDeliveryMarker) => 'kind' in marker && marker.kind === 'launch'
  ? `${prefix}${marker.auditId}:launch:${marker.requestDigest}` : 'kind' in marker && marker.kind === 'completed'
  ? `${prefix}${marker.auditId}:completed:${marker.source.runId}` : `${prefix}${marker.auditId}:${marker.commandId}`

async function armEarlier(storage: Pick<DurableObjectTransaction, 'getAlarm' | 'setAlarm'>, at: number) {
  const current = await storage.getAlarm()
  if (current === null || current > at) await storage.setAlarm(at)
}

/** Publish an outbox item in the same transaction as its admission. */
export async function registerDelivery(tx: DurableObjectTransaction, marker: CoordinatorDeliveryMarker): Promise<void> {
  assertCoordinatorDelivery(marker)
  const key = keyFor(marker), existing = await tx.get<CoordinatorDeliveryMarker>(key)
  if (existing !== undefined && canonicalJson(existing) !== canonicalJson(marker)) {
    throw new RunCommandConflict('idempotency-conflict', 'command delivery id has different content or owner')
  }
  if (existing === undefined) await tx.put(key, marker)
  await armEarlier(tx, Date.now() + 1)
}

/** The existing coordinator alarm transports durable decisions. It never owns
 * their order, executes audit waves, or interprets a replacement configuration. */
export class RunControlDelivery<Marker extends CoordinatorDeliveryMarker = RunControlDeliveryMarker> {
  constructor(private readonly storage: DurableObjectStorage) {}

  async register(marker: Marker): Promise<void> {
    await this.storage.transaction(tx => registerDelivery(tx, marker))
  }

  async alarm(deliver: (marker: Marker) => Promise<boolean>): Promise<void> {
    // Rearm before external work. A lost RPC/exception must not strand the marker.
    // Round-robin pages keep one slow audit from monopolizing an experiment.
    const markers = await this.storage.transaction(async tx => {
      const cursor = await tx.get<string>(cursorKey)
      let page = await tx.list<Marker>({ prefix, limit: controlDeliverySliceSize,
        ...(cursor === undefined ? {} : { startAfter: cursor }) })
      if (page.size === 0) page = await tx.list<Marker>({ prefix, limit: controlDeliverySliceSize })
      if (page.size === 0) { await tx.delete(cursorKey); await tx.deleteAlarm(); return page }
      await tx.put(cursorKey, [...page.keys()].at(-1)!)
      await armEarlier(tx, Date.now() + controlDeliveryRetryMs)
      return page
    })
    await Promise.all([...markers].map(async ([key, marker]) => {
      try {
        assertCoordinatorDelivery(marker)
        // Own delivery until it settles. An observation timeout does not cancel
        // the RPC and would allow the next alarm to start an overlapping copy.
        const settled = await deliver(marker)
        if (!settled) return
        await this.storage.transaction(async tx => {
          const current = await tx.get<Marker>(key)
          if (current !== undefined && canonicalJson(current) === canonicalJson(marker)) await tx.delete(key)
        })
      } catch {
        // An error does not revoke a command or its RPC.
        // Retry the same identity; the shared journal/state CAS reconciles it.
      }
    }))
    await this.storage.transaction(async tx => {
      const remaining = await tx.list({ prefix, limit: 1 })
      if (remaining.size === 0) { await tx.delete(cursorKey); await tx.deleteAlarm() }
      else await armEarlier(tx, Date.now() + controlDeliveryRetryMs)
    })
  }
}
