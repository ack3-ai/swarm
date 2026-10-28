import { describe, expect, it, vi } from 'vitest'
import { clearUntrustedTaskOutputs } from '../src/task-output-boundary.js'

function sandbox(existing: readonly string[] = []) {
  const paths = new Set(existing)
  return {
    exists: vi.fn(async (path: string) => ({ success: true, path, exists: paths.has(path), timestamp: 'now' })),
    deleteFile: vi.fn(async (path: string) => {
      paths.delete(path)
      return { success: true, path, timestamp: 'now' }
    }),
  }
}

describe('task output admission boundary', () => {
  it('removes a future-wave file written before its task is admitted', async () => {
    const path = '/workspace/results/waves/wave-3/research-2.md'
    const target = sandbox([path])

    await clearUntrustedTaskOutputs(target, ['waves/wave-3/research-2.md'], {})

    expect(target.deleteFile).toHaveBeenCalledExactlyOnceWith(path)
  })

  it('requires redirected and fresh replacement attempts to write a new result', async () => {
    const path = '/workspace/results/waves/wave-4/research-1.md'
    const target = sandbox([path])

    await clearUntrustedTaskOutputs(target, ['waves/wave-4/research-1.md'], {})

    expect(target.deleteFile).toHaveBeenCalledExactlyOnceWith(path)
  })

  it('clears the reserved structured handoff before a new task attempt', async () => {
    const path = '/workspace/results/.swarm/submission.json'
    const target = sandbox([path])

    await clearUntrustedTaskOutputs(target, ['.swarm/submission.json'], {})

    expect(target.deleteFile).toHaveBeenCalledExactlyOnceWith(path)
  })

  it('preserves only an explicit quarantined repair baseline', async () => {
    const path = '/workspace/results/coverage-challenge.md'
    const target = sandbox([path])

    await clearUntrustedTaskOutputs(target, ['coverage-challenge.md'], { 'coverage-challenge.md': '# rejected baseline\n' })

    expect(target.exists).not.toHaveBeenCalled()
    expect(target.deleteFile).not.toHaveBeenCalled()
  })

  it('rejects unsafe paths even when definition validation was bypassed', async () => {
    await expect(clearUntrustedTaskOutputs(sandbox(), ['../future.md'], {}))
      .rejects.toThrow('unsafe task output path')
  })
})
