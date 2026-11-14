import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ExperimentDefinition } from '../src/contracts.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { validateExperiment } from '../src/validation.js'

// Definitions compiled at commit ca54217e, before the review fixes. A release sealed then
// must still validate and render every prompt byte for byte (rules R1 and R3 of the fix
// plan). Each `<variant>.definition.json` is `test/fixtures/audit0-hello-vault.json` compiled
// as is (plain), with a scope file (scoped), with keepPocs and submitCheck (pocs-submit), or
// with native search and a recon stage (recon); `<variant>.digests.json` holds the digests
// below as computed then. The files are frozen: never regenerate them to make this test pass.
const SEALED_BASELINE_VARIANTS = ['plain', 'scoped', 'pocs-submit', 'recon'] as const
const SEALED_BASELINE_DEADLINE = '2026-11-12T00:00:00.000Z'
const SEALED_BASELINE_DIAGNOSTICS = ['submission.json: complete must be true'] as const

const directory = new URL('./fixtures/sealed-ca54217e/', import.meta.url)
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** SHA-256 of the first-attempt and one correction prompt of every task, keyed stage/wave/task. */
function sealedPromptDigests(definition: ExperimentDefinition): Record<string, { first: string; correction: string }> {
  const digests: Record<string, { first: string; correction: string }> = {}
  for (const stage of definition.stages) {
    for (const wave of stage.waves) {
      for (const task of wave.tasks) {
        const input = { definition, task, stageKind: stage.kind, visibleArtifacts: [], deadline: SEALED_BASELINE_DEADLINE }
        digests[`${stage.id}/${wave.id}/${task.id}`] = {
          first: digest(renderTaskPrompt(input)),
          correction: digest(renderTaskPrompt({ ...input, diagnostics: SEALED_BASELINE_DIAGNOSTICS, formatRepairOnly: true })),
        }
      }
    }
  }
  return digests
}

const load = (name: string) => JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as unknown

describe('releases sealed before the review fixes', () => {
  it.each(SEALED_BASELINE_VARIANTS)('%s still validates and renders every prompt byte for byte', variant => {
    const definition = load(`${variant}.definition.json`) as ExperimentDefinition
    const expected = load(`${variant}.digests.json`) as Record<string, { first: string; correction: string }>
    expect(() => validateExperiment(definition)).not.toThrow()
    expect(Object.keys(expected).length).toBeGreaterThan(0)
    expect(sealedPromptDigests(definition)).toEqual(expected)
  })
})
