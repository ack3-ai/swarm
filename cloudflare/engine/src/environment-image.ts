import type { ReleasePackageBody, RuntimeRelease } from './contracts.js'

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
): void {
  if (body.environment === undefined) return
  const imageDigest = requestedEnvironmentImageDigest(body.environment.image)
  if (runtimeRelease === undefined || runtimeRelease.containerImageDigest !== imageDigest) {
    throw new Error('audit environment image does not match the selected runtime')
  }
}
