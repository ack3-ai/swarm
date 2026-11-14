import { selectVisibleArtifacts } from './prompts.js'
import { verifiedJournalPrefix } from './execution-journal.js'
import { type ExecutionSourceLoader } from './execution-lineage.js'
import { ExecutionReleases, type ReleaseLoader } from './execution-releases.js'
import { selectedTaskOccurrence, assertTaskOccurrenceExecution } from './task-occurrences.js'
import type { AgentRequest, InFlightAgentAttempt, RunState } from './contracts.js'
import { artifactReferences, assertDispatchedExecution, executionConfiguration } from './artifact-execution.js'
import { hasRecordedAttemptOutcome, finishedAttemptInterval } from './attempt-policy.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { ExecutionAuthorityStore } from './execution-authority.js'
import type { CloudflareRunStore } from './cloudflare-storage.js'
import type { R2AgentExecutionReceiptStore } from './agent-execution-receipt.js'
import { frozenAdmissionArtifacts } from './frozen-inputs.js'
import { RunCommandConflict } from './run-commands.js'
import { PermanentRunFailure, TransientRunFailure, RunFailure } from './run-errors.js'

/** Launch eligibility is distinct from verifying a historical request for custody. */
export async function assertNativeTaskAdmission(state: RunState, request: AgentRequest, loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader): Promise<void> {
  const attempt = state.inFlightAgentAttempts?.find(value => value.taskId === request.task.id)
  if (state.status !== 'running' || attempt === undefined || hasRecordedAttemptOutcome(state.journal, attempt)) {
    throw new RunCommandConflict('operation-conflict', 'native request has no matching persisted task admission')
  }
  await assertRecordedTaskAdmission(state, request, loadRelease, loadExecution)
}

/** Deterministic tasks have a selected occurrence but no paid native attempt.
 * Authenticate that selection before setup, reading inputs or producing output. */
export async function assertSupervisorTaskAdmission(state: RunState, request: AgentRequest,
  loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader): Promise<void> {
  if (state.status !== 'running' || request.task.providerClass !== 'deterministic') throw admissionConflict()
  await assertAdmittedRequest(state, request, undefined, loadRelease, loadExecution)
}

/** Verify exact admitted bytes/frontier/occurrence without granting a launch. */
export async function assertRecordedTaskAdmission(state: RunState, request: AgentRequest, loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader): Promise<void> {
  request = deepClone(request)
  const attempt = state.inFlightAgentAttempts?.find(value => value.taskId === request.task.id)
  if (attempt === undefined) throw admissionConflict()
  await assertAdmittedRequest(state, request, attempt, loadRelease, loadExecution)
}

function admissionConflict() {
  return new RunCommandConflict('operation-conflict', 'native request has no matching persisted task admission')
}

/** Historical custody does not invent an in-flight attempt or grant a launch.
 * The admission event, outcome observation and finish form one ordered interval.
 * Re-observing the same dispatch creates a distinct logical admission. This
 * verifies prior attempts of the currently selected occurrence, not arbitrary
 * history from a replaced task/executor or a completed wave. */
export async function assertFinishedSelectedTaskAdmission(state: RunState, request: AgentRequest, admissionDigest: string,
  loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader) {
  request = deepClone(request)
  let interval: ReturnType<typeof finishedAttemptInterval>
  try { interval = finishedAttemptInterval(state.journal, admissionDigest) } catch { throw admissionConflict() }
  const attempt = interval.admission.payload as InFlightAgentAttempt
  try { await verifiedJournalPrefix(state.journal) } catch { throw admissionConflict() }
  await assertAdmittedRequest(state, request, attempt, loadRelease, loadExecution)
  return interval
}

/** Resolve a closed attempt and its first-writer native receipt using archived
 * evidence only. A logical finish is not proof of native settlement. The source
 * must be the original selected snapshot, including after executor replacement;
 * this neither grants a launch nor satisfies a different task occurrence. */
export async function readSettledFinishedExecution(source: RunState, admissionDigest: string, stores: {
  runs: Pick<CloudflareRunStore, 'getAgentDispatch' | 'getRelease' | 'getStateAt' | 'executionSources'>
  authority: Pick<ExecutionAuthorityStore, 'observeLaunch'>
  receipts: Pick<R2AgentExecutionReceiptStore, 'get'>
}) {
  source = deepClone(source)
  const event = source.journal.find(value => value.digest === admissionDigest)
  if (event?.type !== 'agent.attempt-admitted') throw new PermanentRunFailure('finished admission is missing', 'integrity-failed')
  const admission = event.payload as InFlightAgentAttempt
  if (admission.dispatchDigest === undefined || admission.execution?.taskExecutionId === undefined) {
    throw new PermanentRunFailure('finished admission identity is missing', 'integrity-failed')
  }
  const saved = await stores.runs.getAgentDispatch(source.runId, admission.dispatchDigest)
  if (saved === null) return null
  const dispatch = deepClone(saved)
  const interval = await assertFinishedSelectedTaskAdmission(source, dispatch.request, admissionDigest,
    digest => stores.runs.getRelease(digest), stores.runs.executionSources())
  if (dispatch.dispatchDigest !== admission.dispatchDigest || await sha256(dispatch.request) !== admission.dispatchDigest) {
    throw new PermanentRunFailure('finished dispatch identity differs', 'integrity-failed')
  }
  const claim = await stores.authority.observeLaunch(source.executionAuthority!,
    admission.execution.taskExecutionId, dispatch.nativeRequestDigest)
  if (claim?.receiptDigest == null) return null
  const receipt = await stores.receipts.get(source.runId, dispatch.nativeRequestDigest)
  if (receipt === null) return null
  if (receipt.requestDigest !== dispatch.nativeRequestDigest || await sha256(receipt) !== claim.receiptDigest) {
    throw new PermanentRunFailure('finished native receipt differs from settlement', 'integrity-failed')
  }
  return { dispatch, interval, receipt, claim }
}

/** Both active and finished custody use the same immutable request contract.
 * The caller selects the admission from persisted state, never a public override. */
async function assertAdmittedRequest(state: RunState, request: AgentRequest, attempt: InFlightAgentAttempt | undefined,
  loadRelease?: ReleaseLoader, loadExecution?: ExecutionSourceLoader): Promise<void> {
  const conflict = admissionConflict
  if (state.schemaVersion !== 3 || loadExecution?.assertSelected === undefined) throw conflict()
  await loadExecution.assertSelected(state)
  const authority = request.executionAuthority, execution = request.execution
  if (authority === undefined || execution === undefined
    || state.runId !== request.runId || state.experimentId !== request.experimentId
    || state.rootRunId !== authority.auditId || authority.executionId !== request.runId
    || canonicalJson(state.executionAuthority) !== canonicalJson(authority)
    || execution.taskExecutionId !== request.taskExecutionId || execution.releaseDigest !== request.releaseDigest
    || request.promptDigest !== await sha256(request.prompt)) throw conflict()
  try { assertTaskOccurrenceExecution(selectedTaskOccurrence(state, request.task.id), execution) } catch { throw conflict() }
  if (attempt !== undefined) {
    const { admittedAt: _, ...admitted } = attempt
    const expected = {
      execution, stageId: request.stage.id, waveId: request.wave.id, taskId: request.task.id,
      attempt: request.attempt, dispatchDigest: await sha256(request), promptDigest: request.promptDigest,
      freshContext: request.freshContext, continuationMode: request.continuationMode, sessionId: request.sessionId,
      ...(request.formatRepairOrdinal === undefined ? {} : { formatRepairOrdinal: request.formatRepairOrdinal }),
      ...(request.formatRepairSourceDigest === undefined ? {} : { formatRepairSourceDigest: request.formatRepairSourceDigest }),
    }
    if (canonicalJson(admitted) !== canonicalJson(expected)) throw conflict()
  }
  const admission = state.discoveryScheduler?.admissions.find(value => value.taskIds.includes(request.task.id)) ?? state.waveAdmission
  if (admission == null || admission.stageId !== request.stage.id || admission.waveId !== request.wave.id
    || canonicalJson(selectedTaskOccurrence(state, request.task.id)?.configuration) !== canonicalJson(executionConfiguration(execution))) throw conflict()
  try {
    const occurrence = selectedTaskOccurrence(state, request.task.id)!
    const mixed = state.forkOrigin !== undefined || (state.journal[0]?.payload as { forkOrigin?: unknown })?.forkOrigin !== undefined
    const needsReleases = mixed || state.discoveryScheduler !== undefined || attempt === undefined
    if (needsReleases && loadRelease === undefined) throw conflict()
    const read: ReleaseLoader = async digest => {
      try { return await loadRelease!(digest) }
      catch (error) { if (error instanceof RunFailure) throw error; throw new TransientRunFailure('native admission release read failed', { cause: error }) }
    }
    const readSource: ExecutionSourceLoader | undefined = loadExecution === undefined ? undefined : async (id, pointer) => {
      try { return await loadExecution(id, pointer) }
      catch (error) { if (error instanceof RunFailure) throw error; throw new TransientRunFailure('native admission source read failed', { cause: error }) }
    }
    if (readSource !== undefined && loadExecution?.readSavedWork !== undefined) readSource.readSavedWork = loadExecution.readSavedWork
    const releases = !needsReleases ? undefined : await ExecutionReleases.create(
      (await read(state.releaseDigest)).body.definition, state, read, readSource)
    const peer = 'peerPredecessors' in admission ? admission.peerPredecessors[request.task.id] : undefined
    if (attempt === undefined) {
      const definition = await releases!.definitionView(execution)
      const frontier = await frozenAdmissionArtifacts(state.artifacts, admission)
      const visible = selectVisibleArtifacts(request.task, frontier, state.waveReceipts,
        state.cursor.stageIndex, state.cursor.waveIndex, definition)
      if (canonicalJson(request.visibleArtifacts) !== canonicalJson(visible)) throw conflict()
    }
    if (occurrence.taskDigest !== await sha256(request.task)) throw conflict()
    if (releases !== undefined && canonicalJson(request.task) !== canonicalJson(await releases.task(execution,
      { stageId: request.stage.id, waveId: request.wave.id, taskId: request.task.id }, execution.taskDigest, peer))) throw conflict()
  } catch (error) { if (error instanceof TransientRunFailure) throw error; throw conflict() }
  const frontier = await frozenAdmissionArtifacts(state.artifacts, admission)
  const byId = new Map(frontier.map(record => [record.id, record]))
  if (request.visibleArtifacts.some(record => canonicalJson(record) !== canonicalJson(byId.get(record.id)))) throw conflict()
  try {
    await assertDispatchedExecution(execution, { runId: request.runId, task: request.task,
      attempt: request.attempt, inputArtifacts: artifactReferences(request.visibleArtifacts) })
  } catch { throw conflict() }
}

/** Incidental state progress never changes the paid request identity. Recheck
 * the same admission on a CAS race, and yield if peers keep advancing. */
export async function reserveNativeLaunch(runs: Pick<CloudflareRunStore,
  'getState' | 'getRelease' | 'executionSources' | 'putAgentDispatch'>,
  authority: ExecutionAuthorityStore, input: AgentRequest, nativeRequestDigest: string): Promise<void> {
  // Keep admission, archived bytes and the final D1 claim on one request even
  // if the caller reuses its object while storage or authority reads await.
  const request = deepClone(input)
  if (request.executionAuthority === undefined) throw new TypeError('native launch is not controlled')
  await authority.assertActive(request.executionAuthority)
  let dispatchSaved = false
  for (let read = 0; read < 3; read++) {
    const state = await runs.getState(request.runId)
    await assertNativeTaskAdmission(state, request, digest => runs.getRelease(digest), runs.executionSources())
    const pointer = { generation: state.stateGeneration, digest: await sha256(state) }
    if (!dispatchSaved) {
      await runs.putAgentDispatch(request, nativeRequestDigest)
      dispatchSaved = true
    }
    if (await authority.admitLaunch(request.executionAuthority, request.taskExecutionId!, nativeRequestDigest, pointer)) return
  }
  throw new TransientRunFailure('native admission state changed; reload the exact task before dispatch')
}
