import type { RuntimeRelease } from './contracts.js'
import type { SavedStateReference } from './run-state-pointer.js'
import { deepClone } from './canonical.js'
import { assertRuntimeRelease } from './runtime-release.js'

/** Select work, not a second representation of its prompts/models/limits. */
export type RunCommandScope =
  | { kind: 'audit' }
  | { kind: 'stage'; stageId: string }
  | { kind: 'pool'; poolId: string }
  | { kind: 'tasks'; taskIds: readonly string[] }

/** Restart boundary only; execution settings stay in the referenced manifest. */
export type ForkBoundary = { stageId: string; checkpointDigest?: never; sourceFrontier?: never }
  | { checkpointDigest: string; stageId?: never; sourceFrontier?: never }
  | { sourceFrontier: true; stageId?: never; checkpointDigest?: never }

export function forkBoundary(value: ForkBoundary): ForkBoundary {
  return value.sourceFrontier === true ? { sourceFrontier: true }
    : value.checkpointDigest === undefined ? { stageId: value.stageId } : { checkpointDigest: value.checkpointDigest }
}

interface CommandIdentity {
  id: string
  /** Revision of operator decisions, independent of ordinary agent progress. */
  expectedRevision: number
  reason: string
}

export type RunCommand = CommandIdentity & (
  | { action: 'pause' | 'continue' | 'cancel'; scope: RunCommandScope }
  | ({ action: 'fork'; source: SavedStateReference; releaseDigest: string; runtimeRelease: RuntimeRelease } & ForkBoundary)
)

export type StageForkCommand = Extract<RunCommand, { action: 'fork' }>

export class RunCommandConflict extends Error {
  override name = 'RunCommandConflict'
  constructor(readonly code: 'idempotency-conflict' | 'revision-conflict' | 'operation-conflict', message: string) {
    super(message)
  }
}

/** A valid decision that cannot apply to the current work, not an I/O failure. */
export class RunCommandRejected extends Error {
  override name = 'RunCommandRejected'
  constructor(readonly code: string, message: string) { super(message) }
}

export function assertControlId(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('command fields are invalid')
  }
}

function digest(value: unknown, label: string): void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} is invalid`)
}

export function assertSavedStateReference(value: unknown): asserts value is SavedStateReference {
  object(value, 'saved state reference'); keys(value, ['runId', 'state'])
  assertControlId(value.runId, 'source run id')
  object(value.state, 'saved state pointer'); keys(value.state, ['generation', 'digest'])
  if (!Number.isSafeInteger(value.state.generation) || Number(value.state.generation) < 1) throw new TypeError('source generation is invalid')
  digest(value.state.digest, 'source state digest')
}

function scope(value: unknown): void {
  object(value, 'command scope')
  switch (value.kind) {
    case 'audit': keys(value, ['kind']); return
    case 'stage': keys(value, ['kind', 'stageId']); assertControlId(value.stageId, 'stage id'); return
    case 'pool': keys(value, ['kind', 'poolId']); assertControlId(value.poolId, 'pool id'); return
    case 'tasks':
      keys(value, ['kind', 'taskIds'])
      if (!Array.isArray(value.taskIds) || value.taskIds.length === 0 || value.taskIds.length > 256
        || new Set(value.taskIds).size !== value.taskIds.length) throw new TypeError('task selection is invalid')
      value.taskIds.forEach(id => assertControlId(id, 'task id'))
      return
    default: throw new TypeError('command scope is invalid')
  }
}

/** Parsing never accepts inline model, prompt, provider or budget overrides. */
export function parseRunCommand(value: unknown): RunCommand {
  object(value, 'command')
  const common = ['id', 'expectedRevision', 'reason', 'action']
  assertControlId(value.id, 'command id')
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0
    || Number(value.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new TypeError('expected revision is invalid')
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0 || value.reason.length > 2000) {
    throw new TypeError('command reason is required and must fit 2000 characters')
  }
  switch (value.action) {
    case 'pause': case 'continue': case 'cancel':
      keys(value, [...common, 'scope']); scope(value.scope); break
    case 'fork':
      keys(value, [...common, 'source', 'releaseDigest', 'runtimeRelease'], ['stageId', 'checkpointDigest', 'sourceFrontier'])
      if (['stageId', 'checkpointDigest', 'sourceFrontier'].filter(key => Object.hasOwn(value, key)).length !== 1) throw new TypeError('fork requires exactly one saved boundary')
      assertSavedStateReference(value.source)
      if (Object.hasOwn(value, 'stageId')) assertControlId(value.stageId, 'stage id')
      else if (Object.hasOwn(value, 'checkpointDigest')) digest(value.checkpointDigest, 'checkpoint digest')
      else if (value.sourceFrontier !== true) throw new TypeError('source frontier selector must be true')
      digest(value.releaseDigest, 'release digest'); assertRuntimeRelease(value.runtimeRelease)
      break
    default: throw new TypeError('command action is invalid')
  }
  return deepClone(value) as unknown as RunCommand
}

/** The only currently installed terminal-state execution decision. */
export function isWholeAuditCancellation(command: RunCommand): boolean {
  return command.action === 'cancel' && command.scope.kind === 'audit'
}
