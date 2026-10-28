import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const source = readFileSync(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
const expression = source.match(/const guardedLaunch = (`[^\n]+`)/)![1]!

function guardedLaunch(input: {
  launchFencePath: string
  launchReadyPath: string
  wrapperPath: string
  requestPath: string
  resultPath: string
}) {
  return new Function(
    ...Object.keys(input), 'workflowAttemptTimeoutMs', `return ${expression}`,
  )(...Object.values(input), 1_000) as string
}

it('starts the guarded holder on the fresh prepared private parent', () => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-launch-shell-'))
  try {
    mkdirSync(join(root, 'source'))
    mkdirSync(join(root, 'private'))
    const command = guardedLaunch({
      launchFencePath: join(root, 'private/fence'),
      launchReadyPath: join(root, 'private/ready'),
      wrapperPath: join(root, 'private/wrapper.mjs'),
      requestPath: join(root, 'private/request.json'),
      resultPath: join(root, 'private/result.json'),
    })
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: join(root, 'source'), encoding: 'utf8', timeout: 5_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(74)
    expect(readFileSync(join(root, 'private/fence/owner'), 'utf8')).toBe('')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('releases the holder without injecting a broker credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'swarm-launch-ready-'))
  try {
    mkdirSync(join(root, 'source'))
    mkdirSync(join(root, 'private'))
    const readyPath = join(root, 'private/ready')
    const resultPath = join(root, 'private/result.json')
    const wrapperPath = join(root, 'private/wrapper.mjs')
    writeFileSync(readyPath, 'ready')
    writeFileSync(wrapperPath, `import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[3], 'ready')`)
    const command = guardedLaunch({
      launchFencePath: join(root, 'private/fence'),
      launchReadyPath: readyPath,
      wrapperPath,
      requestPath: join(root, 'private/request.json'),
      resultPath,
    })
    const result = spawnSync('/bin/sh', ['-c', command], {
      cwd: join(root, 'source'), encoding: 'utf8', timeout: 5_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(readFileSync(resultPath, 'utf8')).toBe('ready')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
