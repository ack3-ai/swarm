import { publishImmutableObject } from './immutable-object.js'
import { nativeStopCompletion } from './native-stop-evidence.js'
import { NativeCommandEvidence, readCommandSource, readCommandDispatchEvidence, assertWholeExecutionStop, cancellationKey, type CancellationDisposition } from './native-command-evidence.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import { RunCommandJournal } from './run-command-journal.js'
import type { AgentRequest, InFlightAgentAttempt, RunState } from './contracts.js'
import type { Env } from './env.js'
import { AgentExecutionReceiptIntegrityError, R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { nativeSandboxName } from './native-workspace.js'
import { localRuntimeRelease } from './runtime-release.js'
import { parseLogObservation, sandboxLogReadMaxBytes } from './sandbox-log-observation.js'
import { parseDshSessionObservation, type DshSessionObservation } from './native-session-observation.js'
import { agentWorkingDirectory } from './agent-working-directory.js'
import { taskBackend } from './provider-identity.js'
import { ExecutionAuthorityStore } from './execution-authority.js'
import { assertRecordedTaskAdmission } from './native-launch-authority.js'
import { canonicalJson, sha256 } from './canonical.js'
import { executionRequestBody } from './native-request.js'
import { assertAuditCancellation, type AuditCancellationEffect } from './run-control-state.js'
import { PermanentRunFailure, TransientRunFailure, RunFailure } from './run-errors.js'
import { RunCommandConflict, RunCommandRejected } from './run-commands.js'
import type { RunOperation } from './run-command-journal.js'
import { assertSandboxStopReceipt, type SandboxRevocationReceipt, type SandboxStopReceipt } from './agent-sandbox-client.js'

async function custodyOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (cause) {
    if (cause instanceof RunFailure || cause instanceof RunCommandConflict || cause instanceof RunCommandRejected) throw cause
    if (cause instanceof AgentExecutionReceiptIntegrityError) {
      throw new PermanentRunFailure('command native receipt integrity failed', 'integrity-failed', { cause })
    }
    throw new TransientRunFailure('command custody observation or persistence remains incomplete', { cause })
  }
}

/** Cancellation may abandon unfinished work. Observation is bounded and remains
 * read-only even if the native response arrives after this timeout. Integrity
 * errors still fail closed; an unavailable log is not a successful empty log. */
async function abandonmentObservation<T>(read: () => Promise<T>): Promise<T | { status: 'unavailable'; reason: 'observation-incomplete' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([custodyOperation(read), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TransientRunFailure('abandonment observation timed out')), 5_000)
    })])
  } catch (error) {
    if (!(error instanceof TransientRunFailure)) throw error
    return { status: 'unavailable', reason: 'observation-incomplete' }
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

/** Validate the installed native request projection in addition to the shared
 * source/dispatch contract. Archive-only callers use readCommandDispatchEvidence. */
export async function readCommandDispatch(input: Parameters<typeof readCommandDispatchEvidence>[0] & { workspaceId: string }) {
  const result = await readCommandDispatchEvidence(input)
  if (await sha256(executionRequestBody(result.dispatch.request, input.workspaceId)) !== result.dispatch.nativeRequestDigest) {
    throw new PermanentRunFailure('command dispatch native projection differs', 'integrity-failed')
  }
  return result
}

function evidenceReader(env: Env) {
  return new NativeCommandEvidence({ runs: new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX),
    artifacts: env.ARTIFACTS, index: env.INDEX })
}

async function verifyNativeEvidence(env: Env, evidence: NativeCommandEvidence) {
  let installed: ReturnType<typeof localRuntimeRelease> | undefined
  if (evidence.runtimes.length > 0) {
    try { installed = localRuntimeRelease(env) }
    catch (cause) { throw new PermanentRunFailure('command observation runtime is invalid', 'invalid-configuration', { cause }) }
  }
  for (const runtime of evidence.runtimes) {
    if (canonicalJson(runtime) !== canonicalJson(installed)) {
      throw new PermanentRunFailure('command observation runtime differs from source', 'integrity-failed')
    }
  }
  for (const actor of evidence.nativeActors) {
    if (actor.objectId !== env.AGENT_SANDBOX.idFromName(actor.sandboxName).toString()) {
      throw new PermanentRunFailure('execution stop actor inventory differs', 'integrity-failed')
    }
  }
  for (const dispatch of evidence.nativeRequests) {
    if (await sha256(executionRequestBody(dispatch.request, env.ACK3_CODEX_WORKSPACE_ID)) !== dispatch.nativeRequestDigest) {
      throw new PermanentRunFailure('command dispatch native projection differs', 'integrity-failed')
    }
  }
}

async function withNativeEvidence<T>(env: Env, read: (evidence: NativeCommandEvidence) => Promise<T>): Promise<T> {
  const evidence = evidenceReader(env), result = await read(evidence)
  await verifyNativeEvidence(env, evidence)
  return result
}

interface PendingNativeStop {
  operation: RunOperation
  inventoryDigest: string
  stopped: SandboxStopReceipt[]
  physicalZeroVerified: false
  proofDigest?: undefined
}
type CompletedNativeStop = { operation: RunOperation; inventoryDigest: string; stopped: SandboxStopReceipt[]; proofDigest: string }
  & { physicalZeroVerified: true }
type NativeStopResult = PendingNativeStop | CompletedNativeStop
type NativeSettlementResult = (NativeStopResult & { claimsSettled: false }) | (CompletedNativeStop & { claimsSettled: true })

export async function verifiedCleanupWorkspaces(env: Env, state: RunState) {
  return withNativeEvidence(env, evidence => evidence.cleanupWorkspaces(state))
}

/** Historical task handoffs are interpreted only by their owning app version. */
export function assertCurrentTaskOwner(request: AgentRequest): void {
  const owner = request.execution?.mutationOwner
  if (owner !== undefined && (owner.ordinal !== 0 || Object.hasOwn(owner, 'allocation'))) {
    throw new PermanentRunFailure('workspace handoff belongs to its historical app version', 'integrity-failed')
  }
}

/** A late genuine receipt cannot displace the first verified cancellation. */
export async function verifiedCancellationWinner(env: Env, request: AgentRequest, nativeRequestDigest: string, winner: string): Promise<boolean> {
  return withNativeEvidence(env, evidence => evidence.cancellationWinner(request, nativeRequestDigest, winner))
}

async function assertUnreservedDispatch(env: Env, operation: RunOperation, admission: InFlightAgentAttempt) {
  return withNativeEvidence(env, evidence => evidence.unreservedDispatch(operation, admission))
}

async function verifiedCancellationClaims(env: Env, operation: RunOperation, source: RunState): Promise<boolean> {
  return withNativeEvidence(env, evidence => evidence.cancellationClaims(operation, source))
}

/** Existing command journal + private artifacts; no new scheduler or config.
 * Local admission revocation and source-active observation are distinct from
 * stopping processes and proving cleanup. */
export class CommandCustodyCollector {
  constructor(private readonly env: Env) {}

  /** Close native admission only after preserving the complete local candidate
   * inventory. This does not stop processes, settle claims or mark a command
   * applied. Revocation is permanent; future use needs a new allocation. */
  async revoke(auditId: string, commandId: string) {
    return custodyOperation(() => this.revokeSource(auditId, commandId))
  }

  private async revokeSource(auditId: string, commandId: string) {
    const journal = new RunCommandJournal(this.env.INDEX, auditId)
    const runs = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const { operation: original, state } = await readCommandSource(journal, runs, commandId)
    assertWholeExecutionStop(original.command)
    const runtime = await this.assertRuntime(original)
    const { groups } = await withNativeEvidence(this.env, reader => reader.allocationDispositions(original, state))
    const actors = []
    for (const { workspaceKey, sandboxName, members } of groups) {
      const objectId = this.env.AGENT_SANDBOX.idFromName(sandboxName).toString()
      actors.push({ workspaceKey, sandboxName, objectId, records: members.map(({ task, ...record }) => ({ ...record, taskId: task.id })) })
    }
    await withNativeEvidence(this.env, evidence => evidence.assertCurrentCommandHistory(state, original.command.expectedRevision))
    // Validate every source-active dispatch before touching any actor. The
    // original request carries overrides absent from a logical task contract.
    for (const admission of state.inFlightAgentAttempts ?? []) {
      if (admission.dispatchDigest === undefined) throw new PermanentRunFailure('controlled dispatch identity is missing', 'integrity-failed')
      const dispatch = await runs.getAgentDispatch(state.runId, admission.dispatchDigest)
      if (dispatch === null) {
        continue // Recheck after the atomic launch cutoff, before actor effects.
      }
      await assertRecordedTaskAdmission(state, dispatch.request, digest => runs.getRelease(digest), runs.executionSources())
      if (await sha256(executionRequestBody(dispatch.request, this.env.ACK3_CODEX_WORKSPACE_ID)) !== dispatch.nativeRequestDigest) {
        throw new PermanentRunFailure('command dispatch native projection differs', 'integrity-failed')
      }
    }
    const inventory = { schemaVersion: 1, kind: 'native-revocation-inventory', auditId,
      command: { id: commandId, revision: original.revision, digest: original.commandDigest },
      source: original.source!, runtime, actors,
      physicalZeroVerified: false }
    const inventoryDigest = await this.archive(original, inventory)
    const operation = await journal.beginNativeEffect(commandId, original.version, inventoryDigest)
    for (const admission of state.inFlightAgentAttempts ?? []) {
      if (await runs.getAgentDispatch(state.runId, admission.dispatchDigest!) === null) {
        await assertUnreservedDispatch(this.env, operation, admission)
      } else await readCommandDispatch({ journal, runs, commandId, dispatchDigest: admission.dispatchDigest!,
        workspaceId: this.env.ACK3_CODEX_WORKSPACE_ID })
    }
    const revoked: SandboxRevocationReceipt[] = []
    for (const actor of actors) {
      const receipt = await this.env.AGENT_SANDBOX.getByName(actor.sandboxName).revoke(original.commandDigest)
      if (receipt.objectId !== actor.objectId || receipt.commandDigest !== original.commandDigest
        || receipt.admissionRevoked !== true || receipt.physicalZeroVerified !== false) {
        throw new PermanentRunFailure('command actor revocation identity differs', 'integrity-failed')
      }
      revoked.push(receipt)
      // Partial progress remains immutable even if a later actor or write fails.
      await this.archive(operation, { ...inventory, kind: 'native-revocation-progress',
        inventoryDigest, revoked: [...revoked] })
    }
    return { operation, inventoryDigest, actors, revoked, physicalZeroVerified: false as const }
  }

  /** Explicit abandonment is different from session resume: save the bounded
   * evidence available now, then stop. Never wait for a canceled journal to
   * close. The first captured evidence is immutable across retries. */
  async stop(auditId: string, commandId: string): Promise<NativeStopResult> {
    return custodyOperation(async () => {
      const journal = new RunCommandJournal(this.env.INDEX, auditId)
      const runsForProof = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
      const original = await readCommandSource(journal, runsForProof, commandId)
      const completed = original.operation.nativeEffect === undefined ? null : await nativeStopCompletion(this.env.ARTIFACTS, original.operation)
      if (completed !== null) {
        const proof = await withNativeEvidence(this.env, reader => reader.physicalStop(auditId, commandId, completed!))
        const result = { operation: proof.operation, inventoryDigest: proof.operation.nativeEffect!.inventoryDigest,
          stopped: proof.proof.stopped, proofDigest: completed }
        return { ...result, physicalZeroVerified: true }
      }
      const { inventoryDigest, actors, operation: revoked } = await this.revokeSource(auditId, commandId)
      const runs = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
      const { state } = await readCommandSource(journal, runs, commandId)
      const operation = revoked
      const stopped: SandboxStopReceipt[] = []
      for (const actor of actors) {
        const binding = { schemaVersion: 1, kind: 'native-abandonment', auditId,
          commandDigest: operation.commandDigest, source: operation.source!, inventoryDigest, actor }
        const key = `control/custody/${auditId}/${operation.commandDigest}/abandon-${await sha256(binding)}.json`
        const readSaved = async () => {
          const saved = await this.env.ARTIFACTS.get(key)
          if (saved === null) return null
          const content = await saved.text(), digest = await sha256(content)
          let value: { binding: typeof binding; observations: unknown[]; usageComplete: false }
          try { value = JSON.parse(content) }
          catch (cause) { throw new PermanentRunFailure('abandonment evidence is invalid', 'integrity-failed', { cause }) }
          if (value === null || typeof value !== 'object' || Array.isArray(value) || saved.customMetadata?.sha256 !== digest || saved.checksums.toJSON().sha256 !== digest
            || canonicalJson(value.binding) !== canonicalJson(binding) || !Array.isArray(value.observations)
            || value.usageComplete !== false || canonicalJson(value) !== content) {
            throw new PermanentRunFailure('abandonment evidence differs', 'integrity-failed')
          }
          return { value, digest }
        }
        let saved = await readSaved()
        if (saved === null) {
          const observations = []
          for (const admission of state.inFlightAgentAttempts ?? []) {
            const dispatch = await runs.getAgentDispatch(state.runId, admission.dispatchDigest!)
            if (dispatch === null) {
              await assertUnreservedDispatch(this.env, operation, admission)
              if (actor.records.some(record => record.taskId === admission.taskId)) observations.push({
                kind: 'unreserved-admission', dispatchDigest: admission.dispatchDigest,
                taskExecutionId: admission.execution!.taskExecutionId, nativeLaunchReserved: false })
              continue
            }
            if (await nativeSandboxName(dispatch.request) !== actor.sandboxName) continue
            const { observation } = await this.readObservation(auditId, commandId, admission.dispatchDigest!)
            observations.push(observation)
          }
          const value = { binding, observations, usageComplete: false as const }
          const content = canonicalJson(value), digest = await sha256(content)
          try {
            await this.env.ARTIFACTS.put(key, content, { httpMetadata: { contentType: 'application/json' },
              customMetadata: { sha256: digest }, sha256: digest, onlyIf: { etagDoesNotMatch: '*' } })
          } catch { /* Read the first immutable winner after a lost write response. */ }
          saved = await readSaved()
          if (saved === null) throw new TransientRunFailure('abandonment evidence write could not be confirmed')
        }
        // Also keep the same bytes in the hash-addressed custody archive before
        // the destructive RPC; stop intent binds this digest permanently.
        const custodyDigest = await this.archive(operation, saved.value)
        if (custodyDigest !== saved.digest) throw new PermanentRunFailure('abandonment digest differs', 'integrity-failed')
        const receipt = await this.env.AGENT_SANDBOX.getByName(actor.sandboxName).stopRevoked(operation.commandDigest, custodyDigest)
        if (receipt.objectId !== actor.objectId || receipt.commandDigest !== operation.commandDigest || receipt.custodyDigest !== custodyDigest) {
          throw new PermanentRunFailure('command stop actor identity differs', 'integrity-failed')
        }
        if (receipt.status === 'pending' && receipt.physicalZeroVerified === false) {
          const pending: PendingNativeStop = { operation, inventoryDigest, stopped, physicalZeroVerified: false }
          return pending
        }
        try { assertSandboxStopReceipt(receipt) }
        catch (cause) { throw new PermanentRunFailure('command stop receipt is invalid', 'integrity-failed', { cause }) }
        stopped.push(receipt)
        await this.archive(operation, { schemaVersion: 1, kind: 'native-stop-progress',
          auditId, commandDigest: operation.commandDigest, source: operation.source!, inventoryDigest,
          stopped: [...stopped], physicalZeroVerified: false })
      }
      const proof = { schemaVersion: 1, kind: 'native-stop-proof', auditId,
        commandDigest: operation.commandDigest, source: operation.source!, inventoryDigest,
        stopped, physicalZeroVerified: true, interruptedUsageComplete: false }
      const proofDigest = await this.archive(operation, proof)
      const completedDigest = await nativeStopCompletion(this.env.ARTIFACTS, operation, proofDigest)
      if (completedDigest !== proofDigest) throw new PermanentRunFailure('native stop completion changed', 'integrity-failed')
      const result = { operation, inventoryDigest, stopped, proofDigest }
      return { ...result, physicalZeroVerified: true as const }
    })
  }

  /** Whole-execution stop for audit cancellation.
   * Physical stop precedes launch settlement;
   * no command is acknowledged and no audit state is changed by this method. */
  async settleExecutionStop(auditId: string, commandId: string): Promise<NativeSettlementResult> {
    return custodyOperation(async () => {
      const journal = new RunCommandJournal(this.env.INDEX, auditId)
      const runs = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
      const { operation: original, state } = await readCommandSource(journal, runs, commandId)
      if (original.command.action !== 'cancel') {
        throw new RunCommandRejected('scope-unavailable', 'execution stop requires audit cancellation')
      }
      const stopped = await this.stop(auditId, commandId)
      if (stopped.proofDigest === undefined) return { ...stopped, claimsSettled: false as const }
      const authority = new ExecutionAuthorityStore(this.env.INDEX), owner = original.source!.authority
      const receipts = new R2AgentExecutionReceiptStore(this.env.ARTIFACTS)
      const dispatches = await withNativeEvidence(this.env, evidence => evidence.cancellationDispatches(stopped.operation, state))
      // Query AFTER the irrevocable cutoff. This includes reservations that
      // won between source binding and cancellation intent admission.
      for (const claim of await authority.pendingLaunches(owner)) {
        const dispatch = dispatches.get(claim.requestDigest)
        if (dispatch === undefined || dispatch.request.taskExecutionId !== claim.taskExecutionId) {
          throw new PermanentRunFailure('cancellation has an uncovered native claim', 'integrity-failed')
        }
        const objectId = this.env.AGENT_SANDBOX.idFromName(await nativeSandboxName(dispatch.request)).toString()
        const actor = stopped.stopped.find(receipt => receipt.objectId === objectId)
        if (actor === undefined) throw new PermanentRunFailure('cancellation claim actor was not stopped', 'integrity-failed')
        const disposition: CancellationDisposition = { schemaVersion: 1, kind: 'native-cancellation', auditId,
          commandId, commandDigest: original.commandDigest, inventoryDigest: stopped.inventoryDigest,
          physicalProofDigest: stopped.proofDigest, dispatchDigest: dispatch.dispatchDigest,
          nativeRequestDigest: claim.requestDigest, taskExecutionId: claim.taskExecutionId,
          objectId, custodyDigest: actor.custodyDigest, interruptedUsageComplete: false }
        const content = canonicalJson(disposition), digest = await sha256(content)
        await publishImmutableObject(this.env.ARTIFACTS, cancellationKey(state.runId, claim.requestDigest), content, digest, { sha256: digest })
        if (!await verifiedCancellationWinner(this.env, dispatch.request, claim.requestDigest, digest)) {
          throw new PermanentRunFailure('cancellation disposition bytes differ', 'integrity-failed')
        }
        try { await authority.settleLaunch(owner, claim.requestDigest, digest) }
        catch (error) {
          const selected = await authority.observeLaunch(owner, claim.taskExecutionId, claim.requestDigest)
          if (selected?.receiptDigest === digest) continue // lost settlement acknowledgement
          const terminal = await receipts.get(state.runId, claim.requestDigest)
          if (terminal === null || selected?.receiptDigest !== await sha256(terminal)) {
            if (!(error instanceof RunCommandConflict)) throw error
            throw new PermanentRunFailure('cancellation claim settlement differs', 'integrity-failed', { cause: error })
          }
          // A genuine native terminal receipt won first. Its bytes and usage
          // remain in the receipt store; never overwrite it with cancellation.
        }
      }
      if (!await verifiedCancellationClaims(this.env, stopped.operation, state)) return { ...stopped, claimsSettled: false as const }
      return { ...stopped, claimsSettled: true as const }
    })
  }

  /** Read-only verification shared by cancellation ACK and executor retirement.
   * Selected state/ownership publication is a separate atomic control effect. */
  async verifyExecutionStop(auditId: string, commandId: string, proofDigest: string) {
    return custodyOperation(async () => {
      const { source: _source, ...proof } = await withNativeEvidence(this.env, evidence => evidence.stop(auditId, commandId, proofDigest))
      return proof
    })
  }

  /** Reconcile a persisted terminal transition from immutable evidence. Never
   * calls native stop/dispose again, even after an ACK or owner fence response is lost. */
  async acknowledgeCancellation(state: RunState) {
    return custodyOperation(async () => {
      await assertAuditCancellation(state)
      const event = state.journal.at(-2)
      if (event?.type !== 'run.cancelled') throw new RunCommandConflict('operation-conflict', 'audit has no cancellation transition')
      const effect = event.payload as AuditCancellationEffect
      const journal = new RunCommandJournal(this.env.INDEX, state.rootRunId)
      const runs = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
      const { operation } = await readCommandSource(journal, runs, effect.command.id, true)
      if (canonicalJson(operation.source) !== canonicalJson(effect.source)
        || operation.commandDigest !== state.controls?.lastReceipt.commandDigest
        || operation.nativeEffect?.inventoryDigest !== effect.inventoryDigest) {
        throw new PermanentRunFailure('terminal cancellation differs from its command', 'integrity-failed')
      }
      const verified = await this.verifyExecutionStop(state.rootRunId, effect.command.id, effect.proofDigest)
      const completed = await journal.completeCancellation(operation.command.id, operation.version, state)
      return { operation: completed, proofDigest: effect.proofDigest, workspaceKeys: verified.workspaceKeys, physicalZeroVerified: true as const }
    })
  }

  private async assertRuntime(operation: RunOperation) {
    let runtime: ReturnType<typeof localRuntimeRelease>
    try { runtime = localRuntimeRelease(this.env) }
    catch (cause) { throw new PermanentRunFailure('command observation runtime is invalid', 'invalid-configuration', { cause }) }
    if (await sha256(runtime) !== operation.source!.authority.runtimeDigest) {
      throw new PermanentRunFailure('command observation runtime differs from source', 'integrity-failed')
    }
    return runtime
  }

  private async readObservation(auditId: string, commandId: string, dispatchDigest: string) {
    const journal = new RunCommandJournal(this.env.INDEX, auditId)
    const runs = new CloudflareRunStore(this.env.PACKAGES, this.env.ARTIFACTS, this.env.INDEX)
    const { operation, dispatch } = await readCommandDispatch({ journal, runs, commandId, dispatchDigest,
      workspaceId: this.env.ACK3_CODEX_WORKSPACE_ID })
    const runtime = await this.assertRuntime(operation)
    const { request, nativeRequestDigest } = dispatch
    const launch = await new ExecutionAuthorityStore(this.env.INDEX)
      .observeLaunch(operation.source!.authority, request.taskExecutionId!, nativeRequestDigest)
    const sandboxName = await nativeSandboxName(request)
    const objectId = this.env.AGENT_SANDBOX.idFromName(sandboxName).toString()
    const actor = this.env.AGENT_SANDBOX.getByName(sandboxName)
    const revocation = await actor.revocationStatus(operation.commandDigest)
    if (revocation.objectId !== objectId || revocation.commandDigest !== operation.commandDigest
      || revocation.admissionRevoked !== true || revocation.physicalZeroVerified !== false) {
      throw new PermanentRunFailure('command actor revocation identity differs', 'integrity-failed')
    }
    const receipt = await new R2AgentExecutionReceiptStore(this.env.ARTIFACTS).get(request.runId, nativeRequestDigest)
    const readLog = async () => {
      const value = await actor.observeAgentLog(nativeRequestDigest, 0, sandboxLogReadMaxBytes)
      try { return parseLogObservation(value, 0, sandboxLogReadMaxBytes) }
      catch (cause) { throw new PermanentRunFailure('command log observation integrity failed', 'integrity-failed', { cause }) }
    }
    const log = await abandonmentObservation(readLog)
    let session: DshSessionObservation | { status: 'not-located' | 'unsupported' }
      | { status: 'unavailable'; reason: 'observation-incomplete' } = { status: 'not-located' }
    if (taskBackend(request.task) !== 'dsh-chat-completions') session = { status: 'unsupported' }
    else if (receipt !== null && /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.actorId)) {
      const cwd = agentWorkingDirectory(request.task.promptKind)
      const readSession = async () => {
        const value = await actor.observeDshSession(receipt.actorId, cwd)
        try { return await parseDshSessionObservation(value, receipt.actorId, cwd) }
        catch (cause) { throw new PermanentRunFailure('command session observation integrity failed', 'integrity-failed', { cause }) }
      }
      session = await abandonmentObservation(readSession)
    }
    const observation = { schemaVersion: 1, auditId,
      command: { id: commandId, revision: operation.revision, digest: operation.commandDigest },
      source: operation.source!, dispatchDigest, nativeRequestDigest,
      actor: { runtime, sandboxName, objectId }, revocation, launch, log, session,
      receiptDigest: receipt === null ? null : await sha256(receipt), physicalZeroVerified: false }
    return { operation, observation }
  }

  private async archive(operation: RunOperation, observation: unknown) {
    const { auditId } = operation
    const content = canonicalJson(observation), digest = await sha256(content)
    const key = `control/custody/${auditId}/${operation.commandDigest}/${digest}.json`
    await publishImmutableObject(this.env.ARTIFACTS, key, content, digest, { auditId, commandDigest: operation.commandDigest, sha256: digest })
    return digest
  }
}
