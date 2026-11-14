import { canonicalJson } from './canonical.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import { RuntimeRouter } from './runtime-release.js'
import type { Env } from './env.js'
import { RunCommandRejected, type StageForkCommand } from './run-commands.js'

/** Route interpretation to the immutable source runtime, never the current front door. */
export async function requestSavedWorkExport(env: Env, command: StageForkCommand): Promise<string> {
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const runtime = await store.runRuntime(command.source.runId)
  if (runtime === null) throw new Error('source runtime is unavailable')
  const response = await new RuntimeRouter(env).fetch(runtime, '/internal/runtime/saved-work', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: canonicalJson(command),
  })
  if (!response.ok) {
    // Only the source version can say why its saved state cannot be forked.
    const body = await response.json<{ error?: unknown, code?: unknown }>().catch(() => ({ error: undefined, code: undefined }))
    const reason = typeof body.error === 'string' && body.error !== '' ? body.error.slice(0, 500) : undefined
    if (reason !== undefined && typeof body.code === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(body.code)) {
      throw new RunCommandRejected(body.code, reason)
    }
    throw new Error(`source version cannot export saved work: ${response.status}${reason === undefined ? '' : ` (${reason})`}`)
  }
  const result = await response.json<{ digest?: string }>()
  if (!/^[a-f0-9]{64}$/.test(result.digest ?? '')) throw new Error('source version returned an invalid export digest')
  return result.digest!
}
