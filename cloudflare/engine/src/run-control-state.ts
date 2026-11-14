import { canonicalJson, deepClone, sha256 } from './canonical.js'
import type { ExperimentDefinition, InFlightAgentAttempt, RunPhase, RunState, TaskDefinition } from './contracts.js'
import { parseRunCommand, RunCommandRejected, type RunCommandScope } from './run-commands.js'
import type { RunCommandSource, RunOperation } from './run-command-journal.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'
import { compareText } from './text-order.js'

export interface RunControlReceipt {
  auditId: string
  executionId: string
  revision: number
  commandId: string
  commandDigest: string
  previousStateDigest: string
  pausesDigest: string
  settledAt: string
  outcome: RunControlOutcome
}
export type RunControlOutcome = { status: 'applied' } | { status: 'rejected'; detail: { code: string; message: string } }
export interface RunControlState {
  revision: number
  pauses: readonly RunCommandScope[]
  lastReceipt: RunControlReceipt
}

function normalized(scope: RunCommandScope): RunCommandScope {
  return scope.kind === 'tasks' ? { ...scope, taskIds: [...scope.taskIds].sort() } : deepClone(scope)
}
function pool(task: TaskDefinition): string | undefined {
  return task.modelPool ?? (task.promptKind === 'research' ? configuredResearchTaskPoolId(task) : undefined)
}
export function taskInControlScope(scope: RunCommandScope, stageId: string, task: TaskDefinition): boolean {
  return scope.kind === 'audit' || (scope.kind === 'stage' && scope.stageId === stageId)
    || (scope.kind === 'pool' && pool(task) === scope.poolId)
    || (scope.kind === 'tasks' && scope.taskIds.includes(task.id))
}
export function admissionPaused(state: Pick<RunState, 'controls'>, stageId: string, tasks: readonly TaskDefinition[]): boolean {
  return state.controls?.pauses.some(scope => scope.kind === 'audit'
    || (scope.kind === 'stage' && scope.stageId === stageId)
    || tasks.some(task => taskInControlScope(scope, stageId, task))) ?? false
}

export function assertControlScope(definition: ExperimentDefinition, scope: RunCommandScope): void {
  const tasks = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
  if ((scope.kind === 'stage' && !definition.stages.some(stage => stage.id === scope.stageId))
    || (scope.kind === 'pool' && !tasks.some(task => pool(task) === scope.poolId))
    || (scope.kind === 'tasks' && scope.taskIds.some(id => !tasks.some(task => task.id === id)))) {
    throw new RunCommandRejected('scope-unavailable', 'command scope does not exist in the current release')
  }
}

export async function settledControlState(state: RunState, operation: RunOperation,
  pauses: readonly RunCommandScope[], outcome: RunControlOutcome, now: string): Promise<RunControlState> {
  const command = parseRunCommand(operation.command)
  if (operation.auditId !== state.rootRunId || operation.commandDigest !== await sha256(command)
    || operation.revision !== command.expectedRevision + 1 || operation.status !== 'applying'
    || !Number.isFinite(Date.parse(now))) throw new Error('command operation identity is invalid')
  if (state.controls?.revision === operation.revision
    && state.controls.lastReceipt.commandDigest === operation.commandDigest) {
    if (canonicalJson(state.controls.lastReceipt.outcome) !== canonicalJson(outcome)) throw new Error('command outcome differs from its persisted receipt')
    await assertRunControls(state)
    return deepClone(state.controls)
  }
  if (state.executionAuthority === undefined
    || !(state.status === 'running' || state.status === 'failed' && (command.action === 'cancel' || outcome.status === 'rejected'))
    || (state.controls?.revision ?? 0) !== command.expectedRevision) throw new Error('command cannot apply at this audit revision or lifecycle')
  const result = { revision: operation.revision, pauses: deepClone(pauses), lastReceipt: {
    auditId: state.rootRunId, executionId: state.runId, revision: operation.revision,
    commandId: command.id, commandDigest: operation.commandDigest,
    previousStateDigest: await sha256(state), pausesDigest: await sha256(pauses), settledAt: now, outcome: deepClone(outcome),
  } }
  await assertControlTransition(state.controls, result, state, now)
  return result
}

/** Names the active pauses, as many as fit the 2,000-character receipt detail. */
function noMatchingPauseMessage(pauses: readonly RunCommandScope[]): string {
  const head = 'continue lifts only a pause with exactly the same scope, and no active pause has this scope'
  if (pauses.length === 0) return `${head}; no pause is active`
  const more = ' (see pauses in GET on the commands endpoint)'
  const listed = (count: number) => `${head}; active pauses: ${pauses.slice(0, count).map(value => canonicalJson(value)).join(', ')}`
    + (count < pauses.length ? `, and ${pauses.length - count} more${more}` : '')
  for (let count = pauses.length; count > 0; count--) {
    const message = listed(count)
    if (message.length <= 2000) return message
  }
  return `${head}; ${pauses.length} ${pauses.length === 1 ? 'pause is' : 'pauses are'} active${more}`
}

export async function applyAdmissionControl(definition: ExperimentDefinition, state: RunState,
  operation: RunOperation, now: string): Promise<RunControlState> {
  const command = parseRunCommand(operation.command)
  if (command.action !== 'pause' && command.action !== 'continue') throw new TypeError('command requires its execution transition')
  if (state.controls?.revision === operation.revision) return settledControlState(state, operation,
    state.controls.pauses, { status: 'applied' }, now)
  assertControlScope(definition, command.scope)
  const scope = normalized(command.scope), key = canonicalJson(scope)
  const previous = state.controls?.pauses ?? []
  // Reconciliation settles this as a rejected receipt that keeps every pause (E18).
  if (command.action === 'continue' && !previous.some(value => canonicalJson(value) === key)) {
    throw new RunCommandRejected('no-matching-pause', noMatchingPauseMessage(previous))
  }
  const pauses = command.action === 'pause'
    ? [...previous.filter(value => canonicalJson(value) !== key), scope]
    : previous.filter(value => canonicalJson(value) !== key)
  pauses.sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)))
  return settledControlState(state, operation, pauses, { status: 'applied' }, now)
}

export async function assertRunControls(state: Pick<RunState, 'controls' | 'rootRunId' | 'runId'>): Promise<void> {
  const controls = state.controls
  if (controls === undefined) return
  const receipt = controls.lastReceipt
  if (!Number.isSafeInteger(controls.revision) || controls.revision < 1 || receipt.revision !== controls.revision
    || receipt.auditId !== state.rootRunId || receipt.executionId !== state.runId
    || !Number.isFinite(Date.parse(receipt.settledAt))
    || !['applied', 'rejected'].includes(receipt.outcome?.status)
    || (receipt.outcome.status !== 'applied' && (!/^[a-z][a-z0-9-]{0,99}$/.test(receipt.outcome.detail?.code)
      || typeof receipt.outcome.detail.message !== 'string' || receipt.outcome.detail.message.length > 2000))
    || ![receipt.commandDigest, receipt.previousStateDigest, receipt.pausesDigest].every(value => /^[a-f0-9]{64}$/.test(value))
    || !Array.isArray(controls.pauses) || await sha256(controls.pauses) !== receipt.pausesDigest) {
    throw new Error('run control receipt is invalid')
  }
  if (Object.hasOwn(receipt, 'validation')) throw new Error('output acceptance belongs to its historical app version')
  const keys = controls.pauses.map(scope => {
    parseRunCommand({ id: receipt.commandId, expectedRevision: controls.revision - 1,
      reason: 'validate persisted admission scope', action: 'pause', scope })
    if (canonicalJson(scope) !== canonicalJson(normalized(scope))) throw new Error('run control scope is not canonical')
    return canonicalJson(scope)
  })
  if (new Set(keys).size !== keys.length) throw new Error('run control repeats a paused scope')
}

/** Shared live/replay invariant: a non-applied decision preserves every hold. */
export async function assertControlTransition(previous: RunControlState | undefined, next: RunControlState,
  identity: Pick<RunState, 'rootRunId' | 'runId'>, at: string): Promise<void> {
  await assertRunControls({ ...identity, controls: next })
  if (next.revision !== (previous?.revision ?? 0) + 1 || next.lastReceipt.settledAt !== at) {
    throw new Error('run control settlement order or time differs')
  }
  if (next.lastReceipt.outcome.status !== 'applied'
    && canonicalJson(next.pauses) !== canonicalJson(previous?.pauses ?? [])) {
    throw new Error('non-applied run control changed admission pauses')
  }
}

/** Internal evidence from native custody reconciliation, never a public assertion. */
export interface AuditCancellationProof {
  inventoryDigest: string
  proofDigest: string
  physicalZeroVerified: true
  claimsSettled: true
}
export interface AuditCancellationEffect extends AuditCancellationProof {
  command: import('./run-commands.js').RunCommand
  source: RunCommandSource
  abandonedAttempts: readonly InFlightAgentAttempt[]
  previousStatus: 'running' | 'failed'
  previousPhase: RunPhase
  previousTerminalReason: string | null
  interruptedUsageComplete: false
}

/** A canceled run retains its admitted frontier and every accepted outcome. Only
 * outstanding attempts are abandoned, not reported as successful completions. */
export async function auditCancellationEffect(state: RunState, operation: RunOperation,
  proof: AuditCancellationProof): Promise<AuditCancellationEffect> {
  const command = parseRunCommand(operation.command)
  if (command.action !== 'cancel' || (state.status !== 'running' && state.status !== 'failed')
    || operation.source === undefined || operation.nativeEffect?.kind !== 'revoke-admission'
    || canonicalJson(operation.source.authority) !== canonicalJson(state.executionAuthority)
    || !Number.isSafeInteger(operation.source.state.generation) || operation.source.state.generation < 1
    || operation.source.state.generation > state.stateGeneration
    || operation.source.state.generation === state.stateGeneration && operation.source.state.digest !== await sha256(state)
    || !/^[a-f0-9]{64}$/.test(operation.source.state.digest)
    || operation.nativeEffect.inventoryDigest !== proof.inventoryDigest
    || ![proof.inventoryDigest, proof.proofDigest].every(value => /^[a-f0-9]{64}$/.test(value))
    || proof.physicalZeroVerified !== true || proof.claimsSettled !== true) {
    throw new Error('audit cancellation lacks its settled native evidence')
  }
  return { command, source: deepClone(operation.source), inventoryDigest: proof.inventoryDigest,
    proofDigest: proof.proofDigest, physicalZeroVerified: true, claimsSettled: true,
    abandonedAttempts: deepClone(state.inFlightAgentAttempts ?? []), previousStatus: state.status, previousPhase: state.phase,
    previousTerminalReason: state.terminalReason, interruptedUsageComplete: false }
}

/** Verify the terminal transition against its exact predecessor, including paid
 * outputs and usage. The physical proof itself remains in the custody archive. */
export async function assertAuditCancellation(state: RunState): Promise<void> {
  const events = state.journal.filter(event => event.type === 'run.cancelled')
  if (events.length === 0) return
  const event = events[0]!, following = state.journal.at(-1)
  if (events.length !== 1 || state.journal.at(-2) !== event || following?.type !== 'run.control-settled'
    || following.at !== event.at || state.status !== 'stopped' || state.phase !== 'stopped'
    || state.updatedAt !== event.at || (state.inFlightAgentAttempts?.length ?? 0) !== 0) {
    throw new Error('audit cancellation is not the terminal control transition')
  }
  const effect = event.payload as AuditCancellationEffect
  const command = parseRunCommand(effect.command), controls = following.payload as RunControlState
  if (command.action !== 'cancel' || command.scope.kind !== 'audit' || state.terminalReason !== command.reason
    || effect.interruptedUsageComplete !== false || !Array.isArray(effect.abandonedAttempts)
    || canonicalJson(state.controls) !== canonicalJson(controls) || controls.lastReceipt.outcome.status !== 'applied'
    || controls.lastReceipt.commandId !== command.id || controls.lastReceipt.commandDigest !== await sha256(command)
    || controls.revision !== command.expectedRevision + 1) throw new Error('audit cancellation receipt differs')
  const journal = state.journal.slice(0, -2)
  const previousControls = journal.findLast(value => value.type === 'run.control-settled')?.payload as RunControlState | undefined
  if (canonicalJson(controls.pauses) !== canonicalJson(previousControls?.pauses ?? [])) {
    throw new Error('audit cancellation changed admission pauses')
  }
  const { controls: _controls, ...base } = state
  const previous: RunState = { ...base, status: effect.previousStatus, phase: effect.previousPhase,
    terminalReason: effect.previousTerminalReason, inFlightAgentAttempts: deepClone(effect.abandonedAttempts),
    journal, stateGeneration: state.stateGeneration - 2, updatedAt: journal.at(-1)?.at ?? state.createdAt,
    ...(previousControls === undefined ? {} : { controls: previousControls }) }
  if (await sha256(previous) !== controls.lastReceipt.previousStateDigest) {
    throw new Error('audit cancellation changed its preserved predecessor')
  }
  const expected = await auditCancellationEffect(previous, { auditId: state.rootRunId,
    command, commandDigest: controls.lastReceipt.commandDigest, source: effect.source,
    nativeEffect: { kind: 'revoke-admission', inventoryDigest: effect.inventoryDigest },
    revision: controls.revision, version: 1, status: 'applying', acceptedAt: event.at, updatedAt: event.at }, effect)
  if (canonicalJson(effect) !== canonicalJson(expected)) throw new Error('audit cancellation evidence differs')
}
