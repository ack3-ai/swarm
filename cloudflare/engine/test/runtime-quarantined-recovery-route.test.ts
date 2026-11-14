import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'

it.each(['resumes', 'recoveries', 'discovery-waivers', 'terminal-recoveries',
  'retire-unmaterialized-recovery', 'retire-failed-native'].flatMap(route =>
  [{}, { promoteExecution: {} }, { repairQuarantined: {} }, { retainNative: {} }].map(body => ({ route, body }))))(
  'refuses retired runtime $route without reading or creating work ($body)', async ({ route: endpoint, body }) => {
    const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
    const start = source.indexOf('export async function runtimeServiceRoute(')
    expect(start).toBeGreaterThan(-1)
    const code = stripTypeScriptTypes(source.slice(start).replace('export async', 'async'))
    const route = new Function('engineRole', 'response', `${code}; return runtimeServiceRoute;`)(
      () => 'runtime', (_env: unknown, value: unknown, status: number) => Response.json(value, { status }),
    )
    const request = new Request(`https://runtime.internal/internal/runtime/audit-${endpoint}`, { method: 'POST', body: JSON.stringify(body) })
    const read = vi.spyOn(request, 'json').mockRejectedValue(new Error('retired route must not read intent'))
    const response = await route(request, {})
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: 'not found' })
    expect(read).not.toHaveBeenCalled()
  })
