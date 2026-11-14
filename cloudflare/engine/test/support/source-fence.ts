import type { RunState } from '../../src/contracts.js'
import type { SourceFence } from '../../src/source-fence.js'

/** Pure state tests supply a source-version-verified native retirement. */
export function syntheticSourceFence(source: RunState): SourceFence {
  if (source.executionAuthority === undefined) throw new Error('fixture requires control authority')
  return { authority: source.executionAuthority, commandDigest: 'd'.repeat(64), proofDigest: 'e'.repeat(64) }
}
