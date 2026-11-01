import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { waveStepConfig, workflowBootstrapProgress } from '../src/workflow-step-config.js'
import { failureForWorkflowProgress, workflowFailureDisposition } from '../src/workflow-outcome.js'

it('keeps an admitted run nonterminal when recovery observation also exhausts retries', async () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(
    source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator'),
  ).replace('export class', 'class'))
  class NonRetryableError extends Error {}
  const sameCursor = (
    left: { stageIndex: number, waveIndex: number },
    right: { stageIndex: number, waveIndex: number },
  ) => left.stageIndex === right.stageIndex && left.waveIndex === right.waveIndex
  const Workflow = new Function(
    'WorkflowEntrypoint',
    'CloudflareRunStore',
    'waveStepConfig',
    'workflowBootstrapProgress',
    'failureForWorkflowProgress',
    'workflowFailureDisposition',
    'NonRetryableError',
    'sameCursor',
    `${code}\nreturn AuditWorkflow;`,
  )(
    class { env = {} },
    class {},
    waveStepConfig,
    workflowBootstrapProgress,
    failureForWorkflowProgress,
    workflowFailureDisposition,
    NonRetryableError,
    sameCursor,
  )
  const running = {
    status: 'running', cursor: { stageIndex: 1, waveIndex: 0 },
    checkpointDigest: null, terminalReason: null,
  }
  const completed = { ...running, status: 'completed', terminalReason: 'completed' }
  const instance = new Workflow()
  instance.recordTerminalFailure = vi.fn(async () => {})
  instance.workflowStepError = (error: unknown) => error
  const observedSteps: Array<{ name: string, limit: number }> = []
  const step = {
    do: async (name: string, config: { retries: { limit: number } }) => {
      if (name === 'initialize-index') return { ready: true }
      if (name === 'bootstrap-run') return running
      observedSteps.push({ name, limit: config.retries.limit })
      if (name === 'advance-or-poll-1') return completed
      if (name === 'dispose-completed-workspaces') return { ready: true }
      throw new Error('temporary storage outage; execution state is unknown')
    },
    sleep: vi.fn(async () => {}),
  }

  await expect(instance.run({ payload: { runId: 'outage-recovery' } }, step))
    .resolves.toEqual(completed)
  expect(observedSteps).toEqual([
    { name: 'advance-or-poll-0', limit: 3 },
    { name: 'recover-wave-state-0', limit: 10 },
    { name: 'advance-or-poll-1', limit: 3 },
    { name: 'dispose-completed-workspaces', limit: 10 },
  ])
  expect(step.sleep).toHaveBeenCalledTimes(1)
  expect(step.sleep).toHaveBeenCalledWith('agent-poll-backoff-0', '30 seconds')
  expect(instance.recordTerminalFailure).not.toHaveBeenCalled()
})

it.each([
  { observationOutage: false, retryFails: false },
  { observationOutage: true, retryFails: false },
  { observationOutage: false, retryFails: true },
  { observationOutage: true, retryFails: true },
])('bounds sleep recovery (observation outage: $observationOutage, retry fails: $retryFails)', async ({ observationOutage, retryFails }) => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(
    source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator'),
  ).replace('export class', 'class'))
  class NonRetryableError extends Error {}
  const sameCursor = (
    left: { stageIndex: number, waveIndex: number },
    right: { stageIndex: number, waveIndex: number },
  ) => left.stageIndex === right.stageIndex && left.waveIndex === right.waveIndex
  const Workflow = new Function(
    'WorkflowEntrypoint',
    'CloudflareRunStore',
    'waveStepConfig',
    'workflowBootstrapProgress',
    'failureForWorkflowProgress',
    'workflowFailureDisposition',
    'NonRetryableError',
    'sameCursor',
    `${code}\nreturn AuditWorkflow;`,
  )(
    class { env = {} },
    class {},
    waveStepConfig,
    workflowBootstrapProgress,
    failureForWorkflowProgress,
    workflowFailureDisposition,
    NonRetryableError,
    sameCursor,
  )
  const running = {
    status: 'running', cursor: { stageIndex: 3, waveIndex: 0 },
    checkpointDigest: 'a'.repeat(64), terminalReason: null,
  }
  const completed = { ...running, status: 'completed', terminalReason: 'completed' }
  const platformFailure = new Error('internal error; reference = fixture-platform-reference')
  const retryFailure = new Error('internal error; reference = fixture-retry-reference')
  const operations: string[] = []
  const instance = new Workflow()
  instance.recordTerminalFailure = vi.fn(async () => {})
  instance.workflowStepError = (error: unknown) => error
  let observationCycles = 0
  const step = {
    do: vi.fn(async (name: string) => {
      operations.push(name)
      if (name === 'initialize-index') return { ready: true }
      if (name === 'bootstrap-run') return running
      if (name.startsWith('advance-or-poll-')) {
        observationCycles += 1
        // Bound the regression if the old catch-and-continue loop returns.
        if (observationCycles > 3) throw new NonRetryableError('fixture detected repeated observation cycles')
        if (observationCycles === 2) return completed
        if (observationOutage) throw platformFailure
        return running
      }
      if (name.startsWith('recover-wave-state-')) throw platformFailure
      if (name === 'dispose-completed-workspaces') return { ready: true }
      throw new Error(`unexpected step ${name}`)
    }),
    sleep: vi.fn(async (name: string) => {
      operations.push(name)
      if (name === 'agent-poll-backoff-0') throw platformFailure
      if (retryFails) throw retryFailure
    }),
  }

  const execution = instance.run({ payload: { runId: 'platform-outage' } }, step)
  if (retryFails) await expect(execution).rejects.toBe(retryFailure)
  else await expect(execution).resolves.toEqual(completed)
  expect(observationCycles).toBe(retryFails ? 1 : 2)
  expect(operations).toEqual([
    'initialize-index', 'bootstrap-run', 'advance-or-poll-0',
    ...(observationOutage ? ['recover-wave-state-0'] : []),
    'agent-poll-backoff-0', 'agent-poll-backoff-retry-0',
    ...(retryFails ? [] : ['advance-or-poll-1', 'dispose-completed-workspaces']),
  ])
  expect(step.sleep.mock.calls).toEqual([
    ['agent-poll-backoff-0', observationOutage ? '30 seconds' : '15 seconds'],
    ['agent-poll-backoff-retry-0', '30 seconds'],
  ])
  expect(instance.recordTerminalFailure).not.toHaveBeenCalled()
  expect(running.status).toBe('running')
})
