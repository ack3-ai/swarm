import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ExperimentDefinition, RunState } from '../src/contracts.js'
import { assertAmendmentFrontier, ManifestAmendmentRejected } from '../src/manifest-amendment.js'
import { DEFAULT_RECON_NOTES } from '../src/recon.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

// Stages: preflight 0, discovery 1, synthesis 2, coverage 3 (two waves), negative review 4, ...
const previous = compileExperimentConfig(document).definition
const afterSynthesis = { stageIndex: 3, waveIndex: 0 }
const changed = (edit: (next: ExperimentDefinition) => void) => {
  const next = structuredClone(previous)
  edit(next)
  return next
}
const refusal = (next: ExperimentDefinition, cursor: RunState['cursor'] = afterSynthesis) => {
  try { assertAmendmentFrontier(previous, next, cursor) } catch (error) {
    expect(error).toBeInstanceOf(ManifestAmendmentRejected)
    return (error as Error).message
  }
  throw new Error('amendment was accepted')
}

describe('fork refusals name what changed (E16)', () => {
  it('accepts an unchanged manifest', () => {
    expect(() => assertAmendmentFrontier(previous, structuredClone(previous), afterSynthesis)).not.toThrow()
  })

  it('names the experiment id', () => {
    expect(refusal(changed(next => { next.id = 'another-audit' })))
      .toBe(`manifest amendment changes the experiment id (${previous.id} → another-audit)`)
  })

  it('names the first differing target key path', () => {
    expect(refusal(changed(next => { next.target.runtime = { ...next.target.runtime, commandTimeoutMinutes: 30 } })))
      .toBe('manifest amendment changes the audit target at target.runtime.commandTimeoutMinutes; a fork keeps the original target')
    expect(refusal(changed(next => { next.target.runtime.preflightCommands = ['forge build', 'forge test'] })))
      .toContain('at target.runtime.preflightCommands[0];')
    expect(refusal(changed(next => { next.target.commit = 'f'.repeat(40) }))).toContain('at target.commit;')
  })

  it('names the stage list, or the stage whose waves differ', () => {
    expect(refusal(changed(next => { next.stages = next.stages.filter(stage => stage.kind !== 'coverage') })))
      .toBe('manifest amendment changes the stage list (preflight, discovery, synthesis, coverage, negative-review, '
        + 'verification, reporting → preflight, discovery, synthesis, negative-review, verification, reporting)')
    expect(refusal(changed(next => { next.stages[3]!.waves[1]!.id = 'renamed-union' })))
      .toBe('manifest amendment changes the waves of stage coverage')
  })

  it('names a sealed stage and what differs in it', () => {
    expect(refusal(changed(next => { next.stages[2]!.waves[0]!.tasks[0]!.model = 'another-model' })))
      .toBe('manifest amendment changes a sealed stage: synthesis (first difference: waves[0].tasks[0].model); '
        + 'invalidate its consumers first')
    const taskId = previous.stages[2]!.waves[0]!.tasks[0]!.id
    expect(refusal(changed(next => { next.prompts.synthesisInstructions += ' Be brief.' })))
      .toBe(`manifest amendment changes a sealed stage: synthesis (task ${taskId} renders different instructions); `
        + 'invalidate its consumers first')
  })

  it('names a sealed wave of the open stage', () => {
    const coverageOpen = { stageIndex: 3, waveIndex: 1 }
    expect(refusal(changed(next => { next.stages[3]!.waves[0]!.tasks[0]!.model = 'another-model' }), coverageOpen))
      .toBe('manifest amendment changes a sealed wave: independent-coverage of stage coverage '
        + '(first difference: tasks[0].model); invalidate its consumers first')
    // The open wave itself may still change.
    expect(() => assertAmendmentFrontier(previous, changed(next => {
      next.stages[3]!.waves[1]!.tasks[0]!.model = 'another-model'
    }), coverageOpen)).not.toThrow()
  })

  it('names the discovery pools whose work differs', () => {
    const deepseekTasks = changed(next => {
      for (const task of next.stages[1]!.waves[0]!.tasks) if (task.backend === 'dsh-chat-completions') task.model = 'another-model'
    })
    expect(refusal(deepseekTasks)).toBe('manifest amendment changes a sealed stage: discovery, pool deepseek '
      + '(its tasks or rendered instructions differ); invalidate its consumers first')
    expect(refusal(changed(next => { next.prompts.researcherProtocol += ' Be brief.' })))
      .toContain('a sealed stage: discovery, pools deepseek, luna (')
  })
})

describe('recon note wording (N1)', () => {
  // A recon release sealed before N1 carries the old note; a release compiled now carries the new default.
  const sealed = JSON.parse(readFileSync(new URL('./fixtures/sealed-ca54217e/recon.definition.json', import.meta.url), 'utf8')) as ExperimentDefinition
  const renewed = { ...structuredClone(sealed), prompts: { ...sealed.prompts, reconNotes: DEFAULT_RECON_NOTES } }
  const discovery = sealed.stages.findIndex(stage => stage.kind === 'discovery')

  it('refuses a fork that keeps discovery run under the old note and names the discovery pools', () => {
    expect(sealed.prompts.reconNotes).not.toBe(DEFAULT_RECON_NOTES)
    expect(() => assertAmendmentFrontier(sealed, renewed, { stageIndex: discovery + 1, waveIndex: 0 }))
      .toThrow('manifest amendment changes a sealed stage: discovery, pools deepseek, luna '
        + '(its tasks or rendered instructions differ); invalidate its consumers first')
  })

  it('accepts a fork from recon or from discovery, which reruns discovery under the new note', () => {
    for (const stageIndex of [discovery - 1, discovery]) {
      expect(() => assertAmendmentFrontier(sealed, renewed, { stageIndex, waveIndex: 0 })).not.toThrow()
    }
  })
})
