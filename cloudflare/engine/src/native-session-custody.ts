import type { SandboxClient } from './agent-sandbox-client.js'
import { nativeSessionMarkerPath, nativeSessionMarkerId, parseNativeSessionMarker, nativeSessionMaxBytes, parseDshSessionObservation, type DshSessionObservationAvailable } from './native-session-observation.js'
import type { AgentRequest, NativeTerminalCustodyEvidence, NativeTransportEvidence, NativeSessionCustodyReference, TaskDefinition } from './contracts.js'
import type { AgentExecutionReceipt } from './agent-execution-receipt.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { agentWorkingDirectory } from './agent-working-directory.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

const nativeCodes = new Set(['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE'])
const sessionPattern = /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const maxBytes = nativeSessionMaxBytes

export function nativeTransportCode(request: AgentRequest, receipt: AgentExecutionReceipt): NativeTransportEvidence['code'] | null {
  const code = receipt.providerErrorCode
  if (request.task.providerClass !== 'additive' || request.task.backend !== 'dsh-chat-completions'
    || receipt.exitCode !== 1 || receipt.providerRequests?.length !== 0 || !nativeCodes.has(code ?? '')) return null
  const status = receipt.providerHttpStatus
  if (code === 'SERVER' ? (status ?? 0) < 500 || (status ?? 600) > 599
    : code === 'RATE_LIMIT' ? status !== 429 : status !== null) return null
  return code as NativeTransportEvidence['code']
}

export function nativeTerminalCustodyCode(request: AgentRequest, receipt: AgentExecutionReceipt): 'AUTH' | null {
  return request.task.providerClass === 'additive' && request.task.backend === 'dsh-chat-completions'
    && receipt.exitCode === 1 && receipt.providerRequests?.length === 0
    && receipt.providerErrorCode === 'AUTH' && [401, 403].includes(receipt.providerHttpStatus ?? 0)
    ? 'AUTH' : null
}

export function validNativeTransport(value: unknown): value is NativeTransportEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as NativeTransportEvidence
  return validNativeSessionCustody(r) && nativeCodes.has(r.code)
}

/** Validate the neutral reference separately from any error/retry classification. */
export function validNativeSessionCustody(value: unknown): value is NativeSessionCustodyReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as NativeSessionCustodyReference
  return typeof r.sourceRunId === 'string' && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.sourceRunId)
    && [r.requestDigest, r.snapshotDigest].every(v => typeof v === 'string' && digestPattern.test(v))
    && typeof r.sessionId === 'string' && sessionPattern.test(r.sessionId)
    && ['none', 'present', 'unknown'].includes(r.workState)
    && (r as NativeSessionCustodyReference & { observationId?: unknown }).observationId === undefined
}

export function retainedTransportForAttempt(
  task: Pick<TaskDefinition, 'id' | 'providerClass' | 'backend'>,
  attempt: number,
  rejections: readonly { taskId: string, attempt: number, sessionId: string | null, nativeTransport?: NativeTransportEvidence }[],
): NativeTransportEvidence | undefined {
  if (task.providerClass !== 'additive' || task.backend !== 'dsh-chat-completions' || attempt <= 1) return undefined
  const prior = rejections.filter(r => r.taskId === task.id && r.attempt === attempt - 1).at(-1)
  const evidence = prior?.nativeTransport
  return validNativeTransport(evidence) && evidence.sessionId === prior?.sessionId ? evidence : undefined
}

export function renderNativeSessionResumePatch(evidence: NativeTransportEvidence): string {
  if (!validNativeTransport(evidence) || evidence.workState === 'none') throw new TypeError('native resume custody is invalid')
  return renderNativeSessionIdPatch(evidence.sessionId)
}

export function renderNativeSessionIdPatch(sessionId: string): string {
  if (!sessionPattern.test(sessionId)) throw new TypeError('native session id is invalid')
  return [
    '- id: headless-runner', '  config:',
    '    task: !!js ctx.headlessStartup.task', '    json: !!js ctx.headlessStartup.json',
    `    sessionId: ${JSON.stringify(sessionId)}`, '',
  ].join('\n')
}

interface SnapshotScope {
  runId: string
  releaseDigest: string
  taskId: string
  workspaceKey: string
  sessionId: string
  requestDigest: string
  workingDirectory: string
}
type NativeSnapshot = SnapshotScope & ({
  status: 'available'
  fileName: string
  journalDigest: string
  workState: NativeTransportEvidence['workState']
  contentBase64: string
  workspaceMarkerDigest: string
} | { status: 'unavailable', reason: string })

function snapshotMarker(scope: SnapshotScope): Promise<string> {
  return nativeSessionMarkerPath(scope.requestDigest)
}

function key(runId: string, requestDigest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId) || !digestPattern.test(requestDigest)) throw new TypeError('native custody scope invalid')
  return `quarantine/native-sessions/${runId}/${requestDigest}.json`
}

async function inspection(sandbox: SandboxClient, sessionId: string, cwd: string): Promise<DshSessionObservationAvailable | null> {
  if (!sessionPattern.test(sessionId) || !['/workspace/source', '/workspace/results'].includes(cwd)) return null
  const value = await parseDshSessionObservation(await sandbox.observeDshSession(sessionId, cwd), sessionId, cwd)
  return value.status === 'available' ? value : null
}

async function custodyOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof PermanentRunFailure || error instanceof TransientRunFailure) throw error
    // Retrying private custody I/O must reread the paid execution's receipt,
    // rather than consume another model execution or output-repair allowance.
    throw new TransientRunFailure('native session custody I/O is temporarily unavailable', { cause: error })
  }
}

function assertSnapshotBinding(snapshot: NativeSnapshot, request: AgentRequest, receipt: AgentExecutionReceipt) {
  if (snapshot.runId !== request.runId || snapshot.requestDigest !== receipt.requestDigest
    || snapshot.sessionId !== receipt.actorId || snapshot.releaseDigest !== request.releaseDigest
    || snapshot.taskId !== request.task.id || snapshot.workspaceKey !== request.task.workspaceKey
    || snapshot.workingDirectory !== agentWorkingDirectory(request.task.promptKind)) {
    throw new PermanentRunFailure('native session snapshot ownership failed', 'integrity-failed')
  }
}

export class NativeSessionCustody {
  constructor(private readonly bucket: R2Bucket) {}

  private async read(runId: string, requestDigest: string): Promise<{ snapshot: NativeSnapshot, digest: string } | null> {
    const object = await this.bucket.get(key(runId, requestDigest))
    if (object === null) return null
    const text = await object.text(), digest = await sha256(text)
    if (object.customMetadata?.sha256 !== digest || object.checksums.toJSON().sha256 !== digest) {
      throw new PermanentRunFailure('native session snapshot integrity failed', 'integrity-failed')
    }
    let snapshot: NativeSnapshot
    try { snapshot = JSON.parse(text) as NativeSnapshot } catch {
      throw new PermanentRunFailure('native session snapshot content is invalid', 'integrity-failed')
    }
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || !['available', 'unavailable'].includes(snapshot.status)
      || (snapshot.status === 'available' && (!digestPattern.test(snapshot.journalDigest)
        || !digestPattern.test(snapshot.workspaceMarkerDigest)
        || typeof snapshot.contentBase64 !== 'string' || snapshot.contentBase64.length > Math.ceil(maxBytes / 3) * 4
        || !['none', 'present', 'unknown'].includes(snapshot.workState)))
      || snapshot.runId !== runId || snapshot.requestDigest !== requestDigest
      || 'observationId' in snapshot || 'controlBinding' in snapshot) {
      throw new PermanentRunFailure('native session snapshot scope failed', 'integrity-failed')
    }
    return { snapshot, digest }
  }

  /** Archive before terminal disposal; an archive alone never permits resume. */
  async capture(sandbox: SandboxClient, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTransportEvidence | null> {
    return custodyOperation(() => this.captureClosed(sandbox, request, receipt))
  }

  private async captureClosed(sandbox: SandboxClient, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTransportEvidence | null> {
    const code = nativeTransportCode(request, receipt)
    if (code === null) return null
    const saved = await this.captureSnapshot(sandbox, request, receipt)
    const { snapshot, digest } = saved
    if (snapshot.status === 'unavailable') return null
    return { code, sourceRunId: snapshot.runId, requestDigest: snapshot.requestDigest, sessionId: snapshot.sessionId,
      snapshotDigest: digest, workState: snapshot.workState }
  }

  /** Preserve a terminal AUTH journal and possible scratch without making AUTH retryable. */
  async captureTerminal(sandbox: SandboxClient, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTerminalCustodyEvidence | null> {
    if (nativeTerminalCustodyCode(request, receipt) === null) return null
    const { snapshot, digest } = await custodyOperation(() => this.captureSnapshot(sandbox, request, receipt))
    return { code: 'AUTH', sourceRunId: snapshot.runId, requestDigest: snapshot.requestDigest,
      sessionId: snapshot.sessionId, snapshotDigest: digest, archiveStatus: snapshot.status,
      workState: snapshot.status === 'available' ? snapshot.workState : 'unknown' }
  }

  private async captureSnapshot(sandbox: SandboxClient, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<{ snapshot: NativeSnapshot, digest: string }> {
    // Hash, scope and persist one caller snapshot even if storage awaits.
    request = deepClone(request)
    receipt = deepClone(receipt)
    let saved = await this.read(request.runId, receipt.requestDigest)
    if (saved === null) {
      const scope: SnapshotScope = { runId: request.runId, releaseDigest: request.releaseDigest, taskId: request.task.id,
        workspaceKey: request.task.workspaceKey, sessionId: receipt.actorId, requestDigest: receipt.requestDigest,
        workingDirectory: agentWorkingDirectory(request.task.promptKind) }
      const journal = await inspection(sandbox, receipt.actorId, scope.workingDirectory)
      let snapshot: NativeSnapshot = { ...scope, status: 'unavailable', reason: 'native-journal-missing-invalid-or-unbounded' }
      if (journal !== null) {
        const marker = canonicalJson({ ...scope, journalDigest: journal.journalDigest })
        await sandbox.writeFile(await snapshotMarker(scope), marker)
        snapshot = { ...scope, status: 'available', fileName: journal.fileName, journalDigest: journal.journalDigest,
          workState: journal.workState, contentBase64: journal.contentBase64, workspaceMarkerDigest: await sha256(marker) }
      }
      const text = canonicalJson(snapshot), digest = await sha256(text)
      const stored = await this.bucket.put(key(scope.runId, scope.requestDigest), text, {
        httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: digest, disposition: 'native-session-custody' },
        sha256: digest, onlyIf: { etagDoesNotMatch: '*' },
      })
      saved = stored === null ? await this.read(scope.runId, scope.requestDigest) : { snapshot, digest }
      if (saved === null) throw new TransientRunFailure('native session snapshot not yet durable')
    }
    assertSnapshotBinding(saved.snapshot, request, receipt)
    return saved
  }

  async assertRetryCustody(sandbox: SandboxClient, request: AgentRequest): Promise<void> {
    return custodyOperation(() => this.assertRetained(sandbox, request))
  }

  /** Output correction must reuse the completed native journal and exact quarantined files. */
  async assertFormatRepairCustody(sandbox: SandboxClient, request: AgentRequest): Promise<void> {
    return custodyOperation(async () => {
      if (request.formatRepairOrdinal === undefined || !digestPattern.test(request.formatRepairSourceDigest ?? '')
        || request.continuationMode !== 'resume' || request.freshContext || !sessionPattern.test(request.sessionId ?? '')
        || request.task.backend !== 'dsh-chat-completions' || request.task.providerClass !== 'additive'
        || await sha256(canonicalJson(request.repairFiles)) !== request.formatRepairSourceDigest) {
        throw new PermanentRunFailure('native output correction binding is invalid', 'integrity-failed')
      }
      const retained = await inspection(sandbox, request.sessionId!, agentWorkingDirectory(request.task.promptKind))
      if (retained === null || retained.workState === 'none') {
        throw new PermanentRunFailure('completed native session is no longer retained for output correction',
          'session-recovery-unavailable')
      }
    })
  }

  private async assertRetained(sandbox: SandboxClient, request: AgentRequest): Promise<void> {
    const ref = request.nativeTransport
    if (!validNativeTransport(ref)
      || (ref.workState === 'none' ? request.continuationMode !== 'new' || !request.freshContext || request.sessionId !== null
        : request.continuationMode !== 'resume' || request.freshContext || request.sessionId !== ref.sessionId)) throw new PermanentRunFailure('native session resume binding is invalid', 'integrity-failed')
    await this.assertSession(sandbox, request, ref, ref.workState !== 'none')
  }

  private async assertSession(sandbox: SandboxClient, request: AgentRequest, ref: NativeSessionCustodyReference, requireWorkspace = true): Promise<void> {
    request = deepClone(request)
    ref = deepClone(ref)
    if (!validNativeSessionCustody(ref) || request.task.backend !== 'dsh-chat-completions'
      || request.task.providerClass !== 'additive') throw new PermanentRunFailure('native session custody binding is invalid', 'integrity-failed')
    const saved = await this.read(ref.sourceRunId, ref.requestDigest)
    if (saved === null || saved.digest !== ref.snapshotDigest || saved.snapshot.status !== 'available') {
      throw new PermanentRunFailure('native session archive is missing or mismatched', 'session-recovery-unavailable')
    }
    const snapshot = saved.snapshot
    if (snapshot.sessionId !== ref.sessionId || snapshot.releaseDigest !== request.releaseDigest
      || snapshot.taskId !== request.task.id || snapshot.workspaceKey !== request.task.workspaceKey
      || snapshot.workState !== ref.workState || snapshot.workingDirectory !== agentWorkingDirectory(request.task.promptKind)) {
      throw new PermanentRunFailure('native session resume ownership is invalid', 'integrity-failed')
    }
    if (!requireWorkspace) return // Only automatic fresh retry of an evidenced empty attempt.
    const markerId = await nativeSessionMarkerId(snapshot.requestDigest)
    const marker = parseNativeSessionMarker(await sandbox.observeSessionMarker(snapshot.requestDigest), markerId)
    if (marker.status !== 'available' || marker.digest !== snapshot.workspaceMarkerDigest) {
      throw new PermanentRunFailure('original native workspace custody marker is missing', 'session-recovery-unavailable')
    }
    // Never write a saved journal into a recreated lane: its scratch may be lost.
    const retained = await inspection(sandbox, ref.sessionId, snapshot.workingDirectory)
    if (retained === null || retained.journalDigest !== snapshot.journalDigest || retained.workState !== snapshot.workState) {
      throw new PermanentRunFailure('original native session workspace is no longer retained', 'session-recovery-unavailable')
    }
  }
}
