import { canonicalJson, sha256 } from './canonical.js'
import type { RunState, SealedCheckpoint } from './contracts.js'
import { verifiedJournalPrefix } from './execution-journal.js'
import { RunMachine } from './machine.js'

/** The owner must be a validated machine view: either a new transition or an
 * exact database-selected snapshot. Arbitrary R2 bytes cannot certify a seal. */
export async function verifyRegisteredCheckpoint(checkpoint: SealedCheckpoint, owner: RunState): Promise<void> {
  RunMachine.assertProducedState(owner)
  if (await sha256(checkpoint.body) !== checkpoint.digest) throw new Error('checkpoint digest differs')
  if (owner.checkpoints.filter(value => value.digest === checkpoint.digest && canonicalJson(value) === canonicalJson(checkpoint)).length !== 1) {
    throw new Error('checkpoint is not registered by its owner')
  }
  const registrations = owner.journal.filter(event => event.type === 'checkpoint.sealed'
    && (event.payload as { digest?: string }).digest === checkpoint.digest)
  if (registrations.length !== 1) throw new Error('checkpoint seal registration is missing or repeated')
  const seal = registrations[0]!
  await verifiedJournalPrefix(owner.journal, seal.digest)
  const body = checkpoint.body, authority = body.executionAuthority
  if (body.schemaVersion !== 2 || authority === undefined
    || authority.executionId !== body.runId || authority.auditId !== body.rootRunId
    || authority.runtimeDigest !== await sha256(body.runtimeRelease ?? null)
    || canonicalJson(authority) !== canonicalJson(owner.executionAuthority)
    || body.releaseDigest !== owner.releaseDigest || body.definitionDigest !== owner.definitionDigest
    || canonicalJson(body.forkOrigin) !== canonicalJson(owner.forkOrigin)
    || body.rootRunId !== owner.rootRunId || body.experimentId !== owner.experimentId
    || seal.sequence !== body.stateGeneration || seal.previousDigest !== body.journalHead || seal.at !== body.sealedAt
    || canonicalJson(seal.payload) !== canonicalJson({ digest: checkpoint.digest, cursor: body.cursor })) {
    throw new Error('checkpoint seal identity differs')
  }
}
