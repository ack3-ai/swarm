import { PermanentRunFailure } from './run-errors.js'

export const nativeSessionMaxBytes = 16 * 1024 * 1024
const sessionPattern = /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const digestPattern = /^[a-f0-9]{64}$/

/** A journal sample, not proof that its writer exited or scratch is resumable. */
export interface DshSessionObservationAvailable {
  status: 'available'
  sessionId: string
  workingDirectory: string
  fileName: string
  bytes: number
  journalDigest: string
  contentBase64: string
  closed: boolean
  workState: 'none' | 'present' | 'unknown'
}
export type DshSessionObservation = DshSessionObservationAvailable | {
  status: 'unavailable'
  reason: 'missing' | 'invalid' | 'unbounded'
}

export function assertDshSessionScope(sessionId: string, cwd: string): void {
  if (typeof sessionId !== 'string' || !sessionPattern.test(sessionId)
    || !['/workspace/source', '/workspace/results'].includes(cwd)) throw new TypeError('native session observation scope is invalid')
}

export async function parseDshSessionObservation(value: unknown, sessionId: string, cwd: string): Promise<DshSessionObservation> {
  assertDshSessionScope(sessionId, cwd)
  const invalid = () => new PermanentRunFailure('native session observation integrity failed', 'integrity-failed')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const r = value as Record<string, unknown>
  if (r.status === 'unavailable' && Object.keys(r).length === 2 && typeof r.reason === 'string' && ['missing', 'invalid', 'unbounded'].includes(r.reason)) {
    return r as DshSessionObservation
  }
  if (r.status !== 'available' || Object.keys(r).length !== 9 || r.sessionId !== sessionId || r.workingDirectory !== cwd
    || typeof r.fileName !== 'string' || !/^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/.test(r.fileName)
    || !Number.isSafeInteger(r.bytes) || Number(r.bytes) < 1 || Number(r.bytes) > nativeSessionMaxBytes
    || typeof r.journalDigest !== 'string' || !digestPattern.test(r.journalDigest)
    || typeof r.closed !== 'boolean' || typeof r.workState !== 'string' || !['none', 'present', 'unknown'].includes(r.workState)
    || (r.workState === 'none' && !r.closed)
    || typeof r.contentBase64 !== 'string' || r.contentBase64.length !== Math.ceil(Number(r.bytes) / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.contentBase64)) throw invalid()
  let binary: string
  try { binary = atob(r.contentBase64) } catch { throw invalid() }
  if (binary.length !== r.bytes || btoa(binary) !== r.contentBase64) throw invalid()
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('')
  if (digest !== r.journalDigest) throw invalid()
  return r as unknown as DshSessionObservationAvailable
}

// Fixed native adapter. Reads one journal without installing code or writing
// markers in the workspace. Compressed input is decoded via a temporary file
// outside that workspace; only journal bytes are read, never credential files.
export const nativeSessionInspectionScript = String.raw`import sys,os,stat,json,re,hashlib,base64,subprocess,tempfile,errno
session,cwd=sys.argv[1:]
if not re.fullmatch(r'session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',session) or cwd not in ('/workspace/source','/workspace/results'): raise ValueError('invalid fixed session scope')
project={'/workspace/source':'--workspace-source--','/workspace/results':'--workspace-results--'}[cwd]
root='/opt/dsh-home/sessions/'+project+'/'+session
limit=16*1024*1024
class Unavailable(Exception): pass
try:
 try:
  directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
  try:
   for segment in root.strip('/').split('/'):
    child=os.open(segment,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
    os.close(directory);directory=child
   selected=None
   with os.scandir(directory) as entries:
    for entry in entries:
     name=entry.name
     m=re.fullmatch(r'session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?',name)
     if m:
      candidate=(int(m[1] or 0),not bool(m[2]),name)
      if selected is None or candidate>selected: selected=candidate
   if selected is None: raise Unavailable('missing')
   name=selected[2]
   try: fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
   except FileNotFoundError as error: raise RuntimeError('selected native journal disappeared during observation') from error
   try:
    before=os.fstat(fd)
    if not stat.S_ISREG(before.st_mode): raise Unavailable('invalid')
    if before.st_size>limit: raise Unavailable('unbounded')
    with os.fdopen(fd,'rb',closefd=False) as file: raw=file.read(limit+1)
    after=os.fstat(fd)
    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or len(raw)!=before.st_size: raise RuntimeError('native journal changed during observation')
   finally: os.close(fd)
   if len(raw)>limit: raise Unavailable('unbounded')
  finally: os.close(directory)
 except FileNotFoundError: raise Unavailable('missing')
 except OSError as error:
  if error.errno not in (errno.ELOOP,errno.ENOTDIR): raise
  raise Unavailable('invalid')
 decoded=raw
 if name.endswith('.zstd'):
  with tempfile.TemporaryFile(dir='/tmp') as source:
   source.write(raw);source.seek(0)
   with subprocess.Popen(['/usr/bin/zstd','-q','-d','--stdout'],stdin=source,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL) as proc:
    decoded=proc.stdout.read(64*1024*1024+1)
    if len(decoded)>64*1024*1024: proc.kill();raise Unavailable('unbounded')
    if proc.wait(timeout=5)!=0: raise RuntimeError('native journal decompression did not finish')
 try:
  records=[json.loads(line) for line in decoded.splitlines() if line]
  if not records or records[0].get('type')!='session' or records[0].get('id')!=session or records[0].get('cwd')!=cwd: raise Unavailable('invalid')
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
 except (ValueError,TypeError,AttributeError): raise Unavailable('invalid')
 print(json.dumps({'status':'available','sessionId':session,'workingDirectory':cwd,'fileName':name,'bytes':len(raw),'journalDigest':hashlib.sha256(raw).hexdigest(),'contentBase64':base64.b64encode(raw).decode('ascii'),'closed':closed,'workState':'present' if work else 'none' if closed else 'unknown'}))
except Unavailable as error:
 print(json.dumps({'status':'unavailable','reason':str(error)}))

`

/** Only the digest of one fixed custody marker, never arbitrary file content. */
export type NativeSessionMarkerObservation = {
  status: 'available'; markerId: string; bytes: number; digest: string
} | { status: 'unavailable'; reason: 'missing' | 'invalid' | 'unbounded' }
export const nativeSessionMarkerMaxBytes = 16 * 1024

export async function nativeSessionMarkerId(requestDigest: string): Promise<string> {
  if (typeof requestDigest !== 'string' || !digestPattern.test(requestDigest)) {
    throw new TypeError('native custody marker scope is invalid')
  }
  return requestDigest
}

export async function nativeSessionMarkerPath(requestDigest: string): Promise<string> {
  return `/workspace/private/native-session-custody-${await nativeSessionMarkerId(requestDigest)}.json`
}

export function parseNativeSessionMarker(value: unknown, markerId: string): NativeSessionMarkerObservation {
  if (typeof markerId !== 'string' || !digestPattern.test(markerId)) throw new TypeError('native custody marker scope is invalid')
  const invalid = () => new PermanentRunFailure('native custody marker observation integrity failed', 'integrity-failed')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const r = value as Record<string, unknown>
  if (r.status === 'unavailable' && Object.keys(r).length === 2 && typeof r.reason === 'string'
    && ['missing', 'invalid', 'unbounded'].includes(r.reason)) return r as NativeSessionMarkerObservation
  if (r.status !== 'available' || Object.keys(r).length !== 4 || r.markerId !== markerId
    || !Number.isSafeInteger(r.bytes) || Number(r.bytes) < 1 || Number(r.bytes) > nativeSessionMarkerMaxBytes
    || typeof r.digest !== 'string' || !digestPattern.test(r.digest)) throw invalid()
  return r as NativeSessionMarkerObservation
}

// Deliberately no path argument, mkdir, write, environment discovery or workspace
// recreation. The saved archive supplies the expected digest; a sample does not
// prove an outstanding writer exited or discharge a pending mutation.
export const nativeSessionMarkerInspectionScript = String.raw`import sys,os,stat,json,re,hashlib,errno
marker=sys.argv[1]
if not re.fullmatch(r'[a-f0-9]{64}',marker): raise ValueError('invalid fixed marker scope')
limit=16*1024
class Unavailable(Exception): pass
try:
 try:
  directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
  try:
   for segment in ('workspace','private'):
    child=os.open(segment,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
    os.close(directory);directory=child
   fd=os.open('native-session-custody-'+marker+'.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
   try:
    before=os.fstat(fd)
    if not stat.S_ISREG(before.st_mode): raise Unavailable('invalid')
    if before.st_size>limit: raise Unavailable('unbounded')
    with os.fdopen(fd,'rb',closefd=False) as file: raw=file.read(limit+1)
    after=os.fstat(fd)
    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns) or len(raw)!=before.st_size: raise RuntimeError('native custody marker changed during observation')
    if not raw: raise Unavailable('invalid')
   finally: os.close(fd)
  finally: os.close(directory)
 except FileNotFoundError: raise Unavailable('missing')
 except OSError as error:
  if error.errno not in (errno.ELOOP,errno.ENOTDIR): raise
  raise Unavailable('invalid')
 print(json.dumps({'status':'available','markerId':marker,'bytes':len(raw),'digest':hashlib.sha256(raw).hexdigest()}))
except Unavailable as error:
 print(json.dumps({'status':'unavailable','reason':str(error)}))
`
