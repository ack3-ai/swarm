import { expect, it } from 'vitest'
import { RunMachine } from '../src/machine.js'
import { advanceExperimentOneWave, runNextWave } from '../src/runner.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'
import { DeterministicAuditProvider } from './support/deterministic-audit-provider.js'
import type { AgentProvider, AgentRequest, AgentResult } from '../src/contracts.js'
import { MemoryArtifactStore } from './support/memory-runner.js'
import { instruction, searchQuestion } from './support/instructions.js'

it.each(['required', 'optional', 'unavailable', 'unresolved', 'failed-search', 'outside-stage', 'citation-mismatch', 'empty-citation'])('enforces configured research=%s through ordinary submission and same-session repair', async mode => {
  const enabled = mode !== 'optional' && mode !== 'outside-stage'
  const definition = compileExperimentConfig({ ...document, forceSearch: mode !== 'optional',
    ...(mode === 'outside-stage' ? { forceSearchStages: ['negative-review'] } : {}), nativeSearch: {} }).definition
  const machine = await RunMachine.create(definition, 'a'.repeat(64), 'native-research-runner')
  const artifactStore = new MemoryArtifactStore()
  const base = new DeterministicAuditProvider()
  await advanceExperimentOneWave({ definition, machine, provider: base, artifactStore })
  const stage = definition.stages.find(s => s.kind === 'discovery')!
  const wave = stage.waves[0]!
  await machine.admitWave(stage.id, wave.id)
  const parent = wave.tasks.find(task => task.providerClass !== 'deterministic')!
  const requests: AgentRequest[] = []
  const query = 'generic guard semantics'
  const provider: AgentProvider = { async run(request): Promise<AgentResult> {
    const raw = await base.run(request)
    if (request.task.id !== parent.id) return raw
    requests.push(request)
    expect(request.optionalOutputFiles).toBeUndefined()
    const leadChecks = [{ observationId: 'A1', claimConditions: ['The pinned disposable target is applicable.'],
      examinedConditions: ['The pinned disposable target is applicable.'], remainingUntestedConditions: [],
      evidenceMethod: 'source-inspection' as const,
      conclusion: mode === 'unresolved' || mode === 'failed-search' ? 'unresolved' as const : 'refuted' as const,
      evidence: 'Source conditions and applicable public guard documentation were checked.',
      ...(request.attempt === 1 && mode === 'citation-mismatch' ? { researchQueries: ['unexecuted guard wording'] }
        : request.attempt === 1 && mode === 'empty-citation' ? { researchQueries: [] }
        : request.attempt === 1 || mode === 'unavailable' ? {} : { researchQueries: [query] }) }]
    const submission = JSON.parse(raw.files['.swarm/submission.json']!)
    return { ...raw, protocol: { ...raw.protocol, research: { ...raw.protocol.research!, leadChecks } },
      files: { ...raw.files, '.swarm/submission.json': JSON.stringify({ ...submission, leadChecks }) },
      ...(mode === 'failed-search' ? { nativeSearchEvidence: { schemaVersion: 1 as const, source: 'codex-exa' as const,
        completed: [], failed: 1, incomplete: 0 } } : {}),
      ...(request.attempt === 1 && mode !== 'unavailable' && mode !== 'failed-search' ? { nativeSearchEvidence: { schemaVersion: 1 as const, source: 'codex-exa' as const,
        completed: [{ callId: 'native-1', queryDigest: 'c'.repeat(64), resultDigest: 'd'.repeat(64), queries: [query] }],
        failed: 0, incomplete: 0 } } : {}),
    }
  } }
  await runNextWave({ definition, machine, provider, artifactStore })
  if (mode === 'unavailable') {
    for (let attempt = 2; attempt <= 10; attempt++) await runNextWave({ definition, machine, provider, artifactStore })
    await expect(runNextWave({ definition, machine, provider, artifactStore })).rejects.toThrow('output correction exhausted after 10 turns')
    expect(requests).toHaveLength(11)
    expect(machine.snapshot().artifacts.some(a => a.taskId === parent.id)).toBe(false)
    expect(machine.snapshot().rejectedAttempts.filter(a => a.taskId === parent.id)).toHaveLength(11)
    return
  }
  const needsRepair = enabled && mode !== 'failed-search'
  if (needsRepair) await runNextWave({ definition, machine, provider, artifactStore })
  const state = machine.snapshot()
  const record = state.artifacts.find(a => a.taskId === parent.id)!
  expect(record, JSON.stringify({requests:requests.map(r=>({attempt:r.attempt,diagnostics:r.diagnostics})),rejections:state.rejectedAttempts})).toBeDefined()
  expect(requests).toHaveLength(needsRepair ? 2 : 1)
  if (needsRepair) {
    expect(requests[1]!.continuationMode).toBe('resume')
    expect(requests[1]!.sessionId).toBe(`session-${parent.workspaceKey}`)
    expect(requests[1]!.formatRepairOrdinal).toBe(1)
    const citations = instruction(definition, 'correctionCitations', { SEARCH_QUESTION: searchQuestion(definition, 'web_search_exa') })
    expect(requests[1]!.prompt).toContain(citations)
    expect(requests[1]!.prompt).not.toContain(instruction(definition, 'correctionFormat'))
    if (mode === 'citation-mismatch') {
      expect(requests[1]!.prompt).toContain('unexecuted guard wording')
      expect(requests[1]!.prompt).toContain(citations)
    }
    expect(record.protocol.research?.leadChecks?.[0]?.researchQueries).toEqual([query])
    expect(state.rejectedAttempts.find(r => r.taskId === parent.id)?.nativeSearchEvidence?.completed).toHaveLength(1)
    await expect(RunMachine.fromState(definition, state)).resolves.toBeDefined()
  }
})
