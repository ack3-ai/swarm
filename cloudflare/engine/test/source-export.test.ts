import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { RuntimeRouter } from '../src/runtime-release.js'
import { requestSavedWorkExport } from '../src/source-export.js'
import type { Env } from '../src/env.js'
import { RunCommandRejected, type StageForkCommand } from '../src/run-commands.js'
import { runtime, target } from './support/successor-fixture.js'

const { workerVersionId: _version, ...declaration } = runtime
const env = { RUNTIME_CATALOG_JSON: JSON.stringify({ schemaVersion: 1, latest: runtime.id,
  releases: { [runtime.id]: { ...declaration, binding: 'RUNTIME_SOURCE' } } }) } as Env
const command: StageForkCommand = { action: 'fork', id: 'change-review', reason: 'replace reviewers', expectedRevision: 0,
  source: { runId: 'source', state: { generation: 12, digest: 'a'.repeat(64) } },
  stageId: 'negative-review', releaseDigest: 'b'.repeat(64), runtimeRelease: target }
afterEach(() => vi.restoreAllMocks())

it('asks the pinned source runtime to interpret its records, never the destination', async () => {
  const route = vi.spyOn(CloudflareRunStore.prototype, 'runRuntime').mockResolvedValue(runtime)
  const fetch = vi.spyOn(RuntimeRouter.prototype, 'fetch').mockResolvedValue(Response.json({ digest: 'c'.repeat(64) }))
  expect(await requestSavedWorkExport(env, command)).toBe('c'.repeat(64))
  expect(route).toHaveBeenCalledExactlyOnceWith('source')
  expect(fetch).toHaveBeenCalledOnce()
  const [selected, path, request] = fetch.mock.calls[0]!
  expect(selected).toEqual(runtime)
  expect(path).toBe('/internal/runtime/saved-work')
  expect(JSON.parse(request!.body as string)).toEqual(command)
})

it.each([404, 503])('does not interpret old records locally when their source returns %s', async status => {
  vi.spyOn(CloudflareRunStore.prototype, 'runRuntime').mockResolvedValue(runtime)
  const fetch = vi.spyOn(RuntimeRouter.prototype, 'fetch').mockResolvedValue(new Response(null, { status }))
  const read = vi.spyOn(CloudflareRunStore.prototype, 'getStateAt')
  await expect(requestSavedWorkExport(env, command)).rejects.toThrow(`source version cannot export saved work: ${status}`)
  expect(fetch).toHaveBeenCalledOnce()
  expect(read).not.toHaveBeenCalled()
})

it('refuses a missing source route before contacting any runtime', async () => {
  vi.spyOn(CloudflareRunStore.prototype, 'runRuntime').mockResolvedValue(null)
  const fetch = vi.spyOn(RuntimeRouter.prototype, 'fetch')
  await expect(requestSavedWorkExport(env, command)).rejects.toThrow('source runtime is unavailable')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([
  [new RunCommandRejected('fork-source-unsettled', 'source has unsettled work'),
    { code: 'fork-source-unsettled', message: 'source has unsettled work' }],
  [new Error('state digest differs'), { message: 'source version cannot export saved work: 409 (state digest differs)' }],
])('passes the source runtime reason for a refused export to the operator (%s)', async (failure, expected) => {
  const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export async function runtimeServiceRoute('))
    .replace('export async', 'async'))
  const route = new Function('engineRole', 'response', 'CloudflareRunStore', 'localRuntimeRelease', 'RunCommandRejected',
    `${code}; return runtimeServiceRoute;`)(() => 'runtime',
    (_env: unknown, value: unknown, status = 200) => Response.json(value, { status }),
    class { async exportStageFork() { throw failure } }, () => runtime, RunCommandRejected)
  vi.spyOn(CloudflareRunStore.prototype, 'runRuntime').mockResolvedValue(runtime)
  vi.spyOn(RuntimeRouter.prototype, 'fetch').mockImplementation(async (_selected, path, init) =>
    route(new Request(`https://runtime.internal${path}`, init), {}))
  const error = await requestSavedWorkExport(env, command).catch((value: unknown) => value)
  expect(error instanceof RunCommandRejected).toBe('code' in expected)
  expect(error).toMatchObject(expected)
})
