import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.js'
import type {
  AgentSandboxSettings, SandboxExecOptions, SandboxExecResult, SandboxProcessStatus, SandboxRevocationReceipt,
  SandboxPendingMutation, SandboxRevocationStatus,
  SandboxStopIdentity, SandboxStopReceipt, SandboxStopResult,
} from './agent-sandbox-client.js'
import { assertWorkspaceMutationOwner, birthMutationOwner, mutationSandboxName,
  type WorkspaceMutationOwner } from './workspace-mutation-owner.js'
import { containerCapacity } from './container-resource-diagnostics.js'
import { assertSandboxPendingMutation as assertPendingMutation, assertSandboxStopReceipt } from './agent-sandbox-client.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { agentLogObservationScript, assertLogObservationInput, parseLogObservation,
  type SandboxLogObservation } from './sandbox-log-observation.js'
import { assertDshSessionScope, nativeSessionInspectionScript, parseDshSessionObservation,
  nativeSessionMarkerId, nativeSessionMarkerInspectionScript, parseNativeSessionMarker,
  type NativeSessionMarkerObservation, type DshSessionObservation } from './native-session-observation.js'

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
const mutationPrefix = 'pending-mutation/'
const ownerStateKey = 'workspace-mutation-owner'
interface MutationOwnerState { owner: WorkspaceMutationOwner }

class MutationOwnerDenied extends Error {}


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
  private revokedBy: string | null = null
  private readonly initialized: Promise<void>
  private settingsTail: Promise<void> = Promise.resolve()
  private controlTail: Promise<void> = Promise.resolve()
  private nativeStop: Promise<SandboxStopResult> | undefined
  private mutationOwnerState: MutationOwnerState | null = null
  private mutationOwnerReady = false
  private legacyMutationUsed = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // A restarted Durable Object starts without an inactivity timeout, even
    // when its container is still running.
    this.initialized = ctx.blockConcurrencyWhile(async () => {
      const revokedBy = await ctx.storage.get<string>('revoked-by-command')
      if (revokedBy !== undefined && (typeof revokedBy !== 'string' || !/^[a-f0-9]{64}$/.test(revokedBy))) throw new Error('workspace revocation is invalid')
      this.revokedBy = revokedBy ?? null
      this.mutationOwnerState = await this.readMutationOwnerState()
      this.mutationOwnerReady = true
      this.legacyMutationUsed = await ctx.storage.get('mutation-legacy-use') === true
      if (this.revokedBy === null && this.mutationOwnerState === null && !this.legacyMutationUsed && ctx.container?.running) {
        await ctx.storage.put('mutation-legacy-use', true)
        this.legacyMutationUsed = true
      }
      if (this.revokedBy !== null) await this.applySettings({ keepAlive: false })
      else if (ctx.container?.running) {
        await this.mutation('settings', () => this.applyInactivityTimeout(), undefined, this.mutationOwnerState?.owner)
      }
    })
  }

  async exec(settings: AgentSandboxSettings, command: string, options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    settings = deepClone(settings)
    await this.ready(settings)
    const timeout = options.timeout
    if (timeout !== undefined && !(Number.isFinite(timeout) && timeout > 0)) throw new TypeError('command timeout is invalid')
    const startedAt = Date.now()
    // `timeout` runs the command in its own process group and stops the whole group.
    const result = await this.run(timeout === undefined ? ['bash', '-c', command]
      : ['timeout', '--kill-after=5s', `${timeout / 1_000}s`, 'bash', '-c', command], options, false, settings.mutationOwner)
    if (timeout !== undefined && [124, 137].includes(result.exitCode) && Date.now() - startedAt >= timeout) {
      throw new Error(`command timed out after ${timeout} ms`)
    }
    return { success: result.exitCode === 0, ...result, command }
  }

  async writeFile(settings: AgentSandboxSettings, path: string,
    content: string | ReadableStream<Uint8Array>): Promise<{ success: true, path: string }> {
    settings = deepClone(settings)
    await this.ready(settings)
    const result = await this.run(['sh', '-c', 'mkdir -p "$(dirname "$1")" && cat >"$1"', 'sh', path],
      { stdin: typeof content === 'string' ? new Blob([content]).stream() : content }, false, settings.mutationOwner)
    if (result.exitCode !== 0) throw new Error(`file write failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, path }
  }

  async readFile(settings: AgentSandboxSettings, path: string,
    options: { encoding?: 'base64' } = {}): Promise<{ success: true, path: string, content: string }> {
    settings = deepClone(settings)
    await this.ready(settings, true)
    const result = await this.run(options.encoding === 'base64' ? ['base64', '-w0', '--', path] : ['cat', '--', path], {}, true, settings.mutationOwner)
    if (result.exitCode !== 0) throw new Error(`file read failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, path, content: result.stdout }
  }

  /** Observe an existing actor only, including after admission revocation.
   * No lifetime configuration, environment discovery or container start. */
  async observeAgentLog(requestDigest: string, offset: number, maxBytes: number): Promise<SandboxLogObservation> {
    assertLogObservationInput(requestDigest, offset, maxBytes)
    await this.initialized
    const container = this.container
    if (!container.running) throw new Error('workspace container is not running')
    const process = await container.exec(['/usr/bin/timeout', '--kill-after=1s', '10s',
      '/usr/bin/python3', '-I', '-c', agentLogObservationScript, requestDigest, String(offset), String(maxBytes)], { cwd: '/' })
    const output = await process.output()
    if (output.exitCode !== 0) throw new Error('agent log observation did not finish')
    return parseLogObservation(JSON.parse(new TextDecoder().decode(output.stdout)), offset, maxBytes)
  }

  /** Same-read session evidence from an existing actor; does not grant resume. */
  async observeDshSession(sessionId: string, cwd: string): Promise<DshSessionObservation> {
    assertDshSessionScope(sessionId, cwd)
    await this.initialized
    const container = this.container
    if (!container.running) throw new Error('workspace container is not running')
    const process = await container.exec(['/usr/bin/timeout', '--kill-after=1s', '10s',
      '/usr/bin/python3', '-I', '-c', nativeSessionInspectionScript, sessionId, cwd], { cwd: '/' })
    const output = await process.output()
    if (output.exitCode !== 0) throw new Error('native session observation did not finish')
    return parseDshSessionObservation(JSON.parse(new TextDecoder().decode(output.stdout)), sessionId, cwd)
  }

  /** An owner can observe custody without reacquiring mutation permission. */
  async observeSessionMarker(requestDigest: string): Promise<NativeSessionMarkerObservation> {
    const markerId = await nativeSessionMarkerId(requestDigest)
    await this.initialized
    const container = this.container
    if (!container.running) throw new Error('workspace container is not running')
    const process = await container.exec(['/usr/bin/timeout', '--kill-after=1s', '10s',
      '/usr/bin/python3', '-I', '-c', nativeSessionMarkerInspectionScript, markerId], { cwd: '/' })
    const output = await process.output()
    if (output.exitCode !== 0) throw new Error('native custody marker observation did not finish')
    return parseNativeSessionMarker(JSON.parse(new TextDecoder().decode(output.stdout)), markerId)
  }

  async exists(settings: AgentSandboxSettings, path: string): Promise<{ success: true, exists: boolean }> {
    settings = deepClone(settings)
    await this.ready(settings, true)
    const result = await this.run(['test', '-e', path], {}, true, settings.mutationOwner)
    if (result.exitCode > 1) throw new Error(`file check failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true, exists: result.exitCode === 0 }
  }

  async mkdir(settings: AgentSandboxSettings, path: string,
    options: { recursive?: boolean } = {}): Promise<{ success: true }> {
    settings = deepClone(settings)
    await this.ready(settings)
    const result = await this.run(['mkdir', ...(options.recursive === true ? ['-p'] : []), '--', path], {}, false, settings.mutationOwner)
    if (result.exitCode !== 0) throw new Error(`directory creation failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true }
  }

  async deleteFile(settings: AgentSandboxSettings, path: string): Promise<{ success: true }> {
    settings = deepClone(settings)
    await this.ready(settings)
    const result = await this.run(['rm', '--', path], {}, false, settings.mutationOwner)
    if (result.exitCode !== 0) throw new Error(`file deletion failed: ${path}: ${result.stderr.slice(-500)}`)
    return { success: true }
  }

  async startProcess(settings: AgentSandboxSettings, command: string,
    options: { processId: string, cwd?: string, env?: Record<string, string> }): Promise<SandboxProcessStatus> {
    settings = deepClone(settings)
    const container = await this.ready(settings)
    if (!processIdPattern.test(options.processId)) throw new TypeError('process ID is invalid')
    const directory = `${processRoot}/${options.processId}`
    const created = await this.run(['sh', '-c', 'mkdir -p -m 0700 "$1" && mkdir -m 0700 "$2"', 'sh', processRoot, directory], {}, false, settings.mutationOwner)
    if (created.exitCode !== 0) throw new Error(`Process ${options.processId} already exists`)
    // The process keeps running after this request ends; its state lives in its directory.
    const environment = { ...await this.commandEnvironment(), ...options.env }
    this.assertCommandAllowed()
    await this.mutation('process-start', () => container.exec(['sh', '-c', runProcessScript, 'sh', directory, 'bash', '-c', command], {
      cwd: options.cwd ?? '/workspace',
      env: environment,
      stdout: 'ignore', stderr: 'ignore',
    }), options.processId, settings.mutationOwner)
    let status: SandboxProcessStatus | null = 'starting'
    for (let check = 0; check < 50 && status === 'starting'; check += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
      status = await this.processState(options.processId, settings.mutationOwner)
    }
    return status ?? 'error'
  }

  async processStatus(settings: AgentSandboxSettings, processId: string): Promise<SandboxProcessStatus | null> {
    settings = deepClone(settings)
    await this.ready(settings, true)
    if (!processIdPattern.test(processId)) throw new TypeError('process ID is invalid')
    return this.processState(processId, settings.mutationOwner)
  }

  /** Apply lifetime settings without starting a container. */
  async configure(settings: AgentSandboxSettings): Promise<void> {
    settings = deepClone(settings)
    await this.initialized
    if (this.revokedBy !== null && settings.keepAlive === true) throw new Error('workspace admission is revoked')
    await this.authorizeMutationCaller(settings.mutationOwner)
    await this.mutation('settings', async () => {
      await this.applySettings(settings)
      if (this.ctx.container?.running) await this.applyInactivityTimeout()
    }, undefined, settings.mutationOwner)
  }

  async destroy(owner?: WorkspaceMutationOwner): Promise<void> {
    owner = deepClone(owner)
    await this.initialized
    await this.authorizeMutationCaller(owner)
    await this.mutation('settings', () => this.applySettings({ keepAlive: false }), undefined, owner)
    this.environment = undefined
    this.appliedTimeoutMs = undefined
    if (this.ctx.container?.running) await this.mutation('destroy', () => this.container.destroy(), undefined, owner)
  }

  async alarm(): Promise<void> {
    await this.initialized
    if (this.revokedBy !== null) { await this.ctx.storage.deleteAlarm(); return }
    const owner = deepClone(this.mutationOwnerState?.owner)
    try {
      await this.authorizeMutationCaller(owner)
      await this.mutation('settings', async () => {
        const settings = await this.applySettings({})
        if (!settings.keepAlive || this.ctx.container?.running !== true) return
        await this.applyInactivityTimeout()
        if (this.revokedBy === null) await this.ctx.storage.setAlarm(Date.now() + keepAliveIntervalMs(settings.inactivityTimeoutMs))
      }, undefined, owner)
    } catch (error) {
      if (!(error instanceof MutationOwnerDenied)) throw error
    }
  }

  private get container(): Container {
    const container = this.ctx.container
    if (container === undefined) throw new Error('no container is configured for agent sandboxes')
    return container
  }

  /** Durable admission fence, not a physical-stop or custody receipt. Existing
   * processes remain available for evidence collection and explicit shutdown. */
  async revoke(commandDigest: string): Promise<SandboxRevocationReceipt> {
    if (typeof commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(commandDigest)) throw new TypeError('workspace revocation command digest is invalid')
    await this.initialized
    if (this.revokedBy !== null && this.revokedBy !== commandDigest) throw new Error('workspace was revoked by another command')
    // Fail closed even if storage loses the response. Retrying persists the
    // same identity; an uncertain acknowledgment never reopens admission.
    this.revokedBy = commandDigest
    await this.control(() => this.ctx.storage.put('revoked-by-command', commandDigest))
    await this.applySettings({ keepAlive: false })
    await this.ctx.storage.deleteAlarm()
    return { objectId: this.ctx.id.toString(), commandDigest, admissionRevoked: true, physicalZeroVerified: false }
  }

  /** Read-only ordered cut of tracked submissions. No process or container is
   * started, stopped, re-created, or presumed terminal by this observation. */
  async revocationStatus(commandDigest: string): Promise<SandboxRevocationStatus> {
    await this.initialized
    return this.control(async () => {
      const persisted = await this.ctx.storage.get<string>('revoked-by-command')
      if (typeof commandDigest !== 'string' || !/^[a-f0-9]{64}$/.test(commandDigest)
        || persisted !== commandDigest || this.revokedBy !== commandDigest) throw new Error('workspace revocation identity differs')
      const pendingOperations = await this.pendingMutations()
      return { objectId: this.ctx.id.toString(), commandDigest, admissionRevoked: true,
        physicalZeroVerified: false, pendingOperations }
    })
  }

  /** Explicit abandonment after durable custody capture. No arbitrary shell,
   * credential access or replacement process is involved. The immutable actor
   * fence makes native absence durable: this allocation cannot start again. */
  async stopRevoked(commandDigest: string, custodyDigest: string): Promise<SandboxStopResult> {
    if (typeof commandDigest !== 'string' || typeof custodyDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(commandDigest) || !/^[a-f0-9]{64}$/.test(custodyDigest)) throw new TypeError('stop digest is invalid')
    const pending = { objectId: this.ctx.id.toString(), commandDigest, custodyDigest, status: 'pending' as const, physicalZeroVerified: false as const }
    const operation = this.performStop(commandDigest, custodyDigest)
    this.ctx.waitUntil(operation.then(() => {}, () => {}))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([operation, new Promise<SandboxStopResult>(resolve => {
        timer = setTimeout(() => resolve(pending), 5_000)
      })])
    } finally { if (timer !== undefined) clearTimeout(timer) }
  }

  private async performStop(commandDigest: string, custodyDigest: string): Promise<SandboxStopResult> {
    await this.revocationStatus(commandDigest)
    const identity: SandboxStopIdentity = { objectId: this.ctx.id.toString(), commandDigest, custodyDigest, admissionRevoked: true }
    await this.control(async () => {
      const prior = await this.ctx.storage.get<SandboxStopIdentity>('native-stop-intent')
      if (prior !== undefined && canonicalJson(prior) !== canonicalJson(identity)) throw new Error('native stop intent differs')
      if (prior === undefined) await this.ctx.storage.put('native-stop-intent', identity)
    })
    // Reconcile physical state first, including after a lost destroy response
    // or a Durable Object restart. Never wait for an interrupted process's
    // output promise or erase its unknown submission to make cleanup pass.
    const stopped = await this.observeStopped(identity)
    if (stopped !== null) return stopped
    if (await this.ctx.storage.get('native-stop-receipt') !== undefined) throw new Error('stopped allocation became running again')
    if (this.nativeStop === undefined) {
      const operation = this.stopAndObserve(identity)
      this.nativeStop = operation
      const settled = () => { if (this.nativeStop === operation) this.nativeStop = undefined }
      this.ctx.waitUntil(operation.then(settled, settled))
    }
    return this.nativeStop
  }

  private async stopAndObserve(identity: SandboxStopIdentity): Promise<SandboxStopResult> {
    // A failed monitor can mean nonzero exit or an unavailable observation. Only
    // the independent native absence read below decides whether stop completed.
    let monitor: Promise<unknown>
    try { monitor = this.container.monitor().catch(() => undefined) }
    catch { monitor = Promise.resolve() }
    const destruction = this.mutation('destroy', () => this.container.destroy(), undefined, undefined, () => {
      if (this.revokedBy !== identity.commandDigest) throw new Error('permanent stop authority differs')
    }).catch(() => undefined)
    await Promise.race([monitor, destruction])
    const stopped = await this.observeStopped(identity)
    if (stopped !== null) return stopped
    // A monitor error alone must not release the in-memory operation while
    // its destruction request is still outstanding.
    await destruction
    return await this.observeStopped(identity) ?? { ...identity, status: 'pending', physicalZeroVerified: false }
  }

  private async observeStopped(identity: SandboxStopIdentity): Promise<SandboxStopReceipt | null> {
    const inspection = await this.container.inspect()
    if (inspection !== null || this.container.running) return null
    const revocation = await this.revocationStatus(identity.commandDigest)
    // Native starts are synchronous submissions behind the same permanent
    // fence. Already submitted commands cannot boot another container after
    // this native absence observation, even if their RPC replies arrive late.
    if (this.container.running) return null
    return this.control(async () => {
      const previous = await this.ctx.storage.get<SandboxStopReceipt>('native-stop-receipt')
      if (previous !== undefined) {
        assertSandboxStopReceipt(previous)
        if (previous.objectId !== identity.objectId || previous.commandDigest !== identity.commandDigest
          || previous.custodyDigest !== identity.custodyDigest) throw new Error('workspace stop receipt identity differs')
        return previous
      }
      const receipt: SandboxStopReceipt = { ...identity, status: 'stopped', physicalZeroVerified: true,
        observedAt: new Date().toISOString(), evidence: { inspect: 'absent', running: false },
        pendingOperations: revocation.pendingOperations }
      await this.ctx.storage.put('native-stop-receipt', receipt)
      return receipt
    })
  }

  private async readMutationOwnerState(): Promise<MutationOwnerState | null> {
    const state = await this.ctx.storage.get<MutationOwnerState>(ownerStateKey)
    if (state === undefined) return null
    if (state === null || typeof state !== 'object' || Array.isArray(state)
      || Object.keys(state).join(',') !== 'owner') throw new Error('workspace mutation state is invalid')
    assertWorkspaceMutationOwner(state.owner)
    await this.assertMutationAllocation(state.owner)
    return state
  }

  private async assertMutationAllocation(owner: WorkspaceMutationOwner): Promise<void> {
    const name = await mutationSandboxName(owner)
    if (this.env.AGENT_SANDBOX.idFromName(name).toString() !== this.ctx.id.toString()) {
      throw new Error('workspace mutation allocation differs')
    }
  }

  private assertMutationOwner(owner?: WorkspaceMutationOwner): void {
    if (owner !== undefined) assertWorkspaceMutationOwner(owner)
    if (!this.mutationOwnerReady || (this.mutationOwnerState === null ? owner !== undefined
      : canonicalJson(owner) !== canonicalJson(this.mutationOwnerState.owner))) {
      throw new MutationOwnerDenied('workspace mutation owner is stale or unavailable')
    }
  }

  /** Legacy RPCs cannot race birth registration or silently adopt a covered actor. */
  private async authorizeMutationCaller(owner?: WorkspaceMutationOwner): Promise<void> {
    await this.control(async () => {
      this.assertMutationOwner(owner)
      if (this.mutationOwnerState === null && !this.legacyMutationUsed) {
        await this.ctx.storage.put('mutation-legacy-use', true)
        this.legacyMutationUsed = true
      }
    })
  }

  async initializeMutationOwner(input: WorkspaceMutationOwner): Promise<{ objectId: string; owner: WorkspaceMutationOwner }> {
    const owner = deepClone(input)
    assertWorkspaceMutationOwner(owner)
    if (canonicalJson(owner) !== canonicalJson(await birthMutationOwner(owner.authority, owner.workspaceKey))) {
      throw new Error('workspace mutation birth owner differs')
    }
    await this.initialized
    await this.assertMutationAllocation(owner)
    // Native observation must not hold the metadata queue: revocation must remain
    // available even when the container service stalls. Starts register below.
    const existingContainer = this.mutationOwnerState === null ? await this.container.inspect() : null
    return this.control(async () => {
      if (this.revokedBy !== null) throw new Error('workspace admission is revoked')
      if (this.mutationOwnerState !== null) {
        if (canonicalJson(this.mutationOwnerState.owner) !== canonicalJson(owner)) {
          throw new Error('workspace mutation birth already has another owner')
        }
      } else {
        if (this.legacyMutationUsed || await this.ctx.storage.get('mutation-legacy-use') === true
          || this.container.running || existingContainer !== null
          || await this.ctx.storage.get('settings') !== undefined || await this.ctx.storage.getAlarm() !== null
          || (await this.pendingMutations()).length !== 0) throw new Error('legacy workspace cannot acquire mutation birth coverage')
        this.mutationOwnerState = { owner }
      }
      if (this.revokedBy !== null) throw new Error('workspace admission is revoked')
      // Fail closed in memory even if publication loses its acknowledgement.
      this.mutationOwnerReady = false
      await this.ctx.storage.put(ownerStateKey, this.mutationOwnerState)
      this.mutationOwnerReady = true
      return deepClone({ objectId: this.ctx.id.toString(), owner })
    })
  }

  private async pendingMutations(): Promise<SandboxPendingMutation[]> {
    const entries = await this.ctx.storage.list<SandboxPendingMutation>({ prefix: mutationPrefix })
    const pending: SandboxPendingMutation[] = []
    for (const [key, value] of entries) {
      assertPendingMutation(value)
      if (key !== mutationPrefix + value.id) throw new Error('workspace pending mutation is invalid')
      pending.push(value)
    }
    return deepClone(pending)
  }

  /** Serialize only metadata, never native submission or process output. */
  private control<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.controlTail.then(operation)
    this.controlTail = pending.then(() => {}, () => {})
    return pending
  }

  private async mutation<T>(kind: SandboxPendingMutation['kind'], submit: () => Promise<T> | T,
    processId?: string, owner?: WorkspaceMutationOwner, control?: () => void): Promise<T> {
    owner = deepClone(owner)
    const record: SandboxPendingMutation = { id: crypto.randomUUID(), kind, ...(processId === undefined ? {} : { processId }),
      ...(owner === undefined ? {} : { ownerToken: await sha256(owner) }) }
    const key = mutationPrefix + record.id
    const assertAllowed = () => {
      if (control !== undefined) { control(); return }
      if (this.revokedBy !== null) throw new Error('workspace admission is revoked')
      this.assertMutationOwner(owner)
    }
    await this.control(async () => { assertAllowed(); await this.ctx.storage.put(key, record) })
    // Revocation can arrive during the registration write. This invocation
    // knows it did not submit; all other ambiguous failures retain the row.
    try { assertAllowed() } catch (error) {
      await this.control(() => this.ctx.storage.delete(key)); throw error
    }
    const result = await submit()
    await this.control(() => this.ctx.storage.delete(key))
    return result
  }

  private assertCommandAllowed(observation = false): void {
    if (this.revokedBy === null) return
    if (!observation) throw new Error('workspace admission is revoked')
    if (!this.container.running) throw new Error('workspace container is not running')
  }

  private async applySettings(update: AgentSandboxSettings): Promise<StoredSettings> {
    const operation = this.settingsTail.then(() => this.updateSettings(update))
    this.settingsTail = operation.then(() => {}, () => {})
    return operation
  }

  private async updateSettings(update: AgentSandboxSettings): Promise<StoredSettings> {
    const current = this.stored ??= await this.ctx.storage.get<StoredSettings>('settings') ?? defaultSettings
    const next: StoredSettings = {
      inactivityTimeoutMs: update.inactivityTimeoutMs ?? current.inactivityTimeoutMs,
      keepAlive: this.revokedBy !== null ? false : update.keepAlive ?? current.keepAlive,
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
    if (next.keepAlive && await this.ctx.storage.getAlarm() === null && this.revokedBy === null) {
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
  private async ready(settings: AgentSandboxSettings, observation = false): Promise<Container> {
    await this.initialized
    await this.authorizeMutationCaller(settings.mutationOwner)
    if (this.revokedBy !== null) {
      this.assertCommandAllowed(observation)
      return this.container
    }
    await this.mutation('settings', () => this.applySettings(settings), undefined, settings.mutationOwner)
    if (this.revokedBy !== null) {
      this.assertCommandAllowed(observation)
      return this.container
    }
    const container = this.container
    if (!container.running) {
      const image = container.images.sandbox
      if (image === undefined) throw new Error('the container image "sandbox" is not configured')
      await this.mutation('container-start', () => {
        if (container.running) return
        container.start({
          image,
          instance: { vcpu: containerCapacity.vcpu, memoryMib: containerCapacity.memoryMiB, diskMb: containerCapacity.diskMB },
          enableInternet: true,
          entrypoint: ['sleep', 'infinity'],
          labels: containerLabels(settings.labels),
        })
      }, undefined, settings.mutationOwner)
      this.environment = undefined
      this.appliedTimeoutMs = undefined
    }
    await this.mutation('settings', () => this.applyInactivityTimeout(), undefined, settings.mutationOwner)
    return container
  }

  // Commands inherit only PATH from the container. Give them the main
  // process's environment (the image's ENV lines), as Sandbox SDK 0.12 did.
  private async commandEnvironment(): Promise<Record<string, string>> {
    this.assertCommandAllowed(true)
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
    stdin?: ReadableStream<Uint8Array> } = {}, observation = false, owner?: WorkspaceMutationOwner): Promise<{ exitCode: number, stdout: string, stderr: string }> {
    const environment = { ...await this.commandEnvironment(), ...options.env }
    this.assertCommandAllowed(observation)
    this.assertMutationOwner(owner)
    const execute = async () => {
      const process = await this.container.exec(argv, {
        cwd: options.cwd ?? '/workspace',
        env: environment,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      const output = await process.output()
      const decoder = new TextDecoder()
      return { exitCode: output.exitCode, stdout: decoder.decode(output.stdout), stderr: decoder.decode(output.stderr) }
    }
    return observation ? execute() : this.mutation('command', execute, undefined, owner)
  }

  private async processState(processId: string, owner?: WorkspaceMutationOwner): Promise<SandboxProcessStatus | null> {
    const result = await this.run(['sh', '-c', processStateScript, 'sh', `${processRoot}/${processId}`], {}, true, owner)
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
