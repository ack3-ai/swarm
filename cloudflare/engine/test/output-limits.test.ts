import { createControlledMachine } from './support/controlled-machine.js'
import { expect, it } from 'vitest'
import type { AgentRequest } from '../src/contracts.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { SUBMISSION_PATH, readSubmission } from '../src/submission.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { OUTPUT_FILE_MAX_BYTES, SUBMISSION_MAX_BYTES } from '../src/output-limits.js'

async function fixture() {
  const machine = await createControlledMachine(audit0Definition, 'f'.repeat(64), 'output-limits')
  const base = new DeterministicAuditProvider(), store = new MemoryArtifactStore()
  let captured: AgentRequest | undefined
  for (let tick = 0; tick < 100 && captured === undefined; tick++) {
    await advanceExperimentOneWave({ definition: audit0Definition, machine, artifactStore: store,
      provider: { async run(request) {
        if (request.task.promptKind !== 'synthesis') return base.run(request)
        captured = request
        throw new AgentExecutionPending('synthetic-synthesis', 'unfinished')
      } } })
  }
  expect(captured).toBeDefined()
  return { request: captured!, base }
}

it('allows legitimate larger outputs, bounds bytes, and keeps identity and schema failures distinct', async () => {
  const { request, base } = await fixture()
  const result = await base.run(request)
  const files = { ...result.files, 'observation-ledger.md': 'é'.repeat(1_500_000),
    [SUBMISSION_PATH]: result.files[SUBMISSION_PATH]! + ' '.repeat(300_000) }
  expect((await validateAgentResultDetailed(request.task, { ...result, files }, request.visibleArtifacts)).issues).toEqual([])
  const oversized = { ...files, 'observation-ledger.md': 'é'.repeat(OUTPUT_FILE_MAX_BYTES / 2 + 1),
    [SUBMISSION_PATH]: '{' + ' '.repeat(SUBMISSION_MAX_BYTES) }
  const validation = await validateAgentResultDetailed(request.task, { ...result, files: oversized }, request.visibleArtifacts)
  expect(validation.integrity).toEqual([])
  expect(validation.repairable).toContain('output file is too large: observation-ledger.md')
  expect(validation.repairable).toContain('structured submission is too large')
  const badIdentity = await validateAgentResultDetailed(request.task,
    { ...result, files: oversized, model: 'unexpected-model' }, request.visibleArtifacts)
  expect(badIdentity.integrity).toContain(`served model unexpected-model differs from ${request.task.model}`)
  expect((await readSubmission(request.task, { ...files, [SUBMISSION_PATH]: '{' }, request.visibleArtifacts)).issues.length)
    .toBeGreaterThan(0)
})
