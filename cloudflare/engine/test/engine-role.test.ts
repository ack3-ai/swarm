import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
const engineRole = new Function(`${stripTypeScriptTypes(source.slice(
  source.indexOf('export function engineRole'), source.indexOf('export function assertLocalRuntime'),
).replace('export function', 'function'))}; return engineRole;`)() as
  (env: { ENGINE_ROLE?: 'legacy-monolith' | 'front-door' | 'runtime' }) => string

it('does not turn a missing Worker role into a monolith executor', () => {
  expect(() => engineRole({})).toThrow('ENGINE_ROLE must be front-door or runtime')
  expect(engineRole({ ENGINE_ROLE: 'front-door' })).toBe('front-door')
  expect(engineRole({ ENGINE_ROLE: 'runtime' })).toBe('runtime')
  expect(() => engineRole({ ENGINE_ROLE: 'legacy-monolith' })).toThrow('ENGINE_ROLE must be front-door or runtime')
})
