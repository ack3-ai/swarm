import { canonicalJson, deepClone, sha256 } from './canonical.js'
import type { ExperimentDefinition, RunState, TaskDefinition } from './contracts.js'
import { parseRunCommand, RunCommandRejected, type RunCommandScope } from './run-commands.js'
import type { RunOperation } from './run-command-journal.js'
import { configuredResearchTaskPoolId } from './research-scheduler.js'

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
  | { status: 'failed'; detail: { code: string; message: string } }
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

export function assertControlScope(definition: ExperimentDefinition, scope: RunCommandScope,
  existingPauses: readonly RunCommandScope[] = []): void {
  // A removed pool may still have a persisted hold. Explicit continue must be
  // able to remove that exact hold without clearing any broader/narrower scope.
  if (existingPauses.some(paused => canonicalJson(normalized(paused)) === canonicalJson(normalized(scope)))) return
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
    return deepClone(state.controls)
  }
  if (state.executionAuthority === undefined
    || !(state.status === 'running' || state.status === 'failed' && outcome.status === 'rejected')
    || (state.controls?.revision ?? 0) !== command.expectedRevision) throw new Error('command cannot apply at this audit revision or lifecycle')
  const result = { revision: operation.revision, pauses: deepClone(pauses), lastReceipt: {
    auditId: state.rootRunId, executionId: state.runId, revision: operation.revision,
    commandId: command.id, commandDigest: operation.commandDigest,
    previousStateDigest: await sha256(state), pausesDigest: await sha256(pauses), settledAt: now, outcome: deepClone(outcome),
  } }
  await assertControlTransition(state.controls, result, state, now)
  return result
}

export async function applyAdmissionControl(definition: ExperimentDefinition, state: RunState,
  operation: RunOperation, now: string): Promise<RunControlState> {
  const command = parseRunCommand(operation.command)
  if (command.action !== 'pause' && command.action !== 'continue') throw new TypeError('command requires its execution transition')
  if (state.controls?.revision === operation.revision) return settledControlState(state, operation,
    state.controls.pauses, { status: 'applied' }, now)
  assertControlScope(definition, command.scope, command.action === 'continue' ? state.controls?.pauses : [])
  const scope = normalized(command.scope), key = canonicalJson(scope)
  const previous = state.controls?.pauses ?? []
  const pauses = command.action === 'pause'
    ? [...previous.filter(value => canonicalJson(value) !== key), scope]
    : previous.filter(value => canonicalJson(value) !== key)
  pauses.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  return settledControlState(state, operation, pauses, { status: 'applied' }, now)
}

export async function assertRunControls(state: Pick<RunState, 'controls' | 'rootRunId' | 'runId'>): Promise<void> {
  const controls = state.controls
  if (controls === undefined) return
  const receipt = controls.lastReceipt
  if (!Number.isSafeInteger(controls.revision) || controls.revision < 1 || receipt.revision !== controls.revision
    || receipt.auditId !== state.rootRunId || receipt.executionId !== state.runId
    || !Number.isFinite(Date.parse(receipt.settledAt))
    || !['applied', 'rejected', 'failed'].includes(receipt.outcome?.status)
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

