import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { canonicalJson } from '../src/canonical.js'
import { PermanentRunFailure } from '../src/run-errors.js'

it('rechecks the exact lost-task fence and passes it into Workflow bootstrap', async () => {
  const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
  const start = source.indexOf('  private async bootstrap(')
  const end = source.indexOf('  private async runOneWave(', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const code = stripTypeScriptTypes(`class Fixture {
    env = { ENGINE_ROLE: 'runtime', ARTIFACTS: {} };
    ${source.slice(start, end)}
  }`)
  const lost = { stageId: 'discovery', waveId: 'wave-2', taskId: 'core-wave-2-research-1',
    attempt: 1, promptDigest: 'a'.repeat(64), requestDigest: 'b'.repeat(64),
    fenceProofDigest: 'c'.repeat(64) }
  const evidence = { sourceRunId: 'source', sourceStateGeneration: 42,
    sourceStateDigest: 'd'.repeat(64), unobservableNative: lost }
  const release = { digest: 'e'.repeat(64), body: { definition: { id: 'audit' } } }
  const runtime = { id: 'runtime-child' }
  const sourceState = { inFlightAgentAttempts: [{}] }
  const prepared = vi.fn(async (input: Record<string, unknown>) => {
    expect(input.unobservableNative).toEqual(lost)
    return { importedArtifacts: [], inheritedRejectedAttempts: [], evidence }
  })
  const recover = vi.fn(async () => ({ recovered: true }))
  const Workflow = new Function(
    'runIdPattern', 'engineRole', 'assertLocalRuntime', 'digestPattern',
    'assertReleaseEnvironmentMatchesRuntime', 'R2ArtifactStore',
    'prepareFailedWaveRecovery', 'canonicalJson', 'PermanentRunFailure', 'RunMachine',
    `${code}; return Fixture;`,
  )(
    /^[a-z0-9][a-z0-9._-]{0,99}$/, () => 'runtime', () => runtime,
    /^[0-9a-f]{64}$/, () => undefined, class { constructor(readonly bucket: unknown) {} },
    prepared, canonicalJson, PermanentRunFailure, { recoverFailedWave: recover },
  ) as new () => { bootstrap(payload: unknown, store: unknown): Promise<unknown> }
  let current = lost
  const fenced = vi.fn(async () => current)
  const store = {
    getCheckpoint: async () => ({ body: { releaseDigest: release.digest, experimentId: 'audit' } }),
    getRelease: async () => release,
    getStateIfPresent: async () => null,
    getState: async () => sourceState,
    fencedUnobservableNativeEvidence: fenced,
    retiredRunWorkflow: async () => ({ fenceProofDigest: lost.fenceProofDigest }),
  }
  const payload = { mode: 'recover-failed-wave', runId: 'child', experimentId: 'audit',
    checkpointDigest: 'f'.repeat(64), runtimeRelease: runtime, failedWaveRecovery: evidence }
  const workflow = new Workflow()
  await expect(workflow.bootstrap(payload, store)).resolves.toEqual({ recovered: true })
  expect(fenced).toHaveBeenCalledTimes(1)
  expect(prepared).toHaveBeenCalledTimes(1)
  expect(recover).toHaveBeenCalledTimes(1)
  current = { ...lost, requestDigest: '0'.repeat(64) }
  await expect(workflow.bootstrap(payload, store)).rejects.toThrow('fence changed before bootstrap')
  expect(prepared).toHaveBeenCalledTimes(1)
})
