import { expect, it } from 'vitest'
import type { AgentRequest, AgentResult } from '../src/contracts.js'
import type { AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { sha256 } from '../src/canonical.js'
import { historicalAcceptedExecutionMatches } from '../src/failed-wave-recovery.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

async function fixture() {
  const machine = await RunMachine.create(audit0Definition, 'a'.repeat(64), 'historical-source')
  const store = new MemoryArtifactStore(), base = new DeterministicAuditProvider()
  let selected: { request: AgentRequest, result: AgentResult } | undefined
  const provider = { async run(request: AgentRequest) {
    const result = await base.run(request)
    if (request.stage.kind === 'discovery' && request.task.providerClass === 'core' && selected === undefined) {
      selected = { request: structuredClone(request), result: structuredClone(result) }
    }
    return result
  } }
  await advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: store })
  await advanceExperimentOneWave({ definition: audit0Definition, machine, provider, artifactStore: store })
  const { request, result } = selected!
  const record = machine.snapshot().artifacts.find(value => value.taskId === request.task.id)!
  const requestDigest = 'b'.repeat(64)
  const admission = machine.snapshot().journal.find(event => event.type === 'agent.attempt-admitted'
    && (event.payload as Record<string, unknown>).taskId === request.task.id
    && (event.payload as Record<string, unknown>).attempt === request.attempt)!
  const logged = { schemaVersion: 1 as const, runId: request.runId, stageId: request.stage.id,
    waveId: request.wave.id, taskId: request.task.id, requestDigest, promptDigest: request.promptDigest,
    prompt: request.prompt, model: request.task.model, provider: result.provider,
    attempt: request.attempt, startedAt: admission.at, startedAtBasis: 'execution-admission' as const }
  const receipt: AgentExecutionReceipt = { requestDigest, exitCode: 0, actorId: result.actorId,
    files: result.files, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
    costUsd: result.costUsd, stderr: '' }
  const input = { definition: audit0Definition, source: machine.snapshot(), stage: request.stage,
    wave: request.wave, task: request.task, record, visibleArtifacts: request.visibleArtifacts,
    requests: { async listRequests() { return [logged] } },
    receipts: { async get() { return receipt } } }
  return { input, logged, receipt }
}

it('binds an accepted historical response to its original prompt, attempt, actor, receipt and files', async () => {
  const { input, logged } = await fixture()
  expect(await sha256(logged.prompt)).toBe(logged.promptDigest)
  expect(await historicalAcceptedExecutionMatches(input)).toBe(true)
})

it('rejects a swapped attempt even when the prompt and output are unchanged', async () => {
  const { input, logged } = await fixture()
  expect(await historicalAcceptedExecutionMatches({ ...input,
    requests: { async listRequests() { return [{ ...logged, attempt: logged.attempt + 1 }] } },
  })).toBe(false)
})

it('rejects a forged prompt or admission time despite matching output bytes', async () => {
  const { input, logged } = await fixture()
  expect(await historicalAcceptedExecutionMatches({ ...input,
    requests: { async listRequests() { return [{ ...logged, prompt: `${logged.prompt} forged` }] } },
  })).toBe(false)
  expect(await historicalAcceptedExecutionMatches({ ...input,
    requests: { async listRequests() { return [{ ...logged, startedAt: new Date(0).toISOString() }] } },
  })).toBe(false)
})

it('rejects two independently claimed receipts for the same accepted artifact', async () => {
  const { input, logged, receipt } = await fixture()
  const otherDigest = 'c'.repeat(64)
  await expect(historicalAcceptedExecutionMatches({ ...input,
    requests: { async listRequests() { return [logged, { ...logged, requestDigest: otherDigest }] } },
    receipts: { async get(_runId: string, digest: string) {
      return { ...receipt, requestDigest: digest }
    } },
  })).rejects.toThrow('ambiguous')
})
