import { describe, expect, it } from 'vitest'
import {
  sealReleasePackage,
  validateExperiment,
} from '../src/index.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import {
  audit0Definition,
  audit0PackageBody,
  expectedResearchAssignment,
  anchorResearchPlan,
} from './support/audit0-config.js'
import { compileExperimentConfig } from './support/compile-config.js'
import { sha256 } from '../src/canonical.js'
import { captureDiscoveryRequests, mirroredResearchPrompt, researchReasoningText } from './support/research-prompts.js'
import { researchEvidencePaths, researchPredecessor } from '../src/accepted-mounts.js'

describe('audit0 protocol contracts', () => {
  it('pins the concrete audit0 target, topology, stages, waves, and replication contracts', () => {
    validateExperiment(audit0Definition)
    expect(audit0Definition.id).toBe('audit0-hello-vault')
    expect(audit0Definition.target).toMatchObject({
      repository: 'example/hello-vault',
      commit: '0123456789abcdef0123456789abcdef01234567',
      tree: '89abcdef0123456789abcdef0123456789abcdef',
    })
    expect(audit0Definition.pools).toEqual([
      expect.objectContaining({ backend: 'codex', model: 'gpt-codex-a', agents: 3, required: true }),
      expect.objectContaining({
        backend: 'dsh-chat-completions', provider: 'provider-a',
        connection: { baseUrl: 'https://llm-a.example.com/v1', apiKeyEnv: 'PROVIDER_A_API_KEY' },
        model: 'deepseek-v4-flash', agents: 3, required: false,
      }),
    ])
    expect(audit0Definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .filter(task => task.providerClass !== 'deterministic').every(task => task.modelPool !== undefined)).toBe(true)
    expect(audit0Definition.roles.map(role => role.id)).toEqual(['lead', 'security-researcher', 'verifier'])
    expect(audit0Definition.stages.map(stage => stage.kind)).toEqual([
      'preflight', 'discovery', 'synthesis', 'coverage', 'negative-review', 'verification', 'reporting',
    ])
    const discovery = audit0Definition.stages[1]!
    expect(discovery.waves).toHaveLength(64)
    for (const [waveNumber, wave] of discovery.waves.entries()) {
      expect(wave.tasks.filter(task => task.providerClass === 'core')).toHaveLength(3)
      const replicas = wave.tasks.filter(task => task.providerClass === 'additive' && task.promptKind === 'research')
      expect(replicas).toHaveLength(3)
      expect(replicas.map(task => task.research?.researcher)).toEqual([1, 2, 3])
      for (let researcher = 1; researcher <= 3; researcher += 1) {
        expect(wave.tasks.find(task => task.research?.researcher === researcher && task.providerClass === 'core')?.research)
          .toMatchObject(expectedResearchAssignment(waveNumber, researcher))
      }
    }
    expect(audit0Definition.stages.flatMap(stage => stage.waves).flatMap(wave => wave.tasks)
      .some(task => task.id === 'challenge-open-adversarial-replica')).toBe(false)
    expect(audit0Definition.stages.find(stage => stage.kind === 'negative-review')!.waves[0]!.tasks).toHaveLength(2)
  })

  it('preserves mirrored discovery reasoning with separately bound peer navigation', async () => {
    const definition = compileExperimentConfig({ ...document, researchPlan: anchorResearchPlan(3) }).definition
    const requests = await captureDiscoveryRequests(definition)
    let peerLanes = 0
    for (const right of requests.filter(request => request.task.providerClass === 'additive')) {
      const core = definition.stages[1]!.waves.find(wave => wave.id === right.wave.id)!.tasks.find(task => (
        task.providerClass === 'core' && task.research?.researcher === right.task.research?.researcher
      ))!
      const left = mirroredResearchPrompt(definition, core, right, requests)
      expect(right.task.research?.role).toBe(core.research?.role)
      expect(researchReasoningText(right.prompt)).toBe(researchReasoningText(left))
      expect(await sha256(right.prompt)).toBe(right.promptDigest)
      expect(left).toContain('Protocol: /control/researcher-protocol.md')
      if (right.task.research?.buildsOn !== 'none') {
        peerLanes++
        const peer = researchPredecessor(definition, right.task, right.visibleArtifacts)!
        expect(right.prompt).toContain(`Peer evidence: ${researchEvidencePaths(peer).documents[0]}`)
        expect(right.prompt).toContain(`Peer observations: ${researchEvidencePaths(peer).observations}`)
        expect(left).toContain('/workspace/accepted/by-task/core-')
        expect(right.promptDigest).not.toBe(await sha256(left))
      } else {
        expect(right.promptDigest).toBe(await sha256(left))
      }
    }
    expect(peerLanes).toBeGreaterThan(0)
  })

  it('keeps benchmark answers out of the agent-visible release package', () => {
    const visible = JSON.stringify(audit0PackageBody)
    expect(visible).not.toMatch(/answer[-_ ]?key|expected[-_ ]?findings?|operator[-_ ]truth/i)
    expect(visible).toContain(JSON.stringify(audit0Definition.prompts.reportingInstructions))
  })

  it('makes package identity depend on every tuning input', async () => {
    const first = await sealReleasePackage(audit0PackageBody)
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
    const changed = structuredClone(audit0PackageBody)
    changed.definition.limits.maxInputTokens = (changed.definition.limits.maxInputTokens ?? 0) + 1
    const second = await sealReleasePackage(changed)
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
    expect(second.digest).not.toBe(first.digest)
    const promptChanged = structuredClone(audit0PackageBody)
    promptChanged.definition.stagePrompts['negative-review'] += '\nRetain a new tuned review edge case.'
    const third = await sealReleasePackage(promptChanged)
    expect(third.digest).not.toBe(first.digest)
  })

  it('rejects packages without per-pool execution profiles or with retired harness backends', async () => {
    const unprofiled = structuredClone(audit0PackageBody) as any
    for (const pool of unprofiled.definition.pools) {
      delete pool.reasoningEffort
      delete pool.thinking
    }
    await expect(sealReleasePackage(unprofiled)).rejects.toThrow('has invalid reasoningEffort')

    for (const backend of ['deepseek-harness', 'retired-harness']) {
      const retired = structuredClone(audit0Definition) as any
      for (const pool of retired.pools) if (pool.backend === 'dsh-chat-completions') pool.backend = backend
      expect(() => validateExperiment(retired)).toThrow('has an unsupported backend')
    }
  })

  it('binds each new task to its originating pool even when models match', async () => {
    const misbound = structuredClone(audit0PackageBody) as any
    const luna = misbound.definition.pools.find((pool: any) => pool.id === 'luna')
    misbound.definition.pools.push({
      ...structuredClone(luna),
      id: 'luna-secondary',
      subagents: { default: { mode: 'native', maxConcurrent: 2 } },
    })
    const synthesizer = misbound.definition.stages.flatMap((stage: any) => stage.waves)
      .flatMap((wave: any) => wave.tasks).find((task: any) => task.id === 'synthesizer')
    expect(synthesizer.modelPool).toBe('luna')
    synthesizer.subagents = { mode: 'native', maxConcurrent: 2 }
    await expect(sealReleasePackage(misbound))
      .rejects.toThrow('does not preserve a configured model pool execution profile')
  })

  it('seals a complete agent instruction set and rejects missing or unknown instructions', () => {
    const emptied = structuredClone(audit0Definition)
    emptied.prompts.reportingInstructions = ' '
    expect(() => validateExperiment(emptied)).toThrow('every agent instruction must be non-empty text')
    const missing = structuredClone(audit0Definition) as any
    delete missing.prompts.searchPrivacy
    expect(() => validateExperiment(missing)).toThrow('every agent instruction must be non-empty text')
    const unknown = structuredClone(audit0Definition) as any
    unknown.prompts.hiddenGuidance = 'unsealed'
    expect(() => validateExperiment(unknown)).toThrow('unknown keys: hiddenGuidance')
  })

  it('rejects unknown fields anywhere in a release package', async () => {
    const unknownRoot = { ...structuredClone(audit0PackageBody), runtimeOverride: 'unsealed' }
    await expect(sealReleasePackage(unknownRoot as any)).rejects.toThrow('release package has unknown keys: runtimeOverride')

    const unknownTask = structuredClone(audit0PackageBody) as any
    unknownTask.definition.stages[1].waves[0].tasks[0].promptSuffix = 'inspect a hidden benchmark'
    await expect(sealReleasePackage(unknownTask)).rejects.toThrow('has unknown keys: promptSuffix')

    const unknownProvenance = { ...structuredClone(audit0PackageBody), sourceProvenance: { releaseTag: 'v0' } }
    await expect(sealReleasePackage(unknownProvenance as any)).rejects.toThrow(
      'release package has unknown keys: sourceProvenance',
    )
  })
})
