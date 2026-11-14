/** Fixed, read-only access to the native runner's redacted per-request log.
 * This is an observation of bytes, never a receipt of process termination. */
export const sandboxLogReadMaxBytes = 256 * 1024

export type SandboxLogObservation = { status: 'missing' } | {
  status: 'available'
  offset: number
  size: number
  bytes: number
  data: string
}

export function assertLogObservationInput(requestDigest: string, offset: number, maxBytes: number): void {
  if (typeof requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(requestDigest)
    || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > sandboxLogReadMaxBytes) {
    throw new TypeError('agent log observation scope is invalid')
  }
}

export function parseLogObservation(value: unknown, offset: number, maxBytes: number): SandboxLogObservation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('agent log observation is invalid')
  const r = value as Record<string, unknown>
  if (r.status === 'missing' && Object.keys(r).length === 1) return { status: 'missing' }
  if (r.status !== 'available' || Object.keys(r).length !== 5 || r.offset !== offset
    || !Number.isSafeInteger(r.size) || Number(r.size) < offset
    || !Number.isSafeInteger(r.bytes) || r.bytes !== Math.min(maxBytes, Number(r.size) - offset)
    || typeof r.data !== 'string' || r.data.length !== Math.ceil(Number(r.bytes) / 3) * 4
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) throw new Error('agent log observation is invalid')
  const decoded = atob(r.data)
  if (decoded.length !== r.bytes || btoa(decoded) !== r.data) throw new Error('agent log observation encoding is invalid')
  return r as SandboxLogObservation
}

// Passed directly to the fixed interpreter, never installed in the writable
// agent workspace. No caller-provided path, program, environment or shell text.
// O_NONBLOCK prevents a substituted FIFO from hanging before the regular-file
// check; O_NOFOLLOW applies to every component, including the final file.
export const agentLogObservationScript = String.raw`import os,sys,stat,json,re,base64
digest,offset,maximum=sys.argv[1:]
if not re.fullmatch(r'[a-f0-9]{64}',digest): raise ValueError('invalid log scope')
offset,maximum=int(offset),int(maximum)
if not 0<=offset<=9007199254740991 or not 1<=maximum<=262144: raise ValueError('invalid log range')
directory=None
try:
 directory=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 for segment in ('workspace','private'):
  child=os.open(segment,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
  os.close(directory);directory=child
 fd=os.open('agent-log-'+digest+'.jsonl',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
 try:
  info=os.fstat(fd)
  if not stat.S_ISREG(info.st_mode): raise ValueError('log is not a regular file')
  if not offset<=info.st_size<=9007199254740991: raise ValueError('log was truncated or exceeds safe range')
  length=min(maximum,info.st_size-offset)
  data=os.pread(fd,length,offset)
  if len(data)!=length: raise ValueError('log changed during observation')
  print(json.dumps({'status':'available','offset':offset,'size':info.st_size,'bytes':len(data),'data':base64.b64encode(data).decode('ascii')}))
 finally: os.close(fd)
except FileNotFoundError:
 print(json.dumps({'status':'missing'}))
finally:
 if directory is not None: os.close(directory)
`
