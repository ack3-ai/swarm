import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { compileExperimentConfig } from './support/compile-config.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { expect, it } from 'vitest'
import type { AgentResult } from '../src/contracts.js'
import {
  advanceExperimentOneWave, RunMachine, sealReleasePackage,
} from '../src/index.js'
import { configuredResearchTaskPoolId } from '../src/research-scheduler.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

function manifest(pools: any[], maxDiscoveryWaves = 5): any {
  const value: any = structuredClone(document)
  value.id = `independent-discovery-${pools.map(pool => pool.id).join('-')}`
  value.maxDiscoveryWaves = maxDiscoveryWaves
  value.modelPools = pools
  value.limits.maxModelCalls = 10_000
  value.limits.maxInputTokens = 100_000_000
  value.limits.maxOutputTokens = 100_000_000
  value.limits.maxCostUsd = 10_000
  return value
}

const luna = document.modelPools.find(pool => pool.id === 'luna')!
const deepseek = { ...document.modelPools.find(pool => pool.id === 'deepseek')!, agents: 1 }

async function preparedMachine(config: any, runId: string) {
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await createControlledMachine(body.definition, release.digest, runId)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}

function withMaterial(result: AgentResult, materialHighCriticalDelta: boolean, label: string): AgentResult {
  if (result.protocol.research === undefined) return result
  const observations = result.protocol.research.observations.map(observation => ({
    ...observation,
    statement: label,
    evidence: [label],
  }))
  const submission = JSON.parse(result.files[SUBMISSION_PATH]!)
  submission.materialHighCriticalDelta = materialHighCriticalDelta
  submission.observations = submission.observations.map((observation: any) => ({
    ...observation,
    statement: label,
    evidence: [label],
  }))
  return {
    ...result,
    files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
    protocol: { research: { ...result.protocol.research, materialHighCriticalDelta, observations } },
  }
}


it.each(['provider-credit', 'platform-interruption'] as const)('resumes after optional %s interrupts a quiet streak', async reason => {
  const { body, machine, store, base } = await preparedMachine(manifest([{ ...luna, agents: 1 }, deepseek], 4), 'review-unavailable-after-quiet')
  await advanceExperimentOneWave({ definition: body.definition, machine, artifactStore: store, provider: {
    async run(request) {
      const result = await base.run(request)
      if (request.task.promptKind !== 'research') return result
      if (configuredResearchTaskPoolId(request.task) === 'deepseek' && request.task.research?.wave === 2) {
        return { ...result, status: 'additive-unavailable', files: {}, assertions: [], protocol: {},
          unavailableReason: reason, inputTokens: 0, outputTokens: 0, costUsd: 0 }
      }
      return withMaterial(result, false, 'no material delta')
    }
  } })
  expect(machine.snapshot().cursor.stageIndex).toBe(2)
  await expect(restoreSelected(machine)).resolves.toBeDefined()
})
