import type { AgentSandbox } from './agent-sandbox.js'
import type { SandboxLogObservation } from './sandbox-log-observation.js'
import type { DshSessionObservation, NativeSessionMarkerObservation } from './native-session-observation.js'
import type { WorkspaceMutationOwner } from './workspace-mutation-owner.js'

/** Lifetime settings applied before each call. Unset fields keep the sandbox's stored value. */
export interface AgentSandboxSettings {
  /** Captured at task admission. Never upgrade an old client to the latest owner. */
  mutationOwner?: WorkspaceMutationOwner
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

/** Bind this actor receipt to the caller's recorded runtime/namespace and allocation. */
export interface SandboxRevocationReceipt {
  objectId: string
  commandDigest: string
  admissionRevoked: true
  physicalZeroVerified: false
}

export interface SandboxPendingMutation {
  id: string
  kind: 'container-start' | 'command' | 'process-start' | 'destroy' | 'settings'
  processId?: string
  ownerToken?: string
}

/** Only operations registered by this implementation; an empty list does not
 * attest legacy work, background process exit, or physical shutdown. */
export interface SandboxRevocationStatus extends SandboxRevocationReceipt {
  pendingOperations: readonly SandboxPendingMutation[]
}

export interface SandboxStopIdentity {
  objectId: string
  commandDigest: string
  /** Private, immutable evidence captured before explicitly abandoning work. */
  custodyDigest: string
  admissionRevoked: true
}
export interface SandboxStopReceipt extends SandboxStopIdentity {
  status: 'stopped'
  physicalZeroVerified: true
  observedAt: string
  evidence: { inspect: 'absent'; running: false }
  /** Unresolved submissions are preserved as interrupted/unknown, not replayed. */
  pendingOperations: readonly SandboxPendingMutation[]
}
export type SandboxStopResult = SandboxStopReceipt | (Omit<SandboxStopIdentity, 'admissionRevoked'> & {
  status: 'pending'; physicalZeroVerified: false
})

/** Validate receipts at both the durable actor and its coordinating caller. */
export function assertSandboxPendingMutation(value: unknown): asserts value is SandboxPendingMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace pending mutation is invalid')
  const entry = value as SandboxPendingMutation
  if (typeof entry.id !== 'string' || !/^[a-f0-9-]{36}$/.test(entry.id)
    || !['container-start', 'command', 'process-start', 'destroy', 'settings'].includes(entry.kind)
    || Object.keys(entry).some(field => !['id', 'kind', 'processId', 'ownerToken'].includes(field))
    || (entry.ownerToken !== undefined && (typeof entry.ownerToken !== 'string' || !/^[a-f0-9]{64}$/.test(entry.ownerToken)))
    || (entry.kind === 'process-start' ? typeof entry.processId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.processId)
      : entry.processId !== undefined)) throw new Error('workspace pending mutation is invalid')
}

export function assertSandboxStopReceipt(value: unknown): asserts value is SandboxStopReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('workspace stop receipt is invalid')
  const receipt = value as SandboxStopReceipt
  if (![receipt.objectId, receipt.commandDigest, receipt.custodyDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || receipt.status !== 'stopped' || receipt.physicalZeroVerified !== true || receipt.admissionRevoked !== true
    || receipt.evidence?.inspect !== 'absent' || receipt.evidence.running !== false
    || typeof receipt.observedAt !== 'string' || !Number.isFinite(Date.parse(receipt.observedAt))
    || !Array.isArray(receipt.pendingOperations)) throw new Error('workspace stop receipt is invalid')
  receipt.pendingOperations.forEach(assertSandboxPendingMutation)
  if (new Set(receipt.pendingOperations.map(entry => entry.id)).size !== receipt.pendingOperations.length) {
    throw new Error('workspace stop receipt repeats a pending mutation')
  }
}

/** The command, file and process calls the engine makes in one agent workspace. */
export interface SandboxClient {
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>
  writeFile(path: string, content: string | ReadableStream<Uint8Array>): Promise<{ success: boolean, path: string }>
  readFile(path: string, options?: { encoding?: 'base64' }): Promise<{ success: boolean, path: string, content: string }>
  /** Bounded log observation; never creates a container or changes its lifetime. */
  observeAgentLog(requestDigest: string, offset: number, maxBytes: number): Promise<SandboxLogObservation>
  /** Existing native journal only; no code upload, workspace marker or container start. */
  observeDshSession(sessionId: string, workingDirectory: string): Promise<DshSessionObservation>
  /** Original wrapper/group/session evidence, not whole-container physical zero. */
  /** Fixed custody marker digest only; readable while held without changing lifetime. */
  observeSessionMarker(requestDigest: string): Promise<NativeSessionMarkerObservation>
  exists(path: string): Promise<{ success: boolean, exists: boolean }>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean }>
  deleteFile(path: string): Promise<{ success: boolean }>
  startProcess(command: string, options: { processId: string, cwd?: string, env?: Record<string, string> }):
    Promise<SandboxProcess>
  getProcess(processId: string): Promise<SandboxProcess | null>
  setKeepAlive(keepAlive: boolean): Promise<void>
  destroy(): Promise<void>
  /** Close admission permanently; preserves existing work and does not attest shutdown. */
  revoke(commandDigest: string): Promise<SandboxRevocationReceipt>
  revocationStatus(commandDigest: string): Promise<SandboxRevocationStatus>
  /** Permanent, command-bound stop; never recreates a workspace to inspect it. */
  stopRevoked(commandDigest: string, custodyDigest: string): Promise<SandboxStopResult>
  initializeMutationOwner(owner: WorkspaceMutationOwner): Promise<{ objectId: string; owner: WorkspaceMutationOwner }>
}

/** Reach one agent sandbox by name. No request is made until the first call. */
export function getAgentSandbox(namespace: DurableObjectNamespace<AgentSandbox>, sandboxId: string,
  settings: AgentSandboxSettings = {}): SandboxClient {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sandboxId)) throw new TypeError('sandbox ID is invalid')
  const stub = namespace.getByName(sandboxId)
  let current = structuredClone(settings)
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
    observeAgentLog: (requestDigest, offset, maxBytes) => stub.observeAgentLog(requestDigest, offset, maxBytes),
    observeDshSession: (sessionId, cwd) => stub.observeDshSession(sessionId, cwd),
    observeSessionMarker: requestDigest => stub.observeSessionMarker(requestDigest),
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
    destroy: () => stub.destroy(current.mutationOwner),
    revoke: commandDigest => stub.revoke(commandDigest),
    revocationStatus: commandDigest => stub.revocationStatus(commandDigest),
    stopRevoked: (commandDigest, custodyDigest) => stub.stopRevoked(commandDigest, custodyDigest),
    initializeMutationOwner: owner => stub.initializeMutationOwner(structuredClone(owner)),
  }
}
