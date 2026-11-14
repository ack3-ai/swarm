import { afterEach, describe, expect, it, vi } from 'vitest'
import { observeExpiredFixture } from '../src/fixture-native-observation.js'
import type { TerminalFixtureRetirementProof } from '../src/terminal-fixture-retirement.js'
import type { Env } from '../src/env.js'

const account = 'a'.repeat(32), app = 'b'.repeat(32)
const proof = { runId: 'expired-fixture', sandboxNamespaceId: app, containerApplicationId: app,
  runtimeRelease: { workerService: 'swarm-runtime-a', workflowName: 'audit-runtime-a' },
} as TerminalFixtureRetirementProof
const env = { ACK3_CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_OBSERVABILITY_TOKEN: { get: async () => 'test-native-read-token' },
} as unknown as Env
const settings = { bindings: [
  { name: 'AGENT_SANDBOX', type: 'durable_object_namespace', namespace_id: app },
  { name: 'AUDIT_WORKFLOW', workflow_name: 'audit-runtime-a' },
  { name: 'RUNTIME_ISOLATION_WORKFLOW', workflow_name: 'audit-runtime-a-isolation' },
] }
const missing = { success: false, errors: [{ code: 10400 }], result: null }
const page = { success: true, result: { instances: [], durable_objects: [] }, result_info: { per_page: 100 } }
function nativeFetch(change?: (path: string) => Response | undefined) {
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    expect(new URL(url).origin).toBe('https://api.cloudflare.com')
    expect(new URL(url).pathname).toContain(`/accounts/${account}/`)
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({ authorization: 'Bearer test-native-read-token' })
    expect(init.method).toBeUndefined()
    const custom = change?.(url)
    if (custom) return custom
    if (url.endsWith('/settings')) return Response.json({ success: true, result: settings })
    if (url.includes('/workflows/')) return Response.json(missing, { status: 404 })
    if (url.includes('/dash/')) return Response.json(page)
    return Response.json({ success: true, result: { id: app } })
  })
  vi.stubGlobal('fetch', mock)
  return mock
}
afterEach(() => vi.unstubAllGlobals())
describe('authenticated native fixture observation', () => {
  it('reads both native Workflows and the complete application inventory using the bound credential', async () => {
    const fetch = nativeFetch()
    const result = await observeExpiredFixture(env, proof)
    expect(fetch).toHaveBeenCalledTimes(5)
    expect(result).toMatchObject({ accountId: account,
      audit: { httpStatus: 404, body: missing }, isolation: { httpStatus: 404, body: missing },
      inventory: { application: { id: app }, pages: [{ pageToken: null, response: page }] },
    })
  })
  it('does not turn a live Workflow response into a caller-supplied missing receipt', async () => {
    nativeFetch(path => path.includes('/workflows/')
      ? Response.json({ success: true, result: { status: 'running' } }) : undefined)
    expect((await observeExpiredFixture(env, proof)).isolation.httpStatus).toBe(200)
  })
  it('rejects redirects before consuming their body or following Location', async () => {
    const fetch = nativeFetch(() => Response.json({ success: true, result: settings }, {
      status: 302, headers: { location: 'https://outside.example/native' },
    }))
    await expect(observeExpiredFixture(env, proof)).rejects.toThrow('observation redirected')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('fails closed without credentials', async () => {
    const fetch = nativeFetch()
    await expect(observeExpiredFixture({ ACK3_CLOUDFLARE_ACCOUNT_ID: account } as unknown as Env, proof))
      .rejects.toThrow('credential is not configured')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not accept authorization errors or a different Sandbox binding', async () => {
    nativeFetch(() => Response.json({ success: false }, { status: 403 }))
    await expect(observeExpiredFixture(env, proof)).rejects.toThrow('observation is unavailable')
    nativeFetch(path => path.endsWith('/settings') ? Response.json({ success: true, result: { bindings: [] } }) : undefined)
    await expect(observeExpiredFixture(env, proof)).rejects.toThrow('runtime bindings differ')
  })
  it('reads subsequent inventory pages and rejects a repeated cursor', async () => {
    const fetch = nativeFetch(path => path.includes('/dash/') ? Response.json({ ...page,
      result_info: { per_page: 100, next_page_token: 'next' } }) : undefined)
    await expect(observeExpiredFixture(env, proof)).rejects.toThrow('pagination is invalid')
    expect(fetch.mock.calls.at(-1)?.[0]).toContain('page_token=next')
  })
})
