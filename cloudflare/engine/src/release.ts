import type { ReleasePackage, ReleasePackageBody } from './contracts.js'
import { deepClone, sha256 } from './canonical.js'
import { validateReleasePackage } from './validation.js'

export async function sealReleasePackage(body: ReleasePackageBody): Promise<ReleasePackage> {
  validateReleasePackage(body)
  return { digest: await sha256(body), body: deepClone(body) }
}
