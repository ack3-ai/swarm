import { describe, expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import { compileExperimentConfig } from '../src/config-compiler.js'
import type { AgentRequest, AgentResult, ArtifactRecord, AuditStageKind, ExperimentDefinition, TaskDefinition } from '../src/contracts.js'
import { sealReleasePackage } from '../src/release.js'
import { validateExperiment } from '../src/validation.js'
import { renderSameSessionOutputCorrection, renderTaskPrompt, selectVisibleArtifacts } from '../src/prompts.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import { validateAgentResultDetailed, validateExecutionResult } from '../src/protocol-validation.js'
import { writeAccepted } from '../src/accepted-mounts.js'
import { discoveryDeadline } from '../src/discovery-clock.js'
import { createAudit0RunPolicy } from '../src/runner.js'
import { providerIdentity } from '../src/provider-identity.js'
import {
  DEFAULT_RECON_INSTRUCTIONS, DEFAULT_RECON_NOTES, DEFAULT_RECON_PRIVACY, RECON_FILE_MAX_BYTES, RECON_FILES,
  RECON_INDEX_PATH, RECON_INSTRUCTION_KEYS, isDiscoveryFrontierArtifact, reconFileIssues,
} from '../src/recon.js'
import { createControlledMachine } from './support/controlled-machine.js'
import { DeterministicAuditProvider, deterministicReconQueries } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore, runExperiment } from './support/memory-runner.js'

const { nativeSearch: _disabled, ...searchable } = document
const deadline = '2026-09-29T00:00:00.000Z'

function config(stages: readonly AuditStageKind[], backend: 'codex' | 'dsh-chat-completions' = 'codex', extra: Record<string, unknown> = {}) {
  const pool = { ...document.modelPools.find(pool => pool.backend === backend)!, agents: 1, required: true,
    subagents: { default: { mode: 'disabled' } } }
  return { ...searchable, stages, maxDiscoveryWaves: 2, stopOnSaturation: false, modelPools: [pool],
    stageModelPools: Object.fromEntries(stages.filter(stage => !['discovery', 'recon'].includes(stage)).map(stage => [stage, pool.id])),
    ...extra }
}
const compile = (value: unknown, promptFile: unknown = prompts, scope?: string) => compileExperimentConfig(value, promptFile, scope).definition
const allTasks = (definition: ExperimentDefinition) => definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
const reconTask = (definition: ExperimentDefinition) => allTasks(definition).find(task => task.promptKind === 'recon')!
const discoveryTask = (definition: ExperimentDefinition, wave = 0) => definition.stages.find(stage => stage.kind === 'discovery')!
  .waves[wave]!.tasks[0]!

const files = (overrides: Record<string, string> = {}) => ({
  'recon/index.md': '# Recon\n\n- [project.md](project.md): specs\n- [dependencies.md](./dependencies.md): versions\n- [attacks](/workspace/accepted/recon/attacks.md): incidents\n',
  'recon/project.md': '# Project\n', 'recon/dependencies.md': '# Dependencies\n', 'recon/attacks.md': '# Attacks\n',
  [SUBMISSION_PATH]: JSON.stringify({ complete: true, researchQueries: ['solidity erc4626 advisories'] }),
  ...overrides,
})
const evidence = (queries: readonly string[]) => ({ schemaVersion: 1 as const, source: 'codex-exa' as const, failed: 0, incomplete: 0,
  completed: queries.map((query, index) => ({ callId: `call-${index}`, queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64), queries: [query] })) })
function result(task: TaskDefinition, output: Record<string, string>, queries: readonly string[] | null): AgentResult {
  return { status: 'accepted', actorId: 'session-recon', sessionId: 'session-recon', model: task.model, provider: providerIdentity(task),
    files: output, assertions: [], protocol: { recon: { researchQueries: ['solidity erc4626 advisories'] } },
    inputTokens: 1, outputTokens: 1, costUsd: 0, ...(queries === null ? {} : { nativeSearchEvidence: evidence(queries) }) }
}
function reconArtifact(task: TaskDefinition): ArtifactRecord {
  return { id: 'recon/recon/digest', stageId: 'recon', waveId: 'web-research', taskId: 'recon', status: 'accepted', actorId: 'session-recon',
    model: task.model, provider: providerIdentity(task), promptDigest: 'a'.repeat(64), contentDigest: 'c'.repeat(64), uri: 'fixture://recon',
    files: Object.keys(files()), assertions: [], protocol: { recon: { researchQueries: ['solidity erc4626 advisories'] } },
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 } }
}

describe('recon stage', () => {
  it('leaves releases without recon unchanged, even when the prompt file carries recon overrides', async () => {
    const plain = compileExperimentConfig(config(['discovery', 'synthesis']), prompts)
    const overridden = compileExperimentConfig(config(['discovery', 'synthesis']),
      { ...prompts, instructions: { reconNotes: 'Custom note.', reconPrivacy: 'Public target: names allowed.' } })
    expect((await sealReleasePackage(overridden)).digest).toBe((await sealReleasePackage(plain)).digest)
    for (const key of RECON_INSTRUCTION_KEYS) expect(plain.definition.prompts).not.toHaveProperty(key)
    expect(discoveryTask(plain.definition).visibility).toBe('none')
    const prompt = renderTaskPrompt({ definition: plain.definition, task: discoveryTask(plain.definition), stageKind: 'discovery', visibleArtifacts: [], deadline })
    expect(prompt).not.toContain('Recon notes')
    expect(plain.definition.stagePrompts).not.toHaveProperty('recon')
  })

  it('seals one recon task before discovery with defaults, overrides and the first required pool', () => {
    const definition = compile(config(['recon', 'discovery', 'synthesis']))
    expect(definition.stages.map(stage => stage.kind)).toEqual(['preflight', 'recon', 'discovery', 'synthesis'])
    const task = reconTask(definition)
    expect(task).toMatchObject({ id: 'recon', promptKind: 'recon', logicalRole: 'security-researcher', visibility: 'none',
      workspaceMode: 'fresh-pristine', retryPolicy: 'same-session-repair', modelPool: definition.pools[0]!.id,
      output: { schema: 'ack3.recon.policy-v1', requiredFiles: [...RECON_FILES, SUBMISSION_PATH] } })
    expect(definition.prompts).toMatchObject({ reconInstructions: DEFAULT_RECON_INSTRUCTIONS, reconNotes: DEFAULT_RECON_NOTES })
    expect(discoveryTask(definition).visibility).toBe('accepted-frontier')
    const custom = compile(config(['recon', 'discovery']), { ...prompts, instructions: { reconPrivacy: 'Public target: its name may appear in queries.' } })
    expect(custom.prompts.reconPrivacy).toBe('Public target: its name may appear in queries.')
    const dsh = compile(config(['recon', 'discovery'], 'dsh-chat-completions'))
    expect(reconTask(dsh).retryPolicy).toBe('fresh-repair')
  })

  it.each([
    [['discovery', 'recon']], [['recon', 'recon', 'discovery']], [['recon', 'synthesis', 'discovery']], [['recon']],
  ])('rejects stage selection %j', stages => {
    expect(() => compile(config(stages as AuditStageKind[]))).toThrow(/recon|discovery/)
  })

  it('rejects recon without native search, a missing recon prompt, or an unknown recon pool', () => {
    expect(() => compile({ ...config(['recon', 'discovery']), nativeSearch: false })).toThrow('recon requires native search')
    const { recon: _recon, ...withoutRecon } = prompts
    expect(() => compile(config(['recon', 'discovery']), withoutRecon)).toThrow('prompt file is missing recon')
    expect(() => compile(config(['recon', 'discovery'], 'codex', { stageModelPools: { recon: 'unknown' } }))).toThrow('stageModelPools.recon')
  })

  it('validates recon instructions and native search in stored releases', () => {
    const definition = compile(config(['recon', 'discovery']))
    expect(() => validateExperiment(definition)).not.toThrow()
    const { reconNotes: _notes, ...missing } = definition.prompts
    expect(() => validateExperiment({ ...definition, prompts: missing })).toThrow('recon instructions')
    const { nativeSearch: _search, ...unsearched } = definition
    expect(() => validateExperiment(unsearched)).toThrow('recon requires native search')
    const plain = compile(config(['discovery']))
    expect(() => validateExperiment({ ...plain, prompts: { ...plain.prompts, reconNotes: 'x' } })).toThrow('recon instructions require a recon stage')
  })

  it('renders short recon steps with recon search privacy and points discovery at the notes', () => {
    const definition = compile(config(['recon', 'discovery']))
    const prompt = renderTaskPrompt({ definition, task: reconTask(definition), stageKind: 'recon', visibleArtifacts: [], deadline })
    for (const path of RECON_FILES) expect(prompt).toContain(`/workspace/results/${path}`)
    expect(prompt).toContain('10. Keep each file under 32 KB.')
    expect(prompt).toContain(DEFAULT_RECON_PRIVACY)
    expect(prompt).toContain('web_search_exa')
    expect(prompt).not.toContain(definition.prompts.searchPrivacy)
    expect(prompt).toContain('{"complete":true,"researchQueries":["..."]}')
    expect(prompt).toContain(`each file at most ${RECON_FILE_MAX_BYTES}`)
    expect(prompt).toContain(`Stage instructions:\n${prompts.recon}`)
    const research = renderTaskPrompt({ definition, task: discoveryTask(definition), stageKind: 'discovery', visibleArtifacts: [], deadline })
    expect(research).toContain(`Recon notes: ${RECON_INDEX_PATH}\n${DEFAULT_RECON_NOTES}`)
  })

  it('gives a scoped recon the scope text without the bug-hunting scope rules', () => {
    const definition = compile({ ...config(['recon', 'discovery']), scopeFile: 'scope.md' }, prompts, 'In scope: src/HelloVault.sol')
    const prompt = renderTaskPrompt({ definition, task: reconTask(definition), stageKind: 'recon', visibleArtifacts: [], deadline })
    expect(prompt).toContain('In scope: src/HelloVault.sol\nEnd of audit scope.')
    expect(prompt).not.toContain(definition.prompts.scopeRules!)
    expect(prompt).not.toContain(definition.prompts.scopeReminder!)
    const research = renderTaskPrompt({ definition, task: discoveryTask(definition), stageKind: 'discovery', visibleArtifacts: [], deadline })
    expect(research).toContain(definition.prompts.scopeRules!)
  })

  it('parses the minimal submission and checks file size and index links', async () => {
    const task = reconTask(compile(config(['recon', 'discovery'])))
    expect(await readSubmission(task, files(), [])).toEqual({ protocol: { recon: { researchQueries: ['solidity erc4626 advisories'] } }, issues: [] })
    const empty = await readSubmission(task, files({ [SUBMISSION_PATH]: '{"complete":true,"researchQueries":[]}' }), [])
    expect(empty.protocol).toEqual({})
    expect(empty.issues.join('\n')).toContain('researchQueries')
    const extra = await readSubmission(task, files({ [SUBMISSION_PATH]: '{"complete":true,"researchQueries":["q"],"findings":[]}' }), [])
    expect(extra.issues.join('\n')).toContain('unexpected: findings')
    expect(reconFileIssues(files())).toEqual([])
    const issues = reconFileIssues(files({ 'recon/index.md': '# Recon\n\nSee [project.md](project.md).\n', 'recon/attacks.md': 'x'.repeat(RECON_FILE_MAX_BYTES + 1) }))
    expect(issues).toEqual([
      `recon file is too large: recon/attacks.md has ${RECON_FILE_MAX_BYTES + 1} bytes; shorten it to at most ${RECON_FILE_MAX_BYTES} bytes`,
      'recon/index.md must link recon/dependencies.md, for example [dependencies.md](dependencies.md)',
      'recon/index.md must link recon/attacks.md, for example [attacks.md](attacks.md)',
    ])
    const detailed = await validateAgentResultDetailed(task, result(task, files({ 'recon/index.md': '# Recon\n' }), []), [])
    expect(detailed.repairable).toContain('recon/index.md must link recon/project.md, for example [project.md](project.md)')
    expect(detailed.integrity).toEqual([])
  })

  it('requires a cited successful search for recon even when forceSearch is off', async () => {
    const definition = compile(config(['recon', 'discovery']))
    expect(definition.forceSearch).toBeUndefined()
    const task = reconTask(definition)
    const stage = definition.stages.find(value => value.kind === 'recon')!
    const request = { task, stage, visibleArtifacts: [], continuationMode: 'new' as const, sessionId: null }
    expect((await validateExecutionResult(definition, request, result(task, files(), ['solidity erc4626 advisories']))).issues).toEqual([])
    expect((await validateExecutionResult(definition, request, result(task, files(), null))).issues.join('\n'))
      .toContain('missing native search evidence')
    expect((await validateExecutionResult(definition, request, result(task, files(), ['another query']))).issues.join('\n'))
      .toContain('native search citation mismatch')
  })

  it('shows the recon notes to wave-zero discovery and mounts them at fixed paths', async () => {
    const definition = compile(config(['recon', 'discovery', 'synthesis']))
    const recon = reconArtifact(reconTask(definition))
    expect(isDiscoveryFrontierArtifact(recon)).toBe(true)
    expect(isDiscoveryFrontierArtifact({ ...recon, status: 'additive-unavailable' })).toBe(false)
    const receipts = [{ stageId: 'recon', waveId: 'web-research', artifactRefs: [{ id: recon.id, contentDigest: recon.contentDigest }],
      artifactDigests: [recon.contentDigest], startedAt: deadline, completedAt: deadline, durationMs: 0 }]
    expect(selectVisibleArtifacts(discoveryTask(definition), [recon], receipts, 2, 0, definition)).toEqual([recon])
    for (const task of [discoveryTask(definition), allTasks(definition).find(task => task.promptKind === 'synthesis')!]) {
      const written = new Map<string, string>()
      const sandbox = { async exec() {}, async mkdir() {}, async writeFile(path: string, content: string) { written.set(path, content) } }
      await writeAccepted(sandbox, { task, visibleArtifacts: [recon] }, { async read() { return files() } })
      for (const path of RECON_FILES) expect(written.get(`/workspace/accepted/${path}`)).toBe(files()[path])
      expect(written.has('/workspace/accepted/recon/.swarm/submission.json')).toBe(false)
    }
  })

  it('starts the discovery window when recon ends', () => {
    const definition = compile(config(['recon', 'discovery']))
    const minutes = (value: number) => new Date(Date.parse(deadline) + value * 60_000).toISOString()
    const state = { modelStartedAt: minutes(0), rootCreatedAt: minutes(-5), artifacts: [], rejectedAttempts: [] }
    const window = definition.limits.phaseMinutes.discovery * 60_000
    expect(discoveryDeadline(definition, { ...state, stageEndReceipts: [] })).toBe(Date.parse(minutes(0)) + window)
    const receipt = (stageIndex: number, at: number) => ({ stageIndex, endedAt: minutes(at) }) as any
    expect(discoveryDeadline(definition, { ...state, stageEndReceipts: [receipt(0, 0), receipt(1, 25)] }))
      .toBe(Date.parse(minutes(25)) + window)
    const plain = compile(config(['discovery']))
    expect(discoveryDeadline(plain, { ...state, stageEndReceipts: [receipt(0, 0), receipt(1, 25)] })).toBe(Date.parse(minutes(0)) + window)
  })

  it.each(['codex', 'dsh-chat-completions'] as const)('runs recon before discovery end to end with %s', async backend => {
    const body = compileExperimentConfig(config(['recon', 'discovery', 'synthesis', 'verification', 'reporting'], backend), prompts)
    const release = await sealReleasePackage(body)
    const machine = await createControlledMachine(body.definition, release.digest, `recon-${backend}`)
    const calls: AgentRequest[] = []
    const provider = new DeterministicAuditProvider()
    const outcome = await runExperiment({ definition: body.definition, machine, artifactStore: new MemoryArtifactStore(),
      provider: { run: async request => { calls.push(request); return provider.run(request) }, disposeWorkspace: async () => {} },
      policy: createAudit0RunPolicy() })
    expect(outcome.state.status).toBe('completed')
    expect(outcome.state.stageEndReceipts.map(receipt => receipt.from))
      .toEqual(['preparation', 'recon', 'discovery', 'synthesis', 'verification', 'reporting'])
    const models = calls.filter(call => call.task.providerClass !== 'deterministic')
    expect(models[0]!.task.promptKind).toBe('recon')
    expect(models[0]!.visibleArtifacts).toEqual([])
    const recon = outcome.state.artifacts.find(artifact => artifact.taskId === 'recon')!
    expect(recon.protocol).toEqual({ recon: { researchQueries: [...deterministicReconQueries] } })
    for (const call of models.filter(call => call.task.promptKind === 'research')) {
      expect(call.visibleArtifacts.map(artifact => artifact.id)).toContain(recon.id)
      expect(call.prompt).toContain(`Recon notes: ${RECON_INDEX_PATH}`)
    }
    const synthesis = models.find(call => call.task.promptKind === 'synthesis')!
    expect(synthesis.visibleArtifacts.map(artifact => artifact.id)).toContain(recon.id)
  })
})

describe('recon correction turns', () => {
  it('asks recon for a background search, not the bug-hunting search question', () => {
    const definition = compile(config(['recon', 'discovery']))
    const diagnostics = ['recon: missing native search evidence: no successful native search queries recorded in this session.']
    const recon = renderSameSessionOutputCorrection(definition, diagnostics, 'web_search_exa', 'recon')
    expect(recon).toContain('a technology, dependency, version or standard the target uses (never its name)')
    expect(recon).not.toContain('how the mechanism can fail')
    expect(renderSameSessionOutputCorrection(definition, diagnostics, 'web_search_exa', 'research')).toContain('how the mechanism can fail')
  })
})

