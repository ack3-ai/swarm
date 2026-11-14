import { canonicalJson, sha256 } from './canonical.js'
import type { RunState } from './contracts.js'
import type { RunMachine } from './machine.js'
import type { RunCommandJournal, RunOperation } from './run-command-journal.js'
import { TransientRunFailure } from './run-errors.js'
import { RunCommandRejected } from './run-commands.js'
import type { CommandCustodyCollector } from './command-custody.js'

async function acknowledge(state: RunState, journal: RunCommandJournal, operation: RunOperation) {
  const receipt = state.controls?.lastReceipt
  if (receipt === undefined || receipt.revision !== operation.revision || receipt.commandDigest !== operation.commandDigest) {
    throw new Error('control operation differs from its persisted effect')
  }
  if (operation.fork !== undefined) throw new Error('fork publication cannot acknowledge an admission control')
  const receiptDigest = await sha256(receipt)
  const { outcome } = receipt
  if (operation.status === 'applied' || operation.status === 'rejected') {
    if (operation.status !== outcome.status || operation.receiptDigest !== receiptDigest
      || (outcome.status === 'rejected' && canonicalJson(operation.detail) !== canonicalJson(outcome.detail))) {
      throw new Error('control effect acknowledgement differs')
    }
    return true
  }
  await journal.advance(operation.command.id, operation.version, { status: outcome.status, receiptDigest,
    ...(outcome.status === 'rejected' ? { detail: outcome.detail } : {}) })
  return true
}

/** Terminal cleanup resolves decisions that lost the race with audit failure/stop. GET never does this. */
export async function settleTerminalAdmissionControls(state: RunState, journal: RunCommandJournal): Promise<void> {
  if (state.executionAuthority === undefined || !['completed', 'stopped'].includes(state.status)) return
  let cursor = state.controls?.revision ?? 0, mutations = 0
  if (cursor > 0) {
    const last = await journal.atRevision(cursor)
    if (last === null) throw new Error('persisted control decision is missing')
    await acknowledge(state, journal, last)
  }
  for (;;) {
    const operation = await journal.atRevision(++cursor)
    if (operation === null) return
    // Fork publication belongs to the child; parent cleanup cannot settle it.
    if (operation.fork !== undefined || ['rejected', 'failed'].includes(operation.status)) continue
    if (operation.nativeEffect !== undefined) throw new TransientRunFailure('native command requires its terminal settlement')
    if (++mutations > 32) throw new TransientRunFailure('terminal command reconciliation has more pending decisions')
    await journal.advance(operation.command.id, operation.version, {
      status: operation.status === 'applying' ? 'failed' : 'rejected',
      detail: { code: 'audit-terminal', message: `Audit became ${state.status} before this admission control took effect` },
    })
  }
}

/** One CAS reconciler shared by Workflow and bounded pinned-runtime command delivery. */
export async function reconcileRunControls(input: {
  machine: RunMachine
  journal: RunCommandJournal
  persist: (state: RunState) => Promise<void>
  native?: Pick<CommandCustodyCollector, 'settleExecutionStop' | 'acknowledgeCancellation'>
}): Promise<boolean> {
  const { machine, journal, persist } = input
  if (machine.view().status !== 'running' && machine.view().status !== 'failed') {
    if (machine.view().journal.at(-2)?.type === 'run.cancelled') {
      if (input.native === undefined) throw new TransientRunFailure('cancellation custody reconciler is unavailable')
      await input.native.acknowledgeCancellation(machine.view())
    }
    await settleTerminalAdmissionControls(machine.view(), journal)
    return false
  }
  const cursor = machine.view().controls?.revision ?? 0
  if (cursor > 0) {
    const last = await journal.atRevision(cursor)
    if (last === null) throw new Error('persisted control decision is missing')
    await acknowledge(machine.view(), journal, last)
  }
  // Bound a polling slice. Admission CAS refuses work if another decision remains.
  for (let count = 0; count < 32; count++) {
    let operation = await journal.atRevision((machine.view().controls?.revision ?? 0) + 1)
    if (operation === null) return machine.view().status === 'running'
    // A quiescent source stays frozen while its child owns fork publication.
    if (operation.fork !== undefined) return false
    try {
      if (operation.command.action === 'cancel') {
        if (input.native === undefined) throw new TransientRunFailure('cancellation custody reconciler is unavailable')
        if (operation.nativeEffect === undefined) {
          await persist(machine.view())
          operation = await journal.beginEffect(operation.command.id, operation.version, machine.view())
        }
        const stopped = await input.native.settleExecutionStop(operation.auditId, operation.command.id)
        if (!stopped.physicalZeroVerified || !stopped.claimsSettled) return false
        await machine.cancelAudit(stopped.operation, stopped)
        await persist(machine.view())
        await input.native.acknowledgeCancellation(machine.view())
        return false
      }
      if (machine.view().status === 'failed' && operation.nativeEffect !== undefined) {
        throw new TransientRunFailure('failed audit has unsettled native control intent')
      }
      if (operation.status === 'accepted') {
        operation = await journal.advance(operation.command.id, operation.version, { status: 'applying' })
      }
      if (machine.view().status === 'failed') throw new RunCommandRejected('audit-terminal',
        'Audit failed before this decision took effect')
      await machine.applyAdmissionControl(operation)
    } catch (cause) {
      if (operation.command.action === 'cancel') {
        // A native RPC may already have applied. Only a proved rejection before
        // native intent can use ordinary decision settlement.
        const latest = await journal.get(operation.command.id).catch(() => null)
        if (!(cause instanceof RunCommandRejected) || latest === null || latest.nativeEffect !== undefined) {
          throw new TransientRunFailure('native execution control reconciliation remains incomplete', { cause })
        }
        operation = latest.status === 'applying' ? latest
          : await journal.advance(latest.command.id, latest.version, { status: 'applying' })
      }
      if (!(cause instanceof RunCommandRejected)) throw cause
      await machine.rejectControl(operation, { code: cause.code, message: cause.message })
    }
    await persist(machine.view())
    await acknowledge(machine.view(), journal, operation)
  }
  return false // More commands remain; do not admit work past their revision.
}

/** A native intent owns termination through state selection and its dedicated ACK.
 * A saved control receipt does not, by itself, finish the native operation. */
export async function hasPendingNativeControl(state: RunState, journal: RunCommandJournal): Promise<boolean> {
  if (state.executionAuthority === undefined) return false
  const revision = state.controls?.revision ?? 0
  for (const cursor of revision === 0 ? [1] : [revision, revision + 1]) {
    const operation = await journal.atRevision(cursor)
    if (operation?.nativeEffect !== undefined && operation.status === 'applying'
      && canonicalJson(operation.source?.authority) === canonicalJson(state.executionAuthority)) return true
  }
  return false
}

/** Bookkeeping failure must never prevent attempting custody-preserving native shutdown. */
export async function settleTerminalControlsAndDispose<T>(state: RunState, journal: RunCommandJournal,
  dispose: () => Promise<T>): Promise<T> {
  const [settlement, cleanup] = await Promise.allSettled([
    settleTerminalAdmissionControls(state, journal), Promise.resolve().then(dispose),
  ])
  const failures = [settlement, cleanup].flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new TransientRunFailure('terminal command settlement or native cleanup remains incomplete',
    { cause: new AggregateError(failures, 'terminal reconciliation failed') })
  return (cleanup as PromiseFulfilledResult<T>).value
}
