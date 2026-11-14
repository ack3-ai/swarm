import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
const start = source.indexOf("      if (request.method === 'GET' && runMatch !== undefined)")
const end = source.indexOf("      return json({ error: 'not found' }, 404)", start)
const route = new Function('request', 'runMatch', 'env', 'store', 'engineRole', 'json',
  'RuntimeRouter', 'pinnedRuntime', 'runtimeResponseBody',
  stripTypeScriptTypes(`async function handle() { ${source.slice(start, end)} }`) + '; return handle()')

it.each([false, true])('observes completed status without performing cleanup (retired=%s)', async retired => {
  const state = { status: 'completed', runtimeRelease: { runtimeId: 'pinned-runtime' } }
  const workflow = { status: 'complete' }
  const archive = vi.fn().mockRejectedValue(new Error('GET performed terminal cleanup'))
  const store = {
    retiredUnmaterializedRoute: vi.fn().mockResolvedValue(null),
    retiredRunWorkflow: vi.fn().mockResolvedValue(retired ? {
      workflow, disposition: 'terminal', cleanupProofDigest: 'verified', fenceProofDigest: null, retiredAt: 'recorded',
    } : null),
    getState: vi.fn().mockResolvedValue(state),
    runRuntime: vi.fn().mockResolvedValue(state.runtimeRelease),
    archiveCompletedRunAndReleaseLease: archive,
  }
  const fetch = vi.fn().mockResolvedValue(Response.json({ state, workflow }))
  const response = await route({ method: 'GET' }, 'saved-audit', {}, store, () => 'front-door',
    (value: unknown) => Response.json(value), class { fetch = fetch }, (value: unknown) => value,
    (value: Response) => value.json())
  expect(await response.json()).toMatchObject({ state, workflow, runtimeRelease: state.runtimeRelease })
  expect(archive).not.toHaveBeenCalled()
  expect(store.getState).toHaveBeenCalledTimes(retired ? 1 : 0)
  if (!retired) expect(fetch).toHaveBeenCalledWith(state.runtimeRelease, '/internal/runtime/audit-runs/saved-audit')
})
