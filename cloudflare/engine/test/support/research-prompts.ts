import type { AgentRequest, ExperimentDefinition, TaskDefinition } from '../../src/contracts.js'
import { RunMachine } from '../../src/machine.js'
import { renderTaskPrompt } from '../../src/prompts.js'
import { advanceExperimentOneWave } from '../../src/runner.js'
import { DeterministicAuditProvider } from './deterministic-audit-provider.js'
import { MemoryArtifactStore } from './memory-runner.js'

/** Collect real admitted snapshots and scheduler-selected lineage, without model calls. */
export async function captureDiscoveryRequests(definition: ExperimentDefinition): Promise<readonly AgentRequest[]> {
  // Four waves cover the research-plan cycles used by tests with actual admitted evidence.
  const bounded = { ...definition, discoverySafetyCeiling: 4, stages: definition.stages.map(stage => (
    stage.kind === 'discovery' ? { ...stage, waves: stage.waves.slice(0, 4) } : stage
  )) }
  const machine = await RunMachine.create(bounded, 'a'.repeat(64), 'research-prompt-contract')
  const artifactStore = new MemoryArtifactStore()
  const requests: AgentRequest[] = []
  const base = new DeterministicAuditProvider()
  const provider = {
    async run(request: AgentRequest) {
      if (request.task.promptKind === 'research') requests.push(structuredClone(request))
      return base.run(request)
    },
  }
  for (let tick = 0; tick < 200; tick++) {
    await advanceExperimentOneWave({ definition: bounded, machine, provider, artifactStore })
    const state = machine.snapshot()
    if (state.status !== 'running') throw new Error(`fixture discovery failed: ${state.status}`)
    if (state.cursor.stageIndex > 1) return requests
  }
  throw new Error('fixture discovery did not reach a sealed boundary')
}

/** Compare the same selected assignment on another pool's real sealed snapshot. */
export function mirroredResearchPrompt(
  definition: ExperimentDefinition,
  template: TaskDefinition,
  request: AgentRequest,
  requests: readonly AgentRequest[],
): string {
  const task = { ...template, research: request.task.research! }
  const selected = task.research.buildsOn.match(/^wave-(\d+)\/research-(\d+)$/)
  const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
  const peer = selected === null ? undefined : discovery.waves.flatMap(wave => wave.tasks).find(candidate => (
    candidate.modelPool === template.modelPool && candidate.research?.wave === Number(selected[1])
    && candidate.research.researcher === Number(selected[2])
  ))
  const snapshot = selected === null ? request : requests.find(candidate => (
    candidate.visibleArtifacts.some(artifact => artifact.taskId === peer?.id && artifact.status === 'accepted')
  ))
  if (snapshot === undefined) throw new Error('mirror has no actual admitted peer snapshot')
  return renderTaskPrompt({ definition, task, visibleArtifacts: snapshot.visibleArtifacts, deadline: '2026-09-29T00:00:00.000Z' })
}

/** Remove file navigation only; keep every instruction and selected lineage. */
export function researchReasoningText(prompt: string): string {
  return prompt.replace(/^(?:Accepted research|Peer evidence|Peer observations): .*\n/gm, '')
}
