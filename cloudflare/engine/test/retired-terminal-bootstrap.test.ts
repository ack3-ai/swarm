import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { PermanentRunFailure } from '../src/run-errors.js'

it.each(['resume', 'resume-revalidate', 'recover-failed-wave', 'recover-terminal-completion', 'recover-discovery-waiver'])
  ('rejects retired %s bootstrap without reading or adopting historical records', async mode => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  private async bootstrap('), end = source.indexOf('  private async runOneWave(', start)
    const code = stripTypeScriptTypes(`class Fixture { env = {}; ${source.slice(start, end)} }`)
    const Workflow = new Function('runIdPattern', 'engineRole', 'PermanentRunFailure', `${code}; return Fixture;`)(
      /^[a-z0-9][a-z0-9._-]{0,99}$/, () => 'front-door', PermanentRunFailure)
    const getState = vi.fn(() => { throw new Error('historical reader must not run') })
    await expect(new Workflow().bootstrap({ mode, runId: 'historical-run' }, { getState, getStateIfPresent: getState }))
      .rejects.toThrow('legacy Workflow mode is retired')
    expect(getState).not.toHaveBeenCalled()
  })
