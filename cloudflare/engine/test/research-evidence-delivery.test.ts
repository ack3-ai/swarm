import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { AgentProvider, ArtifactRecord, TaskDefinition } from '../src/contracts.js'
import {
  acceptedEvidencePath, researchEvidencePaths, researchIndexPath, researchPredecessor, writeAccepted,
} from '../src/accepted-mounts.js'
import { canonicalJson, sha256 } from '../src/canonical.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { RunMachine } from '../src/machine.js'
import { renderTaskPrompt } from '../src/prompts.js'
import { advanceExperimentOneWave } from '../src/runner.js'
import { SUBMISSION_PATH } from '../src/submission.js'
import { audit0Definition } from './support/audit0-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import { MemoryArtifactStore } from './support/memory-runner.js'

const deadline = '2026-09-29T00:00:00.000Z'
const researchTasks = audit0Definition.stages.find(stage => stage.kind === 'discovery')!.waves
  .flatMap(wave => wave.tasks)

function task(pool: string, wave: number, lane: number): TaskDefinition {
  const template = researchTasks.find(candidate => candidate.providerClass === 'additive')!
  return {
    ...structuredClone(template), id: `pool-${pool}-wave-${wave}-research-${lane}`, modelPool: pool,
    provider: 'synthetic', model: 'same-model',
    connection: { baseUrl: `https://${pool}.example/v1`, apiKeyEnv: `${pool.toUpperCase()}_API_KEY` },
    research: { ...template.research!, wave, researcher: lane, role: 'researcher', buildsOn: wave === 0 ? 'none' : 'wave-0/research-2' },
    output: { ...template.output, requiredFiles: [`waves/wave-${wave}/research-${lane}.md`, SUBMISSION_PATH] },
  }
}

function definition(tasks: readonly TaskDefinition[]) {
  const value = structuredClone(audit0Definition)
  const discovery = value.stages.find(stage => stage.kind === 'discovery')!
  discovery.waves = [{ ...discovery.waves[0]!, tasks }]
  return value
}

async function artifact(task: TaskDefinition, label: string, observations = true) {
  const records = observations ? [{
    id: 'A1', statement: label, conditions: ['full causal precondition'],
    consequence: 'independent consequence', evidence: ['source.sol:12 and a reproduced tool result'],
  }] : []
  const files = {
    [task.output.requiredFiles[0]!]: `# Full peer reasoning\n\n${label}\n\nA separate older lead and its limitations.\n`,
    [SUBMISSION_PATH]: JSON.stringify({ complete: true, materialHighCriticalDelta: true, nextExperiment: 'none', observations: records }),
  }
  const contentDigest = await sha256(canonicalJson(files))
  const record: ArtifactRecord = {
    id: `discovery/${task.id}/${contentDigest}`, stageId: 'discovery', waveId: `wave-${task.research!.wave}`,
    taskId: task.id, status: 'accepted', actorId: 'synthetic', provider: task.provider!, model: task.model,
    promptDigest: 'a'.repeat(64), contentDigest, uri: `fixture://${contentDigest}`, files: Object.keys(files), assertions: [],
    protocol: { research: { role: task.research!.role, buildsOn: task.research!.buildsOn, nextExperiment: 'none',
      materialHighCriticalDelta: true, observations: records } },
    usage: { modelCalls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  }
  return { record, files }
}

function workspace() {
  const files = new Map<string, string>([[`/workspace/results/${SUBMISSION_PATH}`, 'current repair baseline']])
  return {
    files,
    async exec(command: string) {
      expect(command).toBe('/usr/local/bin/ack3-reset-accepted')
      for (const path of files.keys()) if (path.startsWith('/workspace/accepted/')) files.delete(path)
    },
    async mkdir() {},
    async writeFile(path: string, content: string) { files.set(path, content) },
  }
}

describe('frozen research evidence delivery without model calls', () => {
  it('keeps coverage research separate from the union in downstream workspaces', async () => {
    const seed = await artifact(task('east', 0, 1), 'seed')
    const challenge = { ...seed.record, taskId: 'challenge-open-adversarial', stageId: 'coverage',
      files: ['coverage-challenge.md'], protocol: { challengeObservations: [] } }
    const union = { ...challenge, taskId: 'coverage-union', protocol: { coverageUnion: [] } }
    const verifier = audit0Definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
      .find(task => task.promptKind === 'verification')!
    const sandbox = workspace()
    await writeAccepted(sandbox, { task: verifier, visibleArtifacts: [challenge, union] }, {
      async read(record) { return { 'coverage-challenge.md': record === challenge ? 'original coverage evidence' : 'combined coverage' } },
    })
    expect(sandbox.files.get('/workspace/results/coverage-challenges/challenge-open-adversarial.md')).toBe('original coverage evidence')
    expect(sandbox.files.get('/workspace/results/coverage-challenge.md')).toBe('combined coverage')
    expect(sandbox.files.get(acceptedEvidencePath(challenge, 'coverage-challenge.md'))).toBe('original coverage evidence')
  })

  it('renders the exact same-pool peer paths and mounts complete peer bytes without overwriting current output', async () => {
    const east = task('east', 0, 2)
    const west = task('west', 0, 2)
    const dependent = task('west', 1, 1)
    const peers = await Promise.all([artifact(east, 'other endpoint'), artifact(west, 'selected peer')])
    const visibleArtifacts = peers.map(peer => peer.record)
    const prompt = renderTaskPrompt({ definition: definition([east, west, dependent]), task: dependent, visibleArtifacts, deadline })
    const sandbox = workspace()
    const reads: string[] = []
    await writeAccepted(sandbox, { task: dependent, visibleArtifacts }, {
      async read(record) { reads.push(record.contentDigest); return peers.find(peer => peer.record.contentDigest === record.contentDigest)!.files },
    })
    const selected = peers[1]!
    const paths = researchEvidencePaths(selected.record)
    expect(prompt).toContain('Builds on: wave-0/research-2')
    expect(prompt).toContain(`Peer evidence: ${paths.documents[0]}`)
    expect(prompt).toContain(`Peer observations: ${paths.observations}`)
    expect(prompt).toContain(`Accepted research: ${researchIndexPath}`)
    expect(sandbox.files.get(paths.documents[0]!)).toBe(selected.files[west.output.requiredFiles[0]!])
    expect(sandbox.files.get(paths.observations)).toBe(selected.files[SUBMISSION_PATH])
    expect(reads).toEqual(peers.map(peer => peer.record.contentDigest))
    for (const peer of peers) {
      const index = sandbox.files.get(researchIndexPath)!
      for (const path of Object.keys(peer.files)) expect(index).toContain(acceptedEvidencePath(peer.record, path))
    }
    expect(sandbox.files.get(`/workspace/results/${SUBMISSION_PATH}`)).toBe('current repair baseline')
    expect([...sandbox.files.keys()].filter(path => path.startsWith('/workspace/results/'))).toHaveLength(1)
  })

  it('indexes older cross-pool evidence and zero-observation research without copying provisional local outputs', async () => {
    const peer = task('east', 0, 2)
    const empty = await artifact(peer, 'complete independent negative reasoning', false)
    const current = task('west', 0, 1)
    const sandbox = workspace()
    sandbox.files.set('/workspace/results/waves/wave-99/research-2.md', 'unaccepted future output')
    await writeAccepted(sandbox, { task: current, visibleArtifacts: [empty.record] }, { async read() { return empty.files } })
    expect(sandbox.files.get(researchIndexPath)).toContain(researchEvidencePaths(empty.record).documents[0])
    expect(sandbox.files.get(researchEvidencePaths(empty.record).documents[0]!)).toContain('complete independent negative reasoning')
    expect(sandbox.files.get(researchIndexPath)).not.toContain('wave-99')
    const firstWave = workspace()
    await writeAccepted(firstWave, { task: current, visibleArtifacts: [] }, { async read() { throw new Error('empty frontier must not read') } })
    expect(firstWave.files.get(researchIndexPath)).toBe('# Immutable accepted research index\n\n\n')
    expect(renderTaskPrompt({ definition: definition([current]), task: current, visibleArtifacts: [], deadline })).not.toContain('Peer evidence:')
  })

  it('rejects missing, unaccepted, or ambiguous selected predecessors rather than using another pool or a stale file', async () => {
    const east = task('east', 0, 2)
    const west = task('west', 0, 2)
    const dependent = task('west', 1, 1)
    const peers = await Promise.all([artifact(east, 'other pool'), artifact(west, 'selected pool')])
    const def = definition([east, west, dependent])
    for (const visibleArtifacts of [[], [peers[0]!.record], [{ ...peers[1]!.record, status: 'additive-unavailable' as const }], [peers[1]!.record, peers[1]!.record]]) {
      expect(() => renderTaskPrompt({ definition: def, task: dependent, visibleArtifacts, deadline })).toThrow('assigned research predecessor is missing or ambiguous')
    }
    const noPeer = { ...dependent, research: { ...dependent.research!, buildsOn: 'none' } }
    expect(() => renderTaskPrompt({ definition: def, task: noPeer, visibleArtifacts: [], deadline })).not.toThrow()
  })

  it('replaces the accepted mount with the exact frozen snapshot, preserving same-task digest identity across retries', async () => {
    const peer = task('east', 0, 2)
    const old = await artifact(peer, 'frozen bytes')
    const newer = await artifact(peer, 'different bytes')
    const current = task('west', 0, 1)
    const sandbox = workspace()
    sandbox.files.set(acceptedEvidencePath(old.record, peer.output.requiredFiles[0]!), 'stale retained bytes')
    const reads: string[] = []
    const store = { async read(record: ArtifactRecord) { reads.push(record.contentDigest); return record.contentDigest === old.record.contentDigest ? old.files : newer.files } }
    await writeAccepted(sandbox, { task: current, visibleArtifacts: [old.record] }, store)
    await writeAccepted(sandbox, { task: current, visibleArtifacts: [old.record] }, store)
    expect(sandbox.files.get(acceptedEvidencePath(old.record, peer.output.requiredFiles[0]!))).toBe(old.files[peer.output.requiredFiles[0]!])
    expect(reads).toEqual([old.record.contentDigest, old.record.contentDigest])
    expect(sandbox.files.get(researchIndexPath)).toContain(old.record.contentDigest)
    expect(sandbox.files.get(researchIndexPath)).not.toContain(newer.record.contentDigest)
  })

  it('keeps independent challenges and negative-review packet mounts isolated', async () => {
    const peer = await artifact(task('east', 0, 2), 'private peer evidence')
    const store = { async read() { throw new Error('isolated lane must not load peer files') } }
    for (const promptKind of ['coverage-challenge', 'negative-review'] as const) {
      const sandbox = workspace()
      await writeAccepted(sandbox, { task: { ...task('west', 0, 1), promptKind }, visibleArtifacts: promptKind === 'negative-review' ? [] : [peer.record] }, store)
      expect(sandbox.files.has(researchIndexPath)).toBe(false)
      expect([...sandbox.files.keys()].some(path => path.includes('/by-task/'))).toBe(false)
      expect(sandbox.files.get(`/workspace/results/${SUBMISSION_PATH}`)).toBe('current repair baseline')
    }
  })

  it('diagnoses incomplete stored peer files before publishing the research index', async () => {
    const peer = await artifact(task('east', 0, 2), 'missing structured bytes')
    const sandbox = workspace()
    await expect(writeAccepted(sandbox, { task: task('west', 0, 1), visibleArtifacts: [peer.record] }, {
      async read() { return { [peer.record.files[0]!]: 'narrative only' } },
    })).rejects.toMatchObject({ category: 'integrity-failed', retryable: false })
    expect(sandbox.files.has(researchIndexPath)).toBe(false)
    expect(sandbox.files.get(`/workspace/results/${SUBMISSION_PATH}`)).toBe('current repair baseline')
  })

  it('preserves synthesis aliases and leaves the structured peer files in their separate accepted paths', async () => {
    const peers = await Promise.all([artifact(task('luna', 0, 2), 'core narrative'), artifact(task('west', 0, 2), 'other pool narrative')])
    const sandbox = workspace()
    await writeAccepted(sandbox, { task: { ...task('west', 0, 1), promptKind: 'synthesis' }, visibleArtifacts: peers.map(peer => peer.record) }, {
      async read(record) { return peers.find(peer => peer.record.contentDigest === record.contentDigest)!.files },
    })
    expect(sandbox.files.get('/workspace/results/waves/wave-0/research-2.md')).toContain('core narrative')
    expect(sandbox.files.get('/workspace/results/west-waves/wave-0/research-2.md')).toContain('other pool narrative')
    for (const peer of peers) expect(sandbox.files.get(researchEvidencePaths(peer.record).observations)).toBe(peer.files[SUBMISSION_PATH])
    expect(sandbox.files.get(`/workspace/results/${SUBMISSION_PATH}`)).toBe('current repair baseline')
  })

  it('delivers the actual scheduler fallback for a rotating one-seat pool from its frozen admission', async () => {
    const body = compileExperimentConfig({ ...structuredClone(document), maxDiscoveryWaves: 4,
      limits: { ...document.limits, maxModelCalls: 1000 },
      modelPools: document.modelPools.map(pool => ({ ...pool, agents: pool.id === 'deepseek' ? 1 : 3 })),
    })
    const discovery = body.definition.stages.find(stage => stage.kind === 'discovery')!
    const configured = discovery.waves[1]!.tasks.find(task => task.providerClass === 'additive')!
    configured.research = { ...configured.research!, role: 'satellite', buildsOn: 'wave-0/research-3' }
    const machine = await RunMachine.create(body.definition, 'a'.repeat(64), 'frozen-peer-delivery')
    const store = new MemoryArtifactStore()
    const base = new DeterministicAuditProvider()
    const selected: string[] = []
    const provider: AgentProvider = {
      async run(request) {
        if (request.task.id === configured.id) {
          expect(request.task.research!.buildsOn).toBe('wave-0/research-1')
          const peer = researchPredecessor(body.definition, request.task, request.visibleArtifacts)!
          expect(peer.taskId).toBe('additive-wave-0-research-1')
          const sandbox = workspace()
          await writeAccepted(sandbox, request, { async read(record) {
            const content = store.contents.get(record.uri)!
            expect(await sha256(content)).toBe(record.contentDigest)
            return JSON.parse(content) as Record<string, string>
          } })
          const paths = researchEvidencePaths(peer)
          expect(request.prompt).toContain(`Peer evidence: ${paths.documents[0]}`)
          expect(sandbox.files.get(paths.documents[0]!)).toContain('# Research evidence')
          expect(sandbox.files.get(paths.observations)).toContain('conditions')
          selected.push(peer.contentDigest)
        }
        return base.run(request)
      },
    }
    await advanceExperimentOneWave({ definition: body.definition, machine, provider, artifactStore: store })
    for (let step = 0; step < 8 && machine.snapshot().phase === 'discovery'; step++) {
      await advanceExperimentOneWave({ definition: body.definition, machine, provider, artifactStore: store })
    }
    expect(selected).toHaveLength(1)
    expect(machine.snapshot().status).not.toBe('failed')
  })
})
