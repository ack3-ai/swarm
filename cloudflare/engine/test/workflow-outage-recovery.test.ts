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
  expect(step.sleep).toHaveBeenCalledWith('agent-poll-backoff-0', '30 seconds')
  expect(instance.recordTerminalFailure).not.toHaveBeenCalled()
})

it('continues the same admitted run after a Cloudflare sleep-boundary failure', async () => {
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
  const instance = new Workflow()
  instance.recordTerminalFailure = vi.fn(async () => {})
  instance.workflowStepError = (error: unknown) => error
  const step = {
    do: vi.fn(async (name: string) => {
      if (name === 'initialize-index') return { ready: true }
      if (name === 'bootstrap-run') return running
      if (name === 'advance-or-poll-0') return running
      if (name === 'advance-or-poll-1') return completed
      if (name === 'dispose-completed-workspaces') return { ready: true }
      throw new Error(`unexpected step ${name}`)
    }),
    sleep: vi.fn(async (name: string) => {
      if (name === 'agent-poll-backoff-0') throw platformFailure
    }),
  }

  await expect(instance.run({ payload: { runId: 'platform-outage' } }, step))
    .resolves.toEqual(completed)
  expect(step.sleep).toHaveBeenCalledTimes(1)
  expect(instance.recordTerminalFailure).not.toHaveBeenCalled()
})
