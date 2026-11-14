import { RunMachine } from './machine.js'
import { assertCurrentExecutionFormat } from './run-state-pointer.js'
import type { RunState } from './contracts.js'
import type { CloudflareRunStore } from './cloudflare-storage.js'
import { ExecutionReleases } from './execution-releases.js'
import { recordedWorkspaceTasks } from './execution-workspaces.js'
import { canonicalJson } from './canonical.js'
import { copyState } from './state-copy.js'
import { RunCommandRejected } from './run-commands.js'

/** Imported evidence is excluded by the verified fork seed. Every remaining
 * physical allocation must belong to this execution and runtime. */
export async function currentExecutionWorkspaceTasks(state: RunState, runs: Pick<CloudflareRunStore, 'getRelease' | 'executionSources'>) {
  assertCurrentExecutionFormat(state)
  if (!RunMachine.isProducedState(state)) {
    state = copyState(state)
    const sources = runs.executionSources()
    if (sources.assertSelected === undefined) throw new Error('workspace ownership requires a selected snapshot')
    await sources.assertSelected(state)
  }
  const definition = (await runs.getRelease(state.releaseDigest)).body.definition
  const releases = await ExecutionReleases.create(definition, state, digest => runs.getRelease(digest), runs.executionSources())
  const records = await recordedWorkspaceTasks(definition, state, releases.importedSeed)
  const inherited = records.filter(record => record.execution !== undefined
    ? record.execution.runId !== state.runId || canonicalJson(record.execution.runtimeRelease ?? null) !== canonicalJson(state.runtimeRelease ?? null)
    : record.mutationOwner !== undefined && canonicalJson(record.mutationOwner.authority) !== canonicalJson(state.executionAuthority))
  if (inherited.length > 0) {
    throw new RunCommandRejected('allocation-owner-unavailable', 'native revocation requires the original allocation owner and app version')
  }
  return records
}
