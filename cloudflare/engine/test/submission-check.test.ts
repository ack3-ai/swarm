import { describe, expect, it, vi } from 'vitest'
import type { AgentRequest, AgentResult, ArtifactRecord, ExperimentDefinition, TaskDefinition } from '../src/contracts.js'
import { canonicalJson } from '../src/canonical.js'
import { DEFAULT_SUBMIT_CHECK } from '../src/methods/system-prompts.js'
import { executionRequestBody } from '../src/native-request.js'
import { mandatorySearchRequirement, searchCitationIssues } from '../src/native-research.js'
import { RESEARCH_SUBMIT_CHECK_HINT, renderTaskPrompt } from '../src/prompts.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { providerIdentity } from '../src/provider-identity.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import {
  checkSubmissionFiles, parseSubmitCheckContext, SEARCH_NOT_YET, sourceReferences, SUBMIT_CHECK_CONTEXT_PATH, submitCheckContext, submitCheckReport,
  SUBMIT_CHECK_UNFINISHED, type SourceTree,
} from '../src/submission-check.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import { validateExperiment } from '../src/validation.js'
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import example from '../../../docs/examples/audit.json' with { type: 'json' }
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { compileExperimentConfig as compile } from '../src/config-compiler.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const plain = compileExperimentConfig(document)
const checked = compileExperimentConfig({ ...document, submitCheck: true })
const tasks = (definition: ExperimentDefinition) => definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
const find = (definition: ExperimentDefinition, id: string) => {
  const stage = definition.stages.find(stage => stage.waves.some(wave => wave.tasks.some(task => task.id === id)))!
  const wave = stage.waves.find(wave => wave.tasks.some(task => task.id === id))!
  return { stage, wave, task: wave.tasks.find(task => task.id === id)! }
}
const researchId = 'core-wave-0-research-1'
const deadline = '2026-11-10T00:00:00.000Z'

/** An in-memory source tree: path → line count. */
function source(files: Record<string, number>): SourceTree {
  return {
    lineCount: async path => files[path] ?? 'missing',
    named: async name => Object.keys(files).filter(path => path === name || path.endsWith(`/${name}`)),
    topLevel: async name => Object.keys(files).some(path => path.split('/')[0] === name),
  }
}
const tree = source({ 'src/Vault.sol': 120, 'src/lib/Math.sol': 40, 'test/Vault.t.sol': 30 })

function researchFiles(evidence: readonly string[], document = '# Research\n\n## A1 Withdraw skips the share check\n') {
  return {
    'waves/wave-0/research-1.md': document,
    [SUBMISSION_PATH]: JSON.stringify({ complete: true, materialHighCriticalDelta: false, observations: [{
      id: 'A1', statement: 'withdraw skips the share check', conditions: [], consequence: 'loss', evidence }],
    leadChecks: [], nextExperiment: 'none' }),
  }
}

describe('submitCheck release sealing', () => {
  it('is on unless the manifest sets false, which leaves the release without it', () => {
    // The shared fixture sets "submitCheck": false, so the other tests keep their releases.
    expect(document.submitCheck).toBe(false)
    const { submitCheck: _off, ...unset } = document
    expect(canonicalJson(compileExperimentConfig(unset))).toBe(canonicalJson(checked))
    expect(canonicalJson(plain)).not.toContain('submitCheck')
    expect(() => compileExperimentConfig({ ...document, submitCheck: 'yes' })).toThrow('submitCheck must be a boolean')
  })

  it('turns it on for the docs example, which does not set it', () => {
    expect(example).not.toHaveProperty('submitCheck')
    const { definition } = compile(example, prompts)
    expect(() => validateExperiment(definition)).not.toThrow()
    expect(definition.prompts.submitCheck).toBe(DEFAULT_SUBMIT_CHECK)
    for (const task of tasks(definition)) expect(task.submitCheck).toBe(task.providerClass === 'deterministic' ? undefined : true)
  })

  it('seals the flag on every model task and one instruction, and validation keeps them paired', () => {
    const definition = checked.definition
    expect(definition.prompts.submitCheck).toBe(DEFAULT_SUBMIT_CHECK)
    for (const task of tasks(definition)) expect(task.submitCheck).toBe(task.providerClass === 'deterministic' ? undefined : true)
    expect(() => validateExperiment(definition)).not.toThrow()
    const tampered = (change: (definition: ExperimentDefinition) => void) => {
      const copy = structuredClone(definition) as ExperimentDefinition
      change(copy)
      return () => validateExperiment(copy)
    }
    expect(tampered(copy => { delete (copy.prompts as { submitCheck?: string }).submitCheck })).toThrow('non-empty submitCheck instruction')
    expect(tampered(copy => { delete (tasks(copy).find(task => task.id === researchId) as { submitCheck?: true }).submitCheck }))
      .toThrow('every model task')
    expect(tampered(copy => { Object.assign(tasks(copy).find(task => task.providerClass === 'deterministic')!, { submitCheck: true }) }))
      .toThrow('only on model tasks')
    const unflagged = structuredClone(plain.definition) as ExperimentDefinition
    Object.assign(unflagged.prompts, { submitCheck: 'x' })
    expect(() => validateExperiment(unflagged)).toThrow('requires submitCheck')
  })

  it('uses a prompt-file override only when enabled', () => {
    const custom = { ...prompts, instructions: { ...(prompts as { instructions?: object }).instructions, submitCheck: 'Run ack3-submit.' } }
    expect(compile({ ...document, submitCheck: true }, custom).definition.prompts.submitCheck).toBe('Run ack3-submit.')
    expect(canonicalJson(compile(document, custom))).toBe(canonicalJson(plain))
  })

  it('ends every model prompt and correction with the instruction, and adds the request flag', () => {
    for (const definition of [plain.definition, checked.definition]) {
      const on = definition === checked.definition
      for (const id of [researchId, 'synthesizer', 'verifier']) {
        const { task, stage, wave } = find(definition, id)
        const prompt = renderTaskPrompt({ definition, task, stageKind: stage.kind, visibleArtifacts: [], deadline })
        // Research also gets the hint about what the source-aware checks expect.
        const ending = id === researchId ? `${DEFAULT_SUBMIT_CHECK}\n${RESEARCH_SUBMIT_CHECK_HINT}` : DEFAULT_SUBMIT_CHECK
        expect(prompt.endsWith(`\n\n${ending}`)).toBe(on)
        expect(prompt.includes(RESEARCH_SUBMIT_CHECK_HINT)).toBe(on && id === researchId)
        expect(prompt.includes('ack3-submit')).toBe(on)
        const correction = renderTaskPrompt({ definition, task, stageKind: stage.kind, visibleArtifacts: [], deadline,
          diagnostics: [SUBMIT_CHECK_UNFINISHED], formatRepairOnly: true })
        expect(correction.endsWith(ending)).toBe(on)
        const request = { experimentId: definition.id, runId: 'run', stage, wave, task, prompt: 'p', promptDigest: 'd'.repeat(64),
          visibleArtifacts: [], releaseDigest: 'e'.repeat(64), attempt: 1, diagnostics: [], repairFiles: {}, freshContext: false,
          continuationMode: 'new', sessionId: null } as unknown as AgentRequest
        const body = executionRequestBody(request, 'workspace')
        if (on) expect(body).toMatchObject({ submitCheck: true })
        else expect(body).not.toHaveProperty('submitCheck')
      }
    }
  })
})

describe('the check context', () => {
  it('is written read-only for a flagged task and never for others', async () => {
    for (const definition of [checked.definition, plain.definition]) {
      const { task, stage } = find(definition, researchId)
      const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
      Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
      const writes = new Map<string, string>(), commands: string[] = []
      await (provider as any).prepareSandbox({
        mkdir: async () => {}, writeFile: async (path: string, content: string) => { writes.set(path, content) },
        exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
        exec: async (command: string) => { commands.push(command); return { success: true, stdout: '', stderr: '' } },
      }, { releaseDigest: 'a'.repeat(64), task, stage, visibleArtifacts: [] })
      const written = writes.get(SUBMIT_CHECK_CONTEXT_PATH)
      if (definition === plain.definition) expect(written).toBeUndefined()
      else {
        expect(parseSubmitCheckContext(written!)).toEqual(submitCheckContext(task, task.output.requiredFiles, [],
          mandatorySearchRequirement(definition, task, stage.kind)))
        expect(commands).toContain(`chmod 0444 ${SUBMIT_CHECK_CONTEXT_PATH}`)
      }
    }
  })

  it('names the search requirement when the release requires search citations (S26)', async () => {
    const searched = compileExperimentConfig({ ...document, submitCheck: true, forceSearch: true,
      nativeSearch: { searchConnection: { provider: 'exa', apiKeyEnv: 'EXA_API_KEY' } } }).definition
    const { task, stage } = find(searched, 'challenge-open-adversarial')
    const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
    Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition: searched } }) } })
    const writes = new Map<string, string>()
    await (provider as any).prepareSandbox({
      mkdir: async () => {}, writeFile: async (path: string, content: string) => { writes.set(path, content) },
      exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
      exec: async () => ({ success: true, stdout: '', stderr: '' }),
    }, { releaseDigest: 'a'.repeat(64), task, stage, visibleArtifacts: [] })
    expect(parseSubmitCheckContext(writes.get(SUBMIT_CHECK_CONTEXT_PATH)!))
      .toMatchObject({ searchCheckedLater: true, searchRequirement: 'leads' })
  })
})

describe('the shared checks', () => {
  const research = find(checked.definition, researchId).task
  const context = (task: TaskDefinition, artifacts: readonly ArtifactRecord[] = []) =>
    parseSubmitCheckContext(canonicalJson(submitCheckContext(task, task.output.requiredFiles, artifacts, undefined)))

  it('accept a good research submission and list the problems of a bad one', async () => {
    expect(await checkSubmissionFiles(context(research), researchFiles(['src/Vault.sol:42-50 burns shares']), tree)).toEqual([])
    const bad = { ...researchFiles(['x']), [SUBMISSION_PATH]: '{"complete":false}' }
    const issues = await checkSubmissionFiles(context(research), bad, tree)
    expect(issues).toContain('submission.complete must be true')
    expect(await checkSubmissionFiles(context(research), { [SUBMISSION_PATH]: bad[SUBMISSION_PATH] }, tree))
      .toContain('missing required output file: waves/wave-0/research-1.md')
  })

  it('check synthesis against the accepted research', async () => {
    const synthesizer = find(checked.definition, 'synthesizer').task
    const artifact = { protocol: { research: { role: 'r', buildsOn: 'none', materialHighCriticalDelta: false,
      observations: [{ id: 'OBS-X-W0-R1-A1', statement: 's', conditions: [], consequence: 'c', evidence: ['e'] }] } } } as unknown as ArtifactRecord
    const files = (dispositions: readonly object[]) => ({
      ...Object.fromEntries(synthesizer.output.requiredFiles.map(path => [path, '# Notes\n'])),
      [SUBMISSION_PATH]: JSON.stringify({ complete: true, dispositions, retainedReferences: ['C-1'] }),
    })
    const good = [{ id: 'OBS-X-W0-R1-A1', disposition: 'candidate', reference: 'C-1', rationale: 'share check is missing' }]
    expect(await checkSubmissionFiles(context(synthesizer, [artifact]), files(good), tree)).toEqual([])
    expect((await checkSubmissionFiles(context(synthesizer, [artifact]), files([]), tree)).join('\n')).toContain('synthesis dispositions')
    // The context carries accepted inputs only for stages whose checks read them.
    expect(submitCheckContext(research, [], [artifact], undefined).visibleArtifacts).toEqual([])
  })

  it('find file references and ignore URLs and words that are not paths', () => {
    expect(sourceReferences('See `src/Vault.sol:42-50`, Math.sol#L3 and /workspace/source/test/Vault.t.sol:7.').map(item =>
      [item.path, item.start, item.end])).toEqual([['src/Vault.sol', 42, 50], ['Math.sol', 3, undefined], ['test/Vault.t.sol', 7, undefined]])
    expect(sourceReferences('https://github.com/x/y/blob/main/a.sol:10 www.example.com msg.sender 1.5 e.g. /etc/passwd:1 ../up.sol:2'))
      .toEqual([{ text: 'msg.sender', path: 'msg.sender' }, { text: 'e.g', path: 'e.g' }])
    expect(sourceReferences('src/Vault.sol:42:7')).toEqual([{ text: 'src/Vault.sol:42:7', path: 'src/Vault.sol', start: 42 }])
  })

  it('check research evidence against the source tree without rejecting correct references', async () => {
    const issues = async (evidence: readonly string[], document?: string) =>
      checkSubmissionFiles(context(research), researchFiles(evidence, document), tree)
    for (const evidence of [['src/Vault.sol:120'], ['Vault.sol:7 and https://x.test/a.sol:999'], ['lib/Math.sol#L40'],
      ['/workspace/source/src/Vault.sol'], ['@openzeppelin/contracts/token/ERC20.sol:99 then Vault.sol']]) {
      expect(await issues(evidence)).toEqual([])
    }
    expect(await issues(['src/Vault.sol:121'])).toEqual([
      'observation A1 cites src/Vault.sol:121, but src/Vault.sol has only 120 lines; fix the line number'])
    expect((await issues(['src/Gone.sol:3']))[0]).toContain('no file src/Gone.sol exists under /workspace/source')
    expect((await issues(['src/Vault.sol:9-2']))[0]).toContain('not a valid line or line range')
    expect(await issues(['the share check is missing'])).toEqual([
      'observation A1: its evidence names no file that exists under /workspace/source; add the source file and line it relies on, for example src/Vault.sol:42'])
    expect(await issues(['src/Vault.sol:1'], '# Research\n\nA10 is unrelated\n')).toEqual([
      'observation A1 is not in waves/wave-0/research-1.md; describe it there under its ID A1, or remove it from .swarm/submission.json'])
    // A tree too large to list leaves unresolved names unchecked.
    const unknown: SourceTree = { lineCount: async () => 'missing', named: async () => null, topLevel: async () => null }
    expect(await checkSubmissionFiles(context(research), researchFiles(['Vault.sol:999']), unknown)).toEqual([])
  })

  it('does not read a token pair, a ratio or a fork with a number as a file citation (E7)', async () => {
    const issues = async (evidence: readonly string[], sourceTree = tree) =>
      checkSubmissionFiles(context(research), researchFiles(evidence), sourceTree)
    expect(await issues(['src/Vault.sol:42 prices USDC/WETH:500 at collateral/debt:150 on anvil-fork/mainnet:18000000'])).toEqual([])
    // Without a file extension, a path counts when its first folder is at the top of the source tree.
    expect(await issues(['src/Vault.sol:42', 'src/Vault:42'])).toEqual([
      'observation A1 cites src/Vault:42, but no file src/Vault exists under /workspace/source; give the file path relative to /workspace/source, for example src/Vault.sol:42'])
    // With an extension it is still a file citation, wherever it points.
    expect((await issues(['src/Vault.sol:42', 'pools/WETH.sol:500']))[0]).toContain('no file pools/WETH.sol exists')
    // Such a token alone names no file, and an unknown tree top does not make it one.
    const named = ['observation A1: its evidence names no file that exists under /workspace/source; add the source file and line it relies on, for example src/Vault.sol:42']
    expect(await issues(['USDC/WETH:500'])).toEqual(named)
    expect(await issues(['USDC/WETH:500'], { ...tree, topLevel: async () => null })).toEqual(named)
  })
})

describe('the in-session search citation check (S26)', () => {
  const challenge = find(checked.definition, 'challenge-open-adversarial').task
  const context = (requirement: Parameters<typeof submitCheckContext>[3]) =>
    parseSubmitCheckContext(canonicalJson(submitCheckContext(challenge, challenge.output.requiredFiles, [], requirement)))
  const sent = '"ERC4626 inflation attack"  first depositor'
  const observation = { id: 'OPEN-OBS-1', disposition: 'refuted', reference: 'none', rationale: 'the owner check guards the path',
    referenceEvidence: 'none' }
  const files = (researchQueries?: string[]) => ({ 'coverage-challenge.md': '# Coverage\n',
    [SUBMISSION_PATH]: JSON.stringify({ complete: true, observations: [{ ...observation, ...(researchQueries === undefined ? {} : { researchQueries }) }] }) })
  const check = (requirement: Parameters<typeof submitCheckContext>[3], cited: string[] | undefined,
    search?: { queries: string[], failed: number }) => checkSubmissionFiles(context(requirement), files(cited), tree, search)
  const missing = 'OPEN-OBS-1: missing native search evidence: no successful native search queries recorded in this session. '
    + 'A failed search may leave a lead unresolved, but cannot justify dismissal or narrowing.'

  it('carries the search requirement in the context, and old readers still find searchCheckedLater', () => {
    expect(submitCheckContext(challenge, [], [], 'leads')).toMatchObject({ searchCheckedLater: true, searchRequirement: 'leads' })
    const none = submitCheckContext(challenge, [], [], undefined)
    expect(none.searchCheckedLater).toBe(false)
    expect(none).not.toHaveProperty('searchRequirement')
    for (const bad of [{ searchRequirement: 'all' }, { searchRequirement: 'leads', searchCheckedLater: false }]) {
      expect(() => parseSubmitCheckContext(JSON.stringify({ ...submitCheckContext(challenge, [], [], 'leads'), ...bad })))
        .toThrow('invalid submission check context')
    }
  })

  it('says plainly that the agent must search when search is required and none succeeded', async () => {
    expect(await check('leads', undefined, { queries: [], failed: 0 })).toEqual([SEARCH_NOT_YET, missing])
    expect(await check('leads', ['some query'], { queries: [], failed: 2 })).toEqual([SEARCH_NOT_YET, missing])
    expect(SEARCH_NOT_YET).toContain('No web search has succeeded in this session yet')
  })

  it('runs the Worker\'s citation check, with its normalization, on the recorded queries', async () => {
    const recorded = { queries: [sent], failed: 0 }
    for (const citation of [sent, 'erc4626 inflation attack first depositor.', '“ERC4626 inflation attack” first depositor']) {
      expect(await check('leads', [citation], recorded)).toEqual([])
    }
    const protocol = { challengeObservations: [{ ...observation, perspective: 'open-adversarial', researchQueries: ['ERC4626 donation attack'] }] }
    const mismatch = await check('leads', ['ERC4626 donation attack'], recorded)
    expect(mismatch).toEqual(searchCitationIssues(protocol as never, [sent], false, 'leads'))
    expect(mismatch[0]).toContain('native search citation mismatch')
    expect(mismatch[1]).toContain(JSON.stringify([sent]))
    // A requirement that does not cover this record asks for nothing.
    expect(await check('narrowing', undefined, { queries: [], failed: 0 })).toEqual([])
  })

  it('is skipped without a record (an older image) or without a requirement (an older Worker)', async () => {
    expect(await check('leads', undefined)).toEqual([])
    expect(await check(undefined, undefined, { queries: [], failed: 0 })).toEqual([])
  })
})

describe('Worker validation of the runner report', () => {
  const validate = async (definition: ExperimentDefinition, report: unknown) => {
    const { task } = find(definition, researchId)
    const files = researchFiles(['src/Vault.sol:1'])
    const { protocol } = await readSubmission(task, files, [])
    const result = { status: 'accepted', actorId: 'actor', model: task.model, provider: providerIdentity(task), files,
      assertions: [], protocol, inputTokens: 1, outputTokens: 1, costUsd: 0,
      ...(report === undefined ? {} : { submitCheck: report }) } as unknown as AgentResult
    return validateAgentResultDetailed(task, result, [])
  }

  it('accepts a done report and asks an agent that stopped early to continue', async () => {
    expect(await validate(checked.definition, { done: true, issues: [] })).toEqual({ issues: [], repairable: [], integrity: [] })
    expect((await validate(checked.definition, { done: false, issues: [] })).repairable).toEqual([SUBMIT_CHECK_UNFINISHED])
    expect((await validate(checked.definition, submitCheckReport(true, ['observation A1 cites x.sol:3, but ...']))).repairable)
      .toEqual(['ack3-submit: observation A1 cites x.sol:3, but ...', SUBMIT_CHECK_UNFINISHED])
  })

  it('treats a missing, malformed or unexpected report as an integrity issue', async () => {
    expect((await validate(checked.definition, undefined)).integrity)
      .toEqual(['the runner returned no submission check report; use a container image with ack3-submit'])
    for (const report of [null, { done: true }, { done: 'yes', issues: [] }, { done: true, issues: ['x'] },
      { done: false, issues: [''] }, { done: false, issues: [], extra: 1 }, { done: false, issues: Array(41).fill('x') }]) {
      expect((await validate(checked.definition, report)).integrity).toEqual(['the runner submission check report is malformed'])
    }
    expect((await validate(plain.definition, { done: true, issues: [] })).integrity).toEqual(['submission check report without submitCheck'])
    expect(await validate(plain.definition, undefined)).toEqual({ issues: [], repairable: [], integrity: [] })
  })
})
