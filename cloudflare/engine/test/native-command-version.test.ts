import { expect, it, vi } from 'vitest'
import { NativeCommandEvidence, readCommandSource } from '../src/native-command-evidence.js'
import { RunCommandJournal, type RunOperation } from '../src/run-command-journal.js'
import type { RunState } from '../src/contracts.js'

it.each([['applied', 'retain-workspace'], ['failed', 'retain-workspace'],
  ['applied', 'revoke-selection'], ['failed', 'revoke-selection']] as const)('rejects %s historical retained commands without interpreting their custody', async (status, kind) => {
  const prior = { status, nativeEffect: { kind } } as unknown as RunOperation
  const read = vi.spyOn(RunCommandJournal.prototype, 'atRevision').mockResolvedValue(prior)
  const touched = vi.fn(() => { throw new Error('historical custody must not be accessed') })
  const forbidden = new Proxy({}, { get: touched })
  try {
    const evidence = new NativeCommandEvidence({ runs: forbidden as any, artifacts: forbidden as R2Bucket,
      index: forbidden as D1Database })
    await expect(evidence.assertCurrentCommandHistory({ rootRunId: 'audit', controls: { revision: 1 } } as RunState)).rejects.toThrow('historical app version')
    expect(read).toHaveBeenCalledWith(1)
    expect(touched).not.toHaveBeenCalled()
  } finally { read.mockRestore() }
})

it('still refuses missing consumed command history', async () => {
  const read = vi.spyOn(RunCommandJournal.prototype, 'atRevision').mockResolvedValue(null)
  try {
    const evidence = new NativeCommandEvidence({ runs: {} as any, artifacts: {} as R2Bucket, index: {} as D1Database })
    await expect(evidence.assertCurrentCommandHistory({ rootRunId: 'audit', controls: { revision: 1 } } as RunState)).rejects.toThrow('consumed command history is missing')
  } finally { read.mockRestore() }
})

it.each(['failed', 'superseded'] as const)('does not use %s startup dispositions as cancellation evidence', async status => {
  const operation = { status, startup: { status }, source: {},
    command: { action: 'cancel', scope: { kind: 'audit' } } } as unknown as RunOperation
  const get = vi.spyOn(RunCommandJournal.prototype, 'get').mockResolvedValue(operation)
  const getStateAt = vi.fn(() => { throw new Error('must not interpret retired source') })
  try {
    await expect(readCommandSource(new RunCommandJournal({} as D1Database, 'audit'),
      { getStateAt } as any, 'command', true)).rejects.toThrow('no applying source-bound effect')
    expect(getStateAt).not.toHaveBeenCalled()
  } finally { get.mockRestore() }
})
