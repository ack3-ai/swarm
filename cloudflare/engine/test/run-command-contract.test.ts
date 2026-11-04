import { describe, expect, it } from 'vitest'
import { parseRunCommand, forkBoundary } from '../src/run-commands.js'

const identity = { id: 'decision-1', expectedRevision: 0, reason: 'Operator decision' }
const runtimeRelease = { schemaVersion: 1, id: 'runtime-next', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-next', workflowName: 'runtime-next',
  containerImageDigest: `sha256:${'b'.repeat(64)}`, workerVersionId: '11111111-1111-4111-8111-111111111111' }
const fork = { ...identity, action: 'fork', source: { runId: 'source-audit', state: { generation: 7, digest: 'c'.repeat(64) } },
  releaseDigest: 'd'.repeat(64), runtimeRelease, stageId: 'negative-review' }

describe('audit command wire contract', () => {
  it.each(['pause', 'continue', 'cancel'])('accepts %s with an explicit scope and revision', action => {
    for (const scope of [{ kind: 'audit' }, { kind: 'stage', stageId: 'discovery' },
      { kind: 'pool', poolId: 'reviewer' }, { kind: 'tasks', taskIds: ['task-a', 'task-b'] }]) {
      const value = { ...identity, action, scope }
      expect(parseRunCommand(value)).toEqual(value)
    }
  })

  it.each([{ stageId: 'negative-review' }, { checkpointDigest: 'e'.repeat(64) }, { sourceFrontier: true as const }])(
    'accepts exactly one saved fork boundary: %j', boundary => {
      const { stageId: _, ...base } = fork
      const parsed = parseRunCommand({ ...base, ...boundary })
      expect(parsed.action).toBe('fork')
      if (parsed.action !== 'fork') throw new Error('expected fork')
      expect(forkBoundary(parsed)).toEqual(boundary)
    })

  it('returns an independent snapshot of nested command data', () => {
    const value = structuredClone(fork), parsed = parseRunCommand(value)
    value.source.state.digest = 'f'.repeat(64)
    value.runtimeRelease.id = 'changed-runtime'
    expect(parsed).toEqual(fork)
  })

  it.each(['models', 'prompts', 'limits', 'provider', 'config'])('rejects inline %s overrides', field => {
    expect(() => parseRunCommand({ ...fork, [field]: {} })).toThrow('fields')
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER, Infinity, '1'])('rejects invalid revision %s', expectedRevision => {
    expect(() => parseRunCommand({ ...fork, expectedRevision })).toThrow('revision')
  })

  it.each(['', ' ', 'x'.repeat(2001)])('rejects a missing or excessive reason', reason => {
    expect(() => parseRunCommand({ ...fork, reason })).toThrow('reason')
  })

  it('rejects missing, ambiguous and false fork boundaries', () => {
    const { stageId: _, ...base } = fork
    for (const boundary of [{}, { stageId: 'review', sourceFrontier: true }, { sourceFrontier: false }]) {
      expect(() => parseRunCommand({ ...base, ...boundary })).toThrow()
    }
  })

  it('rejects unbound or malformed source identities and pointers', () => {
    for (const source of [{ runId: '../other', state: fork.source.state },
      { ...fork.source, state: { generation: 0, digest: 'c'.repeat(64) } },
      { ...fork.source, state: { generation: 1, digest: 'missing' } },
      { ...fork.source, state: { ...fork.source.state, current: true } }]) {
      expect(() => parseRunCommand({ ...fork, source })).toThrow()
    }
  })

  it('rejects invalid or ambiguous task selections', () => {
    for (const taskIds of [[], ['task-a', 'task-a'], ['../escape'], Array.from({ length: 257 }, (_, i) => `task-${i}`)]) {
      expect(() => parseRunCommand({ ...identity, action: 'pause', scope: { kind: 'tasks', taskIds } })).toThrow()
    }
  })

  it('rejects unknown actions, fields and mutable runtime identities', () => {
    expect(() => parseRunCommand({ ...fork, action: 'restart' })).toThrow('action')
    expect(() => parseRunCommand({ ...fork, runtimeRelease: { ...runtimeRelease, containerImageDigest: 'latest' } })).toThrow()
    expect(() => parseRunCommand({ ...identity, action: 'pause', scope: { kind: 'audit', force: true } })).toThrow('fields')
    expect(() => parseRunCommand(null)).toThrow('object')
  })
})
