import { expect, it, vi } from 'vitest'
import { boundedReadOnlyObservation, boundedTerminalLogDrain } from '../src/bounded-observation.js'

it('expires one read-only observation without using its late response', async () => {
  vi.useFakeTimers()
  try {
    let resolveRead!: (value: string) => void
    const read = new Promise<string>(resolve => { resolveRead = resolve })
    const observation = boundedReadOnlyObservation(() => read, Date.now() + 10)
    await vi.advanceTimersByTimeAsync(11)
    await expect(observation).resolves.toEqual({ expired: true })
    resolveRead('late null process')
    await Promise.resolve()
    await expect(observation).resolves.toEqual({ expired: true })
  } finally {
    vi.useRealTimers()
  }
})

it('fences a late optional log read before it can write after terminal drain returns', async () => {
  vi.useFakeTimers()
  try {
    let resolveRead!: () => void
    const read = new Promise<void>(resolve => { resolveRead = resolve })
    const write = vi.fn()
    const drain = boundedTerminalLogDrain(async active => {
      await read
      if (active()) write()
    }, 10)
    await vi.advanceTimersByTimeAsync(11)
    await expect(drain).resolves.toBe(false)
    resolveRead()
    await Promise.resolve()
    await Promise.resolve()
    expect(write).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
