import type { ArtifactRecord, ArtifactReference } from './contracts.js'
import { artifactReferences } from './artifact-execution.js'
import { canonicalJson, sha256 } from './canonical.js'
import { PermanentRunFailure } from './run-errors.js'

export interface FrozenInputs {
  inputArtifacts?: readonly ArtifactReference[]
  inputDigest?: string
}

/** Resolve the admitted frontier without allowing later accepted work into it. */
export async function frozenAdmissionArtifacts(artifacts: readonly ArtifactRecord[], admission: FrozenInputs): Promise<readonly ArtifactRecord[]> {
  const refs = admission.inputArtifacts
  if (refs === undefined || admission.inputDigest !== await sha256(refs)
    || canonicalJson(refs) !== canonicalJson(artifactReferences(refs))) {
    throw new PermanentRunFailure('admission input snapshot is invalid', 'integrity-failed')
  }
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]))
  if (byId.size !== artifacts.length || refs.some(ref => byId.get(ref.id)?.contentDigest !== ref.contentDigest)) {
    throw new PermanentRunFailure('admission input snapshot is incomplete', 'integrity-failed')
  }
  return refs.map(ref => byId.get(ref.id)!)
}
