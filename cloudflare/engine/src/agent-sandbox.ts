import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.js'
import type {
  AgentSandboxSettings, SandboxExecOptions, SandboxExecResult, SandboxProcessStatus,
} from './agent-sandbox-client.js'
import { containerCapacity } from './container-resource-diagnostics.js'

// One agent workspace: a Durable Object that starts and owns its container through
// Cloudflare's Durable Object container API (scheduling policy `durable_object`).
// It keeps the calls and result shapes the engine used with Sandbox SDK 0.12.

interface StoredSettings {
  inactivityTimeoutMs: number
  keepAlive: boolean
}

// Sandbox SDK 0.12's default sleepAfter.
const defaultSettings: StoredSettings = { inactivityTimeoutMs: 10 * 60_000, keepAlive: false }
const maxInactivityTimeoutMs = 6 * 60 * 60_000
const processRoot = '/var/lib/ack3-processes'
const processIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

// Runs a command in its own process group and records its process ID and exit
// code, so later requests can observe it after the starting request ends.
export const runProcessScript = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
  "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

export const processStateScript = `dir=$1
if [ ! -d "$dir" ]; then echo missing
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
elif [ ! -e "$dir/pid" ]; then echo starting
elif read -r pid boot <"$dir/pid" && [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] \\
  && kill -0 "$pid" 2>/dev/null; then echo running
elif [ -e "$dir/exit-code" ]; then echo "exited $(cat "$dir/exit-code")"
else echo lost
fi`

function containerLabels(labels: Readonly<Record<string, string>> = {}): Record<string, string> {
  // Container labels allow 10 entries, 16-byte names and 64-byte values.
  const printable = (value: string, bytes: number) => value.replace(/[^\x20-\x7e]/g, '').slice(0, bytes)
  return Object.fromEntries(Object.entries(labels).slice(0, 10)
    .map(([name, value]) => [printable(name, 16), printable(value, 64)])
    .filter(([name]) => name !== ''))
}

// An alarm is Durable Object activity, so one that fires well inside the
// inactivity timeout keeps the container running.
function keepAliveIntervalMs(inactivityTimeoutMs: number): number {
  return Math.max(1_000, Math.min(5 * 60_000, Math.floor(inactivityTimeoutMs / 3)))
}

export class AgentSandbox extends DurableObject<Env> {
  private stored: StoredSettings | undefined
  private appliedTimeoutMs: number | undefined
  private environment: Record<string, string> | undefined

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // A restarted Durable Object starts without an inactivity timeout, even
    // when its container is still running.
    if (ctx.container?.running) void ctx.blockConcurrencyWhile(() => this.applyInactivityTimeout())
  }

  async exec(settings: AgentSandboxSettings, command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    await this.ready(settings)
    const timeout = options.timeout
    if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) throw new TypeError('command timeout is invalid')
    const startedAt = Date.now()
    // `timeout` runs the command in its own process group and stops the whole group.
    const result = await this.run(timeout === undefined ? ['bash', '-c', command]
      : ['timeout', '--kill-after=5s', `${timeout / 1_000}s`, 'bash', '-c', command], options)
    if (timeout !== undefined && [124, 137].includes(result.exitCode) && Date.now() - startedAt >= timeout) {
      throw new Error(`command timed out after ${timeout} ms`)
    }
    return { success: result.exitCode === 0, ...result, command }
  }

  async writeFile(settings: AgentSandboxSettings, path: string,
    content: string | ReadableStream<Uint8Array>): Promise<{ success: true, path: string }> {
    await this.ready(settings)
    const result = await this.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >"$1"', 'sh', path],
      { stdin: typeof content === 'string' ? new Blob([content]).stream() : content })
    if (result.exitCode !== 0) throw new Error(`file write failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, path }
  }

  async readFile(settings: AgentSandboxSettings, path: string,
    options: { encoding?: 'base64' } = {}): Promise<{ success: true, path: string, content: string }> {
    await this.ready(settings)
    const result = await this.run(options.encoding === 'base64' ? ['base64', '-w0', '--', path] : ['cat', '--', path])
    if (result.exitCode !== 0) throw new Error(`file read failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, path, content: result.stdout }
  }

  async exists(settings: AgentSandboxSettings, path: string): Promise<{ success: true, exists: boolean }> {
    await this.ready(settings)
    const result = await this.run(['test', '-e', path])
    if (result.exitCode > 1) throw new Error(`file check failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, exists: result.exitCode === 0 }
  }

  async mkdir(settings: AgentSandboxSettings, path: string,
    options: { recursive?: boolean } = {}): Promise<{ success: true }> {
    await this.ready(settings)
    const result = await this.run(['mkdir', ...(options.recursive === true ? ['-p'] : []), '--', path])
    if (result.exitCode !== 0) throw new Error(`directory creation failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true }
  }

  async deleteFile(settings: AgentSandboxSettings, path: string): Promise<{ success: true }> {
    await this.ready(settings)
    const result = await this.run(['rm', '--', path])
    if (result.exitCode !== 0) throw new Error(`file deletion failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true }
  }

  async startProcess(settings: AgentSandboxSettings, command: string,
    options: { processId: string, cwd?: string, env?: Record<string, string> }): Promise<SandboxProcessStatus> {
    const container = await this.ready(settings)
    if (!processIdPattern.test(options.processId)) throw new TypeError('process ID is invalid')
    const directory = `${processRoot}/${options.processId}`
    const created = await this.run(['sh', '-c', 'mkdir -p -m 0700 "$1" && mkdir -m 0700 "$2"', 'sh', processRoot, directory])
    if (created.exitCode !== 0) throw new Error(`Process ${options.processId} already exists`)
    // The process keeps running after this request ends; its state lives in its directory.
    await container.exec(['sh', '-c', runProcessScript, 'sh', directory, 'bash', '-c', command], {
      cwd: options.cwd ?? '/workspace',
      env: { ...await this.commandEnvironment(), ...options.env },
      stdout: 'ignore', stderr: 'ignore',
    })
    let status: SandboxProcessStatus | null = 'starting'
    for (let check = 0; check < 50 && status === 'starting'; check += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      status = await this.processState(options.processId)
    }
    return status ?? 'error'
  }

  async processStatus(settings: AgentSandboxSettings, processId: string): Promise<SandboxProcessStatus | null> {
    await this.ready(settings)
    if (!processIdPattern.test(processId)) throw new TypeError('process ID is invalid')
    return this.processState(processId)
  }

  /** Apply lifetime settings without starting a container. */
  async configure(settings: AgentSandboxSettings): Promise<void> {
    await this.applySettings(settings)
    if (this.ctx.container?.running) await this.applyInactivityTimeout()
  }

  async destroy(): Promise<void> {
    await this.applySettings({ keepAlive: false })
    this.environment = undefined
    this.appliedTimeoutMs = undefined
    if (this.ctx.container?.running) await this.container.destroy()
  }

  async alarm(): Promise<void> {
    const settings = await this.applySettings({})
    if (!settings.keepAlive || this.ctx.container?.running !== true) return
    await this.applyInactivityTimeout()
    await this.ctx.storage.setAlarm(Date.now() + keepAliveIntervalMs(settings.inactivityTimeoutMs))
  }

  private get container(): Container {
    const container = this.ctx.container
    if (container === undefined) throw new Error('no container is configured for agent sandboxes')
    return container
  }

  private async applySettings(update: AgentSandboxSettings): Promise<StoredSettings> {
    const current = this.stored ??= await this.ctx.storage.get<StoredSettings>('settings') ?? defaultSettings
    const next: StoredSettings = {
      inactivityTimeoutMs: update.inactivityTimeoutMs ?? current.inactivityTimeoutMs,
      keepAlive: update.keepAlive ?? current.keepAlive,
    }
    if (!Number.isSafeInteger(next.inactivityTimeoutMs) || next.inactivityTimeoutMs < 1_000
      || next.inactivityTimeoutMs > maxInactivityTimeoutMs) {
      throw new TypeError('sandbox inactivity timeout must be from 1 second to 6 hours')
    }
    if (next.inactivityTimeoutMs !== current.inactivityTimeoutMs || next.keepAlive !== current.keepAlive) {
      await this.ctx.storage.put('settings', next)
      this.stored = next
    }
    if (!next.keepAlive && current.keepAlive) await this.ctx.storage.deleteAlarm()
    if (next.keepAlive && await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + keepAliveIntervalMs(next.inactivityTimeoutMs))
    }
    return next
  }

  private async applyInactivityTimeout(): Promise<void> {
    const { inactivityTimeoutMs } = await this.applySettings({})
    if (this.appliedTimeoutMs === inactivityTimeoutMs) return
    await this.container.setInactivityTimeout(inactivityTimeoutMs)
    this.appliedTimeoutMs = inactivityTimeoutMs
  }

  /** Start the container on first use, as Sandbox SDK 0.12 did. */
  private async ready(settings: AgentSandboxSettings): Promise<Container> {
    await this.applySettings(settings)
    const container = this.container
    if (!container.running) {
      const image = container.images.sandbox
      if (image === undefined) throw new Error('the container image "sandbox" is not configured')
      container.start({
        image,
        instance: { vcpu: containerCapacity.vcpu, memoryMib: containerCapacity.memoryMiB, diskMb: containerCapacity.diskMB },
        enableInternet: true,
        entrypoint: ['sleep', 'infinity'],
        labels: containerLabels(settings.labels),
      })
      this.environment = undefined
      this.appliedTimeoutMs = undefined
    }
    await this.applyInactivityTimeout()
    return container
  }

  // Commands inherit only PATH from the container. Give them the main
  // process's environment (the image's ENV lines), as Sandbox SDK 0.12 did.
  private async commandEnvironment(): Promise<Record<string, string>> {
    if (this.environment !== undefined) return this.environment
    const output = await (await this.container.exec(['cat', '/proc/1/environ'])).output()
    if (output.exitCode !== 0) throw new Error('container environment is unavailable')
    const variables = new TextDecoder().decode(output.stdout).split('\0').flatMap(entry => {
      const separator = entry.indexOf('=')
      return separator > 0 ? [[entry.slice(0, separator), entry.slice(separator + 1)] as const] : []
    })
    this.environment = { HOME: '/root', ...Object.fromEntries(variables) }
    return this.environment
  }

  private async run(argv: string[], options: { cwd?: string, env?: Record<string, string>,
    stdin?: ReadableStream<Uint8Array> } = {}): Promise<{ exitCode: number, stdout: string, stderr: string }> {
    const process = await this.container.exec(argv, {
      cwd: options.cwd ?? '/workspace',
      env: { ...await this.commandEnvironment(), ...options.env },
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    })
    const output = await process.output()
    const decoder = new TextDecoder()
    return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) }
  }

  private async processState(processId: string): Promise<SandboxProcessStatus | null> {
    const result = await this.run(['sh', '-c', processStateScript, 'sh', `${processRoot}/${processId}`])
    const [state, value] = result.stdout.trim().split(' ')
    if (state === 'missing') return null
    if (state === 'starting' || state === 'running') return state
    if (state === 'exited') return value === '0' ? 'completed' : 'failed'
    if (state === 'lost') return 'error'
    throw new Error(`process state is unreadable: ${processId}`)
  }
}

/**
 * Sandbox SDK 0.12's class. Workers deployed before this release declared it, so
 * it stays exported; it starts no containers.
 */
export class Sandbox extends DurableObject<Env> {
  // A 0.12 keep-alive alarm can fire once after the switch.
  async alarm(): Promise<void> {}
}
