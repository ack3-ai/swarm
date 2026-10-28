import type { AgentDiagnostic } from './agent-diagnostics.js'
import { parseAgentDiagnostic } from './agent-diagnostics.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import { listLiveCompletions } from './dashboard-receipts.js'
import type { LiveCompletion } from './dashboard-types.js'
import type { Env } from './env.js'
import type { ExperimentDefinition } from './contracts.js'

export function latestLaneCompletion(
  definition: ExperimentDefinition,
  workspaceKey: string,
  entries: readonly LiveCompletion[],
): LiveCompletion | null {
  const taskIds = new Set(definition.stages.flatMap(stage => stage.waves.flatMap(wave => (
    wave.tasks.filter(task => task.workspaceKey === workspaceKey).map(task => task.id)
  ))))
  if (taskIds.size === 0) return null
  return entries.filter(entry => taskIds.has(entry.taskId)).toSorted((left, right) => (
    Date.parse(right.recordedAt) - Date.parse(left.recordedAt) || right.attempt - left.attempt
  ))[0] ?? null
}

/** Read only durable evidence. Monitoring must never acquire Sandbox lifecycle ownership. */
export async function durableLaneDiagnostic(
  runId: string,
  workspaceKey: string,
  env: Pick<Env, 'PACKAGES' | 'ARTIFACTS' | 'INDEX'>,
): Promise<AgentDiagnostic | null> {
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const state = await store.getState(runId)
  const release = await store.getRelease(state.releaseDigest)
  const completions = await listLiveCompletions(env.ARTIFACTS, runId)
  const latest = latestLaneCompletion(release.body.definition, workspaceKey, completions.entries)
  if (latest === null) return null
  const receipt = await new R2AgentExecutionReceiptStore(env.ARTIFACTS).get(runId, latest.requestDigest)
  return receipt === null ? null : parseAgentDiagnostic(JSON.stringify(receipt))
}
