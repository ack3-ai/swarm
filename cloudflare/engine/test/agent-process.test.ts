import { describe, expect, it, vi } from 'vitest'
import { agentProcessId, waitForAgentProcess } from '../src/agent-process.js'

describe('idempotent sandbox agent process', () => {
  it('binds one stable process identity to the exact request digest', () => {
    const digest = 'a'.repeat(64)
    expect(agentProcessId(digest)).toBe(`agent-${'a'.repeat(40)}`)
    expect(() => agentProcessId('not-a-digest')).toThrow('agent request digest is invalid')
  })

  it('polls the stable process identity without holding an RPC stream open', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn()
        .mockResolvedValueOnce('starting')
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('completed')
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 10)
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toBe(0)
      expect(getStatus).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs passive observers during a long polling slice', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn()
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('completed')
      const observe = vi.fn(async () => {})
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 10, { intervalMs: 10, observe })
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toBe(0)
      expect(observe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the polling slice when a status RPC never settles', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn(async () => await new Promise<never>(() => {}))
      const onStatusProbe = vi.fn()
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 10, 1,
        { intervalMs: 10, observe: async () => {}, onStatusProbe })
      await vi.advanceTimersByTimeAsync(5_011)
      await expect(result).resolves.toBe('unavailable')
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(onStatusProbe).toHaveBeenCalledExactlyOnceWith('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends the polling slice when a passive observer never settles', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn(async () => 'running' as const)
      const observe = vi.fn(async () => await new Promise<never>(() => {}))
      const result = waitForAgentProcess(
        { id: 'agent-a', getStatus },
        10,
        1,
        { intervalMs: 1, immediate: true, observe },
      )
      await vi.advanceTimersByTimeAsync(5_011)
      await expect(result).resolves.toBe('running')
      expect(getStatus).toHaveBeenCalledTimes(1)
      expect(observe).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a disposed RPC status probe against the same process', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn()
        .mockRejectedValueOnce(new Error('WritableStream RPC stub was disposed without calling close()'))
        .mockResolvedValueOnce('completed')
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 10)
      await vi.advanceTimersByTimeAsync(10)
      await expect(result).resolves.toBe(0)
      expect(getStatus).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries Cloudflare process registration lag against the same process', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn()
        .mockRejectedValueOnce(new Error('Process agent-a not found'))
        .mockResolvedValueOnce('running')
        .mockResolvedValueOnce('completed')
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 10)
      await vi.advanceTimersByTimeAsync(20)
      await expect(result).resolves.toBe(0)
      expect(getStatus).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a terminal process failure to a non-zero result', async () => {
    const getStatus = vi.fn(async () => 'failed' as const)
    await expect(waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000)).resolves.toBe(1)
  })

  it('ends a bounded polling slice while leaving a running process reattachable', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn(async () => 'running' as const)
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 100)
      await vi.advanceTimersByTimeAsync(6_001)
      await expect(result).resolves.toBe('running')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports unavailable when no status probe confirms the process state', async () => {
    vi.useFakeTimers()
    try {
      const getStatus = vi.fn(async () => { throw new Error('Process agent-a not found') })
      const result = waitForAgentProcess({ id: 'agent-a', getStatus }, 1_000, 100)
      await vi.advanceTimersByTimeAsync(6_001)
      await expect(result).resolves.toBe('unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
})
