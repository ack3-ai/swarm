import type { ISandbox } from '@cloudflare/sandbox'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'

type CoverageSandbox = Pick<ISandbox, 'exists' | 'writeFile' | 'exec'>

export const coverageChallengeInitialDocument =
  '# Coverage challenge\n\n## Independent coverage\n\n## Observation ledger\n\n## Candidate supplement\n'

/** Create the alias target only when absent; never overwrite resumed work. */
export async function ensureCoverageChallengeOutput(sandbox: CoverageSandbox): Promise<void> {
  const path = '/workspace/results/coverage-challenge.md'
  const existing = await sandbox.exists(path)
  if (!existing.success) throw new TransientRunFailure('coverage output existence check failed')
  if (existing.exists) return
  await sandbox.writeFile(path, coverageChallengeInitialDocument)
  const writable = await sandbox.exec(`chown 10001:10001 ${path} && chmod 0600 ${path}`, { timeout: 10_000 })
  if (!writable.success) throw new PermanentRunFailure('coverage output initialization failed', 'invalid-configuration')
}
