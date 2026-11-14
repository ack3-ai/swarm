import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'

it.each(['stop', 'stop-now', 'retire-sealed-stopped', 'retire-terminal-failed'])('rejects obsolete %s without reading state, dispatching or parsing a payload', async suffix => {
  const runtime = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(runtime.slice(runtime.indexOf('export async function runtimeServiceRoute('))
    .replace('export async', 'async'))
  const route = new Function('engineRole', 'response', `${code}; return runtimeServiceRoute;`)(
    () => 'runtime', (_env: unknown, value: unknown, status: number) => Response.json(value, { status }))
  const env = new Proxy({}, { get() { throw new Error('retired stop touched a binding') } })
  const request = new Request(`https://runtime.internal/internal/runtime/audit-runs/saved-audit/${suffix}`, { method: 'POST' })
  const read = vi.spyOn(request, 'json').mockRejectedValue(new Error('retired stop parsed a payload'))
  expect((await route(request, env)).status).toBe(404)
  expect(read).not.toHaveBeenCalled()

  const front = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = front.indexOf('      const runMatch =', front.indexOf('export default'))
  expect(start).toBeGreaterThan(-1)
  const stopRoute = front.slice(start, front.indexOf('    } catch (error)', start))
  const handle = new Function('json', `${stripTypeScriptTypes(`async function handle(request, url) { ${stopRoute} }`)}; return handle;`)(
    (value: unknown, status: number) => Response.json(value, { status }))
  const result = await handle(request, new URL(`https://control.invalid/v1/runs/saved-audit/${suffix}`))
  expect(result.status).toBe(404)
  expect(await result.json()).toMatchObject({ error: 'not found' })
})
