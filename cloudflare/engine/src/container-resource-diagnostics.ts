import type { SandboxClient } from './agent-sandbox-client.js'
import type { AgentRequest } from './contracts.js'
import { canonicalJson } from './canonical.js'
import { resolveCredentialBinding } from './release-provider-credentials.js'
import { observedAgentAttemptUsage, PermanentRunFailure } from './run-errors.js'

export const containerCapacity = {
  instanceType: 'custom',
  vcpu: 1,
  memoryMiB: 8_192,
  diskMB: 6_000,
} as const

/** Workspace-note lines about resources and the sealed command time limit. */
export function workspaceLimitNotes(commandTimeoutMinutes: number | undefined): string[] {
  return [
    `Resources: ${containerCapacity.vcpu} CPU and ${containerCapacity.memoryMiB / 1024} GB of memory. Disk: ${containerCapacity.diskMB / 1000} GB in total, including dependencies and build output. Run builds and tests one job at a time (for example \`-j1\`). If memory runs out, your commands are stopped first.`,
    ...(commandTimeoutMinutes === undefined ? [] : [
      `Command time limit: every command you start, background jobs included, is stopped after ${commandTimeoutMinutes} minutes. Split longer work, for example fewer fuzz runs or one test file at a time.`,
    ]),
  ]
}

export type ContainerResourceFailureKind = 'memory' | 'disk' | 'instance-capacity'

export interface ContainerResourceSnapshot {
  memoryCurrentBytes: number | null
  memoryMaxBytes: number | null
  memoryEvents: Readonly<Record<string, number>>
  diskTotalKB: number | null
  diskUsedKB: number | null
  diskAvailableKB: number | null
  diskUsePercent: number | null
  /** memory.events when the agent runner started this attempt, when the runner recorded them. */
  memoryEventsAtLaunch?: Readonly<Record<string, number>>
}

/** Written by the container's agent runner at start, read only on failure. */
export function memoryBaselinePath(requestDigest: string): string {
  return `/workspace/private/memory-events-${requestDigest}`
}

interface CommandResult {
  success: boolean
  stdout: string
}

interface DiagnosticSandbox {
  exec(command: string, options: { timeout: number }): Promise<CommandResult>
}

function integer(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parseMemoryEvents(content: string): Readonly<Record<string, number>> {
  return Object.fromEntries(content.trim().split('\n').flatMap(line => {
    const [key, raw, ...rest] = line.trim().split(/\s+/)
    const value = rest.length === 0 ? integer(raw) : null
    return key === undefined || value === null ? [] : [[key, value]]
  }))
}

export function parseDiskUsage(content: string): Pick<ContainerResourceSnapshot,
  'diskTotalKB' | 'diskUsedKB' | 'diskAvailableKB' | 'diskUsePercent'> {
  const columns = content.trim().split('\n').at(-1)?.trim().split(/\s+/) ?? []
  const usePercent = columns[4]?.match(/^(\d+)%$/)?.[1]
  return {
    diskTotalKB: integer(columns[1]),
    diskUsedKB: integer(columns[2]),
    diskAvailableKB: integer(columns[3]),
    diskUsePercent: integer(usePercent),
  }
}

export function classifyContainerResourceFailure(
  error: unknown,
  snapshot: ContainerResourceSnapshot,
): ContainerResourceFailureKind | null {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const failedProcess = /sandbox|container|process|result (?:read|file)/i.test(message)
  // Agent commands are the kernel's first OOM victims, so an OOM before this attempt
  // (or one that only stopped a command) is no evidence that this failure was memory.
  const before = snapshot.memoryEventsAtLaunch ?? {}
  const newOom = ['oom', 'oom_kill'].some(key => (snapshot.memoryEvents[key] ?? 0) > (before[key] ?? 0))
  // A parsed runner receipt (its usage travels with the error) proves the runner survived:
  // a command killed for memory earlier in the attempt did not cause this failure (E8).
  // The memory label is kept for a lost process or container.
  const receiptBacked = observedAgentAttemptUsage(error) !== null
  if (!receiptBacked && (newOom && failedProcess
    || /\b(?:out of memory|oom[-_ ]?kill|memory limit exceeded)\b/i.test(message))) return 'memory'
  if (/\bENOSPC\b|no space left on device|disk quota exceeded/i.test(message)) return 'disk'
  if (/container (?:instance )?(?:limit|capacity)|maximum (?:container )?instances|too many containers/i.test(message)) {
    return 'instance-capacity'
  }
  return null
}

async function read(sandbox: DiagnosticSandbox, command: string): Promise<string> {
  // Sandbox.exec's timeout starts after a container is available. An
  // unavailable container can leave the RPC waiting for startup indefinitely.
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      sandbox.exec(command, { timeout: 5_000 }),
      new Promise<CommandResult>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('resource diagnostic deadline exceeded')), 6_000)
      }),
    ])
    return result.success ? result.stdout.trim() : ''
  } catch {
    return ''
  } finally {
    if (deadline !== undefined) clearTimeout(deadline)
  }
}

export async function captureContainerResourceSnapshot(
  sandbox: DiagnosticSandbox, baselinePath?: string,
): Promise<ContainerResourceSnapshot> {
  const [events, current, maximum, disk, baseline] = await Promise.all([
    read(sandbox, 'cat /sys/fs/cgroup/memory.events'),
    read(sandbox, 'cat /sys/fs/cgroup/memory.current'),
    read(sandbox, 'cat /sys/fs/cgroup/memory.max'),
    read(sandbox, 'df -Pk /workspace'),
    baselinePath === undefined || !/^\/workspace\/private\/memory-events-[a-f0-9]{64}$/.test(baselinePath)
      ? Promise.resolve('') : read(sandbox, `cat ${baselinePath}`),
  ])
  return {
    memoryCurrentBytes: integer(current),
    memoryMaxBytes: integer(maximum),
    memoryEvents: parseMemoryEvents(events),
    ...parseDiskUsage(disk),
    ...(baseline === '' ? {} : { memoryEventsAtLaunch: parseMemoryEvents(baseline) }),
  }
}

export async function annotateContainerResourceFailure(
  sandbox: SandboxClient,
  request: AgentRequest,
  error: unknown,
  requestDigest?: string,
): Promise<unknown> {
  const snapshot = await captureContainerResourceSnapshot(sandbox,
    requestDigest === undefined ? undefined : memoryBaselinePath(requestDigest))
  const kind = classifyContainerResourceFailure(error, snapshot)
  if (kind === null) return error
  const detail = {
    kind,
    capacity: containerCapacity,
    runId: request.runId,
    stageId: request.stage.id,
    waveId: request.wave.id,
    taskId: request.task.id,
    workspaceKey: request.task.workspaceKey,
    attempt: request.attempt,
    snapshot,
  }
  const original = error instanceof Error ? error.message : String(error)
  return new PermanentRunFailure(
    `container resource exhaustion ${canonicalJson(detail)}: ${original}`,
    'resource-exhausted',
    { cause: error },
  )
}

/** Analytics can show pressure preceding lost observation, but cannot establish an OOM kill. */
export interface NativeObservationResourceAssessment {
  status: 'suspected-memory-exhaustion' | 'unknown'
  source: 'cloudflare-container-metrics'
  lookup: 'available' | 'unavailable' | 'not-configured'
  actorId: string
  firstFailedAt: string
  memoryLimitMiB: number
  applicationId: string | null
  placementIds: readonly string[]
  sampleCount: number
  lastSampleAt: string | null
  peakMemoryBytes: number | null
  peakMemoryFraction: number | null
  peakCpuUtilization: number | null
  peakDiskUsageFraction: number | null
  oomKill: 'not-established'
}

export const nativeResourceLookupMs = 2_000
const resourceCorrelationMs = 5 * 60_000
const resourceBucketSlackMs = 60_000

type NativeMetricRow = {
  dimensions?: { applicationId?: string, instanceId?: string, placementId?: string, datetimeMinute?: string }
  max?: { memory?: number, cpuUtilization?: number, diskUsagePercentage?: number }
}

export function assessObservationResourceLoss(input: {
  actorId: string, firstFailedAt: string, memoryLimitMiB: number, rows: readonly NativeMetricRow[],
}): NativeObservationResourceAssessment {
  const firstFailed = Date.parse(input.firstFailedAt)
  const rows = input.rows.filter(row => row?.dimensions?.instanceId === input.actorId
    && typeof row.dimensions.applicationId === 'string' && row.dimensions.applicationId !== ''
    && typeof row.dimensions.placementId === 'string' && row.dimensions.placementId !== ''
    && Number.isFinite(Date.parse(row.dimensions.datetimeMinute ?? ''))
    && Date.parse(row.dimensions.datetimeMinute!) >= firstFailed - resourceCorrelationMs
    && Date.parse(row.dimensions.datetimeMinute!) <= firstFailed + resourceBucketSlackMs)
  const applications = [...new Set(rows.map(row => row.dimensions!.applicationId!))]
  // A Durable Object identity belongs to one namespace/application. Ambiguous
  // identity, absent measurements and old data never mean the container was healthy.
  const correlated = applications.length === 1 && Number.isFinite(firstFailed)
    && Number.isSafeInteger(input.memoryLimitMiB) && input.memoryLimitMiB > 0 ? rows : []
  const peak = (field: 'memory' | 'cpuUtilization' | 'diskUsagePercentage') => {
    const values = correlated.map(row => row.max?.[field]).filter((value): value is number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return values.length ? Math.max(...values) : null
  }
  const peakMemoryBytes = peak('memory')
  const peakMemoryFraction = peakMemoryBytes === null ? null : peakMemoryBytes / (input.memoryLimitMiB * 1024 * 1024)
  return {
    status: peakMemoryFraction !== null && peakMemoryFraction > 0.9 ? 'suspected-memory-exhaustion' : 'unknown',
    source: 'cloudflare-container-metrics', lookup: 'available', actorId: input.actorId,
    firstFailedAt: input.firstFailedAt, memoryLimitMiB: input.memoryLimitMiB,
    applicationId: correlated.length ? applications[0]! : null,
    placementIds: [...new Set(correlated.map(row => row.dimensions!.placementId!))].toSorted(),
    sampleCount: correlated.length,
    lastSampleAt: correlated.map(row => row.dimensions!.datetimeMinute!).toSorted().at(-1) ?? null,
    peakMemoryBytes, peakMemoryFraction, peakCpuUtilization: peak('cpuUtilization'),
    peakDiskUsageFraction: peak('diskUsagePercentage'), oomKill: 'not-established',
  }
}

/** Read Cloudflare's retained metrics, never call the failed Sandbox or start a process. */
export async function lookupObservationResourceLoss(input: {
  env: Record<string, unknown>, actorId: string, firstFailedAt: string, memoryLimitMiB: number,
}): Promise<NativeObservationResourceAssessment> {
  const empty = assessObservationResourceLoss({ ...input, rows: [] })
  const account = input.env.ACK3_CLOUDFLARE_ACCOUNT_ID
  if (typeof account !== 'string' || !/^[a-f0-9]{32}$/i.test(account)
    || input.env.CLOUDFLARE_OBSERVABILITY_TOKEN === undefined) return { ...empty, lookup: 'not-configured' }
  if (!/^[a-f0-9]{64}$/i.test(input.actorId) || !Number.isFinite(Date.parse(input.firstFailedAt))) {
    return { ...empty, lookup: 'unavailable' }
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const token = await resolveCredentialBinding(input.env, 'CLOUDFLARE_OBSERVABILITY_TOKEN')
        if (token === null || controller.signal.aborted) return { ...empty, lookup: 'unavailable' as const }
        const failedAt = Date.parse(input.firstFailedAt)
        const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          redirect: 'error', signal: controller.signal,
          body: JSON.stringify({
            query: `query($account:String,$start:Time,$end:Time,$actor:String){viewer{accounts(filter:{accountTag:$account}){containersMetricsAdaptiveGroups(limit:120,filter:{datetime_geq:$start,datetime_leq:$end,instanceId:$actor},orderBy:[datetimeMinute_ASC]){dimensions{applicationId datetimeMinute instanceId placementId} max{memory cpuUtilization diskUsagePercentage}}}}}`,
            variables: { account, actor: input.actorId,
              start: new Date(failedAt - resourceCorrelationMs).toISOString(),
              end: new Date(failedAt + resourceBucketSlackMs).toISOString() },
          }),
        })
        if (!response.ok) return { ...empty, lookup: 'unavailable' as const }
        const body = await response.json() as { errors?: unknown[], data?: {
          viewer?: { accounts?: { containersMetricsAdaptiveGroups?: NativeMetricRow[] }[] },
        } }
        const rows = body.data?.viewer?.accounts?.[0]?.containersMetricsAdaptiveGroups
        if (body.errors?.length || !Array.isArray(rows) || rows.length >= 120) return { ...empty, lookup: 'unavailable' as const }
        return assessObservationResourceLoss({ ...input, rows })
      })(),
      new Promise<NativeObservationResourceAssessment>(resolve => {
        timer = setTimeout(() => resolve({ ...empty, lookup: 'unavailable' }), nativeResourceLookupMs)
      }),
    ])
  } catch {
    // Never expose credential/API response text or replace terminal execution custody.
    return { ...empty, lookup: 'unavailable' }
  } finally {
    controller.abort()
    if (timer !== undefined) clearTimeout(timer)
  }
}
