import { RunMachine } from '../../src/machine.js'
import { sha256 } from '../../src/canonical.js'

/** Current test audits use the same explicit ownership as production roots. */
export async function createControlledMachine(...args: Parameters<typeof RunMachine.create>): Promise<RunMachine> {
  const [definition, release, runId, now, runtime, supplied] = args
  const authority = supplied ?? { auditId: runId, executionId: runId, epoch: 0, runtimeDigest: await sha256(runtime ?? null) }
  return RunMachine.create(definition, release, runId, now, runtime, authority)
}

/** Machine-only fixture with synthetic settled custody; never evidence of a native shutdown. */
export async function cancelControlledMachine(machine: RunMachine, reason: string): Promise<void> {
  const state = machine.view(), command = { id: 'fixture-cancel', action: 'cancel' as const,
    scope: { kind: 'audit' as const }, expectedRevision: state.controls?.revision ?? 0, reason }
  const proof = { inventoryDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64),
    physicalZeroVerified: true as const, claimsSettled: true as const }
  await machine.cancelAudit({ auditId: state.rootRunId, revision: command.expectedRevision + 1,
    version: 3, acceptedAt: state.updatedAt, updatedAt: state.updatedAt, command, commandDigest: await sha256(command), status: 'applying',
    source: { authority: state.executionAuthority!, state: { generation: state.stateGeneration, digest: await sha256(state) } },
    nativeEffect: { kind: 'revoke-admission', inventoryDigest: proof.inventoryDigest },
  }, proof)
}
