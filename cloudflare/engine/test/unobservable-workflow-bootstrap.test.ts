import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { expect, it, vi } from 'vitest'
import { PermanentRunFailure } from '../src/run-errors.js'

it.each(['resume', 'recover-failed-wave', 'recover-terminal-completion', 'recover-discovery-waiver', 'unknown'])
  ('rejects retired or unknown Workflow mode %s without reading or executing saved work', async mode => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8')
    const start = source.indexOf('  private async bootstrap('), end = source.indexOf('  private async runOneWave(', start)
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
    const code = stripTypeScriptTypes(`class Fixture { env = {}; ${source.slice(start, end)} }`)
    const Workflow = new Function('runIdPattern', 'engineRole', 'PermanentRunFailure',
      `${code}; return Fixture;`)(/^[a-z0-9][a-z0-9._-]{0,99}$/, () => 'front-door', PermanentRunFailure)
    const read = vi.fn(() => { throw new Error('unexpected archive access') })
    const store = new Proxy({}, { get: () => read })
    for (const initial of [null, { runId: 'child', status: 'running' }]) {
      await expect(new Workflow().bootstrap({ mode, runId: 'child', experimentId: 'audit' }, store, initial))
        .rejects.toMatchObject({ category: 'invalid-configuration' })
    }
    expect(read).not.toHaveBeenCalled()
  })
