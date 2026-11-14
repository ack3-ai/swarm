import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentLogObservationScript, assertLogObservationInput, parseLogObservation,
  sandboxLogReadMaxBytes } from '../src/sandbox-log-observation.js'

const digest = 'a'.repeat(64)
const available = (data: string, offset = 0, size = Buffer.byteLength(data)) => ({
  status: 'available', offset, size, bytes: Buffer.byteLength(data), data: Buffer.from(data).toString('base64'),
})

describe('fixed native log observation', () => {
  function fixture(run: (root: string, read: (offset?: number, maxBytes?: number, id?: string) => ReturnType<typeof spawnSync>) => void) {
    const root = mkdtempSync(join(tmpdir(), 'sandbox-log-'))
    mkdirSync(join(root, 'workspace/private'), { recursive: true })
    // Only relocate the root descriptor. The production path traversal and
    // byte reader run unchanged against synthetic files, without a container.
    const script = agentLogObservationScript.replace("os.open('/',", `os.open(${JSON.stringify(root)},`)
    try {
      run(root, (offset = 0, maxBytes = 4, id = digest) => spawnSync('python3',
        ['-I', '-c', script, id, String(offset), String(maxBytes)], { encoding: 'utf8', timeout: 2_000 }))
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  it('reads bounded bytes from the requested offset and distinguishes EOF from missing', () => fixture((root, read) => {
    expect(JSON.parse(String(read().stdout))).toEqual({ status: 'missing' })
    writeFileSync(join(root, `workspace/private/agent-log-${digest}.jsonl`), 'abcdefghij')
    const slice = read(3)
    expect(slice.status).toBe(0)
    expect(JSON.parse(String(slice.stdout))).toEqual(available('defg', 3, 10))
    expect(JSON.parse(String(read(8).stdout))).toEqual(available('ij', 8, 10))
    expect(JSON.parse(String(read(10).stdout))).toEqual(available('', 10, 10))
    // Truncation is not an empty successful continuation.
    expect(read(11).status).not.toBe(0)
  }))

  it.each(['file', 'ancestor', 'dangling'])('rejects a %s symlink instead of exporting its target', kind => fixture((root, read) => {
    const file = `agent-log-${digest}.jsonl`
    mkdirSync(join(root, 'other'))
    writeFileSync(join(root, 'other', file), 'must-not-export')
    if (kind === 'ancestor') {
      rmSync(join(root, 'workspace/private'), { recursive: true })
      symlinkSync(join(root, 'other'), join(root, 'workspace/private'))
    } else symlinkSync(join(root, kind === 'dangling' ? 'absent' : `other/${file}`), join(root, 'workspace/private', file))
    const result = read()
    expect(result.status).not.toBe(0)
    expect(String(result.stdout)).toBe('')
  }))

  it('rejects a FIFO without blocking and rejects directories', () => fixture((root, read) => {
    const path = join(root, `workspace/private/agent-log-${digest}.jsonl`)
    expect(spawnSync('mkfifo', [path]).status).toBe(0)
    const fifo = read()
    expect(fifo.error).toBeUndefined()
    expect(fifo.status).not.toBe(0)
    rmSync(path); mkdirSync(path)
    expect(read().status).not.toBe(0)
  }))

  it('validates selectors and bounds inside the interpreter as well as the RPC', () => fixture((_root, read) => {
    for (const [offset, limit, id] of [[-1, 4, digest], [0, 0, digest], [0, sandboxLogReadMaxBytes + 1, digest],
      [0, 4, '../auth.json'], [Number.MAX_SAFE_INTEGER + 1, 4, digest]] as const) {
      expect(read(offset, limit, id).status).not.toBe(0)
    }
  }))
})

it('rejects invalid RPC log selectors before native work', () => {
  for (const [id, offset, maximum] of [[digest, -1, 1], [digest, 0.5, 1], [digest, 0, 0],
    [digest, 0, sandboxLogReadMaxBytes + 1], [digest, NaN, 1], ['../auth.json', 0, 1],
    [digest.toUpperCase(), 0, 1]] as const) expect(() => assertLogObservationInput(id, offset, maximum)).toThrow()
  expect(() => assertLogObservationInput(digest, 0, sandboxLogReadMaxBytes)).not.toThrow()
})

it('validates exact byte ranges and canonical encoding rather than trusting a successful native exit', () => {
  const good = available('abcd', 2, 10)
  expect(parseLogObservation(good, 2, 4)).toEqual(good)
  expect(parseLogObservation({ status: 'missing' }, 2, 4)).toEqual({ status: 'missing' })
  for (const invalid of [null, [], { status: 'missing', data: 'abcd' }, { ...good, offset: 0 },
    { ...good, size: 1 }, { ...good, bytes: 3, data: 'YWJj' }, { ...good, data: '!!!!' },
    { ...good, size: Number.MAX_SAFE_INTEGER + 1 }, { ...good, bytes: 1, size: 3, data: 'YR==' },
    { ...good, bytes: 1, size: 3, data: 'YWJj' }]) {
    expect(() => parseLogObservation(invalid, 2, 4)).toThrow()
  }
})
