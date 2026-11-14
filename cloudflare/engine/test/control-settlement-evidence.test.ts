import { createControlledMachine } from './support/controlled-machine.js'
import { expect, it } from 'vitest'
import { RunMachine } from '../src/machine.js'
import { sha256 } from '../src/canonical.js'
import { sealReleasePackage } from '../src/release.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { restoreSelected } from './support/selected-snapshots.js'
import type { RunCommand } from '../src/run-commands.js'

async function fixture() {
  const release = await sealReleasePackage(audit0PackageBody), id = 'settlement-evidence'
  const machine = await createControlledMachine(release.body.definition, release.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  await machine.start()
  const operation = async (command: RunCommand) => ({ auditId: id, revision: command.expectedRevision + 1,
    version: 2, command, commandDigest: await sha256(command), status: 'applying' as const,
    acceptedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  await machine.applyAdmissionControl(await operation({ id: 'pause', expectedRevision: 0, action: 'pause',
    scope: { kind: 'audit' }, reason: 'synthetic pause' }))
  await machine.rejectControl(await operation({ id: 'missing-pool', expectedRevision: 1, action: 'pause',
    scope: { kind: 'pool', poolId: 'unconfigured-pool' }, reason: 'synthetic invalid scope' }),
  { code: 'scope-unavailable', message: 'synthetic refusal' })
  await machine.seal()
  return { machine, state: machine.snapshot() }
}

it.each(['unchanged', 'unpause', 'jump-revision', 'receipt-time'] as const)(
  'preserves rejected command settlement through selected reload: %s', async corruption => {
    const f = await fixture()
    expect(f.state.controls!.revision).toBe(2)
    expect(f.state.controls!.pauses).toHaveLength(1)
    const controls = f.state.controls!
    if (corruption === 'unpause') { controls.pauses = []; controls.lastReceipt.pausesDigest = await sha256([]) }
    if (corruption === 'jump-revision') { controls.revision++; controls.lastReceipt.revision++ }
    if (corruption === 'receipt-time') controls.lastReceipt.settledAt = '2025-01-01T00:00:00.000Z'
    const event = f.state.journal.filter(event => event.type === 'run.control-settled').at(-1)!
    event.payload = structuredClone(controls)
    let previous: string | null = null
    for (const event of f.state.journal) {
      event.previousDigest = previous
      const { digest: _, ...unsigned } = event
      event.digest = await sha256(unsigned); previous = event.digest
    }
    if (corruption === 'unchanged') expect((await restoreSelected(f.machine, f.state)).view()).toEqual(f.state)
    else await expect(restoreSelected(f.machine, f.state)).rejects.toThrow('no matching state selection')
  },
)
