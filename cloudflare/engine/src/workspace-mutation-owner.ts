import { sha256 } from './canonical.js'
import { assertExecutionAuthority, type ExecutionAuthority } from './execution-authority.js'

/** Internal lane ownership, not a credential or another audit configuration. */
export interface WorkspaceMutationOwner {
  schemaVersion: 1
  authority: ExecutionAuthority
  workspaceKey: string
  ordinal: number
  originDigest: string
}

export function assertMutationDigest(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError('workspace mutation digest is invalid')
}

export function assertWorkspaceMutationOwner(owner: WorkspaceMutationOwner): void {
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)
    || Object.keys(owner).sort().join(',') !== 'authority,ordinal,originDigest,schemaVersion,workspaceKey'
    || owner.schemaVersion !== 1 || typeof owner.workspaceKey !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(owner.workspaceKey)
    || owner.ordinal !== 0) {
    throw new TypeError('workspace mutation owner is invalid')
  }
  assertExecutionAuthority(owner.authority)
  assertMutationDigest(owner.originDigest)
}

export async function birthMutationOwner(authority: ExecutionAuthority, workspaceKey: string): Promise<WorkspaceMutationOwner> {
  authority = structuredClone(authority)
  const owner: WorkspaceMutationOwner = { schemaVersion: 1, authority, workspaceKey,
    ordinal: 0, originDigest: await sha256({ kind: 'workspace-birth', authority, workspaceKey }) }
  assertWorkspaceMutationOwner(owner)
  return owner
}

/** Covered allocations never adopt an old unversioned actor, even if it is idle. */
export async function mutationSandboxName(owner: WorkspaceMutationOwner): Promise<string> {
  owner = structuredClone(owner)
  assertWorkspaceMutationOwner(owner)
  const identity = { authority: owner.authority, workspaceKey: owner.workspaceKey }
  return `m1-${(await sha256(identity)).slice(0, 30)}`
}
