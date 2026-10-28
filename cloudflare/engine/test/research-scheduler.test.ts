import { describe, expect, it } from 'vitest'
import { researchPoolNamespace, researchTaskPoolId, scheduleResearchPoolLanes } from '../src/research-scheduler.js'

function lanes(wave: number, pools: readonly { id: string, seats: number }[]) {
  return Object.fromEntries(scheduleResearchPoolLanes(wave, pools).assignments
    .map(assignment => [assignment.poolId, assignment.lanes]))
}

describe('model-independent research scheduling', () => {
  it('rotates a smaller pool over a larger pool in complete fair cycles', () => {
    const pools = [{ id: 'luna', seats: 4 }, { id: 'deepseek', seats: 2 }]
    expect(lanes(0, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2] })
    expect(lanes(1, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [3, 4] })
    expect(lanes(2, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2] })
  })

  it('uses the same rule when the formerly additive pool is larger', () => {
    const pools = [{ id: 'luna', seats: 2 }, { id: 'deepseek', seats: 4 }]
    expect(lanes(0, pools)).toEqual({ luna: [1, 2], deepseek: [1, 2, 3, 4] })
    expect(lanes(1, pools)).toEqual({ luna: [3, 4], deepseek: [1, 2, 3, 4] })
  })

  it('maps equal pools one-to-one without meaningless rotation', () => {
    const pools = [{ id: 'luna', seats: 4 }, { id: 'deepseek', seats: 4 }]
    expect(lanes(0, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2, 3, 4] })
    expect(lanes(17, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2, 3, 4] })
  })

  it('schedules any number of pools without model-name branches', () => {
    const pools = [
      { id: 'luna', seats: 4 },
      { id: 'deepseek', seats: 2 },
      { id: 'third-model', seats: 1 },
    ]
    expect(lanes(0, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2], 'third-model': [1] })
    expect(lanes(1, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [3, 4], 'third-model': [2] })
    expect(lanes(2, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [1, 2], 'third-model': [3] })
    expect(lanes(3, pools)).toEqual({ luna: [1, 2, 3, 4], deepseek: [3, 4], 'third-model': [4] })
  })

  it('rejects duplicate pools and oversubscribed explicit lane sets', () => {
    expect(() => scheduleResearchPoolLanes(0, [{ id: 'same', seats: 1 }, { id: 'same', seats: 1 }]))
      .toThrow('duplicate research pool id')
    expect(() => scheduleResearchPoolLanes(0, [{ id: 'large', seats: 3 }], 2))
      .toThrow('more seats than logical lanes')
  })

  it('uses stable pool namespaces without changing the legacy names', () => {
    expect(researchTaskPoolId('core-wave-2-research-1', 'core')).toBe('luna')
    expect(researchTaskPoolId('additive-wave-2-research-1', 'additive')).toBe('deepseek')
    expect(researchTaskPoolId('pool-third-model-wave-2-research-1', 'core')).toBe('third-model')
    expect(researchPoolNamespace('third.model')).toBe('THIRD-MODEL')
  })
})
