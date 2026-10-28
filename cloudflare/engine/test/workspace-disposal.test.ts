import { describe, expect, it, vi } from 'vitest'
import { boundedWorkspaceDisposal } from '../src/workspace-disposal.js'

describe('bounded workspace disposal', () => {
  it('records completed destruction', async () => {
    await expect(boundedWorkspaceDisposal(async () => {}, 25)).resolves.toEqual({
      status: 'destroyed',
      timeoutMs: 25,
    })
  })

  it('defers a hung control-plane teardown without holding the wave barrier', async () => {
    vi.useFakeTimers()
    try {
      const disposal = boundedWorkspaceDisposal(() => new Promise(() => {}), 5_000)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(disposal).resolves.toEqual({ status: 'deferred', timeoutMs: 5_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})
