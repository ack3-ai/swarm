import { memoryR2 } from './support/memory-r2.js'
import { readSavedWork, readSavedWorkDigest } from '../src/saved-work.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { rootExecutionMachine, materializeRootExecution } from '../src/root-execution.js'
import { namespaceResearchResult } from '../src/research-result-namespace.js'
import { validateExecutionResult } from '../src/protocol-validation.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { frozenAdmissionArtifacts } from '../src/frozen-inputs.js'
import { selectVisibleArtifacts } from '../src/prompts.js'
import * as ownedWorkspaces from '../src/owned-execution-workspaces.js'
import { deliverRunControl, settleControlledFailure } from '../src/run-control-executor.js'
import { hasRecordedAttemptOutcome } from '../src/attempt-policy.js'
import { runControlResponse } from '../src/run-control-api.js'
import { hasPendingNativeControl, reconcileRunControls } from '../src/run-control-reconcile.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { advanceExperimentOneWave, audit0RunPolicy, runNextWave } from '../src/runner.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeCommandEvidence, cancellationKey } from '../src/native-command-evidence.js'
import { CommandCustodyCollector, readCommandDispatch, verifiedCancellationWinner, verifiedCleanupWorkspaces } from '../src/command-custody.js'
import { CloudflareRunStore, R2ArtifactStore, stateWriter } from '../src/cloudflare-storage.js'
import { RunCommandJournal } from '../src/run-command-journal.js'
import { ExecutionAuthorityStore } from '../src/execution-authority.js'
import { R2AgentExecutionReceiptStore, type AgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { reserveNativeLaunch, assertNativeTaskAdmission, assertRecordedTaskAdmission, assertFinishedSelectedTaskAdmission } from '../src/native-launch-authority.js'
import { initialTaskOccurrences } from '../src/task-occurrences.js'
import { artifactExecution, executionConfiguration } from '../src/artifact-execution.js'
import { executionRequestBody } from '../src/native-request.js'
import { nativeSandboxName } from '../src/native-workspace.js'
import { RunMachine } from '../src/machine.js'
import { runStateKey } from '../src/run-state-pointer.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { ROUTING_SCHEMA_SQL } from '../src/routing-schema.js'
import type { AgentRequest, JournalEvent, RunState, RuntimeRelease } from '../src/contracts.js'
import type { Env } from '../src/env.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { sqliteD1 } from './support/sqlite-d1.js'
import { AgentAttemptFailure, AgentExecutionPending, PermanentRunFailure, TransientRunFailure } from '../src/run-errors.js'

const closes: Array<() => void> = []
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); closes.splice(0).forEach(close => close()) })

async function fixture({ accepted = false, journaled = false, failure }: {
  accepted?: boolean; journaled?: boolean; failure?: 'unfinished' | 'recorded' | 'closed'
} = {}) {
  const db = sqliteD1(); closes.push(() => db.sqlite.close())
  for (const sql of ROUTING_SCHEMA_SQL) db.sqlite.exec(sql)
  const { objects, r2, bucket } = memoryR2()
  r2.put = vi.fn(r2.put); r2.get = vi.fn(r2.get); r2.head = vi.fn(r2.head)
  const runs = new CloudflareRunStore(bucket, bucket, db.d1), id = 'custody-audit'
  const body = structuredClone(audit0PackageBody)
  const release = await runs.putRelease(body), definition = release.body.definition
  const declaration = { schemaVersion: 1 as const, id: 'runtime-test', frameworkCommit: 'a'.repeat(40),
    workerService: 'runtime-test', workflowName: 'runtime-test', containerImageDigest: `sha256:${'b'.repeat(64)}` }
  const runtime: RuntimeRelease = { ...declaration, workerVersionId: '12345678-1234-4123-8123-123456789012' }
  const owner = { auditId: id, executionId: id, epoch: 0, runtimeDigest: await sha256(runtime) }
  const authority = new ExecutionAuthorityStore(db.d1)
  await authority.activate(owner, 'c'.repeat(64))
  const machine = await createControlledMachine(definition, release.digest, id, undefined, runtime, owner)
  await machine.start()
  if (accepted) await advanceExperimentOneWave({ definition, machine, provider: new DeterministicAuditProvider(),
    artifactStore: new R2ArtifactStore(bucket), policy: audit0RunPolicy })
  let state = machine.snapshot()
  const stage = definition.stages.find(value => value.kind === 'discovery')!
  const wave = stage.waves[0]!, task = wave.tasks.find(value => value.providerClass === 'additive')!
  expect(task).toBeDefined()
  if (journaled) {
    await machine.admitWave(stage.id, wave.id)
    state = machine.snapshot()
  }
  else state.waveAdmission = { configuration: executionConfiguration(state), stageId: stage.id, waveId: wave.id,
    cursor: { stageIndex: 1, waveIndex: 0 }, admittedAt: state.updatedAt, inputArtifacts: [], inputDigest: await sha256([]),
    taskOccurrences: await initialTaskOccurrences(owner, executionConfiguration(state), wave.tasks) }
  const frontier = journaled ? await frozenAdmissionArtifacts(state.artifacts,
    state.waveAdmission!) : []
  const inputs = journaled ? selectVisibleArtifacts(task, frontier, state.waveReceipts,
    state.cursor.stageIndex, state.cursor.waveIndex, definition) : []
  const execution = await artifactExecution({ state, task, attempt: 1, inputArtifacts: inputs, store: new MemoryArtifactStore() })
  const request: AgentRequest = { experimentId: state.experimentId, runId: id, executionAuthority: owner,
    taskExecutionId: execution.taskExecutionId!, execution, stage, wave, task, prompt: 'synthetic research instructions',
    promptDigest: await sha256('synthetic research instructions'), visibleArtifacts: inputs, releaseDigest: state.releaseDigest,
    attempt: 1, diagnostics: [], repairFiles: {}, freshContext: !journaled, continuationMode: 'new', sessionId: null }
  const dispatchDigest = await sha256(request), workspaceId = 'synthetic-workspace'
  const nativeDigest = await sha256(executionRequestBody(request, workspaceId))
  state.inFlightAgentAttempts = [{ execution, dispatchDigest, stageId: stage.id, waveId: wave.id, taskId: task.id,
    attempt: 1, promptDigest: request.promptDigest, freshContext: !journaled, continuationMode: 'new', sessionId: null, admittedAt: state.updatedAt }]
  if (journaled) {
    const { admittedAt: _admittedAt, ...admission } = state.inFlightAgentAttempts[0]!
    await machine.admitAgentAttempt(admission)
    state = machine.snapshot()
  }
  const stateDigest = await sha256(state)
  let stateKey = runStateKey(id, state.stateGeneration, stateDigest)
  await r2.put(stateKey, canonicalJson(state), { customMetadata: { generation: String(state.stateGeneration), objectSha256: stateDigest }, sha256: stateDigest })
  db.sqlite.prepare(`INSERT INTO experiment_runs (run_id, experiment_id, status, state_key, state_generation, updated_at)
    VALUES (?, ?, 'running', ?, ?, ?)`).run(id, state.experimentId, stateKey, state.stateGeneration, state.updatedAt)
  await reserveNativeLaunch(runs, authority, request, nativeDigest)
  if (failure !== undefined) {
    const failed = await RunMachine.fromState(definition, state, digest => runs.getRelease(digest), runs.executionSources())
    if (failure === 'recorded' || failure === 'closed') await failed.recordRejectedAttempt({ execution, stageId: stage.id, waveId: wave.id,
      taskId: task.id, attempt: 1, promptDigest: request.promptDigest, outputDigest: null, quarantineUri: null,
      diagnostics: ['synthetic terminal transport result'], freshContext: request.freshContext,
      continuationMode: 'new', sessionId: null,
      usage: { modelCalls: 1, inputTokens: 10, outputTokens: 2, costUsd: 0 } })
    if (failure === 'closed') await failed.clearAgentAttempt({ execution, stageId: stage.id, waveId: wave.id, taskId: task.id,
      promptDigest: request.promptDigest, admissionDigest: failed.view().journal.findLast(event => event.type === 'agent.attempt-admitted')!.digest })
    await failed.fail('synthetic executor failure with retained work')
    await (await stateWriter(runs, state))(failed.view())
    state = failed.snapshot(); stateKey = runStateKey(id, state.stateGeneration, await sha256(state))
  }
  const journal = new RunCommandJournal(db.d1, id)
  const command = { id: 'cancel-native', expectedRevision: 0, action: 'cancel', scope: { kind: 'audit' }, reason: 'synthetic cancellation' }
  await journal.admit(command, owner)
  const operation = await journal.beginEffect(command.id, 1, state)
  const objectId = 'e'.repeat(64), sessionId = 'session-12345678-1234-1234-1234-123456789012'
  const actor = {
    stopRevoked: vi.fn(async (commandDigest: string, custodyDigest: string) => ({ objectId, commandDigest, custodyDigest,
      status: 'stopped' as const, admissionRevoked: true as const, physicalZeroVerified: true as const,
      observedAt: state.updatedAt, evidence: { inspect: 'absent' as const, running: false as const }, pendingOperations: [] })),
    revoke: vi.fn(async (digest: string) => ({ objectId, commandDigest: digest, admissionRevoked: true as const, physicalZeroVerified: false as const })),
    revocationStatus: vi.fn(async (digest: string) => ({ objectId, commandDigest: digest, admissionRevoked: true,
      physicalZeroVerified: false, pendingOperations: [] })),
    observeAgentLog: vi.fn(async () => ({ status: 'available', offset: 0, size: 4, bytes: 4, data: btoa('log\n') })),
    observeDshSession: vi.fn(async () => ({ status: 'available', sessionId, workingDirectory: '/workspace/source',
      fileName: 'session.jsonl', bytes: 3, journalDigest: await sha256('{}\n'), contentBase64: btoa('{}\n'), closed: true, workState: 'none' })),
  }
  const selectedName = await nativeSandboxName(request)
  const nativeId = (name: string) => name === selectedName ? objectId : name.slice(3).padEnd(64, '0')
  const env = { INDEX: db.d1, PACKAGES: bucket, ARTIFACTS: bucket, ACK3_CODEX_WORKSPACE_ID: workspaceId,
    RUNTIME_RELEASE_JSON: JSON.stringify(declaration), VERSION_METADATA: { id: runtime.workerVersionId },
    AGENT_SANDBOX: { idFromName: vi.fn((name: string) => ({ toString: () => nativeId(name) })),
      getByName: vi.fn((name: string) => name === selectedName ? actor : { ...actor,
        revocationStatus: async (command: string) => ({ ...await actor.revocationStatus(command), objectId: nativeId(name) }),
        stopRevoked: async (command: string, custody: string) => {
          const receipt = await actor.stopRevoked(command, custody)
          return { ...receipt, objectId: receipt.objectId === objectId ? nativeId(name) : receipt.objectId }
        },
        revoke: async (digest: string) => {
          const receipt = await actor.revoke(digest)
          return { ...receipt, objectId: receipt.objectId === objectId ? nativeId(name) : receipt.objectId }
        } }) } } as unknown as Env
  const receipts = new R2AgentExecutionReceiptStore(bucket)
  const receipt: AgentExecutionReceipt = { requestDigest: nativeDigest, exitCode: 0, actorId: sessionId, files: {},
    inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '' }
  return { ...db, env, id, runs, journal, request, state, stateKey, operation, command, dispatchDigest, nativeDigest, definition,
    authority, owner, objects, r2: vi.mocked(r2), actor, receipt, receipts, objectId }
}

function abandonmentRecords(f: Awaited<ReturnType<typeof fixture>>) {
  return [...f.objects.entries()].filter(([key]) => key.includes('/abandon-'))
    .flatMap(([, object]) => JSON.parse(object.content).observations)
}

it('captures the exact session before stopping without settling its launch or changing accepted work', async () => {
  const f = await fixture({ accepted: true, journaled: true })
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const before = f.objects.get(f.stateKey)!.content
  const result = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  const observation = abandonmentRecords(f).find(value => value.dispatchDigest === f.dispatchDigest)
  expect(observation.session).toMatchObject({ status: 'available', sessionId: f.receipt.actorId })
  expect(observation.physicalZeroVerified).toBe(false)
  expect(result.physicalZeroVerified).toBe(true)
  expect(result.operation.status).toBe('applying')
  expect(f.actor.observeAgentLog).toHaveBeenCalledWith(f.nativeDigest, 0, 256 * 1024)
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
  expect(f.objects.get(f.stateKey)!.content).toBe(before)
})

it('records missing native session identity without choosing another journal', async () => {
  const f = await fixture()
  await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  const observation = abandonmentRecords(f).find(value => value.dispatchDigest === f.dispatchDigest)
  expect(observation.session).toEqual({ status: 'not-located' })
  expect(observation.receiptDigest).toBeNull()
  expect(f.actor.observeDshSession).not.toHaveBeenCalled()
})

it('binds the native request identity to the frozen input frontier', async () => {
  const f = await fixture(), projection = executionRequestBody(f.request, f.env.ACK3_CODEX_WORKSPACE_ID)
  expect(projection).not.toHaveProperty('inputDigest')
  const changed = executionRequestBody({ ...f.request, inputDigest: 'f'.repeat(64) }, f.env.ACK3_CODEX_WORKSPACE_ID)
  expect(changed.inputDigest).toBe('f'.repeat(64))
  expect(await sha256(changed)).not.toBe(await sha256(projection))
})

it.each(['workspace', 'runtime', 'object', 'command', 'dispatch'])('refuses %s mismatches without a completed stop proof', async change => {
  const f = await fixture()
  if (change === 'workspace') f.env.ACK3_CODEX_WORKSPACE_ID = 'different-workspace'
  if (change === 'runtime') f.env.VERSION_METADATA = { id: '22345678-1234-4123-8123-123456789012' } as WorkerVersionMetadata
  if (change === 'object' || change === 'command') f.actor.revocationStatus.mockImplementation(async digest => ({
    objectId: change === 'object' ? 'f'.repeat(64) : f.objectId,
    commandDigest: change === 'command' ? 'f'.repeat(64) : digest, admissionRevoked: true,
    physicalZeroVerified: false, pendingOperations: [] }))
  if (change === 'dispatch') for (const key of f.objects.keys()) if (key.includes('/dispatches/')) f.objects.delete(key)
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toThrow()
  expect([...f.objects.values()].some(object => JSON.parse(object.content).kind === 'native-stop-proof')).toBe(false)
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
})

it('refuses unrelated dispatches and unknown commands before native access', async () => {
  const f = await fixture()
  await expect(readCommandDispatch({ journal: f.journal, runs: f.runs, commandId: f.command.id,
    dispatchDigest: 'f'.repeat(64), workspaceId: f.env.ACK3_CODEX_WORKSPACE_ID })).rejects.toThrow('not active')
  await expect(new CommandCustodyCollector(f.env).stop(f.id, 'unknown-command')).rejects.toThrow('source-bound')
  expect(f.actor.revocationStatus).not.toHaveBeenCalled()
})

it.each([false, true])('rejects retired task-scoped custody before native access (selected: %s)', async selected => {
  const task = audit0Definition.stages.find(value => value.kind === 'discovery')!.waves[0]!.tasks.find(value => value.providerClass === 'additive')!
  const f = await fixture()
  const operation = (await f.journal.get(f.command.id))!
  const command = { ...operation.command, scope: { kind: 'tasks', taskIds: [selected ? task.id : 'unrelated-task'] } }
  const historical = { ...operation, command, commandDigest: await sha256(command) }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json = ?, operation_digest = ? WHERE command_id = ? AND version = ?')
    .run(JSON.stringify(historical), await sha256(historical), command.id, operation.version)
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toThrow('journal integrity failed')
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it.each(['receipt', 'state', 'log'])('refuses corrupt %s evidence rather than recording successful emptiness', async kind => {
  const f = await fixture()
  if (kind === 'receipt') {
    await f.receipts.put(f.id, f.nativeDigest, f.receipt)
    const object = [...f.objects.entries()].find(([key]) => key.includes('/execution-receipts/'))![1]
    const value = JSON.parse(object.content); value.requestDigest = 'f'.repeat(64)
    object.content = canonicalJson(value)
    object.checksum = object.customMetadata.objectSha256 = await sha256(object.content)
  }
  if (kind === 'state') f.objects.get(f.stateKey)!.content += ' '
  if (kind === 'log') f.actor.observeAgentLog.mockResolvedValue({ status: 'available', offset: 1, size: 4, bytes: 3, data: btoa('bad') })
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
})

it('refuses a native launch claim owned by another task before collecting its log', async () => {
  const f = await fixture()
  f.sqlite.prepare("UPDATE audit_execution_launches SET task_execution_id = 'another-task'").run()
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toThrow('admitted occurrence')
  expect(f.actor.observeAgentLog).not.toHaveBeenCalled()
})

it('preserves complete local inventory and irrevocable intent before revoking any actor', async () => {
  const f = await fixture()
  f.actor.revoke.mockImplementation(async digest => {
    const operation = await f.journal.get(f.command.id)
    expect(operation?.nativeEffect?.kind).toBe('revoke-admission')
    const archive = [...f.objects.entries()].find(([key]) => key.endsWith(`/${operation!.nativeEffect!.inventoryDigest}.json`))
    expect(archive).toBeDefined()
    const inventory = JSON.parse(archive![1].content)
    expect(inventory.actors.length).toBeGreaterThan(1)
    expect(inventory.actors.flatMap((actor: any) => actor.records).some((record: any) => record.admitted && !record.active)).toBe(true)
    await expect(f.journal.advance(f.command.id, operation!.version, { status: 'failed' })).rejects.toThrow('must reconcile')
    return { objectId: f.objectId, commandDigest: digest, admissionRevoked: true, physicalZeroVerified: false }
  })
  const result = await new CommandCustodyCollector(f.env).revoke(f.id, f.command.id)
  expect(result.revoked.length).toBe(result.actors.length)
  expect(new Set(result.revoked.map(receipt => receipt.objectId)).size).toBe(result.actors.length)
  expect(result.operation.status).toBe('applying')
  expect(result.physicalZeroVerified).toBe(false)
  expect(f.actor.observeAgentLog).not.toHaveBeenCalled()
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
})

it('does not revoke when inventory persistence cannot be confirmed', async () => {
  const f = await fixture(), put = f.r2.put.getMockImplementation()!
  f.r2.put.mockImplementation(async (...args) => {
    if (args[0].includes('/custody/')) throw new Error('archive unavailable')
    return put(...args)
  })
  await expect(new CommandCustodyCollector(f.env).revoke(f.id, f.command.id)).rejects.toMatchObject({ name: 'TransientRunFailure' })
  expect(f.actor.revoke).not.toHaveBeenCalled()
  expect((await f.journal.get(f.command.id))!.nativeEffect).toBeUndefined()
})

it('does not revoke when a command outcome wins before native effect intent', async () => {
  const f = await fixture(), put = f.r2.put.getMockImplementation()!
  f.r2.put.mockImplementation(async (...args) => {
    if (args[0].includes('/custody/')) await f.journal.advance(f.command.id, f.operation.version, { status: 'rejected' })
    return put(...args)
  })
  await expect(new CommandCustodyCollector(f.env).revoke(f.id, f.command.id)).rejects.toThrow('requires its applying source')
  expect(f.actor.revoke).not.toHaveBeenCalled()
  expect((await f.journal.get(f.command.id))!.status).toBe('rejected')
})

it('retains partial revocation and resumes the same effect after a later actor fails', async () => {
  const f = await fixture(), normal = f.actor.revoke.getMockImplementation()!
  f.actor.revoke.mockImplementationOnce(normal).mockRejectedValueOnce(new Error('lost actor response'))
  const collector = new CommandCustodyCollector(f.env)
  await expect(collector.revoke(f.id, f.command.id)).rejects.toBeInstanceOf(TransientRunFailure)
  const partial = (await f.journal.get(f.command.id))!
  expect(partial.nativeEffect).toBeDefined()
  const archive = [...f.objects.entries()].find(([, object]) => JSON.parse(object.content).kind === 'native-revocation-progress')!
  expect(partial).not.toHaveProperty('custodyDigest')
  expect(JSON.parse(archive[1].content).revoked).toHaveLength(1)
  const resumed = await collector.revoke(f.id, f.command.id)
  expect(resumed.inventoryDigest).toBe(partial.nativeEffect!.inventoryDigest)
  expect(resumed.operation).toEqual(partial)
  expect(resumed.revoked).toHaveLength(resumed.actors.length)
  expect(f.objects.has(archive[0])).toBe(true)
})

it('refuses a returned actor identity mismatch without claiming revocation finished', async () => {
  const f = await fixture()
  f.actor.revoke.mockImplementation(async digest => ({ objectId: 'f'.repeat(64), commandDigest: digest,
    admissionRevoked: true, physicalZeroVerified: false }))
  await expect(new CommandCustodyCollector(f.env).revoke(f.id, f.command.id)).rejects.toThrow('revocation identity differs')
  const pending = (await f.journal.get(f.command.id))!
  expect(pending.nativeEffect).toBeDefined()
  expect(pending.status).toBe('applying')
  expect(pending.receiptDigest).toBeUndefined()
})


it('stops only after immutable evidence capture and preserves every accepted source artifact', async () => {
  const f = await fixture({ accepted: true }), normal = f.actor.stopRevoked.getMockImplementation()!
  const before = f.objects.get(f.stateKey)!.content
  const artifacts = structuredClone(f.state.artifacts)
  expect(artifacts.length).toBeGreaterThan(0)
  const bytes = artifacts.map(record => {
    const object = f.objects.get(record.uri.slice('r2://ARTIFACTS/'.length))!
    expect(object).toBeDefined()
    expect(object.checksum).toBe(record.contentDigest)
    return object.content
  })
  f.actor.stopRevoked.mockImplementation(async (command, custody) => {
    const archive = [...f.objects.entries()].find(([key]) => key.endsWith(`/${custody}.json`))
    expect(archive).toBeDefined()
    expect(JSON.parse(archive![1].content)).toMatchObject({ binding: { kind: 'native-abandonment', commandDigest: command } })
    return normal(command, custody)
  })
  const result = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(result.physicalZeroVerified).toBe(true)
  expect(result.stopped.length).toBeGreaterThan(1)
  expect(result.operation.status).toBe('applying') // physical proof is not command/state settlement
  expect(result.operation).not.toHaveProperty('custodyDigest')
  const completion = [...f.objects.entries()].find(([key]) => key.endsWith('/stop-completed.json'))!
  expect(JSON.parse(completion[1].content).proofDigest).toBe(result.proofDigest)
  expect((await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).proofDigest).toBe(result.proofDigest)
  expect(f.objects.get(f.stateKey)!.content).toBe(before)
  expect(JSON.parse(before).artifacts).toEqual(artifacts)
  for (const [index, record] of artifacts.entries()) {
    const content = f.objects.get(record.uri.slice('r2://ARTIFACTS/'.length))!.content
    expect(content).toBe(bytes[index])
    expect(await sha256(content)).toBe(record.contentDigest)
  }
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBeNull()
})

it('abandonment preserves logs when session observation is unavailable without inventing complete usage', async () => {
  const f = await fixture()
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  f.actor.observeDshSession.mockRejectedValue(new Error('private native response unavailable'))
  const result = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(result.physicalZeroVerified).toBe(true)
  const evidence = [...f.objects.values()].map(o => JSON.parse(o.content)).filter(o => o.binding?.actor.objectId === f.objectId)
  const captured = evidence[0].observations[0]
  expect(captured.log.status).toBe('available')
  expect(captured.session).toEqual({ status: 'unavailable', reason: 'observation-incomplete' })
  expect(JSON.stringify(evidence)).not.toContain('private native response')
  expect(evidence[0].usageComplete).toBe(false)
})

it('bounds a stuck evidence read, stops, and never changes the first evidence after a late response', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  let finish!: (value: Awaited<ReturnType<typeof f.actor.observeAgentLog>>) => void
  f.actor.observeAgentLog.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const stopping = new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  // Native metadata/archive hashing use promises, not fake-timer ticks.
  await vi.waitFor(() => expect(f.actor.observeAgentLog).toHaveBeenCalled())
  await vi.advanceTimersByTimeAsync(5_000)
  const first = await stopping
  expect(first.physicalZeroVerified).toBe(true)
  const captured = [...f.objects.values()].map(o => JSON.parse(o.content)).find(o => o.binding?.actor.objectId === f.objectId)!
  expect(captured.observations[0].log).toEqual({ status: 'unavailable', reason: 'observation-incomplete' })
  finish({ status: 'available', offset: 0, size: 4, bytes: 4, data: btoa('late') })
  const retried = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(retried.proofDigest).toBe(first.proofDigest)
  expect(f.actor.observeAgentLog).toHaveBeenCalledTimes(1)
})

it('does not stop an actor whose evidence could not be durably saved', async () => {
  const f = await fixture(), put = f.r2.put.getMockImplementation()!
  f.r2.put.mockImplementation(async (...args) => args[0].includes('/abandon-') ? null : put(...args))
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toMatchObject({ name: 'TransientRunFailure' })
  expect(f.actor.stopRevoked).not.toHaveBeenCalled()
})

it('reuses the first evidence after stop RPC response loss rather than rebinding the actor', async () => {
  const f = await fixture(), normal = f.actor.stopRevoked.getMockImplementation()!
  f.actor.stopRevoked.mockImplementationOnce(async (command, custody) => { await normal(command, custody); throw new Error('lost response') })
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toBeInstanceOf(TransientRunFailure)
  const first = f.actor.stopRevoked.mock.calls[0]!
  f.actor.observeAgentLog.mockRejectedValue(new Error('already stopped'))
  const result = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(result.physicalZeroVerified).toBe(true)
  expect(f.actor.stopRevoked.mock.calls[1]).toEqual(first)
})

it('does not stop the actor whose available observation is corrupt', async () => {
  const f = await fixture()
  const selectedName = await nativeSandboxName(f.request)
  const get = vi.mocked(f.env.AGENT_SANDBOX.getByName).getMockImplementation()!
  const stopSelected = vi.fn()
  vi.mocked(f.env.AGENT_SANDBOX.getByName).mockImplementation(name => name === selectedName
    ? { ...f.actor, stopRevoked: stopSelected } as any : get(name))
  f.actor.observeAgentLog.mockResolvedValue({ status: 'available', offset: 1, size: 4, bytes: 4, data: btoa('bad!') })
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect(stopSelected).not.toHaveBeenCalled()

})

it.each(['identity', 'pending-entry', 'native-proof'])('refuses a mismatched %s stop receipt', async kind => {
  const f = await fixture(), normal = f.actor.stopRevoked.getMockImplementation()!
  f.actor.stopRevoked.mockImplementation(async (command, custody) => ({ ...await normal(command, custody),
    ...(kind === 'identity' ? { objectId: 'f'.repeat(64) } : kind === 'pending-entry'
      ? { pendingOperations: [{ id: 'bad', kind: 'command' }] } : { evidence: { inspect: 'present', running: false } }) } as any))
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect((await f.journal.get(f.command.id))!.status).toBe('applying')
})

it('returns pending physical work without a final stop proof and reconciles it later', async () => {
  const f = await fixture()
  f.actor.stopRevoked.mockImplementationOnce(async (commandDigest, custodyDigest) => ({ objectId: f.objectId,
    commandDigest, custodyDigest, status: 'pending', physicalZeroVerified: false }) as any)
  const pending = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(pending.physicalZeroVerified).toBe(false)
  expect(pending).not.toHaveProperty('proofDigest')
  expect((await f.journal.get(f.command.id))!.status).toBe('applying')
  const result = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  expect(result.physicalZeroVerified).toBe(true)
})


it('does not destroy retained session work through the abandonment path', async () => {
  const f = await fixture()
  const command = { ...f.command, action: 'restart', scope: { kind: 'audit' }, session: 'resume' }
  const historical = { ...f.operation, command, commandDigest: await sha256(command) }
  f.sqlite.prepare('UPDATE audit_run_commands SET operation_json=?, operation_digest=? WHERE command_id=? AND version=?')
    .run(canonicalJson(historical), await sha256(historical), command.id, historical.version)
  await expect(new CommandCustodyCollector(f.env).stop(f.id, f.command.id)).rejects.toThrow('command journal integrity failed')
  expect(f.actor.revoke).not.toHaveBeenCalled()
  expect(f.actor.stopRevoked).not.toHaveBeenCalled()
})

it('reconciles a lost abandonment archive acknowledgement and rejects changed saved identity', async () => {
  const f = await fixture(), put = f.r2.put.getMockImplementation()!
  f.r2.put.mockImplementation(async (...args) => {
    const result = await put(...args)
    if (args[0].includes('/abandon-')) throw new Error('lost response')
    return result
  })
  const collector = new CommandCustodyCollector(f.env)
  expect((await collector.stop(f.id, f.command.id)).physicalZeroVerified).toBe(true)
  const item = [...f.objects.entries()].find(([key]) => key.includes('/abandon-'))![1]
  const changed = JSON.parse(item.content)
  changed.binding.commandDigest = 'f'.repeat(64)
  item.content = canonicalJson(changed)
  item.checksum = item.customMetadata.sha256 = await sha256(item.content)
  f.actor.stopRevoked.mockClear()
  await expect(collector.stop(f.id, f.command.id)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect(f.actor.stopRevoked).not.toHaveBeenCalled()
})


it('settles cancellation only after physical proof and reconciles a lost settlement acknowledgement', async () => {
  const f = await fixture()
  f.onAfterRun(sql => { if (sql.includes('UPDATE audit_execution_launches')) throw new Error('lost settlement response') })
  const result = await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)
  expect(result.physicalZeroVerified).toBe(true)
  expect(result.claimsSettled).toBe(true)
  const launch = await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest)
  expect(await verifiedCancellationWinner(f.env, f.request, f.nativeDigest, launch!.receiptDigest!)).toBe(true)
  f.onAfterRun()
  expect((await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
  expect((await f.journal.get(f.command.id))!.status).toBe('applying')
})

it('includes a launch reserved after source binding but before native cancellation intent', async () => {
  const f = await fixture()
  f.sqlite.prepare('DELETE FROM audit_execution_launches').run()
  await f.authority.admitLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest, f.operation.source!.state)
  expect((await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
  expect(await f.authority.pendingLaunches(f.owner)).toEqual([])
})

it('leaves unknown or uncovered launches unsettled instead of asserting safe retirement', async () => {
  const f = await fixture()
  await f.authority.admitLaunch(f.owner, 'unknown-task', 'f'.repeat(64), f.operation.source!.state)
  await expect(new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).rejects.toThrow('uncovered native claim')
  expect((await f.authority.pendingLaunches(f.owner)).some(c => c.taskExecutionId === 'unknown-task')).toBe(true)
  expect((await f.journal.get(f.command.id))!.status).toBe('applying')
})

it('keeps a genuine native receipt when it wins settlement before cancellation', async () => {
  const f = await fixture()
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const terminalDigest = await sha256(f.receipt)
  const settle = ExecutionAuthorityStore.prototype.settleLaunch
  let raced = false
  vi.spyOn(ExecutionAuthorityStore.prototype, 'settleLaunch').mockImplementation(async function (this: ExecutionAuthorityStore, owner, request, receipt) {
    if (!raced) { raced = true; await settle.call(this, owner, request, terminalDigest) }
    return settle.call(this, owner, request, receipt)
  })
  expect((await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
  expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBe(terminalDigest)
  expect(await f.receipts.get(f.id, f.nativeDigest)).toEqual(f.receipt)
})

it('rejects an arbitrary competing settlement digest even if a genuine receipt exists', async () => {
  const f = await fixture()
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const settle = ExecutionAuthorityStore.prototype.settleLaunch
  let raced = false
  vi.spyOn(ExecutionAuthorityStore.prototype, 'settleLaunch').mockImplementation(async function (this: ExecutionAuthorityStore, owner, request, receipt) {
    if (!raced) { raced = true; await settle.call(this, owner, request, 'f'.repeat(64)) }
    return settle.call(this, owner, request, receipt)
  })
  await expect(new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).rejects.toThrow('settlement differs')
})

it('preserves a late native receipt after cancellation without accepting output or reporting integrity failure', async () => {
  const f = await fixture()
  const cancelled = await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)
  expect(cancelled.claimsSettled).toBe(true)
  const selected = (await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const provider = new SandboxAgentProvider(f.env)
  ;(provider as any).assertProviderCredentials = async () => {}
  await expect(provider.run(f.request)).rejects.toMatchObject({ name: 'AgentExecutionPending', observation: 'cancelled' })
  expect(await f.receipts.get(f.id, f.nativeDigest)).toEqual(f.receipt)
  expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBe(selected)
})

it('does not settle any launch if native stop is still pending', async () => {
  const f = await fixture()
  f.actor.stopRevoked.mockImplementationOnce(async (commandDigest, custodyDigest) => ({ objectId: f.objectId,
    commandDigest, custodyDigest, status: 'pending', physicalZeroVerified: false }) as any)
  const pending = await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)
  expect(pending.claimsSettled).toBe(false)
  expect(pending.physicalZeroVerified).toBe(false)
  expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBeNull()
})

it('requires exact archived stop evidence before recognizing a cancellation winner', async () => {
  const f = await fixture()
  const result = await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)
  const selected = (await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest!
  const proof = [...f.objects.entries()].find(([key]) => key.endsWith(`/${result.proofDigest}.json`))!
  f.objects.delete(proof[0])
  await expect(verifiedCancellationWinner(f.env, f.request, f.nativeDigest, selected)).rejects.toBeInstanceOf(TransientRunFailure)
  f.objects.set(proof[0], { ...proof[1], content: 'null' })
  await expect(verifiedCancellationWinner(f.env, f.request, f.nativeDigest, selected)).rejects.toBeInstanceOf(PermanentRunFailure)
})


it('does not equate zero pending claims with verified cancellation settlement', async () => {
  const f = await fixture()
  await f.authority.settleLaunch(f.owner, f.nativeDigest, 'f'.repeat(64))
  await expect(new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).rejects.toThrow('unverified prior settlement')
})


it.each(['claim', 'disposition', 'proof'])('does not turn %s observation failure into model repair after cancellation', async failure => {
  const f = await fixture()
  expect((await new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const selected = (await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest
  if (failure === 'claim') vi.spyOn(ExecutionAuthorityStore.prototype, 'observeLaunch').mockRejectedValue(new Error('D1 unavailable'))
  else {
    const get = f.r2.get.getMockImplementation()!
    f.r2.get.mockImplementation(async key => {
      if (key.includes(failure === 'disposition' ? '/cancellations/' : '/custody/')) throw new Error('R2 unavailable')
      return get(key)
    })
  }
  const provider = new SandboxAgentProvider(f.env)
  ;(provider as any).assertProviderCredentials = async () => {}
  await expect(provider.run(f.request)).rejects.toBeInstanceOf(TransientRunFailure)
  expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest).toBe(selected)
  expect(await f.receipts.get(f.id, f.nativeDigest)).toEqual(f.receipt)
})


it('does not endlessly retry an existing conflicting cancellation disposition', async () => {
  const f = await fixture()
  const key = `control/cancellations/${f.id}/${f.nativeDigest}.json`
  const content = '{}', digest = await sha256(content)
  f.objects.set(key, { content, customMetadata: { sha256: digest }, checksum: digest })
  await expect(new CommandCustodyCollector(f.env).settleExecutionStop(f.id, f.command.id)).rejects.toBeInstanceOf(PermanentRunFailure)
  expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBeNull()
})


async function terminalCancellationFixture(mutateProof?: (proof: any) => void) {
  const f = await fixture({ accepted: true, journaled: true })
  const collector = new CommandCustodyCollector(f.env)
  const settled = await collector.settleExecutionStop(f.id, f.command.id)
  expect(settled.claimsSettled).toBe(true)
  if (!settled.physicalZeroVerified || !settled.claimsSettled) throw new Error('fixture cancellation did not settle')
  if (mutateProof !== undefined) {
    const prefix = `control/custody/${f.id}/${settled.operation.commandDigest}/`
    const proof = JSON.parse(f.objects.get(`${prefix}${settled.proofDigest}.json`)!.content)
    mutateProof(proof)
    const content = canonicalJson(proof), digest = await sha256(content)
    f.objects.set(`${prefix}${digest}.json`, { content, checksum: digest,
      customMetadata: { auditId: f.id, commandDigest: settled.operation.commandDigest, sha256: digest } })
    settled.proofDigest = digest
  }
  const machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  await machine.cancelAudit(settled.operation, settled)
  const state = machine.snapshot()
  const persist = await stateWriter(f.runs, f.state)
  await persist(machine.view())
  return { ...f, state, settled, collector }
}

it('acknowledges a selected cancellation from full archived custody without repeating actor controls', async () => {
  const f = await terminalCancellationFixture(), { state, settled, collector } = f
  expect(settled.operation).not.toHaveProperty('custodyDigest')
  const controlsBefore = { stop: f.actor.stopRevoked.mock.calls.length, revoke: f.actor.revoke.mock.calls.length }
  // The selected terminal state consumed this revision, but its native ACK is
  // still outstanding. A later control must not hide that obligation.
  expect(await hasPendingNativeControl(state, f.journal)).toBe(true)
  const result = await collector.acknowledgeCancellation(state)
  expect(await hasPendingNativeControl(state, f.journal)).toBe(false)
  expect(result.operation.status).toBe('applied')
  await f.authority.fence(f.owner, result.operation.commandDigest)
  await f.authority.retire(f.owner, result.proofDigest)
  expect(await collector.acknowledgeCancellation(state)).toEqual(result)
  expect(f.actor.stopRevoked).toHaveBeenCalledTimes(controlsBefore.stop)
  expect(f.actor.revoke).toHaveBeenCalledTimes(controlsBefore.revoke)
  await f.receipts.put(f.id, f.nativeDigest, f.receipt)
  const provider = new SandboxAgentProvider(f.env)
  ;(provider as any).assertProviderCredentials = async () => {}
  await expect(provider.run(f.request)).rejects.toMatchObject({ observation: 'cancelled' })
})


it.each(['missing', 'duplicate', 'extra', 'custody', 'source', 'runtime', 'unsettled', 'settlement', 'unavailable'])
  ('refuses terminal cancellation with %s evidence without repeating controls', async change => {
    const mutate = change === 'missing' ? (proof: any) => { proof.stopped.pop() }
      : change === 'duplicate' ? (proof: any) => { proof.stopped.push(proof.stopped[0]) }
      : change === 'extra' ? (proof: any) => { proof.stopped[0].objectId = 'b'.repeat(64) }
      : change === 'custody' ? (proof: any) => { proof.stopped[0].custodyDigest = proof.stopped[1].custodyDigest }
      : change === 'source' ? (proof: any) => { proof.source.state.digest = 'b'.repeat(64) }
      : undefined
    const f = await terminalCancellationFixture(mutate)
    if (change === 'runtime') f.env.VERSION_METADATA = { ...f.env.VERSION_METADATA!, id: '22222222-2222-4222-8222-222222222222' }
    if (change === 'unsettled') f.sqlite.prepare(`INSERT INTO audit_execution_launches
      (audit_id, epoch, task_execution_id, request_digest, admitted_at) VALUES (?, 0, 'pending', ?, ?)`)
      .run(f.id, 'a'.repeat(64), new Date().toISOString())
    if (change === 'settlement') f.sqlite.prepare('UPDATE audit_execution_launches SET receipt_digest = ?').run('b'.repeat(64))
    if (change === 'unavailable') f.objects.delete(`control/custody/${f.id}/${f.settled.operation.commandDigest}/${f.settled.proofDigest}.json`)
    const calls = f.actor.stopRevoked.mock.calls.length
    await expect(f.collector.acknowledgeCancellation(f.state)).rejects.toThrow()
    expect((await f.journal.get(f.command.id))!.status).toBe('applying')
    expect(f.actor.stopRevoked).toHaveBeenCalledTimes(calls)
  })


it('drives a pending native cancellation through the existing runner without launching or accepting more work', async () => {
  const f = await fixture({ accepted: true, journaled: true })
  let machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  let persist = await stateWriter(f.runs, f.state)
  const collector = new CommandCustodyCollector(f.env)
  const reconcileControls = () => reconcileRunControls({ machine, journal: f.journal, persist, native: collector })
  const provider = { run: vi.fn(async () => { throw new Error('no model call after cancellation') }) }
  const advance = () => advanceExperimentOneWave({ definition: machine.definition, machine, provider,
    artifactStore: new R2ArtifactStore(f.env.ARTIFACTS), policy: audit0RunPolicy, reconcileControls, onWaveAdmission: persist })
  f.actor.stopRevoked.mockImplementationOnce(async (commandDigest, custodyDigest) => ({ objectId: f.objectId,
    commandDigest, custodyDigest, status: 'pending', physicalZeroVerified: false }) as any)
  expect(await advance()).toBe(false)
  expect(machine.view()).toEqual(f.state)
  expect((await f.journal.get(f.command.id))!.nativeEffect).toBeDefined()
  expect(await hasPendingNativeControl(machine.view(), f.journal)).toBe(true)
  expect(provider.run).not.toHaveBeenCalled()
  const saved = await f.runs.getState(f.id)
  machine = await RunMachine.fromState(f.definition, saved, digest => f.runs.getRelease(digest), f.runs.executionSources())
  persist = await stateWriter(f.runs, saved)
  expect(await advance()).toBe(false)
  expect(machine.view().status).toBe('stopped')
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(machine.view().artifacts).toEqual(f.state.artifacts)
  expect(machine.view().inFlightAgentAttempts).toEqual([])
  expect(provider.run).not.toHaveBeenCalled()
  const controls = f.actor.stopRevoked.mock.calls.length
  expect(await reconcileControls()).toBe(false)
  expect(f.actor.stopRevoked).toHaveBeenCalledTimes(controls)
})

it.each(['stop', 'state-ack', 'command-ack'])('recovers %s failure inside cancellation without audit failure or replayed actor controls', async failure => {
  const f = await fixture({ accepted: true, journaled: true })
  let machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  let persist = await stateWriter(f.runs, f.state)
  const native = new CommandCustodyCollector(f.env)
  const reconcile = () => reconcileRunControls({ machine, journal: f.journal, persist, native })
  if (failure === 'stop') f.actor.stopRevoked.mockRejectedValueOnce(new PermanentRunFailure('synthetic native observation failure', 'integrity-failed'))
  else {
    let lost = false
    f.onAfterRun(sql => {
      const state = f.sqlite.prepare('SELECT status FROM experiment_runs WHERE run_id = ?').get(f.id)
      const command = f.sqlite.prepare('SELECT operation_json FROM audit_run_commands WHERE command_id = ? ORDER BY version DESC LIMIT 1').get(f.command.id)
      const matched = failure === 'state-ack' ? state?.status === 'stopped' : JSON.parse(String(command?.operation_json)).status === 'applied'
      if (!lost && matched) { lost = true; throw new Error('response lost after commit') }
    })
  }
  if (failure === 'command-ack') await expect(reconcile()).resolves.toBe(false)
  else await expect(reconcile()).rejects.toBeInstanceOf(TransientRunFailure)
  const saved = await f.runs.getState(f.id)
  expect(saved.status).not.toBe('failed')
  const controls = f.actor.stopRevoked.mock.calls.length
  machine = await RunMachine.fromState(f.definition, saved, digest => f.runs.getRelease(digest), f.runs.executionSources())
  persist = await stateWriter(f.runs, saved)
  expect(await reconcile()).toBe(false)
  expect(machine.view().status).toBe('stopped')
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(machine.view().artifacts).toEqual(f.state.artifacts)
  if (failure !== 'stop') expect(f.actor.stopRevoked).toHaveBeenCalledTimes(controls)
})


it('atomically rejects a failed state when native intent wins after the failure guard read', async () => {
  const f = await fixture({ accepted: true, journaled: true })
  const machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  const persist = await stateWriter(f.runs, f.state)
  expect((await f.journal.get(f.command.id))!.nativeEffect).toBeUndefined()
  await machine.fail('synthetic callback failure')
  const put = f.r2.put.getMockImplementation()!
  let raced = false
  f.r2.put.mockImplementation(async (key, content, options) => {
    const result = await put(key, content, options)
    if (!raced && key.includes('/states/')) {
      raced = true
      await f.journal.beginNativeEffect(f.command.id, f.operation.version, 'c'.repeat(64))
    }
    return result
  })
  await expect(persist(machine.view())).rejects.toBeInstanceOf(TransientRunFailure)
  expect(raced).toBe(true)
  expect((await f.runs.getState(f.id)).status).toBe('running')
  expect((await f.journal.get(f.command.id))!.nativeEffect).toBeDefined()
  expect(f.actor.stopRevoked).not.toHaveBeenCalled()
})

it.each([false, true])('cancels a missing dispatch only when its occurrence has no native reservation (reserved: %s)', async reserved => {
  const f = await fixture({ accepted: true, journaled: true })
  f.objects.delete(`control/dispatches/${f.id}/${f.dispatchDigest}.json`)
  if (!reserved) f.sqlite.prepare('DELETE FROM audit_execution_launches').run()
  const machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  const persist = await stateWriter(f.runs, f.state), native = new CommandCustodyCollector(f.env)
  const reconcile = () => reconcileRunControls({ machine, journal: f.journal, persist, native })
  if (reserved) {
    await expect(reconcile()).rejects.toBeInstanceOf(TransientRunFailure)
    expect(machine.view().status).toBe('running')
    expect(f.actor.revoke).not.toHaveBeenCalled(); expect(f.actor.stopRevoked).not.toHaveBeenCalled()
    return
  }
  expect(await reconcile()).toBe(false)
  expect(machine.view().status).toBe('stopped')
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  expect(f.sqlite.prepare('SELECT count(*) AS n FROM audit_execution_launches').get()!.n).toBe(0)
  const evidence = [...f.objects.values()].map(value => value.content).filter(content => content.includes('unreserved-admission'))
  expect(evidence.length).toBeGreaterThan(0)
  expect(f.actor.observeAgentLog).not.toHaveBeenCalled()
  await expect(f.authority.admitLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest,
    { generation: machine.view().stateGeneration, digest: await sha256(machine.view()) })).rejects.toThrow()
})

it.each(['exact', 'missing-receipt', 'wrong-receipt', 'unsettled', 'unknown-claim', 'missing-history'])(
  'distinguishes an unreserved retry from a completed prior native attempt (%s)', async evidence => {
    const f = await fixture({ accepted: true, journaled: true })
    const machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
    const previous = machine.view().inFlightAgentAttempts![0]!
    const admissionDigest = machine.view().journal.at(-1)!.digest
    await machine.recordRejectedAttempt({ ...previous, outputDigest: null, quarantineUri: null,
      diagnostics: ['synthetic transport failure'], usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 } })
    await machine.clearAgentAttempt({ ...previous, admissionDigest })
    const request = { ...f.request, attempt: 2, freshContext: true,
      execution: { ...f.request.execution!, attempt: 2 } }
    const dispatchDigest = await sha256(request)
    await machine.admitAgentAttempt({ ...previous, dispatchDigest, attempt: 2, freshContext: true,
      execution: request.execution })
    const persist = await stateWriter(f.runs, f.state)
    if (evidence !== 'missing-receipt') await f.receipts.put(f.id, f.nativeDigest, f.receipt)
    if (evidence !== 'unsettled') await f.authority.settleLaunch(f.owner, f.nativeDigest,
      evidence === 'wrong-receipt' ? 'f'.repeat(64) : await sha256(f.receipt))
    if (evidence === 'unknown-claim') await f.authority.admitLaunch(f.owner, f.request.taskExecutionId!,
      'e'.repeat(64), f.operation.source!.state)
    if (evidence === 'missing-history') f.objects.delete(`control/dispatches/${f.id}/${f.dispatchDigest}.json`)
    await persist(machine.view())
    const native = new CommandCustodyCollector(f.env)
    const reconcile = () => reconcileRunControls({ machine, journal: f.journal, persist, native })
    if (evidence !== 'exact') {
      await expect(reconcile()).rejects.toBeInstanceOf(TransientRunFailure)
      expect(f.actor.revoke).not.toHaveBeenCalled()
      return
    }
    expect(await reconcile()).toBe(false)
    expect(machine.view().status).toBe('stopped')
    expect((await f.journal.get(f.command.id))!.status).toBe('applied')
    expect(f.sqlite.prepare('SELECT receipt_digest FROM audit_execution_launches').get()!.receipt_digest)
      .toBe(await sha256(f.receipt))
    expect(f.actor.observeAgentLog).not.toHaveBeenCalled()
  },
)


it('cancels through the command API and reconciles lost responses after native cleanup and retirement', async () => {
  const f = await fixture({ accepted: true, journaled: true })
  f.sqlite.prepare('DELETE FROM audit_run_commands').run()
  const api = (method: string, body?: unknown, commandId?: string, experimentId = f.definition.id) =>
    runControlResponse(new Request('https://internal/commands', { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.runs, f.env.INDEX, experimentId, f.id, commandId)
  expect((await api('POST', f.command, undefined, 'different-experiment')).status).toBe(404)
  for (const scope of [{ kind: 'pool', poolId: 'deepseek' }, { kind: 'tasks', taskIds: [f.request.task.id] }]) {
    expect((await api('POST', { ...f.command, scope })).status).toBe(422)
  }
  expect((await api('POST', f.command)).status).toBe(202)
  const admitted = await (await api('GET', undefined, f.command.id)).json()
  expect(admitted).toMatchObject({ status: 'accepted', revision: 1, version: 1 })
  expect((await api('POST', f.command)).status).toBe(202)
  expect((await api('POST', { ...f.command, reason: 'different' })).status).toBe(409)
  expect((await api('POST', { ...f.command, id: 'competing-cancel' })).status).toBe(409)
  expect(f.actor.revoke).not.toHaveBeenCalled()
  expect(f.actor.stopRevoked).not.toHaveBeenCalled()
  const native = new CommandCustodyCollector(f.env)
  let machine = await RunMachine.fromState(f.definition, f.state, digest => f.runs.getRelease(digest), f.runs.executionSources())
  let persist = await stateWriter(f.runs, f.state)
  const reconcile = () => reconcileRunControls({ machine, journal: f.journal, persist, native })
  f.actor.stopRevoked.mockImplementationOnce(async (commandDigest, custodyDigest) => ({ objectId: f.objectId,
    commandDigest, custodyDigest, status: 'pending', physicalZeroVerified: false }) as any)
  expect(await reconcile()).toBe(false)
  expect(await (await api('GET', undefined, f.command.id)).json()).toMatchObject({ status: 'applying' })
  expect((await api('POST', f.command)).status).toBe(202)
  const actorCalls = f.actor.stopRevoked.mock.calls.length
  await api('GET'); await api('GET', undefined, f.command.id)
  expect(f.actor.stopRevoked).toHaveBeenCalledTimes(actorCalls)
  const queued = { id: 'later-pause', action: 'pause', expectedRevision: 1, scope: { kind: 'audit' }, reason: 'synthetic later command' }
  expect((await api('POST', queued)).status).toBe(202)
  const saved = await f.runs.getState(f.id)
  machine = await RunMachine.fromState(f.definition, saved, digest => f.runs.getRelease(digest), f.runs.executionSources()); persist = await stateWriter(f.runs, saved)
  expect(await reconcile()).toBe(false)
  const proof = await native.acknowledgeCancellation(machine.view())
  await f.authority.fence(f.owner, proof.operation.commandDigest)
  await f.authority.retire(f.owner, proof.proofDigest)
  await reconcile() // queued commands receive an explicit terminal decision.
  const callsAfterCleanup = f.actor.stopRevoked.mock.calls.length
  expect(await (await api('GET')).json()).toMatchObject({ status: 'stopped', inFlight: 0, settledRevision: 1 })
  expect(await (await api('GET', undefined, queued.id)).json()).toMatchObject({ status: 'rejected' })
  expect((await api('POST', f.command)).status).toBe(200)
  expect((await api('POST', { ...f.command, id: 'new-after-retirement', expectedRevision: 2 })).status).toBe(409)
  expect(await (await api('GET', undefined, f.command.id)).json()).toMatchObject({ status: 'applied',
    receiptDigest: await sha256(machine.view().controls!.lastReceipt) })
  expect(f.actor.stopRevoked).toHaveBeenCalledTimes(callsAfterCleanup)
  expect(machine.view().artifacts).toEqual(f.state.artifacts)
  expect(machine.view().budget).toEqual(f.state.budget)
  expect(machine.view().rootCreatedAt).toBe(f.state.rootCreatedAt)
  expect(machine.view().checkpoints).toEqual(f.state.checkpoints)
})

it.each(['unfinished', 'recorded', 'unobservable', 'unreachable'] as const)('cancels a failed executor with %s work without granting a new launch', async failure => {
  const f = await fixture({ accepted: true, journaled: true, failure: failure === 'unobservable' || failure === 'unreachable' ? 'unfinished' : failure })
  const before = structuredClone(f.state)
  expect(before.status).toBe('failed')
  expect(hasRecordedAttemptOutcome(before.journal, before.inFlightAgentAttempts![0]!)).toBe(failure === 'recorded')
  await expect(assertRecordedTaskAdmission(before, f.request, digest => f.runs.getRelease(digest), f.runs.executionSources())).resolves.toBeUndefined()
  await expect(assertNativeTaskAdmission(before, f.request, digest => f.runs.getRelease(digest), f.runs.executionSources())).rejects.toThrow('persisted task admission')
  await expect(reserveNativeLaunch(f.runs, f.authority, f.request, f.nativeDigest)).rejects.toThrow('persisted task admission')
  const machine = await RunMachine.fromState(f.definition, before, digest => f.runs.getRelease(digest), f.runs.executionSources())
  const native = new CommandCustodyCollector(f.env)
  if (failure === 'unreachable') {
    f.actor.revoke.mockRejectedValueOnce(new Error('actor namespace unavailable'))
    await expect(reconcileRunControls({ machine, journal: f.journal, native,
      persist: await stateWriter(f.runs, before) })).rejects.toBeInstanceOf(TransientRunFailure)
    expect(await f.runs.getState(f.id)).toEqual(before)
    expect((await f.journal.get(f.command.id))!.status).toBe('applying')
    expect(f.actor.stopRevoked).not.toHaveBeenCalled()
    expect(await f.runs.retiredRunWorkflow(f.id)).toBeNull()
    expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBeNull()
    await expect(f.authority.retire(f.owner, 'f'.repeat(64))).rejects.toThrow()
    expect(await f.env.ARTIFACTS.get(cancellationKey(f.id, f.nativeDigest))).toBeNull()
  }
  if (failure === 'unobservable') {
    f.actor.observeAgentLog.mockRejectedValue(new Error('native workspace is unavailable'))
    f.actor.stopRevoked.mockImplementationOnce(async (commandDigest, custodyDigest) => ({ objectId: f.objectId,
      commandDigest, custodyDigest, status: 'pending', physicalZeroVerified: false }) as never)
    expect(await reconcileRunControls({ machine, journal: f.journal, native, persist: await stateWriter(f.runs, before) })).toBe(false)
    expect((await f.journal.get(f.command.id))!.status).toBe('applying')
    expect((await f.runs.getState(f.id)).status).toBe('failed')
    expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBeNull()
    expect(await f.receipts.get(f.id, f.nativeDigest)).toBeNull()
  }
  expect(await reconcileRunControls({ machine, journal: f.journal, native, persist: await stateWriter(f.runs, before) })).toBe(false)
  const stopped = await f.runs.getState(f.id)
  expect(stopped.status).toBe('stopped')
  expect(stopped.journal.at(-2)?.payload).toMatchObject({ previousStatus: 'failed', previousTerminalReason: before.terminalReason })
  expect(stopped.journal.slice(0, before.journal.length)).toEqual(before.journal)
  expect(stopped.artifacts).toEqual(before.artifacts)
  expect(stopped.budget).toEqual(before.budget)
  expect(stopped.modelStartedAt).toBe(before.modelStartedAt)
  expect(stopped.rejectedAttempts).toEqual(before.rejectedAttempts)
  expect(stopped.checkpoints).toEqual(before.checkpoints)
  await RunMachine.fromState(f.definition, stopped, digest => f.runs.getRelease(digest), f.runs.executionSources())
  expect((await f.journal.get(f.command.id))!.status).toBe('applied')
  const proof = await native.acknowledgeCancellation(stopped)
  await f.authority.fence(f.owner, proof.operation.commandDigest)
  await f.authority.retire(f.owner, proof.proofDigest)
  for (const checkpoint of stopped.checkpoints) await f.runs.putCheckpoint(checkpoint)
  const continuation = { action: 'fork', id: 'continue-failed-work', expectedRevision: 1,
    reason: 'Continue retained work after native cancellation', sourceFrontier: true,
    source: { runId: f.id, state: { generation: stopped.stateGeneration, digest: await sha256(stopped) } },
    releaseDigest: stopped.releaseDigest, runtimeRelease: stopped.runtimeRelease }
  const exportedDigest = await f.runs.exportStageFork(continuation, stopped.runtimeRelease!)
  const exported = await readSavedWork(f.env.ARTIFACTS, exportedDigest)
  expect(exported.artifacts).toEqual(before.artifacts)
  expect(exported.rejectedAttempts).toEqual(before.rejectedAttempts)
  expect(exported.source.budget).toEqual(before.budget)
  expect(exported.source.rootCreatedAt).toBe(before.rootCreatedAt)
  expect(exported.source.modelStartedAt).toBe(before.modelStartedAt)
  expect(exported.sourceFence?.proofDigest).toBe(proof.proofDigest)
  expect(exported.accounting.interruptions).toContain(proof.proofDigest)
  expect(await f.runs.runRuntime(stopped.runId)).toEqual(stopped.runtimeRelease)
  const selection = { producer: exported.producer, sourceReference: exported.sourceReference,
    boundary: exported.boundary, releaseDigest: exported.releaseDigest }
  expect(await readSavedWorkDigest(f.env.ARTIFACTS, selection)).toBe(exportedDigest)
  expect(await readSavedWorkDigest(f.env.ARTIFACTS, { ...selection, releaseDigest: 'f'.repeat(64) })).toBeNull()
  expect(await readSavedWorkDigest(f.env.ARTIFACTS, { ...selection,
    producer: { ...selection.producer, frameworkCommit: 'f'.repeat(40) } })).toBeNull()
  const selectionKey = `saved-work/selections/${await sha256(selection)}.json`
  const selectedObject = f.objects.get(selectionKey)!
  f.objects.set(selectionKey, { ...selectedObject, checksum: '0'.repeat(64) })
  const exporter = vi.fn(async () => { throw new Error('historical exporter unavailable') })
  await expect(f.runs.admitStageFork(f.id, continuation, undefined, undefined, undefined, exporter))
    .rejects.toThrow('saved-work selection changed')
  expect(await f.journal.get(continuation.id)).toBeNull()
  f.objects.set(selectionKey, selectedObject)
  const archiveKey = `saved-work/sha256/${exportedDigest}.json`, archive = f.objects.get(archiveKey)!
  // Even a checksum-valid pointer cannot authorize a different source projection.
  const wrong = { ...exported, producer: { ...exported.producer, frameworkCommit: 'f'.repeat(40) },
    source: { ...exported.source, runtimeRelease: { ...exported.producer, frameworkCommit: 'f'.repeat(40) } } }
  const wrongContent = canonicalJson(wrong), wrongDigest = await sha256(wrongContent)
  f.objects.set(`saved-work/sha256/${wrongDigest}.json`, { content: wrongContent, checksum: wrongDigest, customMetadata: { sha256: wrongDigest } })
  const pointer = canonicalJson({ digest: wrongDigest }), pointerDigest = await sha256(pointer)
  f.objects.set(selectionKey, { content: pointer, checksum: pointerDigest, customMetadata: { sha256: pointerDigest } })
  await expect(f.runs.admitStageFork(f.id, continuation, undefined, undefined, undefined, exporter))
    .rejects.toThrow('saved-work export differs')
  expect(await f.journal.get(continuation.id)).toBeNull()
  f.objects.set(selectionKey, selectedObject)
  f.objects.set(archiveKey, { ...archive, content: '{}' })
  await expect(f.runs.admitStageFork(f.id, continuation, undefined, undefined, undefined, exporter))
    .rejects.toThrow('saved-work archive is missing or changed')
  f.objects.set(archiveKey, archive)
  const admitted = await f.runs.admitStageFork(f.id, continuation, undefined, undefined, undefined, exporter)
  expect(exporter).not.toHaveBeenCalled()
  const activated = await f.runs.activatePreparedExecution(f.id, continuation.id, stopped.runtimeRelease)
  const child = await f.runs.getState(activated.prepared!.authority.executionId)
  expect(activated.status).toBe('applied')
  const restored = await RunMachine.fromState(f.definition, child,
    digest => f.runs.getRelease(digest), f.runs.executionSources())
  expect(restored.view().artifacts).toEqual(before.artifacts)
  expect(restored.view().budget).toEqual(before.budget)
  expect(restored.view().modelStartedAt).toBe(before.modelStartedAt)
  expect(restored.view().forkOrigin?.savedWorkDigest).toBe(exportedDigest)
  expect((await f.runs.getState(f.id))).toEqual(stopped)
  expect(admitted.status).toBe('accepted')
  expect(f.actor.observeAgentLog).toHaveBeenCalled()
  expect(f.actor.stopRevoked).toHaveBeenCalled()
  if (failure === 'unobservable') {
    expect(await f.receipts.get(f.id, f.nativeDigest)).toBeNull()
    const captures = [...f.objects.entries()].filter(([key]) => key.includes('/abandon-'))
    expect(captures.length).toBeGreaterThan(0)
    const observations = captures.flatMap(([, object]) => JSON.parse(object.content).observations)
    expect(observations).toContainEqual(expect.objectContaining({ log: { status: 'unavailable', reason: 'observation-incomplete' }, receiptDigest: null }))
    expect(captures.every(([, object]) => JSON.parse(object.content).usageComplete === false)).toBe(true)
    expect(await f.authority.pendingLaunches(f.owner)).toEqual([])
  }
})

it('preserves failed native custody until a later cancel', async () => {
  const f = await fixture({ accepted: true, journaled: true, failure: 'unfinished' })
  f.sqlite.prepare('DELETE FROM audit_run_commands').run()
  const retained = await settleControlledFailure(f.id, f.env)
  expect(retained).toMatchObject({ mode: 'controlled-failure-retained', physicalZeroVerified: false })
  expect(retained.retainedWorkspaceKeys.length).toBeGreaterThan(0)
  expect(f.actor.revoke).not.toHaveBeenCalled(); expect(f.actor.stopRevoked).not.toHaveBeenCalled()
  expect(await f.runs.getState(f.id)).toEqual(f.state)
  const response = await runControlResponse(new Request('https://internal/', { method: 'POST', body: JSON.stringify(f.command) }),
    f.runs, f.d1, f.definition.id, f.id)
  expect(response.status).toBe(202)
  expect(await settleControlledFailure(f.id, f.env)).toMatchObject({ mode: 'command-cancelled' })
  expect(f.sqlite.prepare('SELECT status FROM audit_execution_authority').get()!.status).toBe('retired')
})

async function rehashFinishedHistory(state: RunState) {
  const refs = new Map<string, string>()
  let previousDigest: string | null = null
  for (const [sequence, event] of state.journal.entries()) {
    const old = event.digest
    const payload = event.payload as { admissionDigest?: string; sourceEventDigest?: string }
    if (payload.admissionDigest !== undefined) payload.admissionDigest = refs.get(payload.admissionDigest) ?? payload.admissionDigest
    if (payload.sourceEventDigest !== undefined) payload.sourceEventDigest = refs.get(payload.sourceEventDigest) ?? payload.sourceEventDigest
    event.sequence = sequence; event.previousDigest = previousDigest
    const { digest: _, ...unsigned } = event
    event.digest = await sha256(unsigned); refs.set(old, event.digest); previousDigest = event.digest
  }
  return refs
}

it('verifies whole-execution stop evidence without native access', async () => {
  const f = await fixture({ accepted: true, journaled: true })
  const collector = new CommandCustodyCollector(f.env)
  const stopped = await collector.settleExecutionStop(f.id, f.command.id)
  if (stopped.proofDigest === undefined) throw new Error('fixture did not stop')
  const writes = f.r2.put.mock.calls.length, sourceBytes = f.objects.get(f.stateKey)!.content
  const beforeClaims = f.sqlite.prepare('SELECT * FROM audit_execution_launches ORDER BY request_digest').all()
  f.env.AGENT_SANDBOX.getByName = vi.fn(() => { throw new Error('no actor calls in archive verification') }) as any
  const reader = new NativeCommandEvidence({ runs: f.runs, artifacts: f.env.ARTIFACTS, index: f.env.INDEX })
  const proof = await reader.stop(f.id, f.command.id, stopped.proofDigest)
  expect(proof).toMatchObject({ source: f.state, inventoryDigest: stopped.inventoryDigest,
    physicalZeroVerified: true, claimsSettled: true })
  expect(reader.nativeActors.some(actor => actor.objectId === f.objectId)).toBe(true)
  expect(reader.nativeRequests.some(dispatch => dispatch.nativeRequestDigest === f.nativeDigest)).toBe(true)
  expect(f.r2.put).toHaveBeenCalledTimes(writes)
  expect(f.objects.get(f.stateKey)!.content).toBe(sourceBytes)
  expect(f.sqlite.prepare('SELECT * FROM audit_execution_launches ORDER BY request_digest').all()).toEqual(beforeClaims)
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
  const winner = (await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest!
  const sourceReads = vi.spyOn(f.runs, 'getStateAt')
  expect(await reader.cancellationWinner(f.request, f.nativeDigest, winner)).toBe(true)
  expect(sourceReads).toHaveBeenCalledTimes(1)
  sourceReads.mockRestore()
  // The same reader must not reuse a previous successful physical proof.
  f.objects.delete(`control/custody/${f.id}/${stopped.operation.commandDigest}/${stopped.proofDigest}.json`)
  await expect(reader.stop(f.id, f.command.id, stopped.proofDigest)).rejects.toThrow()
  expect(f.env.AGENT_SANDBOX.getByName).not.toHaveBeenCalled()
})

it.each(['genuine', 'late-genuine', 'unverified-settlement', 'missing-dispatch', 'missing-custody'] as const)(
  'archive verification checks the selected source claim and its first writer: %s', async mode => {
    const f = await fixture({ accepted: true, journaled: true }), collector = new CommandCustodyCollector(f.env)
    const terminal = await sha256(f.receipt)
    if (mode === 'genuine') {
      await f.receipts.put(f.id, f.nativeDigest, f.receipt)
      await f.authority.settleLaunch(f.owner, f.nativeDigest, terminal)
    }
    const stopped = await collector.settleExecutionStop(f.id, f.command.id)
    if (stopped.proofDigest === undefined) throw new Error('fixture did not stop')
    const winner = (await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest!
    if (mode === 'late-genuine' || mode === 'unverified-settlement') await f.receipts.put(f.id, f.nativeDigest, f.receipt)
    if (mode === 'unverified-settlement') f.sqlite.prepare('UPDATE audit_execution_launches SET receipt_digest = ? WHERE request_digest = ?').run('e'.repeat(64), f.nativeDigest)
    if (mode === 'missing-dispatch') for (const key of f.objects.keys()) if (key.includes('/dispatches/') && key.includes(f.dispatchDigest)) f.objects.delete(key)
    if (mode === 'missing-custody') f.objects.delete(`control/custody/${f.id}/${stopped.operation.commandDigest}/${stopped.stopped.find(actor => actor.objectId === f.objectId)!.custodyDigest}.json`)
    const reader = new NativeCommandEvidence({ runs: f.runs, artifacts: f.env.ARTIFACTS, index: f.env.INDEX })
    if (['unverified-settlement', 'missing-dispatch', 'missing-custody'].includes(mode)) {
      await expect(reader.stop(f.id, f.command.id, stopped.proofDigest)).rejects.toThrow()
    } else {
      expect((await reader.stop(f.id, f.command.id, stopped.proofDigest)).claimsSettled).toBe(true)
      expect(await f.receipts.get(f.id, f.nativeDigest)).toEqual(f.receipt)
      expect((await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest))!.receiptDigest).toBe(winner)
      expect(winner === terminal).toBe(mode === 'genuine')
    }
  },
)

it.each(['namespace', 'native-workspace', 'runtime', 'invalid-runtime'] as const)('adds installed %s verification to durable evidence', async mode => {
  const f = await fixture({ accepted: true, journaled: true }), collector = new CommandCustodyCollector(f.env)
  const stopped = await collector.settleExecutionStop(f.id, f.command.id)
  if (stopped.proofDigest === undefined) throw new Error('fixture did not stop')
  if (mode === 'namespace') f.env.AGENT_SANDBOX.idFromName = vi.fn(() => ({ toString: () => 'f'.repeat(64) })) as any
  if (mode === 'native-workspace') f.env.ACK3_CODEX_WORKSPACE_ID = 'different-workspace'
  if (mode === 'runtime') f.env.VERSION_METADATA = { ...f.env.VERSION_METADATA!, id: '22222222-2222-4222-8222-222222222222' }
  if (mode === 'invalid-runtime') f.env.RUNTIME_RELEASE_JSON = '{}'
  const reader = new NativeCommandEvidence({ runs: f.runs, artifacts: f.env.ARTIFACTS, index: f.env.INDEX })
  expect((await reader.stop(f.id, f.command.id, stopped.proofDigest)).claimsSettled).toBe(true)
  await expect(collector.verifyExecutionStop(f.id, f.command.id, stopped.proofDigest)).rejects.toBeInstanceOf(PermanentRunFailure)
  if (mode === 'invalid-runtime') await expect(collector.verifyExecutionStop(f.id, f.command.id, stopped.proofDigest))
    .rejects.toMatchObject({ category: 'invalid-configuration' })
})

it('snapshots expected native inventory before delayed archive access', async () => {
  const { readNativeActorInventory } = await import('../src/native-stop-evidence.js')
  const f = await fixture(), revoked = await new CommandCustodyCollector(f.env).revoke(f.id, f.command.id)
  const operation = structuredClone(revoked.operation), runtime = structuredClone(f.state.runtimeRelease!)
  const archived = JSON.parse(f.objects.get(`control/custody/${f.id}/${operation.commandDigest}/${operation.nativeEffect!.inventoryDigest}.json`)!.content)
  const actors = archived.actors.map(({ objectId: _, ...actor }: any) => actor)
  const input: Parameters<typeof readNativeActorInventory>[0] = { artifacts: f.env.ARTIFACTS, operation, runtime, actors }
  let resume!: () => void
  const gate = new Promise<void>(resolve => { resume = resolve })
  const get = f.r2.get.getMockImplementation()!
  f.r2.get.mockImplementationOnce(async key => { await gate; return get(key) })
  const reading = readNativeActorInventory(input)
  operation.commandDigest = 'a'.repeat(64)
  runtime.workerVersionId = '22222222-2222-4222-8222-222222222222'
  actors[0].workspaceKey = 'changed-after-read'
  resume()
  expect(await reading).toEqual(archived)
})

it.each(['lost-put-reply', 'changed-binding', 'changed-proof', 'missing-proof'] as const)(
  'verifies immutable native stop completion with %s', async mode => {
    const f = await fixture(), collector = new CommandCustodyCollector(f.env)
    if (mode === 'lost-put-reply') {
      const put = f.r2.put.getMockImplementation()!
      f.r2.put.mockImplementation(async (...args) => {
        const result = await put(...args)
        if (args[0].endsWith('/stop-completed.json')) throw new Error('lost completion write reply')
        return result
      })
    }
    const stopped = await collector.stop(f.id, f.command.id)
    if (stopped.proofDigest === undefined) throw new Error('fixture did not complete')
    const key = `control/custody/${f.id}/${stopped.operation.commandDigest}/stop-completed.json`
    const pointer = f.objects.get(key)!, value = JSON.parse(pointer.content)
    if (mode === 'changed-binding') value.inventoryDigest = 'a'.repeat(64)
    if (mode === 'changed-proof') value.proofDigest = 'b'.repeat(64)
    if (mode.startsWith('changed-')) {
      pointer.content = canonicalJson(value)
      pointer.checksum = pointer.customMetadata.sha256 = await sha256(pointer.content)
    }
    if (mode === 'missing-proof') f.objects.delete(`control/custody/${f.id}/${stopped.operation.commandDigest}/${stopped.proofDigest}.json`)
    const calls = vi.mocked(f.env.AGENT_SANDBOX.getByName).mock.calls.length
    if (mode === 'lost-put-reply') expect((await collector.stop(f.id, f.command.id)).proofDigest).toBe(stopped.proofDigest)
    else await expect(collector.stop(f.id, f.command.id)).rejects.toThrow()
    expect(f.env.AGENT_SANDBOX.getByName).toHaveBeenCalledTimes(calls)
  })

it.each(['inventory', 'proof'] as const)('rejects rehashed historical prior stops in %s', async kind => {
  const { readPhysicalStopProof, readStopInventory } = await import('../src/native-stop-evidence.js')
  const f = await fixture(), stopped = await new CommandCustodyCollector(f.env).stop(f.id, f.command.id)
  if (!stopped.physicalZeroVerified) throw new Error('fixture did not stop')
  const operation = structuredClone(stopped.operation)
  const prefix = `control/custody/${f.id}/${operation.commandDigest}/`
  const originalDigest = kind === 'inventory' ? operation.nativeEffect!.inventoryDigest : stopped.proofDigest
  const original = f.objects.get(`${prefix}${originalDigest}.json`)!
  const value = JSON.parse(original.content)
  value.priorStops = [{ commandId: 'old-restart', commandDigest: 'b'.repeat(64), revision: 1,
    inventoryDigest: 'c'.repeat(64), proofDigest: 'd'.repeat(64) }]
  const content = canonicalJson(value), digest = await sha256(content)
  f.objects.set(`${prefix}${digest}.json`, { content, checksum: digest,
    customMetadata: { ...original.customMetadata, sha256: digest } })
  if (kind === 'inventory') {
    operation.nativeEffect!.inventoryDigest = digest
    await expect(readStopInventory(f.env, operation, f.state.runtimeRelease!, stopped.stopped.length))
      .rejects.toThrow('execution stop inventory differs')
  } else {
    await expect(readPhysicalStopProof(f.env, operation, digest)).rejects.toThrow('cancellation physical proof differs')
  }
})

it('settles a finished attempt whose native claim has no terminal receipt', async () => {
  const f = await fixture({ accepted: true, journaled: true, failure: 'closed' })
  expect(f.state.inFlightAgentAttempts).toEqual([])
  expect((await f.authority.pendingLaunches(f.owner)).length).toBe(1)
  const collector = new CommandCustodyCollector(f.env)
  expect((await collector.settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
  expect(await f.authority.pendingLaunches(f.owner)).toEqual([])
  expect(await f.receipts.get(f.id, f.nativeDigest)).toBeNull()
  const claim = await f.authority.observeLaunch(f.owner, f.request.taskExecutionId!, f.nativeDigest)
  expect(await verifiedCancellationWinner(f.env, f.request, f.nativeDigest, claim!.receiptDigest!)).toBe(true)
  expect((await collector.settleExecutionStop(f.id, f.command.id)).claimsSettled).toBe(true)
})
