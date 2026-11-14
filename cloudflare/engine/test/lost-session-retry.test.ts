import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { expect, it } from 'vitest'
import type { AgentRequest } from '../src/contracts.js'
import { RunMachine } from '../src/machine.js'
import { AgentAttemptFailure } from '../src/run-errors.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const baseDefinition = structuredClone(audit0Definition)
const definition = {
  ...baseDefinition,
  stages: baseDefinition.stages.map((stage, index) => index === 1
    ? { ...stage, waves: stage.waves.slice(0, 4) }
    : stage),
  discoverySafetyCeiling: 4,
  limits: { ...baseDefinition.limits, maxModelCalls: 10_000, maxCostUsd: 10_000 },
}

it('uses the skipped resume slot as a fresh replacement when a lost core process has no session', async () => {
  const machine = await createControlledMachine(definition, 'f'.repeat(64), 'lost-core-session')
  const artifacts = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  const attempts: Array<{ attempt: number, mode: AgentRequest['continuationMode'], fresh: boolean }> = []
  let taskId: string | undefined
  const provider = {
    async run(request: AgentRequest) {
      if (request.stage.kind !== 'discovery' || request.task.providerClass !== 'core'
        || (taskId !== undefined && request.task.id !== taskId)) return base.run(request)
      taskId = request.task.id
      attempts.push({ attempt: request.attempt, mode: request.continuationMode, fresh: request.freshContext })
      if (request.attempt === 1) {
        throw new AgentAttemptFailure('synthetic lost process and receipt', { includeDiagnosticsInRepair: false })
      }
      const result = await base.run(request)
      if (request.attempt !== 2) return result
      const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as {
        observations: Array<{ id: string }>
      }
      submission.observations[0]!.id = 'not-a-local-id'
      return { ...result, files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) } }
    },
  }
  for (let guard = 0; guard < 8 && !machine.snapshot().artifacts.some(value => value.taskId === taskId);
    guard += 1) {
    await advanceExperimentOneWave({ definition, machine, provider, artifactStore: artifacts })
    await expect(restoreSelected(machine)).resolves.toBeDefined()
  }
  expect(attempts).toEqual([
    { attempt: 1, mode: 'new', fresh: false },
    { attempt: 2, mode: 'new', fresh: true },
    { attempt: 3, mode: 'resume', fresh: false },
  ])
  expect(machine.snapshot().artifacts.some(value => value.taskId === taskId)).toBe(true)
  expect(machine.snapshot().rejectedAttempts.filter(value => value.taskId === taskId).map(value => value.attempt))
    .toEqual([1, 2])
})

