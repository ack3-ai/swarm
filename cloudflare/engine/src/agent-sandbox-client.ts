import type { AgentSandbox } from './agent-sandbox.js'

/** Lifetime settings applied before each call. Unset fields keep the sandbox's stored value. */
export interface AgentSandboxSettings {
  /** How long the container keeps running after its Durable Object goes idle (at most 6 hours). */
  inactivityTimeoutMs?: number
  /** Keep the container running until keep-alive is turned off or the sandbox is destroyed. */
  keepAlive?: boolean
  /** Diagnostic labels for a newly started container. */
  labels?: Readonly<Record<string, string>>
}

export interface SandboxExecOptions {
  /** Milliseconds before the command and the processes it started are stopped; the call then throws. */
  timeout?: number
  env?: Record<string, string>
  cwd?: string
}

export interface SandboxExecResult {
  success: boolean
  exitCode: number
  stdout: string
  stderr: string
  command: string
}

export type SandboxProcessStatus = 'starting' | 'running' | 'completed' | 'failed' | 'error'

export interface SandboxProcess {
  id: string
  getStatus(): Promise<SandboxProcessStatus>
}

/** The command, file and process calls the engine makes in one agent workspace. */
export interface SandboxClient {
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>
  writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<{ success: boolean, path: string }>
  readFile(path: string, options?: { encoding?: 'base64' }): Promise<{ success: boolean, path: string, content: string }>
  exists(path: string): Promise<{ success: boolean, exists: boolean }>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean }>
  deleteFile(path: string): Promise<{ success: boolean }>
  startProcess(command: string, options: { processId: string, cwd?: string, env?: Record<string, string> }):
    Promise<SandboxProcess>
  getProcess(processId: string): Promise<SandboxProcess | null>
  setKeepAlive(keepAlive: boolean): Promise<void>
  destroy(): Promise<void>
}

/** Reach one agent sandbox by name. No request is made until the first call. */
export function getAgentSandbox(namespace: DurableObjectNamespace<AgentSandbox>, sandboxId: string,
  settings: AgentSandboxSettings = {}): SandboxClient {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sandboxId)) throw new TypeError('sandbox ID is invalid')
  const stub = namespace.getByName(sandboxId)
  let current = settings
  const handle = (processId: string): SandboxProcess => ({
    id: processId,
    getStatus: async () => {
      const status = await stub.processStatus(current, processId)
      if (status === null) throw new Error(`Process ${processId} not found`)
      return status
    },
  })
  return {
    exec: (command, options) => stub.exec(current, command, options),
    writeFile: (path, content) => stub.writeFile(current, path, content),
    readFile: (path, options) => stub.readFile(current, path, options),
    exists: path => stub.exists(current, path),
    mkdir: (path, options) => stub.mkdir(current, path, options),
    deleteFile: path => stub.deleteFile(current, path),
    startProcess: async (command, options) => {
      await stub.startProcess(current, command, options)
      return handle(options.processId)
    },
    getProcess: async processId => (await stub.processStatus(current, processId)) === null ? null : handle(processId),
    setKeepAlive: async keepAlive => {
      current = { ...current, keepAlive }
      await stub.configure(current)
    },
    destroy: () => stub.destroy(),
  }
}
