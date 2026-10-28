import { expect, it, vi } from 'vitest'
import { coverageChallengeInitialDocument, ensureCoverageChallengeOutput } from '../src/coverage-output.js'

it('creates the documented challenge headings only when the target is absent', async () => {
  const writeFile = vi.fn(async () => {})
  const exec = vi.fn(async () => ({ success: true }))
  const absent = { exists: async () => ({ success: true, exists: false }), writeFile, exec }
  await ensureCoverageChallengeOutput(absent as any)
  expect(writeFile).toHaveBeenCalledWith('/workspace/results/coverage-challenge.md', coverageChallengeInitialDocument)
  expect(coverageChallengeInitialDocument).toContain('## Observation ledger')
  const retained = { exists: async () => ({ success: true, exists: true }), writeFile, exec }
  await ensureCoverageChallengeOutput(retained as any)
  expect(writeFile).toHaveBeenCalledTimes(1)
})
