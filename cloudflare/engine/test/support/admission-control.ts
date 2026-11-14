import type { RunMachine } from '../../src/machine.js'
import { sha256 } from '../../src/canonical.js'

/** Exercise the real admission-control transition without a Cloudflare delivery fixture. */
export async function admissionControl(machine: RunMachine, action: 'pause' | 'continue'): Promise<void> {
  const state = machine.view(), revision = (state.controls?.revision ?? 0) + 1
  const command = { id: `${action}-${revision}`, expectedRevision: revision - 1, reason: 'test admission control',
    action, scope: { kind: 'audit' as const } }
  const now = new Date().toISOString()
  await machine.applyAdmissionControl({ auditId: state.rootRunId, revision, version: 1,
    command, commandDigest: await sha256(command), status: 'applying', acceptedAt: now, updatedAt: now })
}

export function pauseWhen(machine: RunMachine, predicate: () => boolean) {
  return async () => {
    if (predicate() && !machine.view().controls?.pauses.length) await admissionControl(machine, 'pause')
    return true
  }
}
