import { sha256 } from '../../src/canonical.js'
import { RunMachine } from '../../src/machine.js'
import { savedWork } from '../../src/saved-work.js'
import type { prepareStageForkSource } from '../../src/stage-fork-source.js'

/** Source-version export and content-addressed memory archive for fork tests. */
export async function forkWithSavedWork(prepared: Awaited<ReturnType<typeof prepareStageForkSource>>,
  ...args: Parameters<typeof RunMachine.fork> extends [unknown, ...infer Tail] ? Tail : never) {
  const exported = structuredClone(savedWork(prepared)), savedWorkDigest = await sha256(exported)
  const load = args[3], previous = load.readSavedWork
  load.readSavedWork = async digest => {
    if (digest === savedWorkDigest) return structuredClone(exported)
    if (previous !== undefined) return previous(digest)
    throw new Error('missing saved-work export')
  }
  return RunMachine.fork({ ...exported, release: prepared.release, savedWorkDigest }, ...args)
}
