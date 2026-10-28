import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { TaskDefinition } from '../src/contracts.js'
import {
  nativeDshDiagnosticEndpoint,
  nativeDshHttp2PreloadPath,
  nativeDshHttp2PreloadSource,
  usesNativeDshHttp2,
  withNativeDshHttp2NodeOptions,
} from '../src/native-dsh-http2.js'

const task = {
  providerClass: 'additive', backend: 'dsh-chat-completions', provider: 'provider-a',
  connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
} as TaskDefinition

it('selects every direct native DSH connection with the same transport options', () => {
  const providerB = { ...task, provider: 'provider-b', connection: {
    baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY',
  } } as TaskDefinition
  expect(usesNativeDshHttp2(task)).toBe(true)
  expect(usesNativeDshHttp2(providerB)).toBe(true)
  expect(usesNativeDshHttp2({ ...task, providerClass: 'core' })).toBe(false)
  expect(usesNativeDshHttp2({ ...task, backend: 'codex' })).toBe(false)
  expect(usesNativeDshHttp2({ ...task, connection: { ...task.connection!, baseUrl: 'http://127.0.0.1/v1' } })).toBe(false)
  expect(nativeDshDiagnosticEndpoint(task)).toEqual({ origin: 'https://llm-a.example.com', path: '/v1/chat/completions' })
  expect(nativeDshDiagnosticEndpoint(providerB)).toEqual({ origin: 'https://llm-b.example.com', path: '/v1/chat/completions' })
  expect(withNativeDshHttp2NodeOptions('--trace-warnings')).toBe(`--trace-warnings --require=${nativeDshHttp2PreloadPath}`)
  expect(withNativeDshHttp2NodeOptions(undefined)).toBe(`--require=${nativeDshHttp2PreloadPath}`)
})

it('installs HTTP/2 only in the DSH entrypoint and emits bounded transport codes', () => {
  const options: unknown[] = [], writes: string[] = []
  let onError: ((event: any) => void) | undefined
  const install = vi.fn(), setGlobalDispatcher = vi.fn()
  const undici = { Agent: class { constructor(value: unknown) { options.push(value) } }, install, setGlobalDispatcher }
  const run = (entry: string) => runInNewContext(nativeDshHttp2PreloadSource, {
    process: { argv: ['node', entry], env: { ACK3_DSH_DIAGNOSTIC_ORIGIN: 'https://llm-b.example.com',
      ACK3_DSH_DIAGNOSTIC_PATH: '/v1/chat/completions' },
      stderr: { write: (value: string) => writes.push(value) } },
    require: (name: string) => {
      if (name === 'node:fs') return { realpathSync: () => entry }
      if (name === '/opt/harness/node_modules/undici') return undici
      if (name === 'node:diagnostics_channel') return { channel: () => ({ subscribe: (callback: typeof onError) => { onError = callback } }) }
      throw new Error(`unexpected require: ${name}`)
    },
  })
  run('/usr/local/bin/ack3-agent-runner')
  run('/workspace/source/tool.mjs')
  expect(install).not.toHaveBeenCalled()
  run('/opt/harness/node_modules/@deepseek-ai/dsh/lib/bin.js')
  expect(options).toEqual([{ allowH2: true, h2Options: { pingInterval: 60_000 } }])
  expect(setGlobalDispatcher).toHaveBeenCalledOnce()
  expect(install).toHaveBeenCalledOnce()
  onError!({ request: { origin: 'https://llm-b.example.com', path: '/v1/chat/completions' },
    error: { name: 'SocketError', code: 'UND_ERR_SOCKET', message: 'secret-do-not-log' } })
  onError!({ request: { origin: 'https://unrelated.example', path: '/v1/chat/completions' },
    error: { name: 'SocketError', code: 'UND_ERR_SOCKET' } })
  onError!({ request: { origin: 'https://llm-b.example.com', path: '/v1/chat/completions' },
    error: { name: 'AbortError', code: 20 } })
  expect(writes).toHaveLength(1)
  expect(JSON.parse(writes[0]!)).toEqual({ kind: 'native-dsh-transport-diagnostic',
    name: 'SocketError', code: 'UND_ERR_SOCKET', causeCode: null })
  expect(writes[0]).not.toContain('secret-do-not-log')
})
