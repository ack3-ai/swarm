import { createControlledMachine } from './support/controlled-machine.js'
import { restoreSelected } from './support/selected-snapshots.js'
import { verifiedJournalPrefix } from '../src/execution-journal.js'
/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest, AgentResult, ArtifactRecord } from '../src/contracts.js'
import {
  RunMachine, audit0RunPolicy, advanceExperimentOneWave, createAudit0RunPolicy, sealReleasePackage, sha256,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { OUTPUT_FILE_MAX_BYTES } from '../src/output-limits.js'
import { sealFinalFinding } from '../src/protocol-transforms.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { instruction } from './support/instructions.js'
import { expectSameOrder, textValues } from './support/text-order.js'

async function execute(runId: string, provider: AgentProvider = new DeterministicAuditProvider(), controlled = false) {
  const startedAt = '2026-09-18T20:00:00.000Z'
  const pkg = await sealReleasePackage(audit0PackageBody)
  const machine = await createControlledMachine(audit0Definition, pkg.digest, runId, startedAt, undefined,
    controlled ? { auditId: runId, executionId: runId, epoch: 0, runtimeDigest: await sha256(null) } : undefined)
  const store = new MemoryArtifactStore()
  const outcome = await runExperiment({
    definition: audit0Definition,
    machine,
    provider,
    artifactStore: store,
    policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
  })
  return { pkg, machine, store, outcome }
}

describe('Cloudflare audit0 acceptance flow', () => {
  it('directs the reporter to the collected full report and seals that text', async () => {
    const task = audit0Definition.stages.find(stage => stage.kind === 'reporting')!
      .waves[0]!.tasks.find(candidate => candidate.id === 'reporter')!
    expect(task.output.requiredFiles).toEqual(['finding-draft.md', SUBMISSION_PATH])
    const prompt = renderTaskPrompt({
      definition: audit0Definition, task, visibleArtifacts: [], deadline: '2026-09-18T21:00:00.000Z',
    })
    expect(prompt).toContain(instruction(audit0Definition, 'reportingEvidenceMethod'))
    expect(prompt).not.toContain('finding.md')

    const { outcome, store } = await execute('reporter-output-contract')
    const reporter = outcome.state.artifacts.find(value => value.taskId === 'reporter')!
    const final = outcome.state.artifacts.find(value => value.taskId === 'seal-final')!
    const draft = (JSON.parse(store.contents.get(reporter.uri)!) as Record<string, string>)['finding-draft.md']!
    const sealed = (JSON.parse(store.contents.get(final.uri)!) as Record<string, string>)['finding.md']!
    expect(draft).toContain('## Report item')
    expect(sealed).toBe(sealFinalFinding(draft, final.protocol.finalCustody!))

    const coverageOnly = '# Review\n\n## Coverage and uncertainty\n\nNo report item is supported.\n'
    expect(sealFinalFinding(coverageOnly, final.protocol.finalCustody!))
      .toContain('No report item is supported.')
  })

  it('seals a near-limit UTF-8 draft without relaxing other file or custody checks', async () => {
    const { outcome, store } = await execute('final-seal-size-boundary')
    const reporter = outcome.state.artifacts.find(value => value.taskId === 'reporter')!
    const final = outcome.state.artifacts.find(value => value.taskId === 'seal-final')!
    const tasks = audit0Definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
    const task = tasks.find(value => value.id === 'seal-final')!
    const reporterTask = tasks.find(value => value.id === 'reporter')!
    const reportFiles = JSON.parse(store.contents.get(reporter.uri)!) as Record<string, string>
    const prefix = reportFiles['finding-draft.md']! + '\né'
    const draft = prefix + 'x'.repeat(OUTPUT_FILE_MAX_BYTES - 1 - Buffer.byteLength(prefix))
    expect(Buffer.byteLength(draft)).toBe(3_999_999)
    const base = (artifact: ArtifactRecord): AgentResult => ({
      status: 'accepted', actorId: artifact.actorId, model: artifact.model, provider: artifact.provider,
      inputTokens: 0, outputTokens: 0, costUsd: 0, assertions: [], files: {}, protocol: artifact.protocol,
    })
    const reportResult = { ...base(reporter), files: { ...reportFiles, 'finding-draft.md': draft } }
    expect((await validateAgentResultDetailed(reporterTask, reportResult, outcome.state.artifacts)).issues).toEqual([])
    const sealed = sealFinalFinding(draft, final.protocol.finalCustody!)
    expect(Buffer.byteLength(sealed)).toBeGreaterThan(OUTPUT_FILE_MAX_BYTES)
    const result = { ...base(final), files: { 'finding.md': sealed } }
    expect((await validateAgentResultDetailed(task, result, outcome.state.artifacts)).issues).toEqual([])
    const oversized = { ...result, files: { 'finding.md': sealFinalFinding(draft + 'xx', final.protocol.finalCustody!) } }
    expect((await validateAgentResultDetailed(task, oversized, outcome.state.artifacts)).repairable)
      .toContain('output file is too large: finding.md')
    const extraFile = { ...result, files: { ...result.files, 'extra.md': 'x'.repeat(OUTPUT_FILE_MAX_BYTES + 1) } }
    expect((await validateAgentResultDetailed(task, extraFile, outcome.state.artifacts)).repairable)
      .toContain('output file is too large: extra.md')
    const tampered = { ...result, files: { 'finding.md': sealed.replace('ACK3_FINAL_OBSERVATION_CUSTODY_V1', 'INVALID_CUSTODY') } }
    expect((await validateAgentResultDetailed(task, tampered, outcome.state.artifacts)).integrity)
      .toContain('finding.md lacks the exact deterministic final observation custody register')
  })

  it('preserves one causal defect while retaining its distinct impact paths', async () => {
    const { outcome, store } = await execute('one-defect-report-shape')
    const report = outcome.state.artifacts.find(value => value.taskId === 'reporter')
    const content = report === undefined ? undefined : store.contents.get(report.uri)
    expect(content).toBeDefined()
    const files = JSON.parse(content!)
    expect(files['finding-draft.md'].match(/^## Report item$/gm)).toHaveLength(1)
    expect(outcome.state.artifacts.find(value => value.taskId === 'coverage-union')?.files)
      .toEqual(['coverage-challenge.md'])
  })

  it('runs the zero-provider audit0 protocol to completion', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const startedAt = '2026-09-18T20:00:00.000Z'
    const parentMachine = await createControlledMachine(audit0Definition, pkg.digest, 'audit0-parent', startedAt)
    const parent = await runExperiment({
      definition: audit0Definition,
      machine: parentMachine,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(() => Date.parse(startedAt) + 60_000),
    })
    expect(parent.state.status).toBe('completed')
    expect(parent.state.journal).toContainEqual(expect.objectContaining({
      type: 'stage.ended',
      payload: expect.objectContaining({ reason: 'two-distinct-complete-saturation-cohorts' }),
    }))
    expect([...new Set(parent.state.artifacts.filter(value => value.stageId === 'discovery').map(value => value.waveId))])
      .toEqual(expect.arrayContaining(['wave-0', 'wave-1', 'wave-2', 'wave-3']))
    expect(parent.state.artifacts.map(artifact => artifact.taskId)).toContain('reporter')
    // C1: the shared text order sorts every key and id of a completed state as before.
    expectSameOrder(textValues(parent.state))

    await expect(restoreSelected(parentMachine)).resolves.toBeDefined()

  })

  it('refuses tampered historical checkpoint bytes', async () => {
    const { outcome, machine } = await execute('tamper-parent', undefined, true)
    const checkpoint = outcome.checkpoints[2]!
    const tampered = structuredClone(checkpoint)
    tampered.body.cursor = { stageIndex: 5, waveIndex: 0 }
    await expect(machine.verifyCheckpoint(tampered)).rejects.toThrow('digest differs')
  })

  it('preserves the sealed frontier when the cancellation command settles', async () => {
    const { createExecutorSourceFixture, proof } = await import('./support/successor-fixture.js')
    const closes: Array<() => void> = []
    try {
      const f = await createExecutorSourceFixture(close => closes.push(close))
      const parent = f.machine, before = parent.snapshot(), checkpoint = before.checkpoints.at(-1)!
      const command = { id: 'cancel-sealed-audit', action: 'cancel' as const,
        scope: { kind: 'audit' as const }, expectedRevision: 0, reason: 'operator cancellation' }
      const admitted = await f.journal.admit(command, f.authority)
      const started = await f.journal.beginEffect(command.id, admitted.version, before)
      const operation = await f.journal.beginNativeEffect(command.id, started.version, proof.inventoryDigest)
      // Deterministic machine boundary; native shutdown evidence is exercised by command-custody tests.
      await parent.cancelAudit(operation, proof)
      expect(parent.snapshot()).toMatchObject({ status: 'stopped', cursor: checkpoint.body.cursor,
        terminalReason: command.reason, artifacts: before.artifacts, checkpoints: before.checkpoints,
        controls: { lastReceipt: { commandId: command.id, outcome: { status: 'applied' } } } })
      const restored = await restoreSelected(parent)
      expect(restored.snapshot()).toEqual(parent.snapshot())
    } finally { closes.forEach(close => close()) }
  })

  it('does not seal an incomplete required Codex wave', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await createControlledMachine(audit0Definition, pkg.digest, 'failed-wave', '2026-09-18T20:00:00.000Z')
    await expect(runExperiment({
      definition: audit0Definition,
      machine,
      provider: new DeterministicAuditProvider(new Set(['core-wave-0-research-1'])),
      artifactStore: new MemoryArtifactStore(),
      policy: audit0RunPolicy,
    })).rejects.toThrow('sanitized provider failure for core-wave-0-research-1')
    const state = machine.snapshot()
    expect(state.status).toBe('failed')
    expect(state.checkpoints).toHaveLength(1)
    expect(state.cursor).toEqual({ stageIndex: 1, waveIndex: 0 })
  })


  it('continues after specifically attested additive unavailability without falling back to Codex', async () => {
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      async run(request: AgentRequest): Promise<AgentResult> {
        if (request.task.providerClass !== 'additive' || !request.task.optional) return base.run(request)
        return {
          status: 'additive-unavailable',
          actorId: `deepseek-unavailable-${request.task.id}`,
          model: request.task.model,
          provider: 'provider-a',
          files: {}, assertions: [], protocol: {},
          inputTokens: 0, outputTokens: 0, costUsd: 0,
          unavailableReason: 'provider-credit',
        }
      },
    }
    const { outcome } = await execute('additive-unavailable', provider)
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.artifacts.filter(value => value.status === 'additive-unavailable').length).toBeGreaterThan(0)
    expect(outcome.state.artifacts.some(value => value.taskId.startsWith('additive-') && value.model === 'gpt-codex-a')).toBe(false)
  })

  it.each([false, true])('rejects a final structured handoff that drops a retained reference (controlled=%s)', async controlled => {
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      async run(request: AgentRequest): Promise<AgentResult> {
        const result = await base.run(request)
        if (request.task.id !== 'reporter') return result
        return {
          ...result,
          files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify({ complete: true, retainedReferences: [] }) },
          protocol: { retainedReferences: [] },
        }
      },
    }
    await expect(execute('dropped-reference', provider, controlled)).rejects.toThrow('output correction exhausted after 10 turns')
  })


  it('rejects internally rehashed checkpoint frontier changes and journal mutations', async () => {
    const { outcome, machine } = await execute('semantic-tamper-parent', undefined, true)
    const checkpoint = outcome.checkpoints.find(value => value.body.cursor.stageIndex === 2 && value.body.cursor.waveIndex === 0)!
    const rehashed = structuredClone(checkpoint)
    const removed = rehashed.body.acceptedArtifacts.find(value => value.taskId === 'core-wave-0-research-1')!
    rehashed.body.acceptedArtifacts = rehashed.body.acceptedArtifacts.filter(value => value !== removed)
    rehashed.digest = await sha256(rehashed.body)
    await expect(machine.verifyCheckpoint(rehashed))
      .rejects.toThrow('not registered')

    const changedReceipt = structuredClone(checkpoint)
    const receipt = changedReceipt.body.stageEndReceipts.find(value => value.reason === 'two-distinct-complete-saturation-cohorts')!
    const evidence = receipt.evidence as { pools: Array<{ quietCohorts: number }> }
    evidence.pools[0]!.quietCohorts += 1
    receipt.evidenceDigest = await sha256(receipt.evidence)
    changedReceipt.digest = await sha256(changedReceipt.body)
    await expect(machine.verifyCheckpoint(changedReceipt))
      .rejects.toThrow('not registered')

    const changedSaturation = structuredClone(checkpoint)
    changedSaturation.body.acceptedArtifacts.find(value => (
      value.protocol.research?.materialHighCriticalDelta === false
    ))!
      .protocol.research!.materialHighCriticalDelta = true
    changedSaturation.digest = await sha256(changedSaturation.body)
    await expect(machine.verifyCheckpoint(changedSaturation))
      .rejects.toThrow('not registered')

    const changedBudget = structuredClone(checkpoint)
    changedBudget.body.budget.inputTokens += 1
    changedBudget.digest = await sha256(changedBudget.body)
    await expect(machine.verifyCheckpoint(changedBudget))
      .rejects.toThrow('not registered')

    const changedProvider = structuredClone(checkpoint)
    changedProvider.body.acceptedArtifacts[0]!.provider = 'unattested-provider'
    changedProvider.digest = await sha256(changedProvider.body)
    await expect(machine.verifyCheckpoint(changedProvider))
      .rejects.toThrow('not registered')

    const reportingCheckpoint = outcome.checkpoints.findLast(value => value.body.cursor.stageIndex === 6)!
    const changedReviewInput = structuredClone(reportingCheckpoint)
    changedReviewInput.body.acceptedArtifacts.find(value => value.taskId === 'negative-review-primary')!
      .protocol.reviewInputDigest = 'd'.repeat(64)
    changedReviewInput.digest = await sha256(changedReviewInput.body)
    await expect(machine.verifyCheckpoint(changedReviewInput))
      .rejects.toThrow('not registered')

    const state = structuredClone(outcome.state)
    state.journal[1]!.previousDigest = 'f'.repeat(64)
    await expect(verifiedJournalPrefix(state.journal)).rejects.toThrow('run journal chain is invalid')
    await expect(restoreSelected(machine, state)).rejects.toThrow('snapshot has no matching state selection receipt')
  })
})
