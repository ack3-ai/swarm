import { validSubscriptionWaits } from '../container/subscription-limits.mjs'
import type { AgentResult, ArtifactRecord, TaskDefinition } from './contracts.js'
import { canonicalJson } from './canonical.js'
import {
  createCoverageUnion,
  createFinalObservationCustody,
  createNegativeReviewUnion,
  createNegativeReviewUnionManifest,
  renderCoverageUnion,
  sealFinalFinding,
} from './protocol-transforms.js'
import { readSubmission, requiresSubmission, SUBMISSION_PATH } from './submission.js'
import { providerIdentity } from './provider-identity.js'
import { OUTPUT_FILE_MAX_BYTES } from './output-limits.js'

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export async function validateAgentResultDetailed(
  task: TaskDefinition,
  result: AgentResult,
  visibleArtifacts: readonly ArtifactRecord[],
): Promise<{ issues: string[], repairable: string[], integrity: string[] }> {
  const repairable: string[] = []
  const integrity: string[] = []
  const issues: string[] = []
  const addRepairable = (value: string) => { repairable.push(value); issues.push(value) }
  const addIntegrity = (value: string) => { integrity.push(value); issues.push(value) }
  const finish = () => ({ issues, repairable, integrity })
  const expectedProvider = providerIdentity(task)
  const expectedWaitProvider = task.backend === 'claude' ? 'claude'
    : task.backend === 'dsh-chat-completions' && task.connection?.usageWindowWait === true
      ? 'dsh' : null
  if (!validSubscriptionWaits(result.subscriptionWaits)
    || (result.subscriptionWaits !== undefined && (expectedWaitProvider === null
      || result.subscriptionWaits.some(wait => wait.provider !== expectedWaitProvider
        || wait.sessionId !== result.actorId)))) {
    addIntegrity('provider subscription wait evidence is invalid')
  }
  if (result.model !== task.model) addIntegrity(`served model ${result.model} differs from ${task.model}`)
  if (result.actorId.trim() === '' || result.provider !== expectedProvider) addIntegrity('provider identity is incomplete or unexpected')
  if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0
    || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0
    || !Number.isFinite(result.costUsd) || result.costUsd < 0) addIntegrity('provider usage is invalid')
  const hasCacheEvidence = result.rawInputTokens !== undefined
    || result.cachedInputTokens !== undefined
    || result.cacheAccountingComplete !== undefined
  if (hasCacheEvidence) {
    const raw = result.rawInputTokens
    const cached = result.cachedInputTokens
    const complete = result.cacheAccountingComplete
    if (!Number.isSafeInteger(raw) || (raw ?? -1) < 0
      || !Number.isSafeInteger(cached) || (cached ?? -1) < 0
      || (cached ?? 0) > (raw ?? -1)
      || typeof complete !== 'boolean'
      || result.inputTokens !== (complete ? (raw ?? 0) - (cached ?? 0) : raw)) {
      addIntegrity('provider cache accounting is invalid')
    }
  }
  if (result.costAccountingComplete !== undefined && typeof result.costAccountingComplete !== 'boolean') {
    addIntegrity('provider cost accounting is invalid')
  }
  if (result.status === 'additive-unavailable') {
    if (task.providerClass !== 'additive' || task.optional !== true || result.unavailableReason === undefined) {
      addIntegrity('only an optional additive task may attest unavailability')
    }
    if (Object.keys(result.files).length !== 0) addIntegrity('an unavailable task cannot publish output files')
    // Recovery provenance is checked against the saved receipt proof by RunMachine;
    // it is not research evidence and must carry no observations or output files.
    const provenanceOnly = result.modelCalls === 0 && result.assertions.length === 1
      && /^promoted-execution:[a-z0-9][a-z0-9._-]{0,99}:[0-9a-f]{64}$/.test(result.assertions[0]!)
    if ((!provenanceOnly && result.assertions.length !== 0) || Object.keys(result.protocol).length !== 0) {
      addIntegrity('an unavailable task cannot publish evidence metadata')
    }
    return finish()
  }
  const finalCustody = task.promptKind === 'final-seal'
    ? await createFinalObservationCustody(visibleArtifacts) : undefined
  const finalSuffix = finalCustody === undefined ? undefined
    : sealFinalFinding('x', finalCustody).slice(1)
  for (const path of task.output.requiredFiles) {
    const content = result.files[path]
    if (content === undefined || content.trim() === '') addRepairable(`missing required output file: ${path}`)
  }
  for (const [path, content] of Object.entries(result.files)) {
    if (!/^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/.test(path) || path.includes('..')) addIntegrity(`unsafe output path: ${path}`)
    // Sealing appends exact supervisor-generated custody to a size-valid draft.
    const maxBytes = OUTPUT_FILE_MAX_BYTES + (task.providerClass === 'deterministic'
      && path === 'finding.md' && finalSuffix !== undefined
      ? new TextEncoder().encode(finalSuffix).byteLength : 0)
    if (new TextEncoder().encode(content).byteLength > maxBytes) addRepairable(`output file is too large: ${path}`)
  }
  const primaryPath = task.output.requiredFiles.find(path => path !== SUBMISSION_PATH)
  const primary = primaryPath === undefined ? '' : result.files[primaryPath] ?? ''
  if (requiresSubmission(task)) {
    const submission = await readSubmission(task, result.files, visibleArtifacts)
    for (const issue of submission.issues) addRepairable(issue)
    if (!same(submission.protocol, result.protocol)) {
      if (submission.issues.length > 0) addRepairable('protocol metadata differs from the structured submission')
      else addIntegrity('protocol metadata differs from the structured submission')
    }
    if (task.promptKind === 'coverage-challenge') {
      const headings = new Set(primary.split(/\r?\n/).filter(line => line.startsWith('### ')))
      for (const reference of new Set((submission.protocol.challengeObservations ?? [])
        .filter(observation => observation.disposition !== 'refuted').map(observation => observation.reference))) {
        if (!headings.has(`### ${reference}`)) addRepairable(`coverage challenge lacks evidence heading for ${reference}`)
      }
    }
    return finish()
  }
  if (task.promptKind === 'coverage-union') {
    const union = createCoverageUnion(visibleArtifacts)
    if (primary !== renderCoverageUnion(union)) addIntegrity('coverage union differs from deterministic accepted-input union')
    if (!same(union, result.protocol.coverageUnion ?? [])) {
      addIntegrity('coverage union metadata differs from deterministic accepted-input union')
    }
    const references = [...new Set(union.filter(value => value.observation.disposition !== 'refuted')
      .map(value => value.observation.reference))].toSorted()
    if (!same(references, result.protocol.dispositionReferences ?? [])) {
      addIntegrity('coverage union reference metadata is incomplete')
    }
  } else if (task.promptKind === 'review-union') {
    const union = createNegativeReviewUnion(visibleArtifacts)
    const manifest = createNegativeReviewUnionManifest(visibleArtifacts, union)
    if (primary !== canonicalJson(manifest)) addIntegrity('negative-review union differs from deterministic accepted-input union')
    if (!same(union, result.protocol.reviewUnion ?? [])) {
      addIntegrity('negative-review union metadata differs from deterministic accepted-input union')
    }
    if (!same(manifest.unionReferences, result.protocol.dispositionReferences ?? [])) {
      addIntegrity('negative-review union reference metadata is incomplete')
    }
    if (!same(manifest.decisionDissentObservationIds, result.protocol.decisionDissentObservationIds ?? [])) {
      addIntegrity('negative-review union dissent metadata is incomplete')
    }
  } else if (task.promptKind === 'final-seal') {
    const expected = finalCustody!
    if (!same(expected, result.protocol.finalCustody)) {
      addIntegrity('final observation custody differs from the immutable review frontier')
    } else {
      const marker = '<!-- ACK3_FINAL_OBSERVATION_CUSTODY_V1 -->'
      const expectedSuffix = finalSuffix!
      const markerIndex = primary.indexOf(marker)
      if (markerIndex <= 0 || primary.slice(markerIndex - 2) !== expectedSuffix) {
        addIntegrity('finding.md lacks the exact deterministic final observation custody register')
      }
    }
  }
  return finish()
}

export async function validateAgentResult(
  task: TaskDefinition,
  result: AgentResult,
  visibleArtifacts: readonly ArtifactRecord[],
): Promise<string[]> {
  return (await validateAgentResultDetailed(task, result, visibleArtifacts)).issues
}
