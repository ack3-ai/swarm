import type { DiscoveryCohortAdmission, DiscoverySchedulerState, ExperimentDefinition, JournalEvent, WaveReceipt } from './contracts.js'
import { discoveryPoolIds } from './manifest-amendment.js'

/** The same transition rules serve live execution and read-only evidence verification. */
export function initialDiscoveryProgress(definition: ExperimentDefinition, stageId: string): DiscoverySchedulerState {
  if (!definition.stages.some(stage => stage.id === stageId && stage.kind === 'discovery')) {
    throw new Error('discovery stage is missing')
  }
  return { stageId, materialEpoch: 0, admissions: [], pools: discoveryPoolIds(definition).map(poolId => ({
    poolId, nextWaveIndex: 0, quietCohorts: 0, quietEpoch: 0, parked: false,
  })) }
}

export function completeDiscoveryProgress(scheduler: DiscoverySchedulerState, admission: DiscoveryCohortAdmission,
  input: { materialDelta: boolean; unavailable: boolean; stopOnSaturation: boolean; coalesced: boolean }): DiscoverySchedulerState {
  let materialEpoch = scheduler.materialEpoch
  let pools = scheduler.pools.map(pool => ({ ...pool }))
  if (input.coalesced && !input.materialDelta) throw new Error('only material discovery can be coalesced')
  if (input.materialDelta) {
    if (!input.coalesced) materialEpoch++
    pools = pools.map(pool => ({ ...pool, quietCohorts: 0, quietEpoch: materialEpoch, parked: false }))
  }
  const pool = pools.find(candidate => candidate.poolId === admission.poolId)
  if (pool === undefined || pool.nextWaveIndex !== admission.waveIndex
    || !scheduler.admissions.includes(admission)) throw new Error('discovery completion differs from its admission')
  pool.nextWaveIndex = admission.waveIndex + 1
  if (!input.materialDelta && !input.unavailable
    && admission.waveIndex > 0 && admission.materialEpoch === materialEpoch) {
    pool.quietEpoch = materialEpoch
    pool.quietCohorts++
    pool.parked = input.stopOnSaturation && pool.quietCohorts >= 2
  } else if (!input.materialDelta && (input.unavailable || admission.materialEpoch !== materialEpoch)) {
    pool.quietCohorts = 0
    pool.quietEpoch = materialEpoch
    pool.parked = false
  }
  return { ...scheduler, materialEpoch, pools, admissions: scheduler.admissions.filter(candidate => candidate !== admission) }
}

/** No work may have been admitted using an earlier completion before another
 * completion shares its epoch. This makes coalescing verifiable without clocks
 * or reconstructing transient Promise batches.
 */
export function discoveryCoalescingPredecessor(journal: readonly JournalEvent[], stageId: string): WaveReceipt | undefined {
  for (let index = journal.length - 1; index >= 0; index--) {
    const event = journal[index]!
    if (event.type === 'discovery.cohort-admitted' || event.type === 'stage.ended') return undefined
    if (event.type === 'discovery.cohort-completed') {
      const receipt = event.payload as WaveReceipt
      if (receipt.stageId !== stageId) return undefined
      if (receipt.materialHighCriticalDelta === true) return receipt
    }
  }
  return undefined
}
