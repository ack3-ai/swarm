export interface ResearchPoolCapacity {
  id: string
  seats: number
}

export interface ResearchPoolLaneAssignment {
  poolId: string
  lanes: readonly number[]
}

export function researchPoolNamespace(poolId: string): string {
  const namespace = poolId.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (namespace === '') throw new TypeError(`research pool ${poolId} has no usable namespace`)
  return namespace
}

export function researchTaskPoolId(taskId: string, providerClass: 'core' | 'additive' | 'deterministic'): string {
  const generic = taskId.match(/^pool-(.+)-wave-\d+-research-\d+$/)?.[1]
  if (generic !== undefined) return generic
  if (providerClass === 'deterministic') throw new TypeError(`deterministic task ${taskId} has no research pool`)
  return providerClass === 'additive' ? 'deepseek' : 'luna'
}

export function configuredResearchTaskPoolId(task: {
  id: string
  providerClass: 'core' | 'additive' | 'deterministic'
  modelPool?: string
}): string {
  return task.modelPool ?? researchTaskPoolId(task.id, task.providerClass)
}

export function researchObservationPrefix(
  task: { id: string; providerClass: 'core' | 'additive' | 'deterministic'; modelPool?: string },
  assignment: { wave: number; researcher: number },
): string {
  return `OBS-${researchPoolNamespace(configuredResearchTaskPoolId(task))}-W${assignment.wave}-R${assignment.researcher}-`
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`)
}

/**
 * Assign every model pool to logical research lanes without choosing a primary
 * model. Pools with fewer seats rotate over the lane set; a pool with one seat
 * per lane covers the complete schedule on every wave.
 */
export function scheduleResearchPoolLanes(
  wave: number,
  pools: readonly ResearchPoolCapacity[],
  configuredLaneCount?: number,
): { laneCount: number, assignments: readonly ResearchPoolLaneAssignment[] } {
  if (!Number.isSafeInteger(wave) || wave < 0) throw new TypeError('wave must be a non-negative integer')
  if (pools.length === 0) throw new TypeError('at least one research pool is required')
  const ids = new Set<string>()
  for (const pool of pools) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(pool.id)) throw new TypeError(`invalid research pool id: ${pool.id}`)
    if (ids.has(pool.id)) throw new TypeError(`duplicate research pool id: ${pool.id}`)
    positiveInteger(pool.seats, `research pool ${pool.id} seats`)
    ids.add(pool.id)
  }
  const laneCount = configuredLaneCount ?? Math.max(...pools.map(pool => pool.seats))
  positiveInteger(laneCount, 'research lane count')
  for (const pool of pools) {
    if (pool.seats > laneCount) {
      throw new TypeError(`research pool ${pool.id} has more seats than logical lanes`)
    }
  }
  return {
    laneCount,
    assignments: pools.map(pool => {
      const start = (wave * pool.seats) % laneCount
      return {
        poolId: pool.id,
        lanes: Array.from({ length: pool.seats }, (_, index) => ((start + index) % laneCount) + 1)
          .toSorted((left, right) => left - right),
      }
    }),
  }
}
