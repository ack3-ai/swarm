import { createControlledMachine } from './support/controlled-machine.js'
import { expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import type { JournalEvent, RunState, WaveReceipt } from '../src/contracts.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { verifiedJournalPrefix } from '../src/execution-journal.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { sealReleasePackage } from '../src/release.js'
import { AgentExecutionPending } from '../src/run-errors.js'
import { audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

async function fixture(delayed = false) {
  const packaged = await sealReleasePackage(audit0PackageBody), id = 'progress-evidence'
  const machine = await createControlledMachine(packaged.body.definition, packaged.digest, id, undefined, undefined,
    { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(null) })
  const base = new DeterministicAuditProvider(), store = new MemoryArtifactStore()
  let hold = delayed
  const participants = machine.definition.stages.find(stage => stage.kind === 'discovery')!.waves[0]!.tasks.length
  let arrived = 0, release!: () => void
  const together = new Promise<void>(resolve => { release = resolve })
  const provider = { async run(request: Parameters<typeof base.run>[0]) {
    if (hold && request.task.providerClass === 'additive') throw new AgentExecutionPending(request.task.id)
    if (!delayed && request.task.research?.wave === 0) {
      if (++arrived === participants) release()
      await together
    }
    return base.run(request)
  } }
  await advanceExperimentOneWave({ definition: machine.definition, machine, provider, artifactStore: store })
  await advanceExperimentOneWave({ definition: machine.definition, machine, provider, artifactStore: store })
  if (delayed) {
    expect(machine.view().discoveryScheduler!.admissions.length).toBeGreaterThan(0)
    await restoreSelected(machine, machine.view())
    hold = false
    await advanceExperimentOneWave({ definition: machine.definition, machine, provider, artifactStore: store })
  }
  return { machine, state: machine.snapshot(), definition: machine.definition }
}
async function rehash(state: RunState) {
  let previousDigest: string | null = null
  const journal: JournalEvent[] = []
  for (let sequence = 0; sequence < state.journal.length; sequence++) {
    const { digest: _digest, ...entry } = state.journal[sequence]!
    const unsigned = { ...entry, sequence, previousDigest }
    const digest = await sha256(unsigned)
    journal.push({ ...unsigned, digest }); previousDigest = digest
  }
  state.journal = journal
}
function changeReceipt(state: RunState, mutate: (receipt: WaveReceipt) => void) {
  const receipt = state.waveReceipts.find(receipt => receipt.coalescedWith !== undefined)!
  expect(receipt).toBeDefined()
  const original = canonicalJson(receipt)
  const event = state.journal.find(event => event.type === 'discovery.cohort-completed'
    && canonicalJson(event.payload) === original)!
  mutate(receipt)
  event.payload = structuredClone(receipt)
}

it.each([false, true])('restores selected simultaneous or delayed knowledge updates (delayed=%s)', async delayed => {
  const f = await fixture(delayed)
  await restoreSelected(f.machine, f.state)
  expect(f.state.waveReceipts.filter(receipt => receipt.poolId !== undefined)
    .every(receipt => Number.isSafeInteger(receipt.materialEpochAfter))).toBe(true)
  if (!delayed) expect(f.state.waveReceipts.some(receipt => receipt.coalescedWith !== undefined)).toBe(true)
  const before = f.machine.snapshot()
  await restoreSelected(f.machine, f.machine.view())
  expect(f.machine.snapshot()).toEqual(before)
})

it.each(['epoch', 'coalescing-reference', 'missing-epoch', 'quiet-counter', 'artifact-membership'] as const)(
  'rejects rehashed but inconsistent discovery evidence: %s', async corruption => {
    const f = await fixture(), state = structuredClone(f.state)
    if (corruption === 'epoch') changeReceipt(state, receipt => { receipt.materialEpochAfter!++ })
    if (corruption === 'coalescing-reference') changeReceipt(state, receipt => { receipt.coalescedWith = 'f'.repeat(64) })
    if (corruption === 'missing-epoch') changeReceipt(state, receipt => { delete receipt.materialEpochAfter })
    if (corruption === 'quiet-counter') state.discoveryScheduler!.pools[0]!.quietCohorts++
    if (corruption === 'artifact-membership') changeReceipt(state, receipt => { receipt.artifactRefs = [] })
    await rehash(state)
    await expect(restoreSelected(f.machine, state)).rejects.toThrow('no matching state selection')
  },
)

it('validates only the requested journal prefix and rejects broken or unknown prefixes', async () => {
  const f = await fixture(), journal = structuredClone(f.state.journal)
  const first = journal[0]!
  journal.at(-1)!.previousDigest = 'f'.repeat(64)
  expect(await verifiedJournalPrefix(journal, first.digest)).toEqual([first])
  await expect(verifiedJournalPrefix(journal)).rejects.toThrow('journal chain')
  await expect(verifiedJournalPrefix(journal, 'e'.repeat(64))).rejects.toThrow('head is missing')
  const altered: JournalEvent[] = [{ ...first, payload: {} }]
  await expect(verifiedJournalPrefix(altered)).rejects.toThrow('digest mismatch')
})
