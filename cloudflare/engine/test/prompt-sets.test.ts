import { describe, expect, it } from 'vitest'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import prompts from '../../../docs/examples/prompts.json' with { type: 'json' }
import { compileExperimentConfig } from '../src/config-compiler.js'
import { DEFAULT_INSTRUCTIONS } from '../src/methods/system-prompts.js'
import { validateExperiment } from '../src/validation.js'
import { sealReleasePackage } from '../src/release.js'
import { captureDiscoveryRequests } from './support/research-prompts.js'
import { anchorResearchPlan } from './support/audit0-config.js'

describe('user stage prompts and fixed system contracts', () => {
  it('seals custom research instructions and keeps system contracts separate', async () => {
    const custom = { discovery: 'Focus on access control.' }
    const config = { ...document, stages: ['discovery'], stageModelPools: {}, promptFile: 'custom.json', maxDiscoveryWaves: 4,
      researchPlan: anchorResearchPlan(3) }
    const body = compileExperimentConfig(config, custom)
    const original = await sealReleasePackage(body)
    custom.discovery = 'A different investigation.'
    expect(body.definition.stagePrompts.discovery).toBe('Focus on access control.')
    expect((await sealReleasePackage(compileExperimentConfig(config, custom))).digest).not.toBe(original.digest)
    const requests = await captureDiscoveryRequests(body.definition)
    expect(requests.some(request => request.task.research?.buildsOn !== 'none')).toBe(true)
    for (const { prompt } of requests) {
      expect(prompt.match(/Focus on access control\./g)).toHaveLength(1)
      expect(prompt).toContain('Role: security-researcher')
      // Research plan labels are dashboard metadata; agents never see the lane strategy.
      for (const label of ['anchor', 'scout', 'satellite']) expect(prompt).not.toContain(label)
    }
    expect(body.definition.prompts).toEqual(DEFAULT_INSTRUCTIONS)
    body.definition.prompts.researcherProtocol = ''
    expect(() => validateExperiment(body.definition)).toThrow('every agent instruction must be non-empty text')
  })
  it('seals instruction overrides from the prompt file without exposing them to other stages', async () => {
    const config = { ...document, stages: ['discovery'], stageModelPools: {}, promptFile: 'custom.json', maxDiscoveryWaves: 1 }
    const instructions = { searchPrivacy: 'Keep every query generic.', assignmentPreamble: 'Do exactly this task.' }
    const body = compileExperimentConfig(config, { discovery: 'Review.', instructions })
    expect(body.definition.prompts).toEqual({ ...DEFAULT_INSTRUCTIONS, ...instructions })
    expect(body.definition.stagePrompts).toEqual({ discovery: 'Review.' })
    const plain = await sealReleasePackage(compileExperimentConfig(config, { discovery: 'Review.' }))
    expect((await sealReleasePackage(body)).digest).not.toBe(plain.digest)
    expect(() => compileExperimentConfig(config, { discovery: 'Review.', instructions: { hiddenGuidance: 'x' } }))
      .toThrow('unknown instruction: hiddenGuidance')
    expect(() => compileExperimentConfig(config, { discovery: 'Review.', instructions: { searchPrivacy: ' ' } }))
      .toThrow('instruction searchPrivacy must be non-empty text')
    expect(() => compileExperimentConfig(config, { discovery: 'Review.', instructions: [] }))
      .toThrow('prompt file instructions must be an object')
  })
  it('requires selected prompts, rejects unknown keys and retired selectors', () => {
    expect(() => compileExperimentConfig(document, {})).toThrow('missing discovery')
    expect(() => compileExperimentConfig(document, { ...prompts, discovery: '' })).toThrow('non-empty')
    expect(() => compileExperimentConfig(document, { ...prompts, system: 'override' })).toThrow('unknown prompt stage')
    expect(() => compileExperimentConfig({ ...document, promptSet: 'retired-prompt-set' }, prompts)).toThrow('unknown keys')
    expect(() => compileExperimentConfig({ ...document, outputContractVersion: 4 }, prompts)).toThrow('unknown keys')
  })
})
