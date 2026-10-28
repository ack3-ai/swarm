import type { ISandbox } from '@cloudflare/sandbox'
import type { AgentRequest, NativeTerminalCustodyEvidence, NativeTransportEvidence, TaskDefinition } from './contracts.js'
import type { AgentExecutionReceipt } from './agent-execution-receipt.js'
import { canonicalJson, sha256 } from './canonical.js'
import { agentWorkingDirectory } from './agent-working-directory.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

const nativeCodes = new Set(['TRANSPORT', 'TIMEOUT', 'STREAM_CLOSED', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE'])
const sessionPattern = /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/
const maxBytes = 16 * 1024 * 1024
const inspectorPath = '/workspace/private/native-session-inspector.py'

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

export function validNativeTerminalCustody(value: unknown): value is NativeTerminalCustodyEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as NativeTerminalCustodyEvidence
  return r.code === 'AUTH' && typeof r.sourceRunId === 'string'
    && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.sourceRunId)
    && digestPattern.test(r.requestDigest) && digestPattern.test(r.snapshotDigest)
    && sessionPattern.test(r.sessionId) && ['available', 'unavailable'].includes(r.archiveStatus)
    && ['none', 'present', 'unknown'].includes(r.workState)
    && (r.archiveStatus !== 'unavailable' || r.workState === 'unknown')
}

export function validNativeTransport(value: unknown): value is NativeTransportEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const r = value as NativeTransportEvidence
  return typeof r.sourceRunId === 'string' && nativeCodes.has(r.code) && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(r.sourceRunId)
    && digestPattern.test(r.requestDigest) && digestPattern.test(r.snapshotDigest)
    && sessionPattern.test(r.sessionId) && ['none', 'present', 'unknown'].includes(r.workState)
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

// Runs only against a closed execution or before its existing next attempt.
// The installed image already includes Python and zstd. No agent instructions,
// new image, model calls, or filesystem restore are involved.
export const nativeSessionInspectionScript = String.raw`import sys,os,stat,json,re,hashlib,subprocess,tempfile
session,cwd=sys.argv[1:]
if not re.fullmatch(r'session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',session) or cwd not in ('/workspace/source','/workspace/results'): raise ValueError('invalid fixed session scope')
project={'/workspace/source':'--workspace-source--','/workspace/results':'--workspace-results--'}[cwd]
root='/opt/dsh-home/sessions/'+project+'/'+session
limit=16*1024*1024
try:
 directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for segment in root.strip('/').split('/'):
   child=os.open(segment,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
   os.close(directory);directory=child
  files=[]
  for name in os.listdir(directory):
   m=re.fullmatch(r'session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?',name)
   if m and stat.S_ISREG(os.stat(name,dir_fd=directory,follow_symlinks=False).st_mode): files.append((int(m[1] or 0),not bool(m[2]),name))
  if not files: raise ValueError('native journal is missing')
  name=max(files)[2];path=root+'/'+name
  fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
  with os.fdopen(fd,'rb') as file:
   raw=file.read(limit+1)
  if len(raw)>limit: raise ValueError('native journal exceeds custody limit')
 finally: os.close(directory)
 decoded=raw
 if name.endswith('.zstd'):
  with tempfile.TemporaryFile() as source:
   source.write(raw);source.seek(0)
   with subprocess.Popen(['zstd','-q','-d','--stdout'],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL) as proc:
    decoded=proc.stdout.read(64*1024*1024+1)
    if len(decoded)>64*1024*1024: proc.kill();raise ValueError('decoded journal exceeds custody limit')
    if proc.wait(timeout=5)!=0: raise ValueError('native journal decompression is incomplete')
 records=[json.loads(line) for line in decoded.splitlines() if line]
 if not records or records[0].get('type')!='session' or records[0].get('id')!=session or records[0].get('cwd')!=cwd: raise ValueError('native journal ownership mismatch')
 # Empty is proven only by a complete closed journal without model/tool work.
 work=False
 for record in records:
  kind=record.get('type','');data=record.get('data',{})
  if kind in ('assistant/message','tool/call','tool/result'): work=True
  if kind=='assistant/attempt':
   for chunk in data.get('stream',[]):
    if chunk.get('type')!='chunk' or chunk.get('chunk',{}).get('type')!='finish': work=True
 starts=[r for r in records if r.get('type')=='turn/start']
 ends=[r for r in records if r.get('type')=='turn/end']
 closed=bool(starts and ends and ends[-1].get('data',{}).get('turn')==starts[-1].get('data',{}).get('turn') and ends[-1].get('seq',-1)>starts[-1].get('seq',0))
 print(json.dumps({'status':'available','path':path,'fileName':name,'bytes':len(raw),'journalDigest':hashlib.sha256(raw).hexdigest(),'closed':closed,'workState':'present' if work else 'none' if closed else 'unknown'}))
except (OSError,ValueError,TypeError,AttributeError,subprocess.SubprocessError):
 print(json.dumps({'status':'unavailable','reason':'native-journal-missing-invalid-or-unbounded'}))
`

interface JournalInspection {
  status: 'available'
  path: string
  fileName: string
  bytes: number
  journalDigest: string
  closed?: boolean
  workState: NativeTransportEvidence['workState']
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

function workspaceMarker(requestDigest: string): string {
  if (!digestPattern.test(requestDigest)) throw new TypeError('native workspace marker scope invalid')
  return `/workspace/private/native-session-custody-${requestDigest}.json`
}

function key(runId: string, requestDigest: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(runId) || !digestPattern.test(requestDigest)) throw new TypeError('native custody scope invalid')
  return `quarantine/native-sessions/${runId}/${requestDigest}.json`
}

async function inspection(sandbox: ISandbox, sessionId: string, cwd: string): Promise<JournalInspection | null> {
  if (!sessionPattern.test(sessionId) || !['/workspace/source', '/workspace/results'].includes(cwd)) return null
  await sandbox.writeFile(inspectorPath, nativeSessionInspectionScript)
  const result = await sandbox.exec(`python3 ${inspectorPath} ${sessionId} ${cwd}`, { timeout: 10_000 })
  if (!result.success) throw new TransientRunFailure('native session inspection did not finish')
  const value = JSON.parse(result.stdout) as JournalInspection
  if (value.status !== 'available') return null
  const project = cwd === '/workspace/source' ? '--workspace-source--' : '--workspace-results--'
  if (!/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(value.fileName)
    || value.path !== `/opt/dsh-home/sessions/${project}/${sessionId}/${value.fileName}`
    || !digestPattern.test(value.journalDigest) || !Number.isSafeInteger(value.bytes)
    || value.bytes < 0 || value.bytes > maxBytes || !['none', 'present', 'unknown'].includes(value.workState)
    || (value.closed !== undefined && typeof value.closed !== 'boolean')) {
    throw new PermanentRunFailure('native session inspection ownership is invalid', 'integrity-failed')
  }
  return value
}

async function bytesDigest(base64: string): Promise<string> {
  if (base64.length > Math.ceil(maxBytes / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new PermanentRunFailure('native journal encoding is invalid', 'integrity-failed')
  }
  const binary = atob(base64)
  if (binary.length > maxBytes || btoa(binary) !== base64) throw new PermanentRunFailure('native journal bytes are invalid', 'integrity-failed')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
}

async function custodyOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation() } catch (error) {
    if (error instanceof PermanentRunFailure || error instanceof TransientRunFailure) throw error
    // Retrying private custody I/O must reread the paid execution's receipt,
    // rather than consume another model execution or output-repair allowance.
    throw new TransientRunFailure('native session custody I/O is temporarily unavailable', { cause: error })
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
      || snapshot.runId !== runId || snapshot.requestDigest !== requestDigest) {
      throw new PermanentRunFailure('native session snapshot scope failed', 'integrity-failed')
    }
    return { snapshot, digest }
  }

  /** Archive before terminal disposal; an archive alone never permits resume. */
  async capture(sandbox: ISandbox, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTransportEvidence | null> {
    return custodyOperation(() => this.captureClosed(sandbox, request, receipt))
  }

  private async captureClosed(sandbox: ISandbox, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTransportEvidence | null> {
    const code = nativeTransportCode(request, receipt)
    if (code === null) return null
    const saved = await this.captureSnapshot(sandbox, request, receipt)
    const { snapshot, digest } = saved
    if (snapshot.status === 'unavailable') return null
    return { code, sourceRunId: snapshot.runId, requestDigest: snapshot.requestDigest, sessionId: snapshot.sessionId,
      snapshotDigest: digest, workState: snapshot.workState }
  }

  /** Preserve a terminal AUTH journal and possible scratch without making AUTH retryable. */
  async captureTerminal(sandbox: ISandbox, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<NativeTerminalCustodyEvidence | null> {
    if (nativeTerminalCustodyCode(request, receipt) === null) return null
    const { snapshot, digest } = await custodyOperation(() => this.captureSnapshot(sandbox, request, receipt))
    return { code: 'AUTH', sourceRunId: snapshot.runId, requestDigest: snapshot.requestDigest,
      sessionId: snapshot.sessionId, snapshotDigest: digest, archiveStatus: snapshot.status,
      workState: snapshot.status === 'available' ? snapshot.workState : 'unknown' }
  }

  private async captureSnapshot(sandbox: ISandbox, request: AgentRequest, receipt: AgentExecutionReceipt): Promise<{ snapshot: NativeSnapshot, digest: string }> {
    let saved = await this.read(request.runId, receipt.requestDigest)
    if (saved === null) {
      const scope: SnapshotScope = { runId: request.runId, releaseDigest: request.releaseDigest, taskId: request.task.id,
        workspaceKey: request.task.workspaceKey, sessionId: receipt.actorId, requestDigest: receipt.requestDigest,
        workingDirectory: agentWorkingDirectory(request.task.promptKind) }
      const journal = await inspection(sandbox, receipt.actorId, scope.workingDirectory)
      let snapshot: NativeSnapshot = { ...scope, status: 'unavailable', reason: 'native-journal-missing-invalid-or-unbounded' }
      if (journal !== null) {
        const file = await sandbox.readFile(journal.path, { encoding: 'base64' })
        if (await bytesDigest(file.content) !== journal.journalDigest) throw new TransientRunFailure('closed native journal changed during capture')
        const marker = canonicalJson({ ...scope, journalDigest: journal.journalDigest })
        await sandbox.writeFile(workspaceMarker(scope.requestDigest), marker)
        snapshot = { ...scope, status: 'available', fileName: journal.fileName, journalDigest: journal.journalDigest,
          workState: journal.workState, contentBase64: file.content, workspaceMarkerDigest: await sha256(marker) }
      }
      const text = canonicalJson(snapshot), digest = await sha256(text)
      const stored = await this.bucket.put(key(scope.runId, scope.requestDigest), text, {
        httpMetadata: { contentType: 'application/json' }, customMetadata: { sha256: digest, disposition: 'native-session-custody' },
        sha256: digest, onlyIf: { etagDoesNotMatch: '*' },
      })
      saved = stored === null ? await this.read(scope.runId, scope.requestDigest) : { snapshot, digest }
      if (saved === null) throw new TransientRunFailure('native session snapshot not yet durable')
    }
    const { snapshot, digest } = saved
    if (snapshot.sessionId !== receipt.actorId || snapshot.releaseDigest !== request.releaseDigest
      || snapshot.taskId !== request.task.id || snapshot.workspaceKey !== request.task.workspaceKey
      || snapshot.workingDirectory !== agentWorkingDirectory(request.task.promptKind)) {
      throw new PermanentRunFailure('native session snapshot ownership failed', 'integrity-failed')
    }
    return { snapshot, digest }
  }

  async assertRetryCustody(sandbox: ISandbox, request: AgentRequest): Promise<void> {
    return custodyOperation(() => this.assertRetained(sandbox, request))
  }

  /** Output correction must reuse the completed native journal and exact quarantined files. */
  async assertFormatRepairCustody(sandbox: ISandbox, request: AgentRequest): Promise<void> {
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

  private async assertRetained(sandbox: ISandbox, request: AgentRequest): Promise<void> {
    const ref = request.nativeTransport
    if (!validNativeTransport(ref)
      || (ref.workState === 'none' ? request.continuationMode !== 'new' || !request.freshContext || request.sessionId !== null
        : request.continuationMode !== 'resume' || request.freshContext || request.sessionId !== ref.sessionId)) throw new PermanentRunFailure('native session resume binding is invalid', 'integrity-failed')
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
    if (ref.workState === 'none') return // A complete empty attempt has no research or scratch to lose.
    const marker = await sandbox.exists(workspaceMarker(ref.requestDigest))
    if (!marker.exists || await sha256((await sandbox.readFile(workspaceMarker(ref.requestDigest))).content) !== snapshot.workspaceMarkerDigest) {
      throw new PermanentRunFailure('original native workspace custody marker is missing', 'session-recovery-unavailable')
    }
    // Never write a saved journal into a recreated lane: its scratch may be lost.
    const retained = await inspection(sandbox, ref.sessionId, snapshot.workingDirectory)
    if (retained === null || retained.journalDigest !== snapshot.journalDigest || retained.workState !== snapshot.workState) {
      throw new PermanentRunFailure('original native session workspace is no longer retained', 'session-recovery-unavailable')
    }
  }
}
