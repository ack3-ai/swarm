import { createControlledMachine } from './support/controlled-machine.js'
import { expect, it, vi } from 'vitest'
import { sha256 } from '../src/canonical.js'
import { executionConfiguration } from '../src/artifact-execution.js'
import { ExecutionReleases } from '../src/execution-releases.js'
import { sealReleasePackage } from '../src/release.js'
import { RunMachine } from '../src/machine.js'
import { audit0PackageBody } from './support/audit0-config.js'

async function releases() { return { old: await sealReleasePackage(structuredClone(audit0PackageBody)) } }

it('reconstructs the frozen peer assignment before verifying the dispatched task digest', async () => {
  const { old } = await releases(), definition = old.body.definition
  const machine = await createControlledMachine(definition, old.digest, 'peer-contract')
  const resolver = await ExecutionReleases.create(definition, machine.snapshot())
  const stage = definition.stages.find(stage => stage.kind === 'discovery')!, wave = stage.waves[1]!
  const task = wave.tasks.find(task => task.research !== undefined)!
  const peer = 'wave-0/research-2'
  const dispatched = { ...task, research: { ...task.research!, buildsOn: peer } }
  const location = { stageId: stage.id, waveId: wave.id, taskId: task.id }
  const reference = executionConfiguration(machine.view())
  expect(await resolver.task(reference, location, await sha256(dispatched), peer)).toEqual(dispatched)
  await expect(resolver.task(reference, location, await sha256(dispatched), 'none')).rejects.toThrow('task digest')
  await expect(resolver.task(reference, { ...location, taskId: 'missing' })).rejects.toThrow('outside')
})


it('uses one immutable manifest and protects resolved definitions from caller mutation', async () => {
  const { old } = await releases()
  const machine = await createControlledMachine(old.body.definition, old.digest, 'release-cache')
  const reference = executionConfiguration(machine.view())
  const resolver = await ExecutionReleases.create(old.body.definition, machine.snapshot())
  const [left, right] = await Promise.all([resolver.definition(reference), resolver.definition(reference)])
  left.id = 'mutated-return'
  expect(right.id).toBe(old.body.definition.id)
  expect((await resolver.definition(reference)).id).toBe(old.body.definition.id)
})

it('rejects unauthorized configuration without fetching it', async () => {
  const { old } = await releases()
  const machine = await createControlledMachine(old.body.definition, old.digest, 'release-authorization')
  const load = vi.fn(async () => { throw new Error('unauthorized read') })
  const resolver = await ExecutionReleases.create(old.body.definition, machine.snapshot(), load)
  await expect(resolver.definition({ ...executionConfiguration(machine.view()), releaseDigest: 'f'.repeat(64) })).rejects.toThrow()
  expect(load).not.toHaveBeenCalled()
})
