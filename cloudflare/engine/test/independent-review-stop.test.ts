import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { waveStepConfig, workflowBootstrapProgress } from '../src/workflow-step-config.js'
import { canStopAtSealedWaveBoundary, failureForWorkflowProgress, workflowFailureDisposition, workflowProgress } from '../src/workflow-outcome.js'
import { isPermanentRunFailure } from '../src/run-errors.js'

it('honors a saved stop after cohorts drain without moving the discovery cursor', async () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const code = stripTypeScriptTypes(source.slice(source.indexOf('export class AuditWorkflow'),
    source.indexOf('async function forwardCoordinator')).replace('export class', 'class'))
  class NonRetryableError extends Error {}
  const sameCursor = (a: any, b: any) => a.stageIndex === b.stageIndex && a.waveIndex === b.waveIndex
  let state: any = { runId: 'review-drained-stop', status: 'running', cursor: { stageIndex: 1, waveIndex: 0 },
    releaseDigest: 'a'.repeat(64), checkpoints: [], waveAdmission: null,
    discoveryScheduler: { stageId: 'discovery', admissions: [] }, inFlightAgentAttempts: [], terminalReason: null }
  const running = workflowProgress(state)
  const definition = { stages: [{ kind: 'preparation' }, { kind: 'discovery' }, { kind: 'synthesis' }] }
  const checkpoint = { digest: 'b'.repeat(64), body: { cursor: state.cursor } }
  const machine = { snapshot: () => structuredClone(state),
    seal: vi.fn(async () => { state.checkpoints.push(checkpoint); return checkpoint }),
    stop: async (reason: string) => { state = { ...state, status: 'stopped', terminalReason: reason } } }
  const store = { ensureSchema: async () => {}, getState: async () => structuredClone(state),
    getRelease: async () => ({ body: { definition } }), putCheckpoint: vi.fn(async () => {}), putState: async () => {}, stopRequested: async () => true }
  const Workflow = new Function('WorkflowEntrypoint', 'CloudflareRunStore', 'waveStepConfig',
    'workflowBootstrapProgress', 'failureForWorkflowProgress', 'workflowFailureDisposition',
    'NonRetryableError', 'sameCursor', 'RunMachine', 'QuarantinedRevalidationProvider',
    'PromotedExecutionProvider', 'SandboxAgentProvider', 'R2ArtifactStore',
    'R2AgentExecutionReceiptStore', 'R2AgentExecutionLogStore',
    'advanceExperimentOneWave', 'audit0RunPolicy', 'workflowProgress',
    'canStopAtSealedWaveBoundary', 'isPermanentRunFailure', `${code}\nreturn AuditWorkflow;`)(
      class { env = {} }, function Store() { return store }, waveStepConfig, workflowBootstrapProgress,
      failureForWorkflowProgress, workflowFailureDisposition, NonRetryableError, sameCursor,
      { fromState: async () => machine }, class {}, class {}, class {}, class {}, class {}, class {},
      async () => false, {},
      workflowProgress, canStopAtSealedWaveBoundary, isPermanentRunFailure)
  const instance = new Workflow()
  instance.cleanupTerminalWorkspaces = vi.fn(async () => {})
  instance.recordTerminalFailure = vi.fn(async () => {})
  instance.workflowStepError = (error: unknown) => error
  const step = {
    do: async (name: string, _config: unknown, operation: () => Promise<unknown>) => {
      if (name === 'bootstrap-run') return running
      if (name === 'advance-or-poll-1') throw new NonRetryableError('stop not observed after drain')
      return operation()
    },
    sleep: vi.fn(async () => {}),
  }
  await expect(instance.run({ payload: { runId: state.runId } }, step)).resolves.toMatchObject({
    status: 'stopped', cursor: running.cursor, terminalReason: 'operator-requested-stop-at-sealed-wave-boundary',
  })
  expect(machine.seal).toHaveBeenCalledOnce()
  expect(store.putCheckpoint).toHaveBeenCalledWith(checkpoint)
  expect(instance.cleanupTerminalWorkspaces).toHaveBeenCalledOnce()
  expect(instance.recordTerminalFailure).not.toHaveBeenCalled()
})
