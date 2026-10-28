import type { TaskDefinition } from './contracts.js'

export const nativeDshHttp2PreloadPath = '/control/native-dsh-http2.cjs'

/** All direct native DSH lanes use the same HTTP/2-capable client. */
export function usesNativeDshHttp2(task: TaskDefinition): boolean {
  if (task.providerClass !== 'additive' || task.backend !== 'dsh-chat-completions'
    || task.connection === undefined) return false
  const endpoint = new URL(task.connection.baseUrl)
  return endpoint.protocol === 'https:' && endpoint.username === '' && endpoint.password === ''
}

export function nativeDshDiagnosticEndpoint(task: TaskDefinition): { origin: string, path: string } {
  if (!usesNativeDshHttp2(task)) throw new TypeError('native DSH HTTP/2 endpoint is unavailable')
  const endpoint = new URL(task.connection!.baseUrl)
  return { origin: endpoint.origin, path: `${endpoint.pathname.replace(/\/$/, '')}/chat/completions` }
}

export function withNativeDshHttp2NodeOptions(existing: string | undefined): string {
  return [existing, `--require=${nativeDshHttp2PreloadPath}`].filter(Boolean).join(' ')
}

// NODE_OPTIONS is inherited by DSH tools. The entrypoint guard makes their
// Node processes no-ops while selecting the transport for DSH itself.
export const nativeDshHttp2PreloadSource = `
const { realpathSync } = require('node:fs')
let entry = null
try { entry = realpathSync(process.argv[1] || '') } catch {}
if (entry === '/opt/harness/node_modules/@deepseek-ai/dsh/lib/bin.js') {
  const undici = require('/opt/harness/node_modules/undici')
  undici.setGlobalDispatcher(new undici.Agent({ allowH2: true, h2Options: { pingInterval: 60_000 } }))
  undici.install()
  const channel = require('node:diagnostics_channel').channel('undici:request:error')
  channel.subscribe(({ request, error }) => {
    if (String(request?.origin) !== process.env.ACK3_DSH_DIAGNOSTIC_ORIGIN
      || request?.path !== process.env.ACK3_DSH_DIAGNOSTIC_PATH) return
    // DSH aborts its stream consumer after a successful [DONE] response.
    if (error?.name === 'AbortError' && error?.code === 20) return
    const field = value => typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value) ? value : null
    process.stderr.write(JSON.stringify({ kind: 'native-dsh-transport-diagnostic',
      name: field(error?.name), code: field(error?.code), causeCode: field(error?.cause?.code) }) + '\\n')
  })
}
`
