import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertDshSessionScope, nativeSessionInspectionScript, nativeSessionMaxBytes,
  parseDshSessionObservation, nativeSessionMarkerInspectionScript, nativeSessionMarkerMaxBytes, nativeSessionMarkerId, parseNativeSessionMarker } from '../src/native-session-observation.js'

const sessionId = 'session-11111111-1111-4111-8111-111111111111'
const cwd = '/workspace/source'
const header = { type: 'session', id: sessionId, cwd }
const start = { type: 'turn/start', seq: 1, data: { turn: 1 } }, end = { type: 'turn/end', seq: 3, data: { turn: 1 } }

function fixture(run: (f: { dir: string, root: string, path: string, save: (rows: unknown[]) => string,
  read: (prefix?: string, script?: string) => ReturnType<typeof spawnSync> }) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-session-observation-')))
  const root = join(dir, '--workspace-source--', sessionId), path = join(root, 'session.jsonl')
  mkdirSync(root, { recursive: true })
  // Relocate only the fixture root and installed decoder path for macOS. All
  // traversal, descriptor validation, decoding and ownership checks are real.
  const zstd = execFileSync('which', ['zstd'], { encoding: 'utf8' }).trim()
  const read = (prefix = '', script = nativeSessionInspectionScript) => spawnSync('python3', ['-I', '-c',
    prefix + script.replace("root='/opt/dsh-home/sessions/'+project+'/'+session", `root=${JSON.stringify(dir)}+'/'+project+'/'+session`)
      .replace("'/usr/bin/zstd'", JSON.stringify(zstd)), sessionId, cwd],
  { encoding: 'utf8', timeout: 5_000, maxBuffer: 24 * 1024 * 1024 })
  const save = (rows: unknown[]) => {
    const text = rows.map(r => JSON.stringify(r)).join('\n') + '\n'
    writeFileSync(path, text); return text
  }
  try { run({ dir, root, path, save, read }) } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('native session observation against real files', () => {
  it('returns the exact plain or compressed bytes whose ownership and work state were inspected', () => fixture(({ root, path, save, read }) => {
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'missing' })
    save([header, start]); expect(JSON.parse(String(read().stdout)).workState).toBe('unknown')
    save([header, start, end]); expect(JSON.parse(String(read().stdout)).workState).toBe('none')
    const text = save([header, start, { type: 'tool/result', data: { result: 'synthetic retained proof' } }, end])
    const plain = JSON.parse(String(read().stdout))
    expect(plain).toMatchObject({ status: 'available', sessionId, workingDirectory: cwd, closed: true, workState: 'present' })
    expect(Buffer.from(plain.contentBase64, 'base64').toString()).toBe(text)
    expect(plain.journalDigest).toBe(createHash('sha256').update(text).digest('hex'))
    const raw = execFileSync('zstd', ['-q', '--stdout', path])
    writeFileSync(join(root, 'session.v3.jsonl.zstd'), raw)
    const compressed = JSON.parse(String(read().stdout))
    expect(compressed).toMatchObject({ status: 'available', workState: 'present', fileName: 'session.v3.jsonl.zstd' })
    expect(Buffer.from(compressed.contentBase64, 'base64')).toEqual(raw)
    expect(compressed.journalDigest).toBe(createHash('sha256').update(raw).digest('hex'))
  }))

  it('does not silently fall back to an older valid journal when the newest entry is invalid', () => fixture(({ root, path, save, read }) => {
    save([header, start, end])
    symlinkSync(path, join(root, 'session.v3.jsonl'))
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'invalid' })
  }))

  it('rejects wrong ownership and oversize evidence without exporting their bytes', () => fixture(({ path, save, read }) => {
    for (const wrong of [{ ...header, id: 'wrong-session' }, { ...header, cwd: '/workspace/results' }]) {
      save([wrong, start, end])
      expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'invalid' })
    }
    truncateSync(path, nativeSessionMaxBytes + 1)
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'unbounded' })
  }))

  it.each(['file', 'ancestor', 'fifo', 'directory'])('rejects %s substitution without reading or blocking', kind => fixture(({ dir, root, path, save, read }) => {
    save([header, start, end])
    if (kind === 'ancestor') {
      const other = join(dir, 'other'); mkdirSync(other)
      rmSync(root, { recursive: true }); symlinkSync(other, root)
    } else {
      rmSync(path)
      if (kind === 'file') {
        const other = join(dir, 'synthetic-private'); writeFileSync(other, 'must-not-export'); symlinkSync(other, path)
      } else if (kind === 'fifo') expect(spawnSync('mkfifo', [path]).status).toBe(0)
      else mkdirSync(path)
    }
    const result = read()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(String(result.stdout))).toEqual({ status: 'unavailable', reason: 'invalid' })
  }))

  it('does not convert system I/O failures into an unavailable archive', () => fixture(({ save, read }) => {
    save([header, start, end])
    const result = read(`import os
original_open=os.open
def faulty_open(path,*args,**kwargs):
 if path=='session.jsonl': raise OSError(5,'synthetic I/O failure')
 return original_open(path,*args,**kwargs)
os.open=faulty_open
`)
    expect(result.status).not.toBe(0)
    expect(String(result.stdout)).toBe('')
  }))

  it('keeps disappearance of an enumerated journal retryable', () => fixture(({ save, read }) => {
    save([header, start, end])
    const result = read(`import os
original_open=os.open
def rotating_open(path,*args,**kwargs):
 if path=='session.jsonl': os.unlink(path,dir_fd=kwargs['dir_fd'])
 return original_open(path,*args,**kwargs)
os.open=rotating_open
`)
    expect(result.status).not.toBe(0)
    expect(String(result.stdout)).toBe('')
    expect(String(result.stderr)).toContain('selected native journal disappeared during observation')
  }))

  it('keeps a changing journal retryable instead of sealing mismatched bytes', () => fixture(({ save, read }) => {
    save([header, start, end])
    const result = read(`import os,types
original_fstat=os.fstat
count=0
def changing_fstat(fd):
 global count
 value=original_fstat(fd);count+=1
 return types.SimpleNamespace(st_mode=value.st_mode,st_size=value.st_size,st_mtime_ns=value.st_mtime_ns+count,st_ctime_ns=value.st_ctime_ns)
os.fstat=changing_fstat
`)
    expect(result.status).not.toBe(0)
    expect(String(result.stdout)).toBe('')
  }))

  it('does not classify a decoder failure as missing native evidence', () => fixture(({ root, save, read }) => {
    save([header, start, end])
    writeFileSync(join(root, 'session.v3.jsonl.zstd'), 'invalid compressed stream')
    for (const script of [nativeSessionInspectionScript, nativeSessionInspectionScript.replace("'/usr/bin/zstd'", "'/missing-synthetic-decoder'")]) {
      const result = read('', script)
      expect(result.status).not.toBe(0)
      expect(String(result.stdout)).toBe('')
    }
  }))
})

it('validates session selectors before native work', () => {
  expect(() => assertDshSessionScope(sessionId, cwd)).not.toThrow()
  for (const [id, dir] of [['../../auth.json', cwd], [sessionId, '/opt/dsh-home'], [sessionId, '/workspace/source/..']]) {
    expect(() => assertDshSessionScope(id!, dir!)).toThrow()
  }
})

it('checks exact same-read bytes, ownership and digest before returning evidence', async () => {
  const raw = new TextEncoder().encode(JSON.stringify(header) + '\n')
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', raw)).toString('hex')
  const value = { status: 'available', sessionId, workingDirectory: cwd, fileName: 'session.jsonl',
    bytes: raw.length, journalDigest: digest, contentBase64: Buffer.from(raw).toString('base64'), closed: false, workState: 'unknown' }
  await expect(parseDshSessionObservation(value, sessionId, cwd)).resolves.toEqual(value)
  for (const wrong of [null, [], { ...value, sessionId: 'wrong' }, { ...value, workingDirectory: '/workspace/results' },
    { ...value, bytes: raw.length - 1 }, { ...value, journalDigest: '0'.repeat(64) }, { ...value, fileName: '../auth.json' },
    { ...value, contentBase64: '!'.repeat(value.contentBase64.length) }, { ...value, workState: 'none' },
    { ...value, extra: true }, { status: 'unavailable', reason: 'transport' }]) {
    await expect(parseDshSessionObservation(wrong, sessionId, cwd)).rejects.toMatchObject({ category: 'integrity-failed' })
  }
})

describe('fixed custody marker observation', () => {
  const markerId = 'a'.repeat(64)
  function markerFixture(run: (f: { path: string; directory: string; read: (prefix?: string) => ReturnType<typeof spawnSync> }) => void) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-custody-marker-')))
    const path = join(directory, `native-session-custody-${markerId}.json`)
    // Relocate only the fixed parent directory; preserve descriptor traversal.
    const script = nativeSessionMarkerInspectionScript.replace("('workspace','private')", JSON.stringify(directory.split('/').filter(Boolean)))
    const read = (prefix = '') => spawnSync('python3', ['-I', '-c', prefix + script, markerId],
      { encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024 })
    try { run({ path, directory, read }) } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  it('returns only the exact bounded marker digest and never creates missing evidence', () => markerFixture(({ path, read }) => {
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'missing' })
    const text = '{"synthetic":"custody proof"}'
    writeFileSync(path, text)
    const value = JSON.parse(String(read().stdout))
    expect(parseNativeSessionMarker(value, markerId)).toEqual({ status: 'available', markerId,
      bytes: Buffer.byteLength(text), digest: createHash('sha256').update(text).digest('hex') })
    expect(JSON.stringify(value)).not.toContain('custody proof')
    truncateSync(path, nativeSessionMarkerMaxBytes + 1)
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'unbounded' })
  }))
  it.each(['file', 'ancestor', 'fifo', 'directory', 'empty'])('rejects %s without exporting content or blocking', kind => markerFixture(({ path, directory, read }) => {
    if (kind === 'file') {
      const other = join(directory, 'private'); writeFileSync(other, 'do-not-export'); symlinkSync(other, path)
    } else if (kind === 'ancestor') {
      const other = realpathSync(mkdtempSync(join(tmpdir(), 'native-custody-other-')))
      try {
        rmSync(directory, { recursive: true }); symlinkSync(other, directory)
        expect(JSON.parse(String(read().stdout))).toEqual({ status: 'unavailable', reason: 'invalid' })
      } finally { rmSync(other, { recursive: true, force: true }) }
      return
    } else if (kind === 'fifo') expect(spawnSync('mkfifo', [path]).status).toBe(0)
    else if (kind === 'directory') mkdirSync(path)
    else writeFileSync(path, '')
    const result = read()
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(JSON.parse(String(result.stdout))).toEqual({ status: 'unavailable', reason: 'invalid' })
  }))
  it('does not cache concurrent writes or system I/O failures as missing markers', () => markerFixture(({ path, read }) => {
    writeFileSync(path, 'original')
    const changed = read(`import os
original_fstat=os.fstat
calls=0
def changing_fstat(fd):
 global calls
 calls+=1
 if calls==2:
  with open(${JSON.stringify(path)},'ab') as f: f.write(b'changed')
 return original_fstat(fd)
os.fstat=changing_fstat
`)
    expect(changed.status).not.toBe(0)
    expect(String(changed.stderr)).toContain('changed during observation')
    const unavailable = read(`import os
original_open=os.open
def faulty_open(path,*args,**kwargs):
 if str(path).endswith('.json'): raise OSError(5,'synthetic I/O failure')
 return original_open(path,*args,**kwargs)
os.open=faulty_open
`)
    expect(unavailable.status).not.toBe(0)
    expect(String(unavailable.stdout)).not.toContain('unavailable')
  }))
  it('binds the digest-only response to the selected marker and validates bounds', async () => {
    const id = await nativeSessionMarkerId(markerId)
    expect(id).toBe(markerId)
    const value = { status: 'available', markerId: id, bytes: 15, digest: 'c'.repeat(64) }
    expect(() => parseNativeSessionMarker(value, 'b'.repeat(64))).toThrow('integrity')
    for (const changed of [{ ...value, bytes: 0 }, { ...value, bytes: nativeSessionMarkerMaxBytes + 1 },
      { ...value, digest: 'wrong' }, { ...value, content: 'must-not-return' }]) {
      expect(() => parseNativeSessionMarker(changed, id)).toThrow('integrity')
    }
    await expect(nativeSessionMarkerId('../secret')).rejects.toThrow('scope')
    await expect(nativeSessionMarkerId([id] as any)).rejects.toThrow('scope')
  })
})
