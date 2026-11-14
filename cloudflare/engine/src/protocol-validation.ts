import { validSubscriptionSwitches, validSubscriptionWaits } from '../container/subscription-limits.mjs'
import type { AgentRequest, AgentResult, ArtifactRecord, ExperimentDefinition, RejectedAttempt, TaskDefinition } from './contracts.js'
import { canonicalJson } from './canonical.js'
import {
  createCoverageUnion,
  createFinalObservationCustody,
  createNegativeReviewUnion,
  createNegativeReviewUnionManifest,
  renderCoverageUnion,
  sealFinalFinding,
} from './protocol-transforms.js'
import { requiresSubmission, SUBMISSION_PATH } from './submission.js'
import { providerIdentity } from './provider-identity.js'
import { claudeAccountBindings } from './subscription-credentials.js'
import { OUTPUT_FILE_MAX_BYTES } from './output-limits.js'
import { mandatorySearchRequirement, validateDismissalResearch } from './native-research.js'
import { scratchBundleIssues, scratchBundlePath } from './poc-handoff.js'
import {
  missingOutputIssues, outputSizeIssue, submissionContentChecks, SUBMIT_CHECK_ISSUE_PREFIX, SUBMIT_CHECK_UNFINISHED, validSubmitCheckReport,
} from './submission-check.js'

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/** The runner's report (container/output-files.mjs): 1 to 256 entries, each a returned file and a printable binding name. */
function validOutputCredentials(value: unknown, files: Readonly<Record<string, string>>): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 256 && value.every(item => item !== null
    && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).toSorted().join() === 'name,path'
    && typeof item.path === 'string' && Object.hasOwn(files, item.path)
    && typeof item.name === 'string' && /^[\x21-\x7e]{1,200}$/.test(item.name))
}

/** The execution gate shared by live results and archived-output validation.
 * Callers supply the original request/read set and prior outcomes; this neither
 * dispatches work nor accepts an artifact or charges its usage. */
export async function validateExecutionResult(
  definition: ExperimentDefinition,
  request: Pick<AgentRequest, 'task' | 'stage' | 'visibleArtifacts' | 'formatRepairOrdinal' | 'continuationMode' | 'sessionId'>,
  result: AgentResult,
  prior: readonly Pick<RejectedAttempt, 'sessionId' | 'nativeSearchEvidence'>[] = [],
) {
  const validation = await validateAgentResultDetailed(request.task, result, request.visibleArtifacts)
  const searchRequirement = mandatorySearchRequirement(definition, request.task, request.stage.kind)
  if (searchRequirement !== undefined && result.status === 'accepted') {
    const issues = validateDismissalResearch(result, prior, searchRequirement)
    validation.issues.push(...issues)
    validation.repairable.push(...issues)
  }
  const returnedSessionId = result.sessionId ?? result.actorId
  const changedRepairSession = request.formatRepairOrdinal !== undefined && returnedSessionId !== request.sessionId
  if (changedRepairSession) validation.issues.push('output correction returned a different session')
  if (request.continuationMode === 'resume' && request.task.providerClass === 'core'
    && returnedSessionId !== request.sessionId) {
    validation.issues.push('same-session repair returned a different native session')
  }
  return { ...validation, returnedSessionId, changedRepairSession }
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
  // A runner with Claude account rotation always returns its switches, possibly none.
  const accounts = task.backend === 'claude' && task.fallbackCredentialSources !== undefined
    ? claudeAccountBindings(task) : undefined
  if (accounts !== undefined && result.subscriptionSwitches === undefined) {
    addIntegrity('the runner returned no account switch record; use a container image with Claude account rotation')
  } else if (!validSubscriptionSwitches(result.subscriptionSwitches)
    || (result.subscriptionSwitches !== undefined && (accounts === undefined
      || result.subscriptionSwitches.some(item => item.sessionId !== result.actorId
        || !accounts.includes(item.from) || !accounts.includes(item.to))))) {
    addIntegrity('provider account switch evidence is invalid')
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
    if (result.assertions.length !== 0 || Object.keys(result.protocol).length !== 0) {
      addIntegrity('an unavailable task cannot publish evidence metadata')
    }
    return finish()
  }
  const finalCustody = task.promptKind === 'final-seal'
    ? await createFinalObservationCustody(visibleArtifacts) : undefined
  const finalSuffix = finalCustody === undefined ? undefined
    : sealFinalFinding('x', finalCustody).slice(1)
  for (const issue of missingOutputIssues(task, result.files)) addRepairable(issue)
  for (const [path, content] of Object.entries(result.files)) {
    if (!/^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/.test(path) || path.includes('..')) addIntegrity(`unsafe output path: ${path}`)
    // Sealing appends exact supervisor-generated custody to a size-valid draft.
    const maxBytes = OUTPUT_FILE_MAX_BYTES + (task.providerClass === 'deterministic'
      && path === 'finding.md' && finalSuffix !== undefined
      ? new TextEncoder().encode(finalSuffix).byteLength : 0)
    const oversized = outputSizeIssue(path, content, maxBytes)
    if (oversized !== undefined) addRepairable(oversized)
  }
  // The runner replaced a credential value in these files (T3); the agent must remove it.
  if (result.outputCredentials !== undefined) {
    if (!validOutputCredentials(result.outputCredentials, result.files)) addIntegrity('the runner output credential report is malformed')
    else for (const { path, name } of result.outputCredentials) {
      addRepairable(`${path} contained the value of the credential ${name}; Swarm replaced it with <redacted:${name}>. `
        + 'Remove it: never copy a credential, token or key into an output file.')
    }
  }
  // The runner owns the scratch test bundle: present and exact with keepPocs, absent otherwise.
  if (task.research !== undefined) {
    const bundlePath = scratchBundlePath(task.research)
    if (task.research.scratchCapture === undefined) {
      if (Object.hasOwn(result.files, bundlePath)) addIntegrity(`scratch test bundle without keepPocs: ${bundlePath}`)
    } else for (const issue of await scratchBundleIssues(task.research, result.files[bundlePath])) addIntegrity(issue)
  }
  const primaryPath = task.output.requiredFiles.find(path => path !== SUBMISSION_PATH)
  const primary = primaryPath === undefined ? '' : result.files[primaryPath] ?? ''
  // submitCheck: the runner reruns `ack3-submit` on the final files; its report exists exactly with the flag.
  const submitCheckIssues = () => {
    if (task.submitCheck !== true) {
      if (result.submitCheck !== undefined) addIntegrity('submission check report without submitCheck')
    } else if (result.submitCheck === undefined) {
      addIntegrity('the runner returned no submission check report; use a container image with ack3-submit')
    } else if (!validSubmitCheckReport(result.submitCheck)) {
      addIntegrity('the runner submission check report is malformed')
    } else {
      for (const issue of result.submitCheck.issues) {
        // The Worker reruns the shared checks; list each problem once.
        if (!issues.includes(issue)) addRepairable(`${SUBMIT_CHECK_ISSUE_PREFIX}${issue}`)
      }
      if (!result.submitCheck.done) addRepairable(SUBMIT_CHECK_UNFINISHED)
    }
  }
  if (requiresSubmission(task)) {
    const { submission, outputIssues } = await submissionContentChecks(task, result.files, visibleArtifacts)
    for (const issue of submission.issues) addRepairable(issue)
    if (!same(submission.protocol, result.protocol)) {
      if (submission.issues.length > 0) addRepairable('protocol metadata differs from the structured submission')
      else addIntegrity('protocol metadata differs from the structured submission')
    }
    for (const issue of outputIssues) addRepairable(issue)
    submitCheckIssues()
    return finish()
  }
  submitCheckIssues()
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
