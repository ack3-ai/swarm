/// <reference types="node" />
import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentRequest, AgentResult, ArtifactRecord } from '../src/contracts.js'
import {
  RunMachine, audit0RunPolicy, advanceExperimentOneWave, createAudit0RunPolicy, expiredResumeClockAmendment, sealReleasePackage, sha256,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { sealFinalFinding } from '../src/protocol-transforms.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'
import { instruction } from './support/instructions.js'

async function execute(runId: string, provider: AgentProvider = new DeterministicAuditProvider()) {
  const startedAt = '2026-09-18T20:00:00.000Z'
  const pkg = await sealReleasePackage(audit0PackageBody)
  const machine = await RunMachine.create(audit0Definition, pkg.digest, runId, startedAt)
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

  it('runs the zero-provider audit0 protocol and resumes representative sealed checkpoints as fresh children', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const startedAt = '2026-09-18T20:00:00.000Z'
    const parentMachine = await RunMachine.create(audit0Definition, pkg.digest, 'audit0-parent', startedAt)
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

    const immutableParent = structuredClone(parent.state)
    const afterDiscovery = parent.checkpoints.find(checkpoint => checkpoint.body.cursor.stageIndex === 2 && checkpoint.body.cursor.waveIndex === 0)
    const beforeReporting = parent.checkpoints.findLast(checkpoint => checkpoint.body.cursor.stageIndex === 6)
    expect(afterDiscovery).toBeDefined()
    expect(beforeReporting).toBeDefined()

    for (const [checkpoint, childRunId] of [
      [afterDiscovery!, 'audit0-resume-discovery'],
      [beforeReporting!, 'audit0-resume-reporting'],
    ] as const) {
      const resumeStarted = performance.now()
      const childMachine = await RunMachine.resume(
        audit0Definition,
        checkpoint,
        childRunId,
        new Set([parent.state.runId]),
        '2026-09-18T20:10:00.000Z',
      )
      expect(performance.now() - resumeStarted).toBeLessThan(1_000)
      const child = await runExperiment({
        definition: audit0Definition,
        machine: childMachine,
        provider: new DeterministicAuditProvider(),
        artifactStore: new MemoryArtifactStore(),
        policy: audit0RunPolicy,
      })
      expect(child.state).toMatchObject({
        status: 'completed', parentRunId: parent.state.runId,
        parentCheckpointDigest: checkpoint.digest, recoveryEpoch: 1,
        rootRunId: parent.state.runId, runId: childRunId,
        rootCreatedAt: startedAt,
      })
      const inheritedTaskIds = new Set(checkpoint.body.acceptedArtifacts.map(value => value.taskId))
      const newAccepted = child.state.journal
        .filter(event => event.type === 'task.accepted')
        .map(event => (event.payload as { artifact: { taskId: string } }).artifact.taskId)
      expect(newAccepted.every(taskId => !inheritedTaskIds.has(taskId))).toBe(true)
    }
    expect(parentMachine.snapshot()).toEqual(immutableParent)
  })

  it('refuses tampered checkpoints and duplicate child identities', async () => {
    const { outcome } = await execute('tamper-parent')
    const checkpoint = outcome.checkpoints[2]!
    const tampered = structuredClone(checkpoint)
    tampered.body.cursor = { stageIndex: 5, waveIndex: 0 }
    await expect(RunMachine.resume(audit0Definition, tampered, 'tamper-child')).rejects.toThrow('digest mismatch')
    await expect(RunMachine.resume(audit0Definition, checkpoint, 'existing-child', new Set(['existing-child'])))
      .rejects.toThrow('already exists')
  })

  it('stops only after a sealed wave and resumes that checkpoint as a fresh child', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const parent = await RunMachine.create(audit0Definition, pkg.digest, 'stop-parent', '2026-09-18T20:00:00.000Z')
    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine: parent,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    })
    const checkpoint = parent.snapshot().checkpoints.at(-1)
    expect(checkpoint).toBeDefined()
    await parent.stop('operator-requested-stop-at-sealed-wave-boundary')
    expect(parent.snapshot()).toMatchObject({
      status: 'stopped',
      cursor: checkpoint!.body.cursor,
      terminalReason: 'operator-requested-stop-at-sealed-wave-boundary',
    })
    const child = await RunMachine.resume(audit0Definition, checkpoint!, 'stop-child', new Set(['stop-parent']))
    expect(child.snapshot()).toMatchObject({
      status: 'created', parentRunId: 'stop-parent', parentCheckpointDigest: checkpoint!.digest,
      runId: 'stop-child', recoveryEpoch: 1,
      rootCreatedAt: '2026-09-18T20:00:00.000Z',
    })
  })

  it('does not seal an incomplete required Codex wave', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, pkg.digest, 'failed-wave', '2026-09-18T20:00:00.000Z')
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

  it('records a time amendment when delayed checkpoint recovery rebases the current phase clock', async () => {
    const pkg = await sealReleasePackage(audit0PackageBody)
    const parent = await RunMachine.create(audit0Definition, pkg.digest, 'amend-parent', '2026-09-19T08:00:00.000Z')
    await advanceExperimentOneWave({
      definition: audit0Definition,
      machine: parent,
      provider: new DeterministicAuditProvider(),
      artifactStore: new MemoryArtifactStore(),
    })
    const checkpoint = parent.snapshot().checkpoints.at(-1)!
    const previousModelStartedAt = checkpoint.body.modelStartedAt!
    const amendedAt = new Date(Date.parse(previousModelStartedAt)
      + (audit0Definition.limits.phaseMinutes.discovery + 1) * 60_000).toISOString()
    const amendment = expiredResumeClockAmendment(audit0Definition, checkpoint, amendedAt)!
    const child = await RunMachine.resume(audit0Definition, checkpoint, 'amend-child', new Set(), amendedAt, amendment)
    expect(child.snapshot()).toMatchObject({ modelStartedAt: amendedAt, parentCheckpointDigest: checkpoint.digest })
    expect(child.snapshot().journal.find(event => event.type === 'run.time-amended')?.payload).toEqual(amendment)
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

  it('rejects a final structured handoff that drops a retained reference', async () => {
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
    await expect(execute('dropped-reference', provider)).rejects.toThrow('output correction exhausted after 10 turns')
  })

  it('resumes a second generation from its immediate sealed parent without replaying inherited work', async () => {
    const parent = await execute('nested-parent')
    const afterDiscovery = parent.outcome.checkpoints.find(checkpoint => checkpoint.body.cursor.stageIndex === 2 && checkpoint.body.cursor.waveIndex === 0)!
    const childMachine = await RunMachine.resume(audit0Definition, afterDiscovery, 'nested-child')
    const child = await runExperiment({
      definition: audit0Definition, machine: childMachine,
      provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy,
    })
    const beforeReporting = child.checkpoints.findLast(checkpoint => checkpoint.body.cursor.stageIndex === 6)!
    const grandchildMachine = await RunMachine.resume(audit0Definition, beforeReporting, 'nested-grandchild')
    expect(grandchildMachine.snapshot()).toMatchObject({
      rootRunId: 'nested-parent', parentRunId: 'nested-child', recoveryEpoch: 2,
      parentCheckpointDigest: beforeReporting.digest,
    })
    const inherited = new Set(beforeReporting.body.acceptedArtifacts.map(value => value.taskId))
    const grandchild = await runExperiment({
      definition: audit0Definition, machine: grandchildMachine,
      provider: new DeterministicAuditProvider(), artifactStore: new MemoryArtifactStore(), policy: audit0RunPolicy,
    })
    const newlyAccepted = grandchild.state.journal.filter(event => event.type === 'task.accepted')
      .map(event => (event.payload as { artifact: ArtifactRecord }).artifact.taskId)
    expect(newlyAccepted).toEqual(['seal-final'])
    expect(newlyAccepted.every(taskId => !inherited.has(taskId))).toBe(true)
  })

  it('rejects internally rehashed checkpoint frontier changes and journal mutations', async () => {
    const { outcome } = await execute('semantic-tamper-parent')
    const checkpoint = outcome.checkpoints.find(value => value.body.cursor.stageIndex === 2 && value.body.cursor.waveIndex === 0)!
    const rehashed = structuredClone(checkpoint)
    const removed = rehashed.body.acceptedArtifacts.find(value => value.taskId === 'core-wave-0-research-1')!
    rehashed.body.acceptedArtifacts = rehashed.body.acceptedArtifacts.filter(value => value !== removed)
    rehashed.digest = await sha256(rehashed.body)
    await expect(RunMachine.resume(audit0Definition, rehashed, 'semantic-tamper-child'))
      .rejects.toThrow('discovery cohort discovery/wave-0/luna has an invalid terminal set')

    const changedReceipt = structuredClone(checkpoint)
    const receipt = changedReceipt.body.stageEndReceipts.find(value => value.reason === 'two-distinct-complete-saturation-cohorts')!
    const evidence = receipt.evidence as { pools: Array<{ quietCohorts: number }> }
    evidence.pools[0]!.quietCohorts += 1
    receipt.evidenceDigest = await sha256(receipt.evidence)
    changedReceipt.digest = await sha256(changedReceipt.body)
    await expect(RunMachine.resume(audit0Definition, changedReceipt, 'receipt-tamper-child'))
      .rejects.toThrow('independent discovery saturation receipt is invalid')

    const changedSaturation = structuredClone(checkpoint)
    changedSaturation.body.acceptedArtifacts.find(value => (
      value.protocol.research?.materialHighCriticalDelta === false
    ))!
      .protocol.research!.materialHighCriticalDelta = true
    changedSaturation.digest = await sha256(changedSaturation.body)
    await expect(RunMachine.resume(audit0Definition, changedSaturation, 'saturation-tamper-child'))
      .rejects.toThrow('checkpoint wave timing receipt is invalid')

    const changedBudget = structuredClone(checkpoint)
    changedBudget.body.budget.inputTokens += 1
    changedBudget.digest = await sha256(changedBudget.body)
    await expect(RunMachine.resume(audit0Definition, changedBudget, 'budget-tamper-child'))
      .rejects.toThrow('checkpoint budget does not match its accepted and rejected attempt evidence')

    const changedProvider = structuredClone(checkpoint)
    changedProvider.body.acceptedArtifacts[0]!.provider = 'unattested-provider'
    changedProvider.digest = await sha256(changedProvider.body)
    await expect(RunMachine.resume(audit0Definition, changedProvider, 'provider-tamper-child'))
      .rejects.toThrow('checkpoint artifact identity is invalid')

    const reportingCheckpoint = outcome.checkpoints.findLast(value => value.body.cursor.stageIndex === 6)!
    const changedReviewInput = structuredClone(reportingCheckpoint)
    changedReviewInput.body.acceptedArtifacts.find(value => value.taskId === 'negative-review-primary')!
      .protocol.reviewInputDigest = 'd'.repeat(64)
    changedReviewInput.digest = await sha256(changedReviewInput.body)
    await expect(RunMachine.resume(audit0Definition, changedReviewInput, 'review-input-tamper-child'))
      .rejects.toThrow('checkpoint review does not bind the reconstructed frozen input')

    const state = structuredClone(outcome.state)
    state.journal[1]!.previousDigest = 'f'.repeat(64)
    await expect(RunMachine.fromState(audit0Definition, state)).rejects.toThrow('run journal chain is invalid')
  })
})
