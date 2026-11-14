import { expect, it } from 'vitest'
import { engineRole } from '../src/env.js'

it('does not turn a missing Worker role into a monolith executor', () => {
  expect(() => engineRole({})).toThrow('ENGINE_ROLE must be front-door or runtime')
  expect(engineRole({ ENGINE_ROLE: 'front-door' })).toBe('front-door')
  expect(engineRole({ ENGINE_ROLE: 'runtime' })).toBe('runtime')
  expect(() => engineRole({ ENGINE_ROLE: 'legacy-monolith' } as any)).toThrow('ENGINE_ROLE must be front-door or runtime')
})
