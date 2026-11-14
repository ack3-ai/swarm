import { completedForkFixture, type forkFixtures } from './stage-fork-command-fixture.js'
import { RunCommandJournal } from '../../src/run-command-journal.js'
import { vi } from 'vitest'
import { target } from './successor-fixture.js'
import { executionWorkflowPayload, bootstrapExecution } from '../../src/root-execution.js'
import { loadAdmittedStageFork } from '../../src/stage-fork-command.js'
import { canonicalJson } from '../../src/canonical.js'
import type { Env } from '../../src/env.js'
import type { RunControlDeliveryMarker } from '../../src/run-control-delivery.js'

/** `forks`: restore the completed audit from a per-file snapshot instead of building it. */
export async function createForkStartupFixture(registerClose: (close: () => void) => void, environmentImage?: string, forks?: ReturnType<typeof forkFixtures>) {
  const f = forks === undefined ? await completedForkFixture(registerClose, false, environmentImage) : await forks.restore(registerClose, false, environmentImage)
  await f.admit()
  const operation = await f.store.activatePreparedExecution(f.auditId, f.command.id, target)
  const reference = { auditId: f.auditId, commandId: f.command.id, commandDigest: operation.commandDigest }
  const prepared = await loadAdmittedStageFork(operation, f.store.executionSources())
  const selected = { prepared, payload: await executionWorkflowPayload(prepared, f.store) }
  const { env, binding } = startupEnvironment(f, selected.prepared.runId)
  const marker: RunControlDeliveryMarker = { schemaVersion: 1, kind: 'fork', auditId: f.auditId,
    experimentId: f.source.experimentId, commandId: f.command.id, commandDigest: operation.commandDigest,
    expectedRevision: f.command.expectedRevision, source: f.command.source }
  return { ...f, reference, operation, successor: selected.prepared, payload: selected.payload,
    release: await f.store.getRelease(selected.prepared.releaseDigest), env, binding, marker,
    controls: new RunCommandJournal(f.d1, selected.prepared.rootRunId),
    start: () => bootstrapExecution(selected.payload, f.store, env) }
}

export function startupEnvironment(f: { d1: D1Database; bucket: R2Bucket }, runId: string) {
  const { workerVersionId, ...declaration } = target
  const binding = { create: vi.fn(async (_options: unknown) => ({ id: runId })),
    get: vi.fn(async () => ({ id: runId, status: vi.fn(async () => ({ status: 'running' })) })) }
  const env = { INDEX: f.d1, PACKAGES: f.bucket, ARTIFACTS: f.bucket, AUDIT_WORKFLOW: binding,
    ENGINE_ROLE: 'runtime', RUNTIME_RELEASE_JSON: canonicalJson(declaration), VERSION_METADATA: { id: workerVersionId, tag: '', timestamp: '' },
    ACK3_CODEX_AUTH_JSON: JSON.stringify({ tokens: { account_id: '11111111-1111-4111-8111-111111111111' } }), ACK3_CODEX_WORKSPACE_ID: 'synthetic',
    PROVIDER_A_API_KEY: 'synthetic-never-sent',
    AGENT_SANDBOX: { idFromName: vi.fn(() => { throw new Error('unexpected actor allocation') }),
      getByName: vi.fn(() => { throw new Error('unexpected actor RPC') }) } } as unknown as Env
  return { env, binding }
}
