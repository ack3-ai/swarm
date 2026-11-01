import { sameRuntimeRelease } from './runtime-release.js'
import type { FailedWaveRecoveryEvidence, ReleasePackageBody, RuntimeRelease } from './contracts.js'

const imagePattern = /^registry\.cloudflare\.com\/[0-9a-f]{32}\/swarm-sandbox@(sha256:[0-9a-f]{64})$/

/** The current runtime can only execute images in its configured swarm-sandbox repository. */
export function requestedEnvironmentImageDigest(image: unknown): string {
  if (typeof image !== 'string') throw new TypeError('environment.image must be an approved immutable OCI image')
  const match = imagePattern.exec(image)
  if (match === null) throw new TypeError('environment.image must be an approved immutable OCI image')
  return match[1]!
}

export function assertReleaseEnvironmentMatchesRuntime(
  body: ReleasePackageBody,
  runtimeRelease: RuntimeRelease | undefined,
  verifiedRecovery?: FailedWaveRecoveryEvidence,
): void {
  if (body.environment === undefined) return
  const imageDigest = requestedEnvironmentImageDigest(body.environment.image)
  // Only custody-verified review repair may cross the original environment pin.
  // Callers must prepare/reconstruct this evidence before admitting work.
  if (runtimeRelease !== undefined && verifiedRecovery?.quarantinedRepair?.kind === 'negative-review'
    && verifiedRecovery.quarantinedRepair.stageId === 'negative-review'
    && verifiedRecovery.promotedExecution === undefined && verifiedRecovery.retainedNative === undefined
    && verifiedRecovery.unobservableNative === undefined
    && verifiedRecovery.sourceRuntimeRelease.containerImageDigest === imageDigest
    && runtimeRelease.containerImageDigest !== imageDigest
    && sameRuntimeRelease(verifiedRecovery.targetRuntimeRelease, runtimeRelease)) return
  const inherited = verifiedRecovery?.sealedWaveRetry?.imageAuthorization
  if (runtimeRelease !== undefined && inherited !== undefined
    && verifiedRecovery !== undefined && verifiedRecovery.quarantinedRepair === undefined
    && verifiedRecovery.promotedExecution === undefined && verifiedRecovery.retainedNative === undefined
    && verifiedRecovery.unobservableNative === undefined
    && /^[0-9a-f]{64}$/.test(verifiedRecovery.sealedWaveRetry!.retirementProofDigest)
    && /^[0-9a-f]{64}$/.test(inherited.sourceRecoveryDigest)
    && inherited.originalImageDigest === imageDigest
    && inherited.authorizedImageDigest !== imageDigest
    && verifiedRecovery.sourceRuntimeRelease.containerImageDigest === inherited.authorizedImageDigest
    && runtimeRelease.containerImageDigest === inherited.authorizedImageDigest
    && sameRuntimeRelease(verifiedRecovery.targetRuntimeRelease, runtimeRelease)) return
  if (runtimeRelease === undefined || runtimeRelease.containerImageDigest !== imageDigest) {
    throw new Error('audit environment image does not match the selected runtime')
  }
}
