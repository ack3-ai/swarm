import { spawn } from 'node:child_process'
import { codexSubscriptionLimits } from './subscription-limits.mjs'

/** Read the supported app-server endpoint, outside the model execution loop. */
export function readCodexSubscription(env, { command = 'codex', prefix = [], timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    const child = spawn(command, [...prefix, 'app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    let settled = false
    const finish = response => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      resolve(codexSubscriptionLimits(response))
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    child.stdin.on('error', () => finish(null))
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.length > 1024 * 1024) { finish(null); return }
      let index
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (message.id === 1) {
          if (message.error) { finish(null); return }
          send({ method: 'initialized', params: {} })
          send({ id: 2, method: 'account/rateLimits/read' })
        } else if (message.id === 2) finish(message.result)
      }
    })
    send({ id: 1, method: 'initialize',
      params: { clientInfo: { name: 'swarm', title: 'Swarm', version: '1' } } })
  })
}
