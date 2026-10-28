import { compileExperimentConfig } from './support/compile-config.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { expect, it } from 'vitest'
import type { AgentProvider } from '../src/contracts.js'
import {
  advanceExperimentOneWave, RunMachine, sealReleasePackage,
} from '../src/index.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'

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

const luna = {
  id: 'luna', backend: 'codex', model: 'shared-model', reasoningEffort: 'max',
  subagents: { default: { mode: 'disabled' } }, credentialSource: 'endpoint-luna', agents: 3, required: true,
}
const deepseek = {
  id: 'deepseek', backend: 'dsh-chat-completions', provider: 'provider-a',
  connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
  model: 'shared-model', reasoningEffort: 'max', thinking: 'enabled',
  subagents: { default: { mode: 'disabled' } }, agents: 1, required: false,
}

async function preparedMachine(config: any, runId: string) {
  const body = compileExperimentConfig(config)
  const release = await sealReleasePackage(body)
  const machine = await RunMachine.create(body.definition, release.digest, runId)
  const store = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition: body.definition, machine, provider: base, artifactStore: store })
  return { body, machine, store, base }
}


import { AgentExecutionPending } from '../src/run-errors.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

it('records two completed peers while one observation remains unknown, without spending repair',async()=>{
 const {body,machine,store,base}=await preparedMachine(manifest([luna,deepseek],4),'review-peer-observation')
 const calls:string[]=[]
 const provider:AgentProvider={async run(request){calls.push(request.task.id);if(request.task.id.endsWith('research-3') || request.task.providerClass==='additive')throw new AgentExecutionPending('same-process','unavailable');return base.run(request)}}
 await advanceExperimentOneWave({definition:body.definition,machine,provider,artifactStore:store})
 const state=machine.snapshot();const accepted=state.artifacts.filter(a=>a.stageId==='discovery')
 expect(accepted).toHaveLength(2);expect(state.rejectedAttempts).toHaveLength(0)
 expect(state.inFlightAgentAttempts?.map(a=>a.taskId).sort()).toEqual(['additive-wave-0-research-1','core-wave-0-research-3'])
 const priorUsage=state.budget.modelCalls
 const restored=await RunMachine.fromState(body.definition,state)
 const afterCalls:string[]=[]
 await advanceExperimentOneWave({definition:body.definition,machine:restored,artifactStore:store,provider:{async run(request){afterCalls.push(request.task.id);throw new AgentExecutionPending('same-process','unavailable')}}})
 expect(afterCalls.sort()).toEqual(['additive-wave-0-research-1','core-wave-0-research-3'])
 expect(restored.snapshot().budget.modelCalls).toBe(priorUsage)
 expect(restored.snapshot().rejectedAttempts).toHaveLength(0)
 expect(restored.snapshot().artifacts.filter(a=>a.stageId==='discovery').map(a=>a.contentDigest)).toEqual(accepted.map(a=>a.contentDigest))
 expect(restored.snapshot().inFlightAgentAttempts?.[0]?.attempt).toBe(1)
})
