import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { AgentProvider, AgentResult, TaskDefinition } from '../src/contracts.js'
import {
  RunMachine, acceptedMountMode, agentWorkingDirectory, createAudit0RunPolicy, discoveryResearchPromptPath, SUBMISSION_PATH, submissionTemplate, sealReleasePackage, validateExperiment,
} from '../src/index.js'
import { audit0Definition, audit0PackageBody } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const startedAt = '2026-09-18T20:00:00.000Z'

function task(promptKind: TaskDefinition['promptKind']): Pick<TaskDefinition, 'promptKind'> {
  return { promptKind }
}

function challenge(id: string): TaskDefinition {
  const task = audit0Definition.stages
    .flatMap(stage => stage.waves)
    .flatMap(wave => wave.tasks)
    .find(candidate => candidate.id === id)
  if (task === undefined) throw new Error(`missing challenge fixture: ${id}`)
  return task
}

describe('Cloudflare live-readiness boundaries', () => {
  it('mounts only the information each reasoning lane is allowed to see', () => {
    expect(acceptedMountMode(task('research'))).toBe('research-frontier')
    expect(acceptedMountMode(task('negative-review'))).toBe('negative-review-packet-only')
    expect(acceptedMountMode(task('synthesis'))).toBe('full-frontier')
    expect(acceptedMountMode(task('verification'))).toBe('full-frontier')
    expect(acceptedMountMode(task('reporting'))).toBe('full-frontier')
    expect(acceptedMountMode(task('coverage-challenge'))).toBe('none')
    expect(acceptedMountMode(task('coverage-union'))).toBe('none')
  })

  it('keeps every model pool in a separate synthesis input path', () => {
    const artifact = (taskId: string, provider: string) => ({
      stageId: 'discovery', taskId, provider,
    })
    expect(discoveryResearchPromptPath(artifact('core-wave-1-research-1', 'codex'), 'waves/wave-1/research-1.md'))
      .toBe('waves/wave-1/research-1.md')
    expect(discoveryResearchPromptPath(artifact('additive-wave-1-research-1', 'deepseek-official'), 'waves/wave-1/research-1.md'))
      .toBe('deepseek-waves/wave-1/research-1.md')
    expect(discoveryResearchPromptPath(artifact('additive-wave-1-research-1', 'provider-a'), 'waves/wave-1/research-1.md'))
      .toBe('deepseek-waves/wave-1/research-1.md')
    expect(discoveryResearchPromptPath(artifact('pool-terra-wave-1-research-1', 'codex'), 'waves/wave-1/research-1.md'))
      .toBe('terra-waves/wave-1/research-1.md')
  })

  it('runs relative artifact producers from the results workspace', () => {
    expect(agentWorkingDirectory('synthesis')).toBe('/workspace/results')
    expect(agentWorkingDirectory('verification')).toBe('/workspace/results')
    expect(agentWorkingDirectory('reporting')).toBe('/workspace/results')
    expect(agentWorkingDirectory('research')).toBe('/workspace/source')
    expect(agentWorkingDirectory('coverage-challenge')).toBe('/workspace/source')
  })

  it('seeds one role-specific structured template after stale output cleanup', async () => {
    const source = await readFile(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
    const cleanupAt = source.indexOf('await clearUntrustedTaskOutputs(')
    const templateAt = source.indexOf('const template = submissionTemplate(request.task)')
    expect(cleanupAt).toBeGreaterThan(-1)
    expect(templateAt).toBeGreaterThan(cleanupAt)
    expect(submissionTemplate(challenge('challenge-open-adversarial'))).toContain('"complete": false')
    expect(challenge('challenge-open-adversarial').output.requiredFiles).toContain(SUBMISSION_PATH)
  })

  it('rejects unsafe output contracts before a sandbox is created', () => {
    const definition = structuredClone(audit0Definition)
    definition.stages[0]!.waves[0]!.tasks[0]!.output.requiredFiles = ['../escape']
    expect(() => validateExperiment(definition)).toThrow('unsafe output path')
  })

  it('makes created output directories writable before dropping agent privilege', async () => {
    const source = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
    const mkdirAt = source.indexOf('await mkdir(directory, { recursive: true })')
    const chownAt = source.indexOf('await chown(directory, 10001, 10001)')
    const privilegeDropAt = source.indexOf("execution = await execute('setpriv'")
    expect(mkdirAt).toBeGreaterThan(-1)
    expect(chownAt).toBeGreaterThan(mkdirAt)
    expect(privilegeDropAt).toBeGreaterThan(chownAt)
  })

  it('reattaches an exact process and starts paid work only after guarded setup is ready', async () => {
    const source = await readFile(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
    const exactReceiptAt = source.indexOf('classifyAgentExecutionReceipt(file.content, requestDigest)')
    const lookupAt = source.indexOf('sandbox.getProcess(processId)')
    const holderAt = source.indexOf('sandbox.startProcess(guardedLaunch')
    const clearAt = source.indexOf('rm -f ${resultPath}')
    const readyAt = source.indexOf("sandbox.writeFile(launchReadyPath, 'ready')")
    const monitorAt = source.indexOf('this.ensureAgentLogRequest(request, requestDigest, admittedAt)')
    expect(exactReceiptAt).toBeGreaterThan(-1)
    expect(lookupAt).toBeGreaterThan(exactReceiptAt)
    expect(holderAt).toBeGreaterThan(lookupAt)
    expect(clearAt).toBeGreaterThan(holderAt)
    expect(readyAt).toBeGreaterThan(clearAt)
    expect(monitorAt).toBeGreaterThan(readyAt)
    expect(source).toContain('processId = agentProcessId(requestDigest)')
    expect(source).toContain('request.inputDigest === undefined')
    expect(source).toContain('autoCleanup: false')
    expect(source).toContain('waitForAgentProcess(process, agentProcessWaitSliceMs, 1_000, {')
    expect(source).toContain('agentLogReadMaxBytes = 256 * 1024')
    expect(source).not.toContain('sandbox.readFile(logPath)')
    const durableReceiptAt = source.indexOf('this.executionReceipts.put(request.runId, requestDigest, result, request)')
    const finalDrainAt = source.indexOf('this.drainAgentLogs(sandbox, request, requestDigest)', durableReceiptAt)
    expect(finalDrainAt).toBeGreaterThan(durableReceiptAt)
  })

  it('does not attach a fixed lifetime deadline to admitted agent execution', async () => {
    const source = await readFile(new URL('../src/sandbox-provider.ts', import.meta.url), 'utf8')
    expect(source).toContain("if (exitCode === 'running')")
    expect(source).toContain("if (exitCode === 'unavailable') throw new AgentObservationExpired")
    expect(source).not.toContain('executionDeadlineAt')
    expect(source).not.toContain('phaseDeadlineAt')
  })

  it('uses measured admission rather than treating the configured topology as a discovery-round target', async () => {
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      async run(request): Promise<AgentResult> {
        const result = await base.run(request)
        if (request.task.promptKind !== 'research' || result.protocol.research === undefined) return result
        const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as Record<string, unknown>
        submission.materialHighCriticalDelta = true
        return {
          ...result,
          files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
          protocol: { research: { ...result.protocol.research, materialHighCriticalDelta: true } },
        }
      },
    }
    const release = await sealReleasePackage(audit0PackageBody)
    const machine = await RunMachine.create(audit0Definition, release.digest, 'discovery-exhaustion', startedAt)
    const outcome = await runExperiment({
      definition: audit0Definition,
      machine,
      provider,
      artifactStore: new MemoryArtifactStore(),
      policy: createAudit0RunPolicy(),
    })

    const state = machine.snapshot()
    expect(outcome.state.status).toBe('completed')
    expect(state.stageEndReceipts.find(receipt => receipt.stageIndex === 1)?.reason).toBe('measured-budget-inability')
    expect(new Set(state.artifacts.filter(artifact => artifact.stageId === 'discovery').map(artifact => artifact.waveId)).size)
      .toBeLessThan(audit0Definition.discoverySafetyCeiling)
    const discoveryCheckpoint = state.checkpoints.find(checkpoint => (
      checkpoint.body.cursor.stageIndex === 2 && checkpoint.body.cursor.waveIndex === 0
    ))!
    const resumed = await RunMachine.resume(audit0Definition, discoveryCheckpoint, 'budget-admission-child')
    expect(resumed.snapshot()).toMatchObject({
      phase: 'synthesis', parentCheckpointDigest: discoveryCheckpoint.digest,
    })
  })

  it('seals a deterministic receipt when the configured discovery safety ceiling is reached', async () => {
    const definition = structuredClone(audit0Definition)
    const discovery = definition.stages.find(stage => stage.kind === 'discovery')!
    discovery.waves = discovery.waves.slice(0, 4)
    definition.discoverySafetyCeiling = discovery.waves.length
    definition.limits.maxModelCalls = 512
    const base = new DeterministicAuditProvider()
    const provider: AgentProvider = {
      async run(request): Promise<AgentResult> {
        const result = await base.run(request)
        if (request.task.promptKind !== 'research' || result.protocol.research === undefined) return result
        const submission = JSON.parse(result.files[SUBMISSION_PATH]!) as Record<string, unknown>
        submission.materialHighCriticalDelta = true
        return {
          ...result,
          files: { ...result.files, [SUBMISSION_PATH]: JSON.stringify(submission) },
          protocol: { research: { ...result.protocol.research, materialHighCriticalDelta: true } },
        }
      },
    }
    const machine = await RunMachine.create(definition, 'd'.repeat(64), 'safety-ceiling-fixture')
    const outcome = await runExperiment({
      definition, machine, provider, artifactStore: new MemoryArtifactStore(), policy: createAudit0RunPolicy(),
    })

    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.stageEndReceipts.find(receipt => receipt.stageIndex === 1)).toMatchObject({
      reason: 'safety-ceiling-reached',
      evidence: {
        configuredWaves: 4,
        pools: expect.arrayContaining([
          expect.objectContaining({ poolId: 'luna', completedWaves: 4 }),
          expect.objectContaining({ poolId: 'deepseek', completedWaves: 4 }),
        ]),
      },
    })
    const checkpoint = outcome.checkpoints.find(candidate => (
      candidate.body.cursor.stageIndex === 2 && candidate.body.cursor.waveIndex === 0
      && candidate.body.stageEndReceipts.some(receipt => receipt.reason === 'safety-ceiling-reached')
    ))!
    await expect(RunMachine.resume(definition, checkpoint, 'safety-ceiling-child')).resolves.toBeDefined()
  })
})
