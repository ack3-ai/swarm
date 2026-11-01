import { expect, it } from 'vitest'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { audit0Definition } from './support/audit0-config.js'
import { subscriptionWaits, validSubscriptionWaits } from '../container/subscription-limits.mjs'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { providerIdentity } from '../src/provider-identity.js'

const start = Date.parse('2026-01-01T00:00:00Z')
const time = (minutes: number) => new Date(start + minutes * 60_000).toISOString()
const wait = (from: number, to: number) => ({ provider: 'claude' as const, sessionId: 'native-session',
  startedAt: time(from), resumedAt: time(to), resetsAt: time(to) })
const record = (from: number, to: number, stageId = 'discovery'): any => ({ stageId,
  usage: { subscriptionWaits: [wait(from, to)] } })

it('keeps old clocks unchanged and unions parallel, duplicated and rejected native waits', () => {
  const state = { modelStartedAt: time(0), rootCreatedAt: time(-10), artifacts: [], rejectedAttempts: [] }
  const original = discoveryDeadline(audit0Definition, state)
  expect(original).toBe(start + audit0Definition.limits.phaseMinutes.discovery * 60_000)
  const current = { ...state, artifacts: [record(10, 40), record(20, 50), record(10, 40), record(0, 1000, 'report')],
    rejectedAttempts: [record(60, 70)] }
  expect(discoveryDeadline(audit0Definition, current)).toBe(original + 50 * 60_000)
  expect(discoveryDeadline(audit0Definition, JSON.parse(JSON.stringify(current)))).toBe(original + 50 * 60_000)
})

it('rejects malformed or prematurely resumed wait evidence', () => {
  expect(validSubscriptionWaits(undefined)).toBe(true)
  expect(validSubscriptionWaits([wait(0, 10)])).toBe(true)
  for (const patch of [{ resumedAt: time(-1) }, { resetsAt: time(20) }, { sessionId: '' },
    { provider: 'codex' }, { startedAt: 'invalid' }]) {
    expect(validSubscriptionWaits([{ ...wait(0, 10), ...patch }])).toBe(false)
  }
})

it('counts an evidenced provider usage-window wait without accepting invented wait providers', () => {
  const evidence = { ...wait(10, 70), provider: 'dsh' }
  expect(subscriptionWaits(JSON.stringify({ type: 'subscription_wait', wait: evidence }))).toEqual([evidence])
  expect(discoveryDeadline(audit0Definition, {
    modelStartedAt: time(0), rootCreatedAt: time(0), artifacts: [{ stageId: 'discovery',
      usage: { subscriptionWaits: [evidence] } } as any],
    rejectedAttempts: [],
  })).toBe(start + audit0Definition.limits.phaseMinutes.discovery * 60_000 + 60 * 60_000)
  expect(validSubscriptionWaits([{ ...evidence, provider: 'other' }])).toBe(false)
})

it('accepts DSH window-wait evidence only from a connection that opts in', async () => {
  const task = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves
    .flatMap(wave => wave.tasks).find(candidate => candidate.backend === 'dsh-chat-completions')!
  const result: any = { status: 'accepted', actorId: 'native-session', model: task.model,
    provider: providerIdentity(task), files: {}, assertions: [], inputTokens: 0, outputTokens: 0, costUsd: 0,
    subscriptionWaits: [{ ...wait(10, 70), provider: 'dsh' }] }
  const integrity = async (connection: any) =>
    (await validateAgentResultDetailed({ ...task, connection }, result, [])).integrity
  const invalid = 'provider subscription wait evidence is invalid'
  expect(await integrity({ ...task.connection, usageWindowWait: true })).not.toContain(invalid)
  expect(await integrity(task.connection)).toContain(invalid)
  expect(await integrity({ ...task.connection, usageWindowWait: false })).toContain(invalid)
})

