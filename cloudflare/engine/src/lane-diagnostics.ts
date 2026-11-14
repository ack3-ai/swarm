import { R2AgentDispatchStore, type AgentDispatch } from './agent-dispatch.js'
import type { ExecutionSourceLoader } from './execution-lineage.js'
import { ExecutionReleases, type ReleaseLoader } from './execution-releases.js'
import type { AgentDiagnostic } from './agent-diagnostics.js'
import { parseAgentDiagnostic } from './agent-diagnostics.js'
import { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { CloudflareRunStore } from './cloudflare-storage.js'
import { listLiveCompletions } from './dashboard-receipts.js'
import type { LiveCompletion } from './dashboard-types.js'
import type { Env } from './env.js'
import type { ExperimentDefinition, InFlightAgentAttempt, RunState } from './contracts.js'

/** Resolve native lane diagnostics from original admissions, including removed
 * pools. The current manifest is not evidence of an old actor's account/route. */
export async function latestRecordedLaneCompletion(state: RunState, definition: ExperimentDefinition,
  workspaceKey: string, entries: readonly LiveCompletion[], load: ReleaseLoader,
  loadDispatch: (digest: string) => Promise<AgentDispatch | null>, loadSource?: ExecutionSourceLoader): Promise<LiveCompletion | null> {
  if (state.executionAuthority === undefined) throw new Error('lane diagnostics belong to the historical app version')
  const releases = await ExecutionReleases.create(definition, state, load, loadSource)
  const admissions = state.journal.filter(event => event.type === 'agent.attempt-admitted')
    .map(event => event.payload as InFlightAgentAttempt)
  for (const entry of [...entries].sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b.attempt - a.attempt)) {
    const admitted = admissions.find(attempt => attempt.stageId === entry.stageId && attempt.waveId === entry.waveId
      && attempt.taskId === entry.taskId && attempt.attempt === entry.attempt && attempt.promptDigest === entry.promptDigest)
    if (admitted?.execution === undefined || admitted.dispatchDigest === undefined) continue
    const dispatch = await loadDispatch(admitted.dispatchDigest)
    if (dispatch === null || dispatch.nativeRequestDigest !== entry.requestDigest) continue
    const peer = [...(state.discoveryScheduler?.admissions ?? []), ...state.waveReceipts].find(receipt =>
      receipt.stageId === admitted.stageId && receipt.waveId === admitted.waveId
        && receipt.peerPredecessors?.[admitted.taskId] !== undefined)?.peerPredecessors?.[admitted.taskId]
    const task = await releases.task(admitted.execution, admitted, admitted.execution.taskDigest, peer)
    if (workspaceKey === admitted.execution.workspaceKey || workspaceKey === task.workspaceKey) return entry
  }
  return null
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
  const latest = await latestRecordedLaneCompletion(state, release.body.definition, workspaceKey, completions.entries,
    digest => store.getRelease(digest), digest => new R2AgentDispatchStore(env.ARTIFACTS).get(runId, digest), store.executionSources())
  if (latest === null) return null
  const receipt = await new R2AgentExecutionReceiptStore(env.ARTIFACTS).get(runId, latest.requestDigest)
  return receipt === null ? null : parseAgentDiagnostic(JSON.stringify(receipt))
}
