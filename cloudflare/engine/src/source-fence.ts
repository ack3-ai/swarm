import type { ExecutionAuthority } from './execution-authority.js'
import { canonicalJson } from './canonical.js'

/** Source-version attestation of a permanent retirement decision. */
export interface SourceFence {
  authority: ExecutionAuthority
  /** Cancellation command digest, or the verified failed-retirement proof digest. */
  commandDigest: string
  proofDigest: string
}

/** Keep the source retired through admission and activation, even if its export
 * was prepared earlier. This checks ownership, not a historical record format. */
export function sourceFenceWitness(saved: SourceFence | undefined, first: number) {
  const p = (offset: number) => `?${first + offset}`
  return { sql: `(${p(0)} IS NULL OR EXISTS (SELECT 1 FROM audit_execution_authority owner
    WHERE owner.authority_json = ${p(0)} AND owner.status = 'retired'
      AND owner.fence_command_digest = ${p(1)} AND owner.retirement_digest = ${p(2)}
      AND NOT EXISTS (SELECT 1 FROM audit_execution_launches launch
        WHERE launch.audit_id = owner.audit_id AND launch.epoch = owner.epoch AND launch.receipt_digest IS NULL)))`,
    values: [saved === undefined ? null : canonicalJson(saved.authority), saved?.commandDigest ?? null, saved?.proofDigest ?? null] }
}
