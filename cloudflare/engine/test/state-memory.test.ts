import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { canonicalJsonBytes } from '../src/canonical-bytes.js'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

describe('bounded state serialization and internal views', () => {
  it('preserves canonical UTF-8 bytes and hashes, including numeric keys and Unicode', async () => {
    const examples = [null, false, 0, -0, 1e24, '😀\ud800é\u2028',
      { z: undefined, '10': 'ten', '2': 'two', '01': 'one', ä: 'a', A: 'A', a: 'a',
        missing: () => 0, nested: [undefined, , null, { z: 1, a: 2 }] },
      { repeated: Array.from({ length: 6000 }, (_, i) => ({ z: '😀é'.repeat(30), a: i })) },
    ]
    for (const value of examples) {
      const expected = canonicalJson(value), encoded = canonicalJsonBytes(value)
      expect(new TextDecoder().decode(encoded.bytes)).toBe(expected)
      expect(encoded.digest).toBe(await sha256(expected))
    }
    for (const legacy of [Object.defineProperty({}, 'toJSON', { value: () => ({ hidden: true }) }),
      Object.create({ toJSON() { return 'inherited' } }), undefined, Symbol('ignored'), { toJSON() { return { legacy: true } } },
      { nested: { toJSON() { return 'nested' } } }, new Date('2026-01-01T00:00:00Z')]) {
      const text = canonicalJson(legacy)
      const bytes = new TextEncoder().encode(text)
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      expect(await sha256(legacy)).toBe(digest)
    }
    expect(() => canonicalJsonBytes({ a: Infinity })).toThrow('non-finite')
    expect(() => canonicalJsonBytes([NaN])).toThrow('non-finite')
  })

  it('shares frozen views across reads while snapshots and old frontiers remain independent', async () => {
    const machine = await RunMachine.create(audit0Definition, 'a'.repeat(64), 'immutable-state-view')
    const before = machine.view(), snapshot = machine.snapshot()
    expect(machine.view()).toBe(before)
    expect(() => { before.cursor.stageIndex = 99 }).toThrow(TypeError)
    expect(() => { before.budget.modelCalls = 99 }).toThrow(TypeError)
    snapshot.cursor.stageIndex = 99
    expect(before.cursor.stageIndex).toBe(0)
    await machine.start()
    expect(before.status).toBe('created')
    expect(machine.view().status).toBe('running')
    expect(machine.view().artifacts).toBe(before.artifacts)
    const store = new MemoryArtifactStore()
    await advanceExperimentOneWave({ definition: audit0Definition, machine,
      provider: new DeterministicAuditProvider(), artifactStore: store,
      onWaveAdmission: async state => {
        expect(Object.isFrozen(state)).toBe(true)
        expect(Object.isFrozen(state.cursor)).toBe(true)
        await Promise.resolve()
        expect(state).toBe(machine.view())
      },
    })
    const accepted = machine.view()
    expect(before.artifacts).toHaveLength(0)
    expect(accepted.artifacts.length).toBeGreaterThan(0)
    const protocol = accepted.artifacts[0]!.protocol
    expect(Object.isFrozen(protocol)).toBe(true)
    expect(() => { Object.assign(protocol, { forged: true }) }).toThrow(TypeError)
    const sealed = await machine.seal('2026-10-31T00:00:00.000Z')
    sealed.body.cursor.stageIndex = 77
    expect(machine.view().checkpoints.at(-1)!.body.cursor.stageIndex).not.toBe(77)
    expect(accepted.checkpoints.length + 1).toBe(machine.view().checkpoints.length)
    const clone = machine.snapshot()
    clone.artifacts[0]!.protocol = {}
    expect(machine.view().artifacts[0]!.protocol).toBe(protocol)
    const restored = await RunMachine.fromState(audit0Definition, accepted)
    expect(restored.view()).toEqual(accepted)
    expect(restored.view()).not.toBe(accepted)
  })
})
