import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compileExperimentConfig as compile } from '../src/config-compiler.js'
import { AUDIT_SCOPE_MAX_BYTES, DEFAULT_SCOPE_REMINDER, DEFAULT_SCOPE_RULES, INSTRUCTION_KEYS, RESEARCH_DELTA_INSTRUCTION_KEYS } from '../src/methods/system-prompts.js'
import { assertAmendmentFrontier } from '../src/manifest-amendment.js'
import { auditScopeHeader, auditScopePath, renderTaskPrompt } from '../src/prompts.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'
import { validateExperiment } from '../src/validation.js'
import { loadAuditConfig } from '../tools/load-audit-config.js'
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

vi.mock('../src/agent-sandbox-client.js', () => ({ getAgentSandbox: vi.fn() }))

const scopeText = '# Scope\n\nIn scope: src/HelloVault.sol\nOut of scope: lib/, test/, script/'
const scoped = { ...document, scopeFile: 'scope.md' }
const deadline = '2026-10-09T00:00:00.000Z'
const tasks = (definition: ReturnType<typeof compileExperimentConfig>['definition']) =>
  definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks.map(task => ({ task, stageKind: stage.kind }))))

describe('audit scope file', () => {
  const directories: string[] = []
  afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

  it('leaves a release without a scope file unchanged', () => {
    const definition = compileExperimentConfig(document).definition
    expect(definition.policy).not.toHaveProperty('scope')
    expect(Object.keys(definition.prompts).toSorted()).toEqual([...INSTRUCTION_KEYS, ...RESEARCH_DELTA_INSTRUCTION_KEYS].toSorted())
    for (const { task, stageKind } of tasks(definition)) {
      expect(renderTaskPrompt({ definition, task, stageKind, visibleArtifacts: [], deadline })).not.toContain('Audit scope:')
    }
  })

  it('seals the scope text with the default or configured scope rules', () => {
    const definition = compileExperimentConfig(scoped, `\r\n${scopeText.replaceAll('\n', '\r\n')}\r\n\r\n`).definition
    expect(definition.policy.scope).toBe(scopeText)
    expect(definition.prompts.scopeRules).toBe(DEFAULT_SCOPE_RULES)
    expect(definition.prompts.scopeReminder).toBe(DEFAULT_SCOPE_REMINDER)
    for (const label of ['Scope boundary:', 'Out of scope:']) {
      expect(DEFAULT_SCOPE_RULES).toContain(`"${label}"`)
      expect(DEFAULT_SCOPE_REMINDER).toContain(`"${label}"`)
    }
    const instructions = { scopeRules: 'Stay inside the listed files.', scopeReminder: 'Check the scope.' }
    const custom = compile(scoped, { ...prompts, instructions }, scopeText)
    expect(custom.definition.prompts).toMatchObject(instructions)
    const unused = compile(document, { ...prompts, instructions })
    expect(unused.definition.prompts).not.toHaveProperty('scopeRules')
    expect(unused.definition.prompts).not.toHaveProperty('scopeReminder')
  })

  it('rejects a missing, empty or oversized scope and scope text without a scope file', () => {
    expect(() => compileExperimentConfig(scoped)).toThrow('scopeFile contents are required')
    expect(() => compileExperimentConfig(document, scopeText)).toThrow('scope text requires scopeFile')
    expect(() => compileExperimentConfig(scoped, ' \n\t ')).toThrow('scopeFile must not be empty')
    expect(() => compileExperimentConfig({ ...document, scopeFile: '' }, scopeText)).toThrow('scopeFile must name a file')
    expect(() => compileExperimentConfig({ ...document, scopeFile: 7 }, scopeText)).toThrow('scopeFile must name a file')
    expect(() => compileExperimentConfig(scoped, 'x'.repeat(AUDIT_SCOPE_MAX_BYTES))).not.toThrow()
    expect(() => compileExperimentConfig(scoped, 'é'.repeat(AUDIT_SCOPE_MAX_BYTES / 2 + 1))).toThrow('at most')
  })

  it('validates that a scope and its rules are sealed together', () => {
    const definition = compileExperimentConfig(scoped, scopeText).definition
    validateExperiment(definition)
    for (const key of ['scopeRules', 'scopeReminder'] as const) {
      const without = structuredClone(definition)
      delete without.prompts[key]
      expect(() => validateExperiment(without)).toThrow('requires non-empty scopeRules and scopeReminder')
    }
    const withoutScope = structuredClone(definition)
    delete withoutScope.policy.scope
    expect(() => validateExperiment(withoutScope)).toThrow('scope instructions require an audit scope')
    const oversized = structuredClone(definition)
    oversized.policy.scope = 'x'.repeat(AUDIT_SCOPE_MAX_BYTES + 1)
    expect(() => validateExperiment(oversized)).toThrow('size limit')
  })

  it('opens every model prompt with the scope and ends it with the reminder, for every backend', () => {
    const plain = compileExperimentConfig(document).definition
    const definition = compileExperimentConfig(scoped, scopeText).definition
    const header = auditScopeHeader(definition)
    expect(header).toBe(`Audit scope (also saved at ${auditScopePath}):\n${scopeText}\nEnd of audit scope.\n\n${DEFAULT_SCOPE_RULES}`)
    const kinds = new Set<string>(), backends = new Set<string>()
    for (const { task, stageKind } of tasks(definition)) {
      const input = { task, stageKind, visibleArtifacts: [], deadline }
      const prompt = renderTaskPrompt({ ...input, definition })
      const before = renderTaskPrompt({ ...input, definition: plain })
      if (task.providerClass === 'deterministic') {
        expect(prompt).toBe(before)
        continue
      }
      kinds.add(task.promptKind)
      backends.add(task.backend!)
      expect(prompt).toBe(`${header}\n\n${before}\n\n${DEFAULT_SCOPE_REMINDER}`)
      const correction = renderTaskPrompt({ ...input, definition, formatRepairOnly: true, diagnostics: ['fix the handoff'] })
      expect(correction).not.toContain('Audit scope:')
    }
    expect([...kinds].toSorted()).toEqual(['coverage-challenge', 'negative-review', 'reporting', 'research', 'synthesis', 'verification'])
    expect([...backends].toSorted()).toEqual(['codex', 'dsh-chat-completions'])
  })

  it('saves the scope in every agent workspace so long sessions can reread it', async () => {
    for (const definition of [compileExperimentConfig(scoped, scopeText).definition, compileExperimentConfig(document).definition]) {
      const provider = new SandboxAgentProvider({ ACK3_CODEX_AUTH_JSON: 'synthetic', ACK3_CODEX_WORKSPACE_ID: 'synthetic' } as any)
      Object.assign(provider, { runs: { getRelease: async () => ({ body: { definition } }) } })
      const writes = new Map<string, string>()
      await (provider as any).prepareSandbox({
        mkdir: async () => {}, writeFile: async (path: string, content: string) => { writes.set(path, content) },
        exists: async (path: string) => ({ success: true, exists: path.includes('/source-tree-') }),
        exec: async () => ({ success: true, stdout: '', stderr: '' }),
      }, { releaseDigest: 'a'.repeat(64), task: { providerClass: 'additive', promptKind: 'research' } })
      expect(writes.get(auditScopePath)).toBe(definition.policy.scope === undefined ? undefined : `${auditScopeHeader(definition)}\n`)
    }
  })

  it('lets a fork keep only work done under the same scope', () => {
    const previous = compileExperimentConfig(document).definition
    const next = compileExperimentConfig(scoped, scopeText).definition
    const afterDiscovery = { stageIndex: 2, waveIndex: 0 }
    expect(() => assertAmendmentFrontier(previous, next, afterDiscovery)).toThrow('changes a sealed stage')
    expect(() => assertAmendmentFrontier(next, compileExperimentConfig(scoped, `${scopeText}\nAlso out: docs/`).definition, afterDiscovery))
      .toThrow('changes a sealed stage')
    expect(() => assertAmendmentFrontier(next, compileExperimentConfig(scoped, scopeText).definition, afterDiscovery)).not.toThrow()
    expect(() => assertAmendmentFrontier(previous, next, { stageIndex: 1, waveIndex: 0 })).not.toThrow()
  })

  it('reads the scope file next to the audit config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'audit-scope-'))
    directories.push(directory)
    const example = JSON.parse(await readFile(new URL('../../../docs/examples/audit.json', import.meta.url), 'utf8'))
    await writeFile(join(directory, 'prompts.json'), JSON.stringify(prompts))
    await writeFile(join(directory, 'scope.md'), `${scopeText}\n`)
    await writeFile(join(directory, 'audit.json'), JSON.stringify({ ...example, promptFile: 'prompts.json', scopeFile: 'scope.md' }))
    expect((await loadAuditConfig(join(directory, 'audit.json'))).definition.policy.scope).toBe(scopeText)
    await writeFile(join(directory, 'missing.json'), JSON.stringify({ ...example, promptFile: 'prompts.json', scopeFile: 'absent.md' }))
    await expect(loadAuditConfig(join(directory, 'missing.json'))).rejects.toThrow('ENOENT')
    await writeFile(join(directory, 'plain.json'), JSON.stringify({ ...example, promptFile: 'prompts.json' }))
    expect((await loadAuditConfig(join(directory, 'plain.json'))).definition.policy).not.toHaveProperty('scope')
  })
})
