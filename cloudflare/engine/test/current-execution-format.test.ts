import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { assertCurrentExecutionFormat } from '../src/run-state-pointer.js'
import { checkpointBody } from '../src/checkpoint-body.js'
import { executionConfiguration } from '../src/artifact-execution.js'
import { persistedTerminalTaskFailures } from '../src/execution-failures.js'
import { CloudflareRunStore } from '../src/cloudflare-storage.js'
import { disposeTerminalWorkspaces } from '../src/runner.js'
import { beforeAll, expect, it, vi } from 'vitest'
import { RunMachine } from '../src/machine.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import { runtime, target } from './support/successor-fixture.js'

type Mutation = (state: any) => void
const cases: Array<[string, Mutation]> = []
const historicalFields = ['failedWaveRecovery', 'terminalCompletionRecovery', 'runtimeTransition', 'promotedExecutionProofs', 'configurationHistory']
for (const field of historicalFields) {
  cases.push([field, state => { state[field] = {} }])
}
const event = (type: string, payload: unknown = {}): Mutation => state => {
  state.journal.push({ ...state.journal.at(-1), type, payload })
}
for (const type of ['task.occurrences-restarted', 'task.occurrences-skipped', 'run.configuration-amended',
  'run.executor-replaced', 'run.resumed', 'run.time-amended']) cases.push([type, event(type)])
cases.push(
  ['output artifact', event('task.accepted', { artifact: { acceptance: {} } })],
  ['output event', event('task.accepted', { validation: {}, artifact: {} })],
  ['output receipt', state => { state.controls = { lastReceipt: { validation: {} } } }],
  ['native failure event', event('run.failed', { nativeControl: {} })],
  ['native failure receipt', state => { state.controls = { lastReceipt: { outcome: { status: 'failed' } } } }],
  ['historical failure receipt', event('run.control-settled', { lastReceipt: { outcome: { status: 'failed' } } })],
  ['waiver receipt', state => { state.stageEndReceipts = [{ reason: 'operator-discovery-pool-waiver' }] }],
  ['waiver attempt', state => { state.rejectedAttempts = [{ operatorWaiver: {} }] }],
)
const abandoned = { abandonedTasks: [{ taskId: 'task', taskExecutionId: 'occurrence' }] }
for (const location of ['waveAdmission', 'discoveryScheduler', 'waveReceipts', 'journal']) {
  cases.push([`abandoned ${location}`, state => {
    if (location === 'journal') event('wave.admitted', abandoned)(state)
    else state[location] = location === 'discoveryScheduler' ? { admissions: [abandoned] }
      : location === 'waveReceipts' ? [abandoned] : abandoned
  }])
}

let machine: RunMachine
beforeAll(async () => {
  machine = await createControlledMachine(audit0Definition, 'a'.repeat(64), 'current-format')
  await machine.start(); await machine.seal()
  await expect(restoreSelected(machine, machine.snapshot())).resolves.toBeDefined()
})

it.each(cases)('rejects historical %s consistently before storage, restore, sealing or disposal', async (_name, mutate) => {
  const state = machine.snapshot()
  mutate(state)
  expect(() => assertCurrentExecutionFormat(state)).toThrow('historical app version')
  if (historicalFields.includes(_name)) expect(() => assertCurrentExecutionFormat({
    ...machine.view().checkpoints.at(-1)!.body, [_name]: {},
  })).toThrow('historical app version')
  expect(() => checkpointBody(state, state.updatedAt)).toThrow('historical app version')
  expect(() => persistedTerminalTaskFailures(state)).toThrow('historical app version')
  await expect(restoreSelected(machine, state)).rejects.toThrow('no matching state selection')
  const touched = vi.fn(() => { throw new Error('storage must not be accessed') })
  const forbidden = new Proxy({}, { get: touched })
  const store = new CloudflareRunStore(forbidden as R2Bucket, forbidden as R2Bucket, forbidden as D1Database)
  await expect(store.putState(state)).rejects.toThrow('state must be produced')
  const disposeWorkspace = vi.fn()
  await expect(disposeTerminalWorkspaces({ run: vi.fn(), disposeWorkspace }, audit0Definition,
    { ...state, status: 'failed' })).rejects.toThrow('historical app version')
  expect(touched).not.toHaveBeenCalled()
  expect(disposeWorkspace).not.toHaveBeenCalled()
})

it('requires the manifest image to match the runtime without incident-specific exceptions', () => {
  const body = { ...audit0PackageBody, environment: {
    image: `registry.cloudflare.com/${'0'.repeat(32)}/swarm-sandbox@${runtime.containerImageDigest}` } }
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, runtime)).not.toThrow()
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, { ...target, containerImageDigest: `sha256:${'e'.repeat(64)}` })).toThrow('image does not match')
  expect(() => assertReleaseEnvironmentMatchesRuntime(body, undefined)).toThrow('image does not match')
})

it('rejects historical configuration references without silently selecting their last revision', () => {
  expect(() => executionConfiguration({ releaseDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64),
    configurationHistory: { initial: { releaseDigest: 'a'.repeat(64), definitionDigest: 'b'.repeat(64) }, amendments: [] } } as any))
    .toThrow('historical app version')
})
