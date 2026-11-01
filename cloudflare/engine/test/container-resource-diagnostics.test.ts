import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import {
  assessObservationResourceLoss,
  lookupObservationResourceLoss,
  nativeResourceLookupMs,
  captureContainerResourceSnapshot,
  classifyContainerResourceFailure,
  containerCapacity,
  parseDiskUsage,
  parseMemoryEvents,
} from '../src/container-resource-diagnostics.js'

const emptySnapshot = {
  memoryCurrentBytes: null,
  memoryMaxBytes: null,
  memoryEvents: {},
  diskTotalKB: null,
  diskUsedKB: null,
  diskAvailableKB: null,
  diskUsePercent: null,
}

describe('container resource diagnostics', () => {
  it('starts agent containers with the measured headroom profile', async () => {
    expect(containerCapacity).toEqual({
      instanceType: 'custom', vcpu: 1, memoryMiB: 8_192, diskMB: 6_000,
    })
    // Under the durable_object policy the size is chosen at start(), not in Wrangler.
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    expect(JSON.parse(wrangler).containers[0].instance_type).toBeUndefined()
    const sandbox = await readFile(new URL('../src/agent-sandbox.ts', import.meta.url), 'utf8')
    expect(sandbox).toContain(
      'instance: { vcpu: containerCapacity.vcpu, memoryMib: containerCapacity.memoryMiB, diskMb: containerCapacity.diskMB }')
  })

  it('parses cgroup and disk snapshots', async () => {
    const outputs = new Map([
      ['cat /sys/fs/cgroup/memory.events', 'low 0\nhigh 0\noom 2\noom_kill 1\n'],
      ['cat /sys/fs/cgroup/memory.current', '734003200\n'],
      ['cat /sys/fs/cgroup/memory.max', '4294967296\n'],
      ['df -Pk /workspace', 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 7812500 3500000 4312500 45% /workspace\n'],
    ])
    const sandbox = { exec: async (command: string) => ({ success: true, stdout: outputs.get(command) ?? '' }) }

    await expect(captureContainerResourceSnapshot(sandbox)).resolves.toEqual({
      memoryCurrentBytes: 734003200,
      memoryMaxBytes: 4294967296,
      memoryEvents: { low: 0, high: 0, oom: 2, oom_kill: 1 },
      diskTotalKB: 7812500,
      diskUsedKB: 3500000,
      diskAvailableKB: 4312500,
      diskUsePercent: 45,
    })
    expect(parseMemoryEvents('oom_kill 3\nmalformed')).toEqual({ oom_kill: 3 })
    expect(parseDiskUsage('unavailable')).toEqual({
      diskTotalKB: null, diskUsedKB: null, diskAvailableKB: null, diskUsePercent: null,
    })
  })

  it('bounds diagnostic RPC startup and keeps measurements that arrived before the deadline', async () => {
    vi.useFakeTimers()
    try {
      let release!: () => void
      const stalled = new Promise<void>(resolve => { release = resolve })
      const commands: Array<{ command: string, timeout: number }> = []
      const sandbox = { exec: async (command: string, options: { timeout: number }) => {
        commands.push({ command, timeout: options.timeout })
        if (command === 'cat /sys/fs/cgroup/memory.events') {
          return { success: true, stdout: 'oom 0\noom_kill 0\n' }
        }
        await stalled
        return { success: true, stdout: 'late result' }
      } }
      const snapshot = captureContainerResourceSnapshot(sandbox)
      await vi.advanceTimersByTimeAsync(6_000)
      expect(await snapshot).toEqual({
        memoryCurrentBytes: null,
        memoryMaxBytes: null,
        memoryEvents: { oom: 0, oom_kill: 0 },
        diskTotalKB: null,
        diskUsedKB: null,
        diskAvailableKB: null,
        diskUsePercent: null,
      })
      expect(commands).toHaveLength(4)
      expect(commands.every(value => value.timeout === 5_000)).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
      release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('classifies memory, disk, and account capacity failures without guessing generic failures', () => {
    expect(classifyContainerResourceFailure(new Error('sandbox agent failed (137)'), emptySnapshot)).toBeNull()
    expect(classifyContainerResourceFailure(new Error('write failed: ENOSPC'), emptySnapshot)).toBe('disk')
    expect(classifyContainerResourceFailure(new Error('maximum container instances reached'), emptySnapshot))
      .toBe('instance-capacity')
    expect(classifyContainerResourceFailure(new Error('provider returned malformed output'), emptySnapshot)).toBeNull()
  })
})

const actorId = 'a'.repeat(64)
const firstFailedAt = '2030-01-01T12:05:00Z'
const metric = { dimensions: { applicationId: 'application-a', instanceId: actorId, placementId: 'placement-a', datetimeMinute: '2030-01-01T12:03:00Z' },
  max: { memory: 6_000 * 1024 * 1024, cpuUtilization: 0.99, diskUsagePercentage: 0.6 } }

describe('native observation-loss diagnostics', () => {
  it('correlates pre-loss pressure with the original runtime capacity, never a confirmed OOM', () => {
    const result = assessObservationResourceLoss({ actorId, firstFailedAt, memoryLimitMiB: 6_144, rows: [metric] })
    expect(result).toMatchObject({ status: 'suspected-memory-exhaustion', sampleCount: 1,
      peakMemoryFraction: 6_000 / 6_144, peakCpuUtilization: 0.99, oomKill: 'not-established', applicationId: 'application-a' })
    expect(assessObservationResourceLoss({ actorId, firstFailedAt, memoryLimitMiB: 8_192, rows: [metric] }).status).toBe('unknown')
    for (const rows of [[], [{ ...metric, dimensions: { ...metric.dimensions, instanceId: 'b'.repeat(64) } }],
      [{ ...metric, dimensions: { ...metric.dimensions, datetimeMinute: '2030-01-01T11:00:00Z' } }],
      [metric, { ...metric, dimensions: { ...metric.dimensions, applicationId: 'other-application' } }]]) {
      expect(assessObservationResourceLoss({ actorId, firstFailedAt, memoryLimitMiB: 6_144, rows }).status).toBe('unknown')
    }
    expect(classifyContainerResourceFailure(new Error('sandbox agent failed (137)'), emptySnapshot)).toBeNull()
    expect(classifyContainerResourceFailure(new Error('sandbox process failed'), {
      ...emptySnapshot, memoryEvents: { oom_kill: 1 },
    })).toBe('memory')
  })

  it('uses the DO actor and first failure timestamp in one bounded native query', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: [metric] }] } } }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const result = await lookupObservationResourceLoss({ actorId, firstFailedAt, memoryLimitMiB: 6_144,
        env: { ACK3_CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32), CLOUDFLARE_OBSERVABILITY_TOKEN: { get: async () => 'private-monitor-token' } } })
      expect(result.status).toBe('suspected-memory-exhaustion')
      expect(fetcher).toHaveBeenCalledTimes(1)
      const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('https://api.cloudflare.com/client/v4/graphql')
      const body = JSON.parse(init.body as string)
      expect(body.variables).toMatchObject({ actor: actorId, start: '2030-01-01T12:00:00.000Z', end: '2030-01-01T12:06:00.000Z' })
      expect(body.query).toContain('instanceId:$actor')
      expect(JSON.stringify(result)).not.toContain('private-monitor-token')
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps absent, denied or delayed native telemetry unknown without exposing token/error text', async () => {
    const input = { actorId, firstFailedAt, memoryLimitMiB: 6_144,
      env: { ACK3_CLOUDFLARE_ACCOUNT_ID: 'c'.repeat(32), CLOUDFLARE_OBSERVABILITY_TOKEN: 'private-monitor-token' } }
    for (const operation of [async () => { throw new Error('private-monitor-token') },
      async () => Response.json({ errors: [{ message: 'private-monitor-token' }] }),
      async () => Response.json({ data: { viewer: { accounts: [{ containersMetricsAdaptiveGroups: [] }] } } })]) {
      vi.stubGlobal('fetch', operation)
      try {
        const result = await lookupObservationResourceLoss(input)
        expect(result.status).toBe('unknown')
        expect(result.oomKill).toBe('not-established')
        expect(JSON.stringify(result)).not.toContain('private-monitor-token')
      } finally { vi.unstubAllGlobals() }
    }
    vi.useFakeTimers()
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    try {
      let resolve!: (value: string) => void
      const get = () => new Promise<string>(done => { resolve = done })
      const pending = lookupObservationResourceLoss({ ...input, env: { ...input.env, CLOUDFLARE_OBSERVABILITY_TOKEN: { get } } })
      await vi.advanceTimersByTimeAsync(nativeResourceLookupMs)
      expect(await pending).toMatchObject({ status: 'unknown', lookup: 'unavailable' })
      resolve('private-monitor-token')
      await Promise.resolve()
      await Promise.resolve()
      expect(fetcher).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
})
