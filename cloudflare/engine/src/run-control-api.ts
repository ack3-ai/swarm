import type { RunControlDeliveryMarker } from './run-control-delivery.js'
import { sha256 } from './canonical.js'
import type { CloudflareRunStore } from './cloudflare-storage.js'
import { ExecutionAuthorityStore } from './execution-authority.js'
import { RunCommandJournal } from './run-command-journal.js'
import { parseRunCommand, RunCommandConflict, RunCommandRejected } from './run-commands.js'
import { assertControlScope } from './run-control-state.js'
import { blockedTasks } from './execution-failures.js'

/** Invoked only behind the existing authenticated front door/coordinator boundary. */
export async function runControlResponse(request: Request, store: CloudflareRunStore, index: D1Database,
  experimentId: string, auditId: string, commandId?: string,
  deliver?: (marker: RunControlDeliveryMarker) => Promise<void>, exportSource?: (command: import('./run-commands.js').StageForkCommand) => Promise<string>): Promise<Response> {
  await store.ensureSchema()
  try {
    const command = request.method === 'POST' && commandId === undefined ? parseRunCommand(await request.json()) : undefined
    const journal = new RunCommandJournal(index, auditId)
    if (command?.action === 'fork') {
      const existing = await journal.get(command.id)
      const commandDigest = await sha256(command)
      if (existing !== null && existing.commandDigest !== commandDigest) throw new RunCommandConflict('idempotency-conflict', 'command id has different content')
      if (deliver === undefined) throw new RunCommandRejected('delivery-unavailable', 'fork requires durable command delivery')
      const operation = await store.admitStageFork(auditId, command, undefined, () => deliver({
        schemaVersion: 1, kind: 'fork', experimentId, auditId, commandId: command.id,
        commandDigest, expectedRevision: command.expectedRevision, source: command.source,
      }), source => {
        if (source.experimentId !== experimentId
          || (source.executionAuthority === undefined ? source.runId : source.rootRunId) !== auditId) throw new RunCommandRejected('fork-source-not-found', 'audit not found')
        if (!['completed', 'failed', 'stopped'].includes(source.status)) {
          throw new RunCommandRejected('fork-source-lifecycle', 'fork requires a completed or retired failed or stopped source')
        }
      }, exportSource)
      return Response.json(operation, { status: ['applied', 'rejected', 'failed'].includes(operation.status) ? 200 : 202 })
    }
    const authority = await new ExecutionAuthorityStore(index).current(auditId)
    if (authority === null) {
      return Response.json({ error: 'audit has no control-system execution authority' }, { status: 409 })
    }
    const state = await store.getStateIfPresent(authority.executionId)
    if (state === null) return Response.json({ error: 'audit state is not materialized yet' }, { status: 409 })
    if (state.rootRunId !== auditId || state.experimentId !== experimentId) return Response.json({ error: 'audit not found' }, { status: 404 })
    if (request.method === 'GET') {
      if (commandId !== undefined) {
        const operation = await journal.get(commandId)
        return operation === null ? Response.json({ error: 'command not found' }, { status: 404 }) : Response.json(operation)
      }
      return Response.json({ auditId, executionId: state.runId, revision: await journal.revision(),
        stateReference: { runId: state.runId, state: { generation: state.stateGeneration, digest: await sha256(state) } },
        settledRevision: state.controls?.revision ?? 0, lastOutcome: state.controls?.lastReceipt.outcome ?? null, pauses: state.controls?.pauses ?? [],
        inFlight: state.inFlightAgentAttempts?.length ?? 0, status: state.status, blockedTasks: blockedTasks(state) })
    }
    if (command === undefined) return Response.json({ error: 'method not allowed' }, { status: 405 })
    const existing = await journal.get(command.id)
    if (existing !== null) {
      if (existing.commandDigest !== await sha256(command)) throw new RunCommandConflict('idempotency-conflict', 'command id has different content')
      await deliver?.({ schemaVersion: 1, experimentId, auditId, commandId: command.id,
        commandDigest: existing.commandDigest, expectedRevision: command.expectedRevision, authority: existing.admittedAuthority! })
      return Response.json(existing, { status: ['applied', 'rejected', 'failed'].includes(existing.status) ? 200 : 202 })
    }
    if (!(state.status === 'running' || state.status === 'failed' && command.action === 'cancel')) {
      return Response.json({ error: 'audit lifecycle does not permit this command' }, { status: 409 })
    }
    await new ExecutionAuthorityStore(index).assertActive(authority)
    if (command.action === 'cancel' && state.runtimeRelease === undefined) {
      return Response.json({ error: 'native cancellation requires a pinned runtime' }, { status: 422 })
    }
    const definition = (await store.getRelease(state.releaseDigest)).body.definition
    assertControlScope(definition, command.scope)
    // The revision only grows, so a mismatch now means admission can never succeed; a marker
    // for an expectedRevision above it would be retried until the audit ends (E18).
    const revision = await journal.revision()
    if (revision !== command.expectedRevision) throw new RunCommandConflict('revision-conflict', `audit control revision changed: ${revision}`)
    await deliver?.({ schemaVersion: 1, experimentId, auditId, commandId: command.id,
      commandDigest: await sha256(command), expectedRevision: command.expectedRevision, authority })
    return Response.json(await journal.admit(command, authority), { status: 202 })
  } catch (error) {
    if (error instanceof TypeError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 })
    if (error instanceof RunCommandConflict) return Response.json({ error: error.message, code: error.code }, { status: 409 })
    if (error instanceof RunCommandRejected) return Response.json({ error: error.message, code: error.code }, {
      status: error.code === 'fork-source-not-found' ? 404 : error.code === 'fork-source-lifecycle' ? 409
        : error.code === 'scope-unavailable' ? 400 : 422,
    })
    throw error
  }
}
