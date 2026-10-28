import { mandatorySearchRequirement } from './native-research.js'
import type {
  AgentRequest,
  ArtifactRecord,
  ExperimentDefinition,
  StageDefinition,
  StageKind,
  TaskDefinition,
  WaveDefinition,
  WaveReceipt,
} from './contracts.js'
import { sha256 } from './canonical.js'
import { verificationAssignments } from './protocol-transforms.js'
import { requiresSubmission, SUBMISSION_PATH } from './submission.js'
import { researchEvidencePaths, researchIndexPath, researchPredecessor } from './accepted-mounts.js'

/** Fill {{NAME}} placeholders literally. */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return Object.entries(values).reduce((text, [name, value]) => text.split(`{{${name}}}`).join(value), template)
}

function researchPrompt(definition: ExperimentDefinition, task: TaskDefinition, artifacts: readonly ArtifactRecord[]): string {
  const assignment = task.research
  if (assignment === undefined) throw new TypeError(`research task ${task.id} has no assignment`)
  const predecessor = researchPredecessor(definition, task, artifacts)
  const paths = predecessor === undefined ? undefined : researchEvidencePaths(predecessor)
  const peer = paths === undefined ? ''
    : `\nPeer evidence: ${paths.documents.join(', ')}\nPeer observations: ${paths.observations}`
  const leadInstruction = task.output.schema === 'ack3.research-delta.policy-v3'
    ? `\n${definition.prompts.researchLeadChecks}` : ''
  return `Task name: research-${assignment.researcher}
Wave: ${assignment.wave}
Role: security-researcher
Builds on: ${assignment.buildsOn}
Accepted research: ${researchIndexPath}${peer}
Output path: /workspace/results/waves/wave-${assignment.wave}/research-${assignment.researcher}.md
Lane scratch path: ${assignment.laneScratchPath}

Objective: ${definition.policy.outcome}
Protocol: /control/researcher-protocol.md
Target: /workspace/source${leadInstruction}`
}

function coveragePrompt(definition: ExperimentDefinition, task: TaskDefinition, deadline: string): string {
  if (task.perspective === undefined || task.observationPrefix === undefined) {
    throw new TypeError(`coverage task ${task.id} lacks a perspective contract`)
  }
  const replica = task.providerClass === 'additive'
  const taskName = replica ? 'open-adversarial-replica' : `challenge-${task.perspective}`
  const sourceDirectory = replica ? '/workspace/source' : `/workspace/challenge-${task.perspective}`
  const outputFile = `${sourceDirectory}/.swarm/coverage-challenge.md`
  return `Task name: ${taskName}
Role: ${definition.prompts.securityResearcherRole}

${definition.prompts.assignmentPreamble}

Objective: ${definition.policy.outcome}

${fill(definition.prompts.coverageInstructions, { SOURCE_DIRECTORY: sourceDirectory, OUTPUT_FILE: outputFile,
    PERSPECTIVE: task.objective, OBSERVATION_PREFIX: task.observationPrefix, DEADLINE: deadline })}`
}

function negativeReviewPrompt(definition: ExperimentDefinition, task: TaskDefinition, deadline: string): string {
  const replica = task.providerClass === 'additive'
  const taskName = replica ? 'negative-disposition-review-replica' : 'disposition-reviewer'
  const sourceDirectory = replica ? '/workspace/source' : '/workspace/disposition-reviewer'
  const inputFile = replica
    ? '/input/negative-disposition-review-input.json'
    : '/workspace/results/negative-disposition-review-input.json'
  const outputFile = `/workspace/results/${task.output.requiredFiles.find(path => path.endsWith('.md'))!}`
  const viewInstruction = task.output.schema === 'ack3.negative-review.policy-v3'
    ? `\n\n${fill(definition.prompts.negativeReviewView, {
      VIEW_FILE: inputFile.replace('negative-disposition-review-input.json', 'negative-disposition-review-view.json') })}`
    : ''
  return `Task name: ${taskName}
Role: ${definition.prompts.verifierRole}

${definition.prompts.assignmentPreamble}

Objective: ${definition.policy.outcome}

${fill(definition.prompts.negativeReviewInstructions, { INPUT_FILE: inputFile, SOURCE_DIRECTORY: sourceDirectory,
    OUTPUT_FILE: outputFile, DEADLINE: deadline })}${viewInstruction}`
}

function synthesisPrompt(definition: ExperimentDefinition): string {
  const leadInstruction = definition.stages.some(stage => stage.kind === 'discovery'
    && stage.waves.some(wave => wave.tasks.some(task => task.output.schema === 'ack3.research-delta.policy-v3')))
    ? `\n\n${definition.prompts.synthesisLeadChecks}` : ''
  return `Task name: synthesizer
Role: ${definition.prompts.securityResearcherRole}

Objective: ${definition.policy.outcome}

${definition.prompts.synthesisInstructions}${leadInstruction}`
}

function verificationPrompt(definition: ExperimentDefinition, visibleArtifacts: readonly ArtifactRecord[]): string {
  return `Task name: verifier
Role: ${definition.prompts.verifierRole}

Objective: ${definition.policy.outcome}

${definition.prompts.verificationInstructions}

Frozen verification assignments (reference and eligible observation IDs):
${JSON.stringify(verificationAssignments(visibleArtifacts))}
${definition.prompts.verificationAssignments}`
}

function reportingPrompt(definition: ExperimentDefinition, task: TaskDefinition, artifacts: readonly ArtifactRecord[]): string {
  const assignments = task.output.schema === 'ack3.finding.policy-v4'
    ? `\n\nEligible report reference–observation pairs:\n${JSON.stringify(verificationAssignments(artifacts))}` : ''
  return `Task name: reporter
Role: ${definition.prompts.securityResearcherRole}

Objective: ${definition.policy.outcome}

${definition.prompts.reportingInstructions}${assignments}`
}

function submissionInstruction(definition: ExperimentDefinition, task: TaskDefinition, searchRequired = false): string {
  const text = definition.prompts
  if (!requiresSubmission(task)) return ''
  const shape = task.promptKind === 'research'
    ? task.output.schema === 'ack3.research-delta.policy-v3'
      ? '{"complete":true,"materialHighCriticalDelta":false,"observations":[{"id":"A1","statement":"...","conditions":[],"consequence":"...","evidence":["..."]}],"leadChecks":[{"observationId":"A1","claimConditions":["..."],"examinedConditions":[],"remainingUntestedConditions":["..."],"evidenceMethod":"not-attempted","conclusion":"unresolved","evidence":"..."}]}'
      : '{"complete":true,"materialHighCriticalDelta":false,"observations":[{"id":"A1","statement":"...","conditions":[],"consequence":"...","evidence":["..."]}]}'
    : task.promptKind === 'synthesis'
      ? '{"complete":true,"dispositions":[{"id":"OBS-...","disposition":"candidate","reference":"C-1","rationale":"..."}],"retainedReferences":["C-1"]}'
      : task.promptKind === 'coverage-challenge'
        ? `{"complete":true,"observations":[{"id":"${task.observationPrefix}-OBS-1","disposition":"candidate","reference":"REF-${task.observationPrefix}-1","rationale":"...","referenceEvidence":"..."}]}`
        : task.promptKind === 'negative-review'
          ? task.output.schema === 'ack3.negative-review.policy-v3'
            ? '{"complete":true,"decisions":[{"observationId":"...","reviewedPrimaryDisposition":"candidate","reviewedPrimaryReference":"C-1","action":"uphold","finalDisposition":"candidate","finalReference":"C-1","rationale":"..."}]}'
            : '{"complete":true,"decisions":[{"observationId":"...","action":"uphold","finalDisposition":"candidate","finalReference":"C-1","rationale":"..."}]}'
          : task.promptKind === 'verification'
            ? '{"complete":true,"outcomes":[{"reference":"...","behavior":"reproduced","exploitability":"supported","evidenceMethod":"fresh-execution","evidence":"..."}]}'
            : '{"complete":true,"retainedReferences":["..."]}'
  const scopedShape = task.output.schema === 'ack3.verification.policy-v4'
    ? shape.replace('"reference":"..."', '"reference":"...","observationIds":["OBS-..."]')
    : task.output.schema === 'ack3.finding.policy-v4'
      ? '{"complete":true,"retainedReferences":["..."],"reportSections":[{"observationId":"OBS-...","reference":"C-1","section":"## Coverage and uncertainty"}]}'
      : shape
  const searchShape = searchRequired
    ? scopedShape.replace(/"(conclusion|disposition|finalDisposition|exploitability)":"[^"]+"/,
      '$&,"researchQueries":[]') : scopedShape
  const queryInstruction = searchRequired ? `\n${text.searchQueries}` : ''
  const referenceInstruction = task.promptKind === 'coverage-challenge'
    ? `\n${fill(text.coverageReferences, { OBSERVATION_PREFIX: task.observationPrefix ?? '' })}`
    : ''
  const evidenceMethodInstruction = task.promptKind === 'verification' ? `\n${text.verificationEvidenceMethod}`
    : task.promptKind === 'reporting' ? `\n${text.reportingEvidenceMethod}` : ''
  const reportSectionsInstruction = task.output.schema === 'ack3.finding.policy-v4' ? `\n${text.reportSections}` : ''
  const leadChecksV3 = task.output.schema === 'ack3.research-delta.policy-v3'
  const nextExperimentInstruction = task.promptKind === 'research'
    ? `\n${leadChecksV3 ? `${text.researchLeadCheckRules} ` : ''}${text.nextExperiment}`
    : ''
  const leadReconciliationInstruction = task.promptKind === 'research' && leadChecksV3
    ? `\n${text.leadReconciliation}` : ''
  return `

${fill(text.handoffIntro, { SUBMISSION_FILE: `/workspace/results/${SUBMISSION_PATH}` })}
${searchShape}${queryInstruction}${referenceInstruction}${evidenceMethodInstruction}${reportSectionsInstruction}${leadReconciliationInstruction}${nextExperimentInstruction}
${text.handoffClosing}`
}

function nativeSearchInstruction(definition: ExperimentDefinition, tool: string): string {
  return fill(definition.prompts.searchQuestion, { TOOL: tool })
}

function needsSearchInvestigation(diagnostics: readonly string[]): boolean {
  return diagnostics.some(value => /\bresearchQueries\b|missing native search evidence|native search citation mismatch/.test(value))
}

export function renderTaskPrompt(input: {
  definition: ExperimentDefinition
  task: TaskDefinition
  stageKind?: StageKind
  visibleArtifacts: readonly ArtifactRecord[]
  deadline: string
  diagnostics?: readonly string[]
  formatRepairOnly?: boolean
}): string {
  const { definition, task, deadline } = input
  const nativeSearchTool = task.providerClass === 'additive' ? 'mcp__exa__web_search_exa' : 'web_search_exa'
  const requirement = mandatorySearchRequirement(definition, task, input.stageKind)
  const text = definition.prompts
  const trigger = requirement === 'leads' ? text.searchTriggerLeads
    : requirement === 'narrowing' ? text.searchTriggerNarrowing
      : text.searchTriggerDismissal
  const search = task.providerClass === 'deterministic' ? ''
    : requirement !== undefined || definition.nativeSearch?.enabled === true
      ? `\n\n${requirement === undefined ? fill(text.searchOptional, { TOOL: nativeSearchTool })
        : `${trigger}, ${nativeSearchInstruction(definition, nativeSearchTool)}`}
${text.searchObjective}
${text.searchPrivacy}` : ''
  if (input.formatRepairOnly === true) {
    const diagnostics = input.diagnostics ?? []
    const correction = renderSameSessionOutputCorrection(definition, diagnostics, nativeSearchTool)
    // The session already has the schema. Keep search repair focused on the security question.
    return needsSearchInvestigation(diagnostics) ? correction : `${correction}${submissionInstruction(definition, task)}`
  }
  let prompt: string
  switch (task.promptKind) {
    case 'research': prompt = researchPrompt(definition, task, input.visibleArtifacts); break
    case 'coverage-challenge': prompt = coveragePrompt(definition, task, deadline); break
    case 'coverage-union': prompt = 'Deterministically union every accepted coverage observation with source provenance; preserve all rows and dissent.'; break
    case 'negative-review': prompt = negativeReviewPrompt(definition, task, deadline); break
    case 'review-union': prompt = 'Deterministically union every accepted negative-review decision with reviewer provenance; preserve all references and dissent.'; break
    case 'synthesis': prompt = synthesisPrompt(definition); break
    case 'verification': prompt = verificationPrompt(definition, input.visibleArtifacts); break
    case 'reporting': prompt = reportingPrompt(definition, task, input.visibleArtifacts); break
    case 'final-seal': prompt = 'Deterministically seal finding.md with the exact final observation-custody register.'; break
    case 'preflight': prompt = fill(definition.prompts.preflightInstructions,
      { COMMIT: definition.target.commit, TREE: definition.target.tree }); break
  }
  const repair = input.diagnostics === undefined || input.diagnostics.length === 0
    ? ''
    : `\n\n${text.repairDiagnostics}\n${input.diagnostics.map(value => `- ${value}`).join('\n')}`
  const stageInstructions = task.providerClass === 'deterministic' ? '' : `\n\nStage instructions:\n${definition.stagePrompts[(input.stageKind ?? definition.stages.find(stage => stage.waves.some(wave => wave.tasks.some(candidate => candidate.id === task.id)))?.kind) as import('./contracts.js').AuditStageKind]}`
  return `${prompt}${stageInstructions}${search}${repair}${submissionInstruction(definition, task, requirement !== undefined)}`
}

export function renderSameSessionOutputCorrection(
  definition: ExperimentDefinition, diagnostics: readonly string[], nativeSearchTool: string,
): string {
  if (diagnostics.length === 0) throw new Error('output correction requires exact validator diagnostics')
  const text = definition.prompts
  const question = nativeSearchInstruction(definition, nativeSearchTool)
  const searchRepair = diagnostics.some(value => value.includes('no successful native search queries recorded in this session'))
    ? fill(text.correctionSearchMissing, { SEARCH_QUESTION: question })
    : fill(text.correctionCitations, { SEARCH_QUESTION: question })
  const instruction = needsSearchInvestigation(diagnostics)
    ? `${searchRepair} ${text.correctionSearchUpdate}`
    : text.correctionFormat
  return `${instruction} ${text.correctionDiagnostics}\n${diagnostics.map(value => `- ${value}`).join('\n')}`
}

export async function composePrompt(input: {
  definition: ExperimentDefinition
  runId: string
  stage: StageDefinition
  wave: WaveDefinition
  task: TaskDefinition
  visibleArtifacts: readonly ArtifactRecord[]
  releaseDigest: string
  deadline?: string
  diagnostics?: readonly string[]
  formatRepairOnly?: boolean
}): Promise<Pick<AgentRequest, 'prompt' | 'promptDigest'>> {
  const prompt = renderTaskPrompt({
    definition: input.definition,
    task: input.task,
    stageKind: input.stage.kind,
    visibleArtifacts: input.visibleArtifacts,
    deadline: input.deadline ?? new Date(Date.now() + input.definition.limits.maxWallTimeMs).toISOString(),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
    ...(input.formatRepairOnly === undefined ? {} : { formatRepairOnly: input.formatRepairOnly }),
  })
  return { prompt, promptDigest: await sha256(prompt) }
}

export function selectSealedArtifacts(
  artifacts: readonly ArtifactRecord[],
  waveReceipts: readonly WaveReceipt[],
): readonly ArtifactRecord[] {
  const exactIds = new Set(waveReceipts.flatMap(receipt => (
    receipt.artifactRefs?.map(reference => reference.id) ?? []
  )))
  const legacyKeys = new Set(waveReceipts.filter(receipt => receipt.artifactRefs === undefined).flatMap(receipt => (
    receipt.artifactDigests.map(digest => JSON.stringify([receipt.stageId, receipt.waveId, digest]))
  )))
  return artifacts.filter(artifact => exactIds.has(artifact.id) || legacyKeys.has(JSON.stringify([
    artifact.stageId, artifact.waveId, artifact.contentDigest,
  ])))
}

export function selectVisibleArtifacts(
  task: TaskDefinition,
  artifacts: readonly ArtifactRecord[],
  waveReceipts: readonly WaveReceipt[],
  stageIndex: number,
  waveIndex: number,
  definition: ExperimentDefinition,
): readonly ArtifactRecord[] {
  const sealedArtifacts = selectSealedArtifacts(artifacts, waveReceipts)
  // The release describes the review union as a previous-wave operation because
  // its model-produced inputs are the two reviews. The deterministic union also
  // needs the frozen upstream dispositions to publish the complete verifier
  // eligibility manifest; exposing them here adds no model-visible context.
  if (task.providerClass === 'deterministic' && task.promptKind === 'review-union') return sealedArtifacts
  if (task.visibility === 'none') return []
  if (task.visibility === 'all-accepted') return sealedArtifacts
  const stage = definition.stages[stageIndex]
  if (stage === undefined) return []
  if (task.visibility === 'previous-wave') {
    const previous = stage.waves[waveIndex - 1]
    return previous === undefined ? [] : sealedArtifacts.filter((artifact) => (
      artifact.stageId === stage.id && artifact.waveId === previous.id && artifact.status === 'accepted'
    ))
  }
  const acceptedFrontier = sealedArtifacts.filter((artifact) => artifact.status === 'accepted' && (
    definition.stages.findIndex((entry) => entry.id === artifact.stageId) < stageIndex
    || (artifact.stageId === stage.id && artifact.waveId !== stage.waves[waveIndex]?.id)
  ))
  return task.promptKind === 'research'
    ? acceptedFrontier.filter(artifact => artifact.protocol.research !== undefined)
    : acceptedFrontier
}
