import type { CheckpointBody, RunState, RuntimeRelease, RuntimeTransitionEvidence } from './contracts.js'
import { sha256 } from './canonical.js'

const runtimeIdPattern = /^[a-z0-9][a-z0-9-]{2,62}$/
const bindingPattern = /^RUNTIME_[A-Z0-9_]{1,110}$/
const servicePattern = /^[a-z0-9][a-z0-9-]{0,62}$/
const workflowPattern = /^[a-z0-9][a-z0-9-]{0,99}$/
const workerVersionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/
declare const __ACK3_RUNTIME_BUILD_COMMIT_SHA__: string | undefined

export interface RuntimeReleaseDeclaration {
  schemaVersion: 1
  id: string
  frameworkCommit: string
  workerService: string
  workflowName: string
  containerImageDigest: string
}

export interface RuntimeCatalogEntry extends RuntimeReleaseDeclaration {
  binding: string
}

export interface RuntimeCatalog {
  schemaVersion: 1
  latest: string
  releases: Readonly<Record<string, RuntimeCatalogEntry>>
}

export type RuntimeSelector =
  | Readonly<{ mode: 'latest' }>
  | Readonly<{ mode: 'release', id: string }>

type RuntimeEnv = Readonly<Record<string, unknown>> & {
  RUNTIME_CATALOG_JSON?: string
  RUNTIME_RELEASE_JSON?: string
  RUNTIME_SLOT_POOL_ENABLED?: string
  INDEX?: D1Database
  VERSION_METADATA?: WorkerVersionMetadata
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).toSorted()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].toSorted())) {
    throw new TypeError(`${label} has invalid keys: ${actual.join(',')}`)
  }
}

export function assertRuntimeReleaseDeclaration(value: unknown, label = 'runtime release'): asserts value is RuntimeReleaseDeclaration {
  if (!record(value)) throw new TypeError(`${label} must be an object`)
  exactKeys(value, [
    'schemaVersion', 'id', 'frameworkCommit', 'workerService', 'workflowName', 'containerImageDigest',
  ], label)
  if (value.schemaVersion !== 1
    || typeof value.id !== 'string' || !runtimeIdPattern.test(value.id)
    || typeof value.frameworkCommit !== 'string' || !/^[0-9a-f]{40}$/.test(value.frameworkCommit)
    || typeof value.workerService !== 'string' || !servicePattern.test(value.workerService)
    || typeof value.workflowName !== 'string' || !workflowPattern.test(value.workflowName)
    || typeof value.containerImageDigest !== 'string' || !imageDigestPattern.test(value.containerImageDigest)) {
    throw new TypeError(`${label} is invalid`)
  }
}

export function assertRuntimeRelease(value: unknown, label = 'runtime release'): asserts value is RuntimeRelease {
  if (!record(value)) throw new TypeError(`${label} must be an object`)
  exactKeys(value, [
    'schemaVersion', 'id', 'frameworkCommit', 'workerService', 'workerVersionId', 'workflowName', 'containerImageDigest',
  ], label)
  const { workerVersionId, ...declaration } = value
  assertRuntimeReleaseDeclaration(declaration, label)
  if (typeof workerVersionId !== 'string' || !workerVersionPattern.test(workerVersionId)) {
    throw new TypeError(`${label} workerVersionId is invalid`)
  }
}

export function sameRuntimeRelease(left: RuntimeRelease, right: RuntimeRelease): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id === right.id
    && left.frameworkCommit === right.frameworkCommit
    && left.workerService === right.workerService
    && left.workerVersionId === right.workerVersionId
    && left.workflowName === right.workflowName
    && left.containerImageDigest === right.containerImageDigest
}

export function assertRuntimeTransition(value: unknown): asserts value is RuntimeTransitionEvidence {
  if (!record(value)) throw new TypeError('runtime transition must be an object')
  exactKeys(value, ['sourceRunId', 'sourceStateGeneration', 'sourceStateDigest', 'checkpointDigest',
    'sourceRuntimeRelease', 'targetRuntimeRelease', 'inheritedRecoveryDigest'], 'runtime transition')
  assertRuntimeRelease(value.sourceRuntimeRelease)
  assertRuntimeRelease(value.targetRuntimeRelease)
  if (typeof value.sourceRunId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(value.sourceRunId)
    || !Number.isSafeInteger(value.sourceStateGeneration) || (value.sourceStateGeneration as number) < 1
    || ['sourceStateDigest', 'checkpointDigest', 'inheritedRecoveryDigest'].some(key => (
      typeof value[key] !== 'string' || !/^[0-9a-f]{64}$/.test(value[key])
    )) || sameRuntimeRelease(value.sourceRuntimeRelease, value.targetRuntimeRelease)) {
    throw new TypeError('runtime transition evidence is invalid')
  }
}

export function inheritedRecoveryDigest(value: Pick<RunState | CheckpointBody,
  'failedWaveRecovery' | 'terminalCompletionRecovery' | 'promotedExecutionProofs'>): Promise<string> {
  return sha256({ failedWaveRecovery: value.failedWaveRecovery ?? null,
    terminalCompletionRecovery: value.terminalCompletionRecovery ?? null,
    promotedExecutionProofs: value.promotedExecutionProofs ?? [] })
}

export async function assertInheritedRuntimeTransition(value: Pick<RunState | CheckpointBody,
  'runtimeRelease' | 'runtimeTransition' | 'failedWaveRecovery' | 'terminalCompletionRecovery' | 'promotedExecutionProofs'>): Promise<void> {
  if (value.runtimeTransition === undefined) return
  assertRuntimeTransition(value.runtimeTransition)
  if (value.runtimeRelease === undefined
    || !sameRuntimeRelease(value.runtimeRelease, value.runtimeTransition.targetRuntimeRelease)
    || await inheritedRecoveryDigest(value) !== value.runtimeTransition.inheritedRecoveryDigest) {
    throw new Error('runtime transition inherited evidence mismatch')
  }
}

export function parseRuntimeCatalog(serialized: string | undefined): RuntimeCatalog {
  if (serialized === undefined || serialized === '') throw new TypeError('RUNTIME_CATALOG_JSON is required')
  const value: unknown = JSON.parse(serialized)
  if (!record(value)) throw new TypeError('runtime catalog must be an object')
  exactKeys(value, ['schemaVersion', 'latest', 'releases'], 'runtime catalog')
  if (value.schemaVersion !== 1 || typeof value.latest !== 'string'
    || !record(value.releases)) throw new TypeError('runtime catalog is invalid')
  const releases: Record<string, RuntimeCatalogEntry> = {}
  for (const [id, candidate] of Object.entries(value.releases)) {
    if (!record(candidate)) throw new TypeError(`runtime catalog entry ${id} must be an object`)
    exactKeys(candidate, [
      'schemaVersion', 'id', 'frameworkCommit', 'workerService', 'workflowName', 'containerImageDigest', 'binding',
    ], `runtime catalog entry ${id}`)
    const { binding, ...declaration } = candidate
    assertRuntimeReleaseDeclaration(declaration, `runtime catalog entry ${id}`)
    if (id !== declaration.id || typeof binding !== 'string' || !bindingPattern.test(binding)) {
      throw new TypeError(`runtime catalog entry ${id} is invalid`)
    }
    releases[id] = { ...declaration, binding }
  }
  if (releases[value.latest] === undefined) throw new TypeError('runtime catalog latest release must exist')
  return { schemaVersion: 1, latest: value.latest, releases }
}

/** Reassemble deployment variables, then use the unchanged catalog validator. */
export function runtimeCatalogFromBindings(env: RuntimeEnv): RuntimeCatalog {
  const serialized = env.RUNTIME_CATALOG_JSON
  if (serialized === undefined || serialized === '') return parseRuntimeCatalog(serialized)
  const manifest: unknown = JSON.parse(serialized)
  const partNames = Object.keys(env).filter(name => name.startsWith('RUNTIME_CATALOG_JSON_PART_'))
  if (!record(manifest) || !Object.hasOwn(manifest, 'runtimeCatalogParts')) {
    if (partNames.length !== 0) throw new TypeError('runtime catalog has unexpected variable parts')
    return parseRuntimeCatalog(serialized)
  }
  exactKeys(manifest, ['runtimeCatalogParts'], 'runtime catalog variable manifest')
  const count = manifest.runtimeCatalogParts
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 2 || count > 64) {
    throw new TypeError('runtime catalog variable part count is invalid')
  }
  const expected = Array.from({ length: count }, (_, index) => `RUNTIME_CATALOG_JSON_PART_${index}`)
  if (JSON.stringify(partNames.toSorted()) !== JSON.stringify(expected.toSorted())) {
    throw new TypeError('runtime catalog variable parts are missing or unexpected')
  }
  const encoder = new TextEncoder()
  const parts = expected.map(name => {
    const part = env[name]
    if (typeof part !== 'string' || part.length === 0 || encoder.encode(part).length > 5120) {
      throw new TypeError(`runtime catalog variable part is invalid: ${name}`)
    }
    return part
  })
  return parseRuntimeCatalog(parts.join(''))
}

export function localRuntimeRelease(env: RuntimeEnv): RuntimeRelease {
  if (env.RUNTIME_RELEASE_JSON === undefined || env.RUNTIME_RELEASE_JSON === '') {
    throw new TypeError('RUNTIME_RELEASE_JSON is required')
  }
  const declaration: unknown = JSON.parse(env.RUNTIME_RELEASE_JSON)
  assertRuntimeReleaseDeclaration(declaration)
  // Runtime rotation uploads a new bundle into a stable Worker binding. Its
  // reviewed source commit is embedded in that bundle; the slot's existing
  // RUNTIME_RELEASE_JSON still supplies its stable identity and image.
  const embeddedCommit = typeof __ACK3_RUNTIME_BUILD_COMMIT_SHA__ === 'string'
    ? __ACK3_RUNTIME_BUILD_COMMIT_SHA__ : declaration.frameworkCommit
  if (!/^[0-9a-f]{40}$/.test(embeddedCommit)) {
    throw new TypeError('runtime bundle commit is invalid')
  }
  const workerVersionId = env.VERSION_METADATA?.id
  const release = { ...declaration, frameworkCommit: embeddedCommit, workerVersionId }
  assertRuntimeRelease(release)
  return release
}

function fetcher(env: RuntimeEnv, entry: RuntimeCatalogEntry): Fetcher {
  const candidate = env[entry.binding]
  if (!record(candidate) || typeof candidate.fetch !== 'function') {
    throw new Error(`runtime release binding is unavailable: ${entry.id}/${entry.binding}`)
  }
  return candidate as unknown as Fetcher
}

function assertCatalogMatch(entry: RuntimeCatalogEntry, release: RuntimeRelease): void {
  if (entry.schemaVersion !== release.schemaVersion
    || entry.id !== release.id
    || entry.frameworkCommit !== release.frameworkCommit
    || entry.workerService !== release.workerService
    || entry.workflowName !== release.workflowName
    || entry.containerImageDigest !== release.containerImageDigest) {
    throw new Error(`runtime release identity differs from its catalog: ${entry.id}`)
  }
}

function assertStableSlotMatch(entry: RuntimeCatalogEntry, release: RuntimeRelease): void {
  if (entry.id !== release.id || entry.workerService !== release.workerService
    || entry.workflowName !== release.workflowName) {
    throw new Error(`runtime slot identity differs from its catalog: ${entry.id}`)
  }
}

export class RuntimeRouter {
  readonly catalog: RuntimeCatalog

  constructor(private readonly env: RuntimeEnv) {
    this.catalog = runtimeCatalogFromBindings(env)
  }

  private get rotatingPool(): boolean {
    return this.env.RUNTIME_SLOT_POOL_ENABLED === '1'
  }

  private async slotRelease(id: string): Promise<RuntimeRelease> {
    const db = this.env.INDEX
    if (db === undefined) throw new Error('runtime slot index is unavailable')
    const row = await db.prepare(`
      SELECT runtime_release_json FROM runtime_slots
      WHERE slot_id = ?1 AND NOT EXISTS (
        SELECT 1 FROM runtime_slot_control
        WHERE singleton = 1 AND rotating_slot_id = ?1
      )
    `).bind(id).first<{ runtime_release_json: string }>()
    if (row === null) throw new Error(`runtime slot is unavailable: ${id}`)
    const release: unknown = JSON.parse(row.runtime_release_json)
    assertRuntimeRelease(release)
    return release
  }

  async latest(): Promise<RuntimeRelease> {
    if (this.rotatingPool) {
      const db = this.env.INDEX
      if (db === undefined) throw new Error('runtime slot index is unavailable')
      const row = await db.prepare(`
        SELECT latest_slot_id FROM runtime_slot_control WHERE singleton = 1 AND enabled = 1
      `).first<{ latest_slot_id: string | null }>()
      if (row?.latest_slot_id === null || row?.latest_slot_id === undefined) {
        throw new Error('runtime slot pool is not activated')
      }
      return this.resolve(row.latest_slot_id)
    }
    return this.resolve(this.catalog.latest)
  }

  async resolve(id: string): Promise<RuntimeRelease> {
    const release = await this.probeSlot(id)
    const entry = this.catalog.releases[id]!
    if (this.rotatingPool) {
      if (!sameRuntimeRelease(await this.slotRelease(id), release)) {
        throw new Error(`runtime slot version differs from its current release: ${id}`)
      }
    } else {
      assertCatalogMatch(entry, release)
    }
    return release
  }

  /** Read-only identity probe used to verify a locked slot after publication. */
  async probeSlot(id: string): Promise<RuntimeRelease> {
    const entry = this.catalog.releases[id]
    if (entry === undefined) throw new Error(`runtime release is unavailable: ${id}`)
    const response = await fetcher(this.env, entry).fetch('https://runtime.internal/internal/runtime/identity')
    if (!response.ok) throw new Error(`runtime release identity failed: ${id}/${response.status}`)
    const release: unknown = await response.json()
    assertRuntimeRelease(release)
    if (response.headers.get('x-ack3-runtime-worker-version') !== release.workerVersionId) {
      throw new Error(`runtime release identity header differs: ${id}`)
    }
    assertStableSlotMatch(entry, release)
    return release
  }

  async fetch(release: RuntimeRelease, path: string, init?: RequestInit): Promise<Response> {
    assertRuntimeRelease(release)
    const entry = this.catalog.releases[release.id]
    if (entry === undefined) throw new Error(`runtime release is unavailable: ${release.id}`)
    if (this.rotatingPool) {
      assertStableSlotMatch(entry, release)
      if (!sameRuntimeRelease(await this.slotRelease(release.id), release)) {
        throw new Error(`runtime slot version changed: ${release.id}`)
      }
    } else {
      assertCatalogMatch(entry, release)
    }
    const headers = new Headers(init?.headers)
    for (const name of ['authorization', 'cookie', 'cf-access-jwt-assertion', 'cf-authorization-token']) {
      headers.delete(name)
    }
    const response = await fetcher(this.env, entry).fetch(`https://runtime.internal${path}`, {
      ...init,
      headers,
    })
    const observedVersion = response.headers.get('x-ack3-runtime-worker-version')
    if (observedVersion !== release.workerVersionId) {
      throw new Error(`runtime release worker version changed: ${release.id}`)
    }
    return response
  }
}

/** Resolve only the runtime explicitly saved for a run or checkpoint. */
export function pinnedRuntime(pinned: RuntimeRelease | null | undefined): RuntimeRelease {
  if (pinned === null || pinned === undefined) throw new Error('run has no pinned runtime release')
  assertRuntimeRelease(pinned)
  return pinned
}

/** Resolve a new run's requested selector exactly once, immediately before reservation. */
export async function resolveRuntimeSelector(
  selector: RuntimeSelector,
  router: RuntimeRouter,
): Promise<RuntimeRelease> {
  if (selector.mode === 'latest') return router.latest()
  if (!runtimeIdPattern.test(selector.id)) throw new TypeError('runtime selector id is invalid')
  return router.resolve(selector.id)
}
