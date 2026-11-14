import type { RuntimeRelease } from './contracts.js'
import type { Env } from './env.js'
import type { RunOperation } from './run-command-journal.js'
import { canonicalJson, deepClone, sha256 } from './canonical.js'
import { readCustodyArchive } from './command-custody-archive.js'
import { assertSandboxStopReceipt, type SandboxStopReceipt } from './agent-sandbox-client.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

export type NativeActorProjection = { workspaceKey: string; sandboxName: string; records: readonly unknown[] }

export async function readPhysicalStopProof(env: Pick<Env, 'ARTIFACTS'>, operation: RunOperation, digest: string) {
  const proof = await readCustodyArchive(env.ARTIFACTS, operation, digest) as {
    schemaVersion: number; kind: string; auditId: string; commandDigest: string; inventoryDigest: string;
    source: unknown; stopped: SandboxStopReceipt[];
    physicalZeroVerified: boolean; selectedPhysicalZeroVerified?: boolean; interruptedUsageComplete: boolean }
  if (proof === null || typeof proof !== 'object' || proof.schemaVersion !== 1 || proof.kind !== 'native-stop-proof'
    || proof.auditId !== operation.auditId || proof.commandDigest !== operation.commandDigest
    || proof.inventoryDigest !== operation.nativeEffect?.inventoryDigest
    || canonicalJson(proof.source) !== canonicalJson(operation.source)
    || operation.nativeEffect?.kind !== 'revoke-admission'
    || proof.physicalZeroVerified !== true || Object.hasOwn(proof, 'selectedPhysicalZeroVerified')
    || proof.interruptedUsageComplete !== false || !Array.isArray(proof.stopped)
    || Object.hasOwn(proof, 'priorStops')) {
    throw new PermanentRunFailure('cancellation physical proof differs', 'integrity-failed')
  }
  try { proof.stopped.forEach(assertSandboxStopReceipt) }
  catch (cause) { throw new PermanentRunFailure('cancellation stop receipt is invalid', 'integrity-failed', { cause }) }
  if (proof.stopped.some(receipt => receipt.commandDigest !== operation.commandDigest)
    || new Set(proof.stopped.map(receipt => receipt.objectId)).size !== proof.stopped.length) {
    throw new PermanentRunFailure('cancellation physical proof repeats or changes an actor', 'integrity-failed')
  }
  return proof
}

export async function readStopInventory(env: Pick<Env, 'ARTIFACTS'>, operation: RunOperation, runtime: RuntimeRelease, stoppedCount: number) {
  const inventory = await readCustodyArchive(env.ARTIFACTS, operation, operation.nativeEffect!.inventoryDigest) as {
    schemaVersion: number; kind: string; auditId: string; command: unknown; source: unknown; runtime: unknown;
    physicalZeroVerified: boolean;
    actors: Array<{ workspaceKey: string; sandboxName: string; objectId: string }> }
  if (inventory === null || typeof inventory !== 'object' || inventory.schemaVersion !== 1
    || inventory.kind !== 'native-revocation-inventory' || inventory.auditId !== operation.auditId
    || canonicalJson(inventory.command) !== canonicalJson({ id: operation.command.id, revision: operation.revision, digest: operation.commandDigest })
    || canonicalJson(inventory.source) !== canonicalJson(operation.source)
    || canonicalJson(inventory.runtime) !== canonicalJson(runtime) || inventory.physicalZeroVerified !== false
    || Object.hasOwn(inventory, 'selection') || Object.hasOwn(inventory, 'priorStops')
    || !Array.isArray(inventory.actors) || inventory.actors.length !== stoppedCount) {
    throw new PermanentRunFailure('execution stop inventory differs', 'integrity-failed')
  }
  return inventory
}

/** Archive-envelope validation only: expected actors and runtime are supplied
 * by the source-derived reader, not authenticated here. The runtime additionally
 * checks actual namespace IDs. This reader never opens actors or performs controls. */
export async function readNativeActorInventory(input: {
  artifacts: R2Bucket; operation: RunOperation; runtime: RuntimeRelease
  actors: readonly NativeActorProjection[]
}) {
  const { artifacts } = input
  const { operation, runtime, actors } = deepClone({ operation: input.operation, runtime: input.runtime, actors: input.actors })
  const inventory = await readStopInventory({ ARTIFACTS: artifacts }, operation, runtime, actors.length)
  const withoutIds = inventory.actors.map(actor => {
    if (actor === null || typeof actor !== 'object' || typeof actor.objectId !== 'string' || !/^[a-f0-9]{64}$/.test(actor.objectId)) {
      throw new PermanentRunFailure('execution stop actor inventory differs', 'integrity-failed')
    }
    const { objectId: _objectId, ...record } = actor
    return record
  })
  if (canonicalJson(withoutIds) !== canonicalJson(actors)
    || new Set(inventory.actors.map(actor => actor.objectId)).size !== inventory.actors.length) {
    throw new PermanentRunFailure('execution stop workspace coverage differs', 'integrity-failed')
  }
  return inventory
}

export async function readNativeStoppedActors(input: {
  artifacts: R2Bucket; operation: RunOperation; proofDigest: string; runtime: RuntimeRelease
  actors: readonly NativeActorProjection[]
}) {
  const { artifacts } = input
  const { operation, proofDigest, runtime, actors } = deepClone({ operation: input.operation,
    proofDigest: input.proofDigest, runtime: input.runtime, actors: input.actors })
  const proof = await readPhysicalStopProof({ ARTIFACTS: artifacts }, operation, proofDigest)
  const inventory = await readNativeActorInventory({ artifacts, operation, runtime, actors })
  if (proof.stopped.length !== inventory.actors.length) {
    throw new PermanentRunFailure('execution stop actor coverage differs', 'integrity-failed')
  }
  for (const actor of inventory.actors) {
    const receipt = proof.stopped.find(value => value.objectId === actor.objectId)
    if (receipt === undefined) throw new PermanentRunFailure('execution stop actor is not stopped', 'integrity-failed')
    const custody = await readCustodyArchive(artifacts, operation, receipt.custodyDigest) as {
      binding: unknown; usageComplete: boolean; observations: unknown[] }
    if (canonicalJson(custody?.binding) !== canonicalJson({ schemaVersion: 1, kind: 'native-abandonment',
      auditId: operation.auditId, commandDigest: operation.commandDigest, source: operation.source!,
      inventoryDigest: operation.nativeEffect!.inventoryDigest, actor })
      || custody.usageComplete !== false || !Array.isArray(custody.observations)) {
      throw new PermanentRunFailure('execution stop actor custody differs', 'integrity-failed')
    }
    const captured = await artifacts.get(`control/custody/${operation.auditId}/${operation.commandDigest}/abandon-${await sha256(custody.binding)}.json`)
    if (captured === null) throw new TransientRunFailure('execution stop original capture is unavailable')
    if (await captured.text() !== canonicalJson(custody) || captured.customMetadata?.sha256 !== receipt.custodyDigest
      || captured.checksums.toJSON().sha256 !== receipt.custodyDigest) {
      throw new PermanentRunFailure('execution stop original capture differs', 'integrity-failed')
    }
  }
  return { proof, inventory, workspaceKeys: [...new Set(inventory.actors.map(actor => actor.workspaceKey))].sort() }
}

/** One immutable completion reference lets retries verify the physical effect
 * without repeating actor RPCs. */
export async function nativeStopCompletion(bucket: R2Bucket, operation: RunOperation, proofDigest?: string): Promise<string | null> {
  operation = deepClone(operation)
  const key = `control/custody/${operation.auditId}/${operation.commandDigest}/stop-completed.json`
  const binding = { schemaVersion: 1, kind: 'native-stop-completion', auditId: operation.auditId,
    commandDigest: operation.commandDigest, source: operation.source, inventoryDigest: operation.nativeEffect?.inventoryDigest }
  if (proofDigest !== undefined) {
    await readPhysicalStopProof({ ARTIFACTS: bucket }, operation, proofDigest)
    const content = canonicalJson({ ...binding, proofDigest }), digest = await sha256(content)
    try {
      await bucket.put(key, content, { httpMetadata: { contentType: 'application/json' },
        customMetadata: { sha256: digest }, sha256: digest, onlyIf: { etagDoesNotMatch: '*' } })
    } catch { /* Verify the first immutable completion after an ambiguous write. */ }
  }
  const saved = await bucket.get(key)
  if (saved === null) {
    if (proofDigest !== undefined) throw new TransientRunFailure('native stop completion could not be confirmed')
    return null
  }
  const content = await saved.text(), digest = await sha256(content)
  let value: { proofDigest: string }
  try { value = JSON.parse(content) }
  catch (cause) { throw new PermanentRunFailure('native stop completion is invalid', 'integrity-failed', { cause }) }
  if (value === null || typeof value !== 'object' || !/^[a-f0-9]{64}$/.test(value.proofDigest)
    || canonicalJson({ ...binding, proofDigest: value.proofDigest }) !== content
    || saved.customMetadata?.sha256 !== digest || saved.checksums.toJSON().sha256 !== digest) {
    throw new PermanentRunFailure('native stop completion differs', 'integrity-failed')
  }
  await readPhysicalStopProof({ ARTIFACTS: bucket }, operation, value.proofDigest)
  return value.proofDigest
}
