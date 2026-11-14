import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { compileExperimentConfig as compile } from '../src/config-compiler.js'
import type { AgentRequest, AgentResult, ArtifactRecord, ExperimentDefinition, TaskDefinition } from '../src/contracts.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { acceptedEvidencePath, researchEvidencePaths, researchIndexPath, writeAccepted } from '../src/accepted-mounts.js'
import { isLateUpstreamHandoffCandidate } from '../src/late-upstream-handoff.js'
import { DEFAULT_POC_CAPTURE, DEFAULT_POC_REVIEW, INSTRUCTION_KEYS, RESEARCH_DELTA_INSTRUCTION_KEYS, SCRATCH_CAPTURE } from '../src/methods/system-prompts.js'
import { executionRequestBody } from '../src/native-request.js'
import { pocBundleDirectory, scratchBundleIssues, scratchBundlePath, scratchRetainedPath } from '../src/poc-handoff.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { providerIdentity } from '../src/provider-identity.js'
import { writeRepairBaseline } from '../src/sandbox-provider.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import { validateExperiment } from '../src/validation.js'
import { mountPocTests } from '../container/mount-tests.mjs'
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const deadline = '2026-11-10T00:00:00.000Z'
const kept = compileExperimentConfig({ ...document, keepPocs: true }).definition
const plain = compileExperimentConfig(document).definition
const entries = (definition: ExperimentDefinition) =>
  definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks.map(task => ({ task, stage, wave }))))
const find = (definition: ExperimentDefinition, id: string) => entries(definition).find(entry => entry.task.id === id)!
const request = (definition: ExperimentDefinition, id: string, overrides: Partial<AgentRequest> = {}): AgentRequest => {
  const { task, stage, wave } = find(definition, id)
  return { experimentId: definition.id, runId: 'poc-run', stage, wave, task, prompt: 'fixture', promptDigest: 'd'.repeat(64),
    visibleArtifacts: [], releaseDigest: 'e'.repeat(64), attempt: 1, diagnostics: [], repairFiles: {}, freshContext: false,
    continuationMode: 'new', sessionId: null, ...overrides } as AgentRequest
}

async function bundle(directory: string, files: readonly [string, string][], omitted: readonly object[] = []) {
  return canonicalJson({ schemaVersion: 1, directory, omitted, files: await Promise.all(files.map(async ([path, content]) => ({
    path, content, bytes: new TextEncoder().encode(content).byteLength, sha256: await sha256(content) }))) })
}

async function artifact(task: TaskDefinition, tests: readonly [string, string][] | undefined) {
  const observations = [{ id: `OBS-X-W${task.research!.wave}-R${task.research!.researcher}-A1`, statement: `lead ${task.id}`,
    conditions: [], consequence: 'loss', evidence: ['source.sol:1'] }]
  const files: Record<string, string> = {
    [task.output.requiredFiles[0]!]: `# Research ${task.id}\n`,
    [SUBMISSION_PATH]: JSON.stringify({ complete: true, materialHighCriticalDelta: false, observations }),
    ...(tests === undefined ? {} : { [scratchBundlePath(task.research!)]: await bundle(task.research!.laneScratchPath, tests) }),
  }
  const contentDigest = await sha256(canonicalJson(files))
  const record: ArtifactRecord = {
    id: `discovery/${task.id}/${contentDigest}`, stageId: 'discovery', waveId: `wave-${task.research!.wave}`, taskId: task.id,
    status: 'accepted', actorId: 'synthetic', provider: providerIdentity(task), model: task.model, promptDigest: 'a'.repeat(64),
    contentDigest, uri: `fixture://${contentDigest}`, files: Object.keys(files).toSorted(), assertions: [],
    protocol: { research: { role: task.research!.role, buildsOn: task.research!.buildsOn, nextExperiment: 'none',
      materialHighCriticalDelta: false, observations } },
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  }
  return { record, files }
}

function workspace() {
  const files = new Map<string, string>()
  const commands: string[] = []
  return {
    files, commands,
    async exec(command: string) {
      commands.push(command)
      return { success: true, exitCode: 0, command, stdout: '', stderr: '' }
    },
    async mkdir() {},
    async writeFile(path: string, content: string) { files.set(path, content) },
  }
}

async function mount(task: TaskDefinition, artifacts: readonly Awaited<ReturnType<typeof artifact>>[], pocTests = false) {
  const sandbox = workspace()
  await writeAccepted(sandbox, { task, visibleArtifacts: artifacts.map(value => value.record) }, {
    async read(record) { return artifacts.find(value => value.record === record)!.files },
  }, { pocTests })
  return sandbox
}

describe('discovery PoC tests for the verifier (keepPocs)', () => {
  it('leaves a release without keepPocs unchanged', () => {
    expect(compileExperimentConfig({ ...document, keepPocs: false })).toEqual(compileExperimentConfig(document))
    expect(canonicalJson(plain)).not.toMatch(/scratchCapture|pocCapture|pocReview/)
    expect(Object.keys(plain.prompts).toSorted()).toEqual([...INSTRUCTION_KEYS, ...RESEARCH_DELTA_INSTRUCTION_KEYS].toSorted())
    const unused = compile(document, { ...prompts, instructions: { pocCapture: 'x', pocReview: 'y' } }).definition
    expect(unused).toEqual(plain)
    for (const { task, stage } of entries(plain)) {
      const prompt = renderTaskPrompt({ definition: plain, task, stageKind: stage.kind, visibleArtifacts: [], deadline })
      expect(prompt).not.toContain('PoC')
    }
    expect(executionRequestBody(request(plain, 'core-wave-0-research-1'), 'workspace')).not.toHaveProperty('scratchCapture')
  })

  it('seals the capture limits and both PoC instructions, and shows them only to research and verification', () => {
    expect(() => validateExperiment(kept)).not.toThrow()
    for (const { task } of entries(kept)) {
      if (task.promptKind === 'research') expect(task.research!.scratchCapture).toEqual(SCRATCH_CAPTURE)
      else expect(task.research).toBeUndefined()
    }
    expect(kept.prompts).toMatchObject({ pocCapture: DEFAULT_POC_CAPTURE, pocReview: DEFAULT_POC_REVIEW })
    for (const text of [DEFAULT_POC_CAPTURE, DEFAULT_POC_REVIEW]) {
      for (const line of text.split('\n').slice(1)) expect(line).toMatch(/^\d\. .{1,200}$/)
    }
    const custom = compile({ ...document, keepPocs: true }, { ...prompts, instructions: { pocCapture: 'Keep tests.', pocReview: 'Judge tests.' } })
    expect(custom.definition.prompts).toMatchObject({ pocCapture: 'Keep tests.', pocReview: 'Judge tests.' })
    for (const { task, stage } of entries(kept)) {
      const prompt = renderTaskPrompt({ definition: kept, task, stageKind: stage.kind, visibleArtifacts: [], deadline })
      expect(prompt.includes(DEFAULT_POC_CAPTURE)).toBe(task.promptKind === 'research')
      expect(prompt.includes(DEFAULT_POC_REVIEW)).toBe(task.promptKind === 'verification')
      if (task.promptKind === 'research') expect(prompt).toContain(`Lane scratch path: ${task.research!.laneScratchPath}`)
    }
  })

  it('rejects invalid keepPocs settings and releases that seal only part of them', () => {
    expect(() => compileExperimentConfig({ ...document, keepPocs: 'yes' })).toThrow('keepPocs must be a boolean')
    for (const stages of [['discovery'], ['discovery', 'synthesis'], ['discovery', 'synthesis', 'coverage']]) {
      expect(() => compileExperimentConfig({ ...document, stages, keepPocs: true }))
        .toThrow('keepPocs requires the discovery and verification stages')
    }
    const tamper = (change: (definition: ExperimentDefinition & Record<string, any>) => void, base = kept) => {
      const value = structuredClone(base) as ExperimentDefinition & Record<string, any>
      change(value)
      return () => validateExperiment(value)
    }
    const research = (value: any) => entries(value).find(entry => entry.task.promptKind === 'research')!.task as any
    expect(tamper(value => { research(value).research.scratchCapture.maxFiles = 129 })).toThrow('sealed PoC capture limits')
    expect(tamper(value => { research(value).research.scratchCapture.extra = 1 })).toThrow('sealed PoC capture limits')
    expect(tamper(value => { research(value).research.laneScratchPath = '/workspace/private' })).toThrow('sealed PoC capture limits')
    expect(tamper(value => { delete research(value).research.scratchCapture })).toThrow('keepPocs must capture every research task')
    expect(tamper(value => { delete value.prompts.pocReview })).toThrow('keepPocs requires non-empty pocCapture and pocReview')
    expect(tamper(value => { value.prompts.pocCapture = ' ' })).toThrow('keepPocs requires non-empty pocCapture and pocReview')
    expect(tamper(value => { value.prompts.pocReview = 'x' }, plain)).toThrow('PoC instructions require keepPocs')
    expect(tamper(value => { research(value).research.scratchCapture = { ...SCRATCH_CAPTURE } }, plain))
      .toThrow('keepPocs must capture every research task')
    expect(tamper(value => {
      for (const { task } of entries(value)) if (task.research !== undefined) (task.research as any).scratchCapture = { ...SCRATCH_CAPTURE }
    }, plain)).toThrow('keepPocs requires non-empty pocCapture and pocReview')
  })

  it('gives the runner a capture contract only for capture-enabled research tasks', () => {
    expect(executionRequestBody(request(kept, 'additive-wave-1-research-2'), 'workspace')).toMatchObject({
      scratchCapture: { directory: '/workspace/source/test/swarm/lane-2', bundlePath: 'waves/wave-1/research-2.tests.json',
        limits: SCRATCH_CAPTURE },
      expectedFiles: ['waves/wave-1/research-2.md', SUBMISSION_PATH],
    })
    expect(executionRequestBody(request(kept, 'verifier'), 'workspace')).not.toHaveProperty('scratchCapture')
  })

  it('accepts only the exact runner bundle for a capture-enabled task', async () => {
    const assignment = find(kept, 'core-wave-0-research-1').task.research!
    const directory = assignment.laneScratchPath
    const good = await bundle(directory, [['A.t.sol', '// A1\n'], ['sub/B.t.sol', 'b']], [{ path: 'x.bin', bytes: 3, reason: 'binary' }])
    expect(await scratchBundleIssues(assignment, good)).toEqual([])
    const parsed = JSON.parse(good)
    const issues = async (value: unknown) => (await scratchBundleIssues(assignment, typeof value === 'string' ? value : canonicalJson(value)))
    const bad: unknown[] = [
      JSON.stringify(parsed, null, 2),
      { ...parsed, directory: '/workspace/source/test/swarm/lane-2' },
      { ...parsed, schemaVersion: 2 },
      { ...parsed, extra: true },
      { ...parsed, files: [...parsed.files].reverse() },
      { ...parsed, files: [{ ...parsed.files[0], sha256: '0'.repeat(64) }] },
      { ...parsed, files: [{ ...parsed.files[0], bytes: 99 }] },
      { ...parsed, files: [{ ...parsed.files[0], path: '../A.t.sol' }] },
      await bundle(directory, [['A.t.sol', 'nul\u0000']]),
      await bundle(directory, [['A.t.sol', 'x'.repeat(SCRATCH_CAPTURE.maxFileBytes + 1)]]),
      await bundle(directory, Array.from({ length: 129 }, (_, index) => [`f${String(index).padStart(3, '0')}`, 'x'] as [string, string])),
      await bundle(directory, Array.from({ length: 5 }, (_, index) => [`f${index}`, 'x'.repeat(SCRATCH_CAPTURE.maxFileBytes)] as [string, string])),
      { ...parsed, omitted: [{ path: 'x.bin', bytes: 3, reason: 'other' }] },
    ]
    for (const value of bad) expect(await issues(value)).toHaveLength(1)
    expect(await scratchBundleIssues(assignment, undefined)).toEqual(['scratch test bundle is missing'])

    const result = async (definition: ExperimentDefinition, withBundle: boolean): Promise<string[]> => {
      const { task } = find(definition, 'core-wave-0-research-1')
      const files: Record<string, string> = {
        'waves/wave-0/research-1.md': '# Research\n',
        [SUBMISSION_PATH]: JSON.stringify({ complete: true, materialHighCriticalDelta: false, observations: [{
          id: 'A1', statement: 'lead', conditions: [], consequence: 'loss', evidence: ['source.sol:1'] }], leadChecks: [], nextExperiment: 'none' }),
        ...(withBundle ? { 'waves/wave-0/research-1.tests.json': good } : {}),
      }
      const { protocol } = await readSubmission(task, files, [])
      const value: AgentResult = { status: 'accepted', actorId: 'actor', model: task.model, provider: providerIdentity(task),
        files, assertions: [], protocol, inputTokens: 1, outputTokens: 1, costUsd: 0 }
      return (await validateAgentResultDetailed(task, value, [])).integrity
    }
    expect(await result(kept, true)).toEqual([])
    expect(await result(kept, false)).toEqual(['scratch test bundle is missing'])
    expect(await result(plain, false)).toEqual([])
    expect(await result(plain, true)).toEqual(['scratch test bundle without keepPocs: waves/wave-0/research-1.tests.json'])
  })

  it('lets a late upstream handoff carry the bundle and keeps the bundle out of a repair workspace', async () => {
    const receipt = (agentRequest: AgentRequest) => ({
      requestDigest: 'c'.repeat(64), exitCode: 1, providerHttpStatus: 504,
      files: { 'waves/wave-0/research-1.md': 'x', [SUBMISSION_PATH]: '{}', 'waves/wave-0/research-1.tests.json': '{}' },
      providerRequests: [{ provider: providerIdentity(agentRequest.task), providerHttpStatus: 504, abortedByClient: false }],
    }) as any
    for (const [definition, expected] of [[kept, true], [plain, false]] as const) {
      const agentRequest = request(definition, 'additive-wave-0-research-1')
      expect(isLateUpstreamHandoffCandidate(agentRequest, receipt(agentRequest), 'c'.repeat(64))).toBe(expected)
    }

    const repairFiles = { 'waves/wave-0/research-1.md': 'draft', [SUBMISSION_PATH]: '{}', 'waves/wave-0/research-1.tests.json': '{}' }
    const sandbox = workspace()
    await writeRepairBaseline(sandbox as any, request(kept, 'core-wave-0-research-1', { repairFiles }))
    expect([...sandbox.files.keys()].toSorted())
      .toEqual([`/workspace/results/${SUBMISSION_PATH}`, '/workspace/results/waves/wave-0/research-1.md'])
    await expect(writeRepairBaseline(workspace() as any, request(plain, 'core-wave-0-research-1', { repairFiles })))
      .rejects.toThrow('repair file is outside output contract: waves/wave-0/research-1.tests.json')
  })

  it('never mounts bundles as research evidence and gives a lane the files its accepted bundles keep', async () => {
    const same = await artifact(find(kept, 'core-wave-0-research-1').task, [['A.t.sol', 'a'], ['B.t.sol', 'b']])
    const otherLane = await artifact(find(kept, 'core-wave-0-research-2').task, [['C.t.sol', 'c']])
    const otherPool = await artifact(find(kept, 'additive-wave-0-research-1').task, [['D.t.sol', 'd']])
    const current = find(kept, 'core-wave-1-research-1').task
    expect(researchEvidencePaths(same.record).documents).toEqual([acceptedEvidencePath(same.record, 'waves/wave-0/research-1.md')])
    const sandbox = await mount(current, [same, otherLane, otherPool])
    expect([...sandbox.files.keys()].filter(path => path.endsWith('.tests.json'))).toEqual([])
    expect(sandbox.files.get(researchIndexPath)).not.toContain('.tests.json')
    expect(JSON.parse(sandbox.files.get(scratchRetainedPath)!)).toEqual({ schemaVersion: 1,
      directory: '/workspace/source/test/swarm/lane-1', files: JSON.parse(same.files['waves/wave-0/research-1.tests.json']!).files
        .map((file: { path: string, sha256: string }) => ({ path: file.path, sha256: file.sha256 })) })
    expect(sandbox.commands).toContain(`chown 0:0 ${scratchRetainedPath} && chmod 0600 ${scratchRetainedPath}`)
    const changed = await artifact(find(kept, 'core-wave-1-research-1').task, [['A.t.sol', 'a2']])
    const later = await mount(find(kept, 'core-wave-2-research-1').task, [changed, same])
    expect(JSON.parse(later.files.get(scratchRetainedPath)!).files)
      .toEqual([{ path: 'A.t.sol', sha256: await sha256('a2') }, { path: 'B.t.sol', sha256: await sha256('b') }])
    const first = await mount(find(kept, 'core-wave-0-research-1').task, [])
    expect(JSON.parse(first.files.get(scratchRetainedPath)!).files).toEqual([])
    const unrelated = await mount(find(plain, 'core-wave-1-research-1').task, [])
    expect(unrelated.files.has(scratchRetainedPath)).toBe(false)
  })

  it('writes each bundle once for the verifier and lays the tests out outside the source tree', async () => {
    const research = [
      await artifact(find(kept, 'core-wave-0-research-1').task, [['A.t.sol', 'wave zero']]),
      await artifact(find(kept, 'core-wave-1-research-1').task, [['A.t.sol', 'wave one'], ['B.t.sol', 'b']]),
      await artifact(find(kept, 'additive-wave-0-research-2').task, []),
    ]
    const verifier = find(kept, 'verifier').task
    const sandbox = await mount(verifier, research, true)
    const bundles = [...sandbox.files.keys()].filter(path => path.startsWith(`${pocBundleDirectory}/`)).toSorted()
    expect(bundles).toEqual([...research.map(value => `${pocBundleDirectory}/${value.record.taskId}.json`),
      `${pocBundleDirectory}/manifest.json`].toSorted())
    expect([...sandbox.files.keys()].filter(path => path.endsWith('.tests.json'))).toEqual([])
    expect(sandbox.commands.filter(command => command.includes('ack3-mount-tests'))).toEqual(['node /usr/local/bin/ack3-mount-tests'])
    const manifest = JSON.parse(sandbox.files.get(`${pocBundleDirectory}/manifest.json`)!)
    expect(manifest.tasks[0]).toEqual({ bundle: 'core-wave-0-research-1.json', lane: 1, pool: 'luna',
      taskId: 'core-wave-0-research-1', wave: 0, observations: ['OBS-X-W0-R1-A1'] })
    expect((await mount(verifier, research)).files.has(`${pocBundleDirectory}/manifest.json`)).toBe(false)

    // The extractor accepts exactly what the Worker wrote.
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ack3-poc-mount-')))
    try {
      await mkdir(join(root, 'bundles'))
      for (const path of bundles) await writeFile(join(root, 'bundles', path.split('/').at(-1)!), sandbox.files.get(path)!)
      const paths = { bundles: join(root, 'bundles'), output: join(root, 'tests'), index: join(root, 'tests-index.md') }
      expect(await mountPocTests(paths)).toEqual({ tasks: 3, files: 2 })
      expect(await readFile(join(paths.output, 'luna/lane-1/A.t.sol'), 'utf8')).toBe('wave one')
      const index = await readFile(paths.index, 'utf8')
      expect(index).toContain('Observations: OBS-X-W1-R1-A1')
      expect(index).toContain('## deepseek lane 2, wave 0 (additive-wave-0-research-2)')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
