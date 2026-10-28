import { dashboardContext } from './dashboard-context.js'
import type { ArtifactRecord, ProviderUsage, RunState, TaskDefinition } from './contracts.js'
import type { DashboardDefinition } from './dashboard-release.js'
import type {
  DashboardAgent, DashboardCompletion, DashboardEdge, DashboardFinding, DashboardNode, DashboardSnapshot, DashboardVerification, DashboardWaveTask, LiveCompletion,
} from './dashboard-types.js'
import { providerIdentity } from './provider-identity.js'
import { dashboardThroughput, dashboardTiming } from './dashboard-timing.js'
import { dashboardTaskBoundary, dashboardWaveViews, type DashboardRunState } from './dashboard-waves.js'

type Disposition = DashboardFinding['disposition']
type Location = { task: TaskDefinition, stageId: string, waveId: string, stageIndex: number, waveIndex: number }
type ObservationSource = { nodeId: string, agentId: string | null, waveIndex: number, artifact: ArtifactRecord | null }
type FindingDraft = { id: string, observationIds: Set<string>, nodeIds: Set<string>, inReport: boolean, dissent: boolean }

const text = (value: string, limit = 240): string => value.length > limit ? `${value.slice(0, limit - 1)}…` : value
const taskKey = (stageId: string, waveId: string, taskId: string): string => JSON.stringify([stageId, waveId, taskId])
const referenceKey = (value: string): string | null => value.trim() === '' || value.trim().toLowerCase() === 'none'
  ? null : value.trim().toUpperCase()
const providerFor = (task: TaskDefinition): string => providerIdentity(task)
const numberEqual = (left: number, right: number): boolean => Math.abs(left - right) <= 1e-10

/** Adds receipt counters without converting missing cache evidence into an attested cache miss. */
export function sumDashboardUsage(items: readonly ProviderUsage[]): ProviderUsage {
  const usage: ProviderUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
    rawInputTokens: 0, cachedInputTokens: 0, cacheAccountingComplete: true,
    costAccountingComplete: true }
  for (const item of items) {
    usage.modelCalls += item.modelCalls
    usage.inputTokens += item.inputTokens
    usage.outputTokens += item.outputTokens
    usage.costUsd += item.costUsd
    usage.rawInputTokens = (usage.rawInputTokens ?? 0) + (item.rawInputTokens ?? item.inputTokens)
    usage.cachedInputTokens = (usage.cachedInputTokens ?? 0) + (item.cachedInputTokens ?? 0)
    if ((item.modelCalls > 0 || item.inputTokens > 0 || item.outputTokens > 0)
      && item.cacheAccountingComplete !== true) usage.cacheAccountingComplete = false
    if (item.costAccountingComplete === false
      || ((item.modelCalls > 0 || item.inputTokens > 0 || item.outputTokens > 0
        || item.costUsd > 0 || (item.rawInputTokens ?? 0) > 0 || (item.cachedInputTokens ?? 0) > 0)
        && item.costAccountingComplete !== true)) usage.costAccountingComplete = false
  }
  usage.costUsd = Number(usage.costUsd.toFixed(12))
  return usage
}

export function buildDashboardSnapshot(
  state: DashboardRunState,
  definition: DashboardDefinition,
  live: { entries: LiveCompletion[], legacyCount: number, truncated: boolean },
  generatedAt = new Date().toISOString(),
  inheritedReceipts: readonly DashboardCompletion[] = [],
): DashboardSnapshot {
  const views = dashboardWaveViews(state, definition)
  const limitations = new Set([
    'Recorded state updates at persisted wave boundaries. Completed execution receipts are provisional; they do not establish validation or findings. In-flight token usage is not recorded.',
    state.discoveryScheduler
      ? 'Independent pool waves are not globally ordered. Earliest recorded contribution uses cohort publication time; all ties remain credited. Publication order does not establish discovery priority.'
      : 'Earliest wave means the earliest recorded position in this run’s stage/wave order. All tied source workspaces remain credited; task recording order does not establish discovery priority.',
    'Shared prior context and scheduled builds_on assignments do not demonstrate causal influence or exclusive contribution. Attribution follows explicit structured observation links only.',
    'Verification is shown only when explicit structured outcomes exist; behavior and exploitability remain separate. Outcomes without observation IDs are archived group assessments and do not establish individual observation coverage. Missing verification, severity and distinct finding titles are not inferred from prose.',
    'Final custody includes unretained observations. Custody links remain visible, but only explicitly retained report references contribute to report-item metrics.',
    'Recorded provider cost is an estimate, not an invoice. Subscription tasks record zero incremental cost; native DSH counters cover recorded agent steps and may omit provider-side summary traffic.',
    'This snapshot includes inherited checkpoint usage once. Adding parent and child run totals would count shared work again; revalidation can carry historical usage without a new provider call.',
    'Agent times measure elapsed time from wave admission to result receipt, including startup, queueing, retries and receipt delivery; they are not model execution durations. Awaiting-result clocks do not prove process activity. Stage spans include pauses. Missing historical or inherited receipt times remain unknown.',
    'Throughput is recorded input (including recorded cache hits) plus output per elapsed wall-clock second, with output shown separately. Parallel agents share the wave/stage span. Active or incomplete snapshots are partial; unvalidated receipts are provisional. This is an end-to-end average, not live model generation speed. Missing time or usage is unavailable, not zero.',
  ])
  const locations = new Map<string, Location>()
  const waveOrdinals = new Map<string, number>()
  const agentMap = new Map<string, DashboardAgent>()
  const agentRoles = new Map<string, Set<string>>()
  let ordinal = 0
  for (const { stage, stageIndex, wave, sourceWaveId } of views) {
    const waveIndex = ordinal++
    waveOrdinals.set(JSON.stringify([stage.id, wave.id]), waveIndex)
    for (const task of wave.tasks) {
      locations.set(taskKey(stage.id, sourceWaveId, task.id), { task, stageId: stage.id, waveId: wave.id, stageIndex, waveIndex })
      const current = agentMap.get(task.workspaceKey)
      if (current === undefined) {
        agentMap.set(task.workspaceKey, { id: task.workspaceKey, model: task.model, provider: providerFor(task),
          role: task.logicalRole, usage: sumDashboardUsage([]), acceptedTasks: 0, rejectedAttempts: 0,
          observations: 0, linkedReportItems: 0, firstRecordedItems: 0 })
      } else if (current.model !== task.model || current.provider !== providerFor(task)) {
        current.model = current.model === task.model ? current.model : 'mixed'
        current.provider = current.provider === providerFor(task) ? current.provider : 'mixed'
        limitations.add('A workspace contains multiple configured models/providers; its grouped usage cannot be assigned one model rate.')
      }
      const roles = agentRoles.get(task.workspaceKey) ?? new Set<string>()
      roles.add(task.research?.role ?? task.logicalRole)
      agentRoles.set(task.workspaceKey, roles)
    }
  }
  for (const agent of agentMap.values()) agent.role = text([...agentRoles.get(agent.id) ?? []].join(', '))
  const locationFor = (item: { stageId: string, waveId: string, taskId: string }): Location | undefined =>
    locations.get(taskKey(item.stageId, item.waveId, item.taskId))
  const usageRows = [...state.artifacts.map(item => ({ ...item, kind: 'artifact' as const })),
    ...state.rejectedAttempts.map(item => ({ ...item, kind: 'rejection' as const }))]
  const activity = new Map<string, DashboardSnapshot['activity'][number]>()
  for (const row of usageRows) {
    const location = locationFor(row)
    if (location === undefined) {
      limitations.add('Some recorded tasks are absent from the supplied definition; their usage remains in run totals and source attribution is unknown.')
      continue
    }
    const agent = agentMap.get(location.task.workspaceKey)!
    agent.usage = sumDashboardUsage([agent.usage, row.usage])
    const key = taskKey(row.stageId, location.waveId, agent.id)
    const group = activity.get(key) ?? { stageId: row.stageId, waveId: location.waveId, agentId: agent.id, usage: sumDashboardUsage([]) }
    group.usage = sumDashboardUsage([group.usage, row.usage])
    activity.set(key, group)
    if (row.kind === 'rejection') agent.rejectedAttempts += 1
    else if (row.kind === 'artifact' && row.status === 'accepted') agent.acceptedTasks += 1
  }
  const reconstructedUsage = sumDashboardUsage(usageRows.map(row => row.usage))
  const accountingMatches = (['modelCalls', 'inputTokens', 'outputTokens', 'costUsd'] as const)
    .every(key => numberEqual(reconstructedUsage[key], state.budget[key]))
  if (!accountingMatches) {
    limitations.add('Receipt sums differ from the authoritative state budget; run totals use the recorded budget and grouped totals use available receipts.')
  }
  const recordedUsage = accountingMatches ? { ...reconstructedUsage, ...state.budget }
    : { ...state.budget, cacheAccountingComplete: false, costAccountingComplete: false }

  const terminalTasks = new Set(state.artifacts.map(item => taskKey(item.stageId, item.waveId, item.taskId)))
  const rejectedKeys = new Set(state.rejectedAttempts.filter(item => item.outputDigest !== null).map(item => JSON.stringify([
    item.stageId, item.waveId, item.taskId, item.promptDigest, item.attempt, item.outputDigest,
  ])))
  const uniqueLive = new Map<string, LiveCompletion>()
  for (const entry of live.entries) {
    if (!uniqueLive.has(entry.requestDigest)) uniqueLive.set(entry.requestDigest, entry)
  }
  const provisionalCompletions = [...uniqueLive.values()]
    .filter(entry => !terminalTasks.has(taskKey(entry.stageId, entry.waveId, entry.taskId))
    && !rejectedKeys.has(JSON.stringify([entry.stageId, entry.waveId, entry.taskId, entry.promptDigest, entry.attempt, entry.outputDigest])))
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.requestDigest.localeCompare(right.requestDigest))
    .map(entry => ({ ...entry, usage: { ...entry.usage } }))
  if (live.legacyCount > 0) limitations.add('Legacy execution receipts lack dashboard metadata; their provisional usage and task attribution are unavailable.')
  if (live.truncated) limitations.add('Execution receipt listing is truncated. Provisional totals cover only the listed receipts.')

  const nodes = new Map<string, DashboardNode>()
  const edges = new Map<string, DashboardEdge>()
  const sources = new Map<string, ObservationSource>()
  const primary = new Map<string, Set<Disposition>>()
  const reviewed = new Map<string, Set<Disposition>>()
  const reviewOutcomes = new Map<string, Set<string>>()
  const explicitDissent = new Set<string>()
  const refsByObservation = new Map<string, Set<string>>()
  const findings = new Map<string, FindingDraft>()
  const observationReviewNodes = new Map<string, Set<string>>()
  const reportArtifacts: ArtifactRecord[] = []
  const verificationByReference = new Map<string, DashboardVerification[]>()
  const addEdge = (from: string, to: string, kind: DashboardEdge['kind']) => {
    edges.set(JSON.stringify([from, to, kind]), { from, to, kind })
  }
  const artifactNode = (artifact: ArtifactRecord | null, id: string, kind: DashboardNode['kind'], label: string, detail: string,
    sourceTaskId?: string): DashboardNode => {
    const location = artifact === null ? undefined : sourceTaskId === undefined ? locationFor(artifact)
      : locations.get(taskKey(artifact.stageId, artifact.waveId, sourceTaskId))
    return { id, kind, label: text(label), detail: text(detail, 3000), stageId: artifact?.stageId ?? '', waveId: location?.waveId ?? artifact?.waveId ?? '',
      waveIndex: location?.waveIndex ?? -1,
      model: artifact?.model ?? null, agentId: location?.task.workspaceKey ?? null,
      artifactId: artifact?.id ?? null, artifactDigest: artifact?.contentDigest ?? null }
  }
  const ensureObservation = (id: string): ObservationSource => {
    const found = sources.get(id)
    if (found !== undefined) return found
    const nodeId = `observation:${id}`
    nodes.set(nodeId, artifactNode(null, nodeId, 'observation', id, 'Source observation content and contributor are not recorded in this snapshot.'))
    const source = { nodeId, agentId: null, waveIndex: -1, artifact: null }
    sources.set(id, source)
    limitations.add('Some structured links lack a recorded source observation; those nodes remain visible with unknown contributor and wave.')
    return source
  }
  const addObservation = (id: string, label: string, detail: string, artifact: ArtifactRecord) => {
    if (sources.has(id)) {
      limitations.add('A source observation identifier appears more than once; the first recorded source is shown and exclusivity is unproven.')
      return
    }
    const node = artifactNode(artifact, `observation:${id}`, 'observation', label, detail)
    nodes.set(node.id, node)
    sources.set(id, { nodeId: node.id, agentId: node.agentId, waveIndex: node.waveIndex, artifact })
    if (node.agentId !== null) agentMap.get(node.agentId)!.observations += 1
  }
  const draft = (id: string): FindingDraft => {
    const found = findings.get(id)
    if (found !== undefined) return found
    const created = { id, observationIds: new Set<string>(), nodeIds: new Set<string>(), inReport: false, dissent: false }
    findings.set(id, created)
    return created
  }
  const ensureReference = (reference: string): string => {
    const nodeId = `reference:${reference}`
    if (!nodes.has(nodeId)) nodes.set(nodeId, artifactNode(null, nodeId, 'reference', reference,
      'Structured reference identifier. This may link multiple observations and does not prove they share one mechanism.'))
    draft(reference).nodeIds.add(nodeId)
    return nodeId
  }
  const linkReference = (observationId: string, rawReference: string): string | null => {
    const reference = referenceKey(rawReference)
    if (reference === null) return null
    const source = ensureObservation(observationId)
    const refNode = ensureReference(reference)
    const related = refsByObservation.get(observationId) ?? new Set<string>()
    related.add(reference)
    refsByObservation.set(observationId, related)
    const finding = draft(reference)
    finding.observationIds.add(observationId)
    finding.nodeIds.add(source.nodeId)
    return refNode
  }
  const recordJudgment = (map: Map<string, Set<Disposition>>, observationId: string, disposition: Disposition) => {
    ensureObservation(observationId)
    const values = map.get(observationId) ?? new Set<Disposition>()
    values.add(disposition)
    map.set(observationId, values)
  }
  const accepted = state.artifacts.filter(artifact => artifact.status === 'accepted')
  for (const artifact of accepted) {
    for (const observation of artifact.protocol.research?.observations ?? []) {
      addObservation(observation.id, observation.statement, [observation.statement, `Conditions: ${observation.conditions.join('; ')}`,
        `Consequence: ${observation.consequence}`, `Evidence: ${observation.evidence.join('; ')}`].join('\n'), artifact)
    }
    for (const observation of artifact.protocol.challengeObservations ?? []) {
      addObservation(observation.id, observation.id, `${observation.perspective}: ${observation.rationale}`, artifact)
    }
  }
  // Union entries explicitly retain source task/model attribution even if the
  // corresponding source artifact is absent from a partial historical export.
  for (const artifact of accepted) for (const entry of artifact.protocol.coverageUnion ?? []) {
    if (sources.has(entry.observation.id)) continue
    const location = [...locations.values()].find(value => value.task.id === entry.sourceTaskId)
    const node = artifactNode(null, `observation:${entry.observation.id}`, 'observation', entry.observation.id,
      `${entry.observation.perspective}: ${entry.observation.rationale}\nSource recorded by coverage union; source artifact unavailable.`)
    node.stageId = location?.stageId ?? ''
    node.waveId = location?.waveId ?? ''
    node.waveIndex = location?.waveIndex ?? -1
    node.model = entry.model
    node.agentId = location?.task.workspaceKey ?? null
    nodes.set(node.id, node)
    sources.set(entry.observation.id, { nodeId: node.id, agentId: node.agentId, waveIndex: node.waveIndex, artifact: null })
    if (node.agentId !== null) agentMap.get(node.agentId)!.observations += 1
    limitations.add('Some observations retain explicit coverage-union source attribution without their source artifact; source artifact links remain unavailable.')
  }
  for (const artifact of accepted) {
    for (const disposition of [...artifact.protocol.synthesisDispositions ?? [], ...artifact.protocol.challengeObservations ?? [],
      ...(artifact.protocol.coverageUnion ?? []).map(entry => entry.observation)]) {
      recordJudgment(primary, disposition.id, disposition.disposition)
      const refNode = linkReference(disposition.id, disposition.reference)
      if (refNode !== null) addEdge(ensureObservation(disposition.id).nodeId, refNode, 'disposition')
    }
    for (const observationId of artifact.protocol.decisionDissentObservationIds ?? []) explicitDissent.add(observationId)
    for (const custody of artifact.protocol.finalCustody?.observations ?? []) {
      ensureObservation(custody.observationId)
      if (custody.decisionDissent) explicitDissent.add(custody.observationId)
      for (const reference of custody.retainedReferences) {
        const refNode = linkReference(custody.observationId, reference)
        if (refNode !== null) addEdge(ensureObservation(custody.observationId).nodeId, refNode, 'disposition')
      }
    }
    const location = locationFor(artifact)
    if (location?.task.promptKind === 'reporting' || artifact.protocol.finalCustody !== undefined || artifact.taskId === 'reporter') {
      reportArtifacts.push(artifact)
    }
  }
  const reviewKeys = new Set<string>()
  const addReview = (artifact: ArtifactRecord, reviewerTaskId: string, actorId: string, model: string,
    decision: { observationId: string, action: string, finalDisposition: Disposition, finalReference: string, rationale: string }) => {
    const key = JSON.stringify([reviewerTaskId, actorId, decision.observationId, decision.action,
      decision.finalDisposition, decision.finalReference, decision.rationale])
    if (reviewKeys.has(key)) return
    reviewKeys.add(key)
    recordJudgment(reviewed, decision.observationId, decision.finalDisposition)
    const outcomes = reviewOutcomes.get(decision.observationId) ?? new Set<string>()
    outcomes.add(JSON.stringify([decision.finalDisposition, referenceKey(decision.finalReference)]))
    reviewOutcomes.set(decision.observationId, outcomes)
    const source = ensureObservation(decision.observationId)
    const id = `review:${reviewerTaskId}:${decision.observationId}:${reviewKeys.size}`
    const node = artifactNode(artifact, id, 'review', `${reviewerTaskId}: ${decision.action}`,
      `${decision.finalDisposition} | ${decision.finalReference}\n${decision.rationale}`, reviewerTaskId)
    node.model = model
    nodes.set(id, node)
    const reviewNodes = observationReviewNodes.get(decision.observationId) ?? new Set<string>()
    reviewNodes.add(id)
    observationReviewNodes.set(decision.observationId, reviewNodes)
    addEdge(source.nodeId, id, 'review')
    const refNode = linkReference(decision.observationId, decision.finalReference)
    if (refNode !== null) addEdge(id, refNode, 'review')
  }
  for (const artifact of accepted) for (const decision of artifact.protocol.reviewDecisions ?? []) {
    addReview(artifact, artifact.taskId, artifact.actorId, artifact.model, decision)
  }
  for (const artifact of accepted) for (const union of artifact.protocol.reviewUnion ?? []) {
    if (union.dissent) explicitDissent.add(union.observationId)
    for (const decision of union.decisions) {
      const sourceArtifact = accepted.find(value => value.taskId === decision.reviewerTaskId && value.actorId === decision.actorId)
      addReview(sourceArtifact ?? artifact, decision.reviewerTaskId, decision.actorId, decision.model, decision)
    }
    for (const reference of union.retainedReferences) {
      const refNode = linkReference(union.observationId, reference)
      if (refNode !== null) addEdge(ensureObservation(union.observationId).nodeId, refNode, 'review')
    }
  }
  for (const [observationId, source] of sources) {
    if ((refsByObservation.get(observationId)?.size ?? 0) === 0) {
      const finding = draft(observationId)
      finding.observationIds.add(observationId)
      finding.nodeIds.add(source.nodeId)
    }
  }
  // Optional typed outcomes from the structured-submissions contract. Older
  // artifacts stay readable; this projection never interprets narrative text.
  for (const artifact of accepted) {
    const outcomes = 'verificationOutcomes' in artifact.protocol ? artifact.protocol.verificationOutcomes : undefined
    if (!Array.isArray(outcomes)) continue
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.reference !== 'string'
        || typeof outcome.evidence !== 'string'
        || !['reproduced', 'not-reproduced', 'unresolved'].includes(outcome.behavior)
        || !['supported', 'refuted', 'unresolved'].includes(outcome.exploitability)) {
        limitations.add('An invalid structured verification outcome was omitted; its source artifact remains available.')
        continue
      }
      const reference = referenceKey(outcome.reference)
      if (reference === null) continue
      const referenceNode = ensureReference(reference)
      const nodeId = `verification:${artifact.id}:${index}`
      const evidenceMethod = typeof outcome.evidenceMethod === 'string'
        && ['fresh-execution', 'prior-execution-reviewed', 'source-inspection', 'not-attempted'].includes(outcome.evidenceMethod)
        ? outcome.evidenceMethod as DashboardVerification['evidenceMethod'] : undefined
      const value: DashboardVerification = { nodeId,
        ...(outcome.observationIds === undefined ? {} : { observationIds: outcome.observationIds }), behavior: outcome.behavior, exploitability: outcome.exploitability,
        ...(evidenceMethod === undefined ? {} : { evidenceMethod }), evidence: text(outcome.evidence, 3_000) }
      const values = verificationByReference.get(reference) ?? []
      values.push(value)
      verificationByReference.set(reference, values)
      nodes.set(nodeId, artifactNode(artifact, nodeId, 'verification', `${reference}: recorded verification`,
        `Behavior: ${value.behavior}\nExploitability: ${value.exploitability}\nEvidence method: ${value.evidenceMethod ?? 'not recorded'}\n${value.evidence}`))
      draft(reference).nodeIds.add(nodeId)
      addEdge(referenceNode, nodeId, 'review')
      for (const id of outcome.observationIds ?? []) addEdge(ensureObservation(id).nodeId, nodeId, 'review')
    }
  }
  for (const artifact of reportArtifacts) {
    const reportId = `report:${artifact.id}`
    nodes.set(reportId, artifactNode(artifact, reportId, 'report', artifact.taskId,
      'Report or observation record. Links show which evidence was retained; retention alone does not establish a reported finding.'))
    const references = new Set([...(artifact.protocol.retainedReferences ?? []), ...(artifact.protocol.finalCustody?.retainedReferences ?? [])])
    for (const rawReference of references) {
      const reference = referenceKey(rawReference)
      if (reference === null) continue
      const observationId = sources.has(rawReference) ? rawReference : reference
      const source = sources.get(observationId)
      const from = source?.nodeId ?? ensureReference(reference)
      addEdge(from, reportId, 'report')
      const finding = draft(source === undefined ? reference : observationId)
      if (source !== undefined) {
        finding.observationIds.add(observationId)
        finding.nodeIds.add(source.nodeId)
      }
      finding.inReport = true
      finding.nodeIds.add(reportId)
      for (const outcome of verificationByReference.get(reference) ?? []) addEdge(outcome.nodeId, reportId, 'report')
    }
    for (const custody of artifact.protocol.finalCustody?.observations ?? []) {
      const source = ensureObservation(custody.observationId)
      addEdge(source.nodeId, reportId, 'report')
      const observationFinding = findings.get(custody.observationId)
      if (observationFinding !== undefined) observationFinding.nodeIds.add(reportId)
      for (const rawReference of custody.retainedReferences) {
        const reference = referenceKey(rawReference)
        if (reference === null) continue
        const finding = draft(reference)
        finding.inReport = true
        finding.nodeIds.add(reportId)
        addEdge(ensureReference(reference), reportId, 'report')
      }
    }
    const sourceReport = reportArtifacts.find(value => value.contentDigest === artifact.protocol.finalCustody?.sourceReportArtifactDigest)
    if (sourceReport !== undefined && sourceReport.id !== artifact.id) addEdge(`report:${sourceReport.id}`, reportId, 'report')
  }
  const projectedFindings: DashboardFinding[] = [...findings.values()].map((finding): DashboardFinding => {
    const observationIds = [...finding.observationIds].sort()
    const dispositions = new Set<Disposition>()
    const contributors = new Set<string>()
    let earliestWave: number | null = null
    let earliestOrder = Infinity
    const firstContributors = new Set<string>()
    for (const observationId of observationIds) {
      for (const disposition of reviewed.get(observationId) ?? primary.get(observationId) ?? []) dispositions.add(disposition)
      if (explicitDissent.has(observationId) || (reviewOutcomes.get(observationId)?.size ?? 0) > 1) finding.dissent = true
      const source = sources.get(observationId)!
      if (source.agentId !== null) contributors.add(source.agentId)
      const location = source.artifact === null ? undefined : locationFor(source.artifact)
      const orderedByPublication = state.discoveryScheduler !== undefined
      const publication = orderedByPublication && source.artifact !== null && location !== undefined ? dashboardTaskBoundary(state,
        source.artifact.stageId, source.artifact.waveId, location.task).receipt?.completedAt : undefined
      const order = orderedByPublication ? Date.parse(publication ?? '') : source.waveIndex
      if (source.waveIndex >= 0 && Number.isFinite(order)) {
        if (order < earliestOrder) { earliestOrder = order; earliestWave = source.waveIndex; firstContributors.clear() }
        if (order === earliestOrder && source.agentId !== null) firstContributors.add(source.agentId)
      }
      for (const nodeId of observationReviewNodes.get(observationId) ?? []) finding.nodeIds.add(nodeId)
    }
    if (dispositions.size > 1) finding.dissent = true
    const disposition = dispositions.size === 1 ? [...dispositions][0]! : 'unresolved'
    const verification = verificationByReference.get(finding.id) ?? []
    if (verification.some((left, i) => verification.slice(i + 1).some(right =>
      (left.observationIds === undefined || right.observationIds === undefined
        || left.observationIds.some(id => right.observationIds!.includes(id)))
      && `${left.behavior}:${left.exploitability}` !== `${right.behavior}:${right.exploitability}`))) finding.dissent = true
    for (const id of contributors) if (finding.inReport) agentMap.get(id)!.linkedReportItems += 1
    for (const id of firstContributors) if (finding.inReport) agentMap.get(id)!.firstRecordedItems += 1
    return { id: finding.id, label: text(finding.id), disposition, inReport: finding.inReport,
      confirmation: verification.length === 0 ? 'not-recorded' : 'axes-recorded', verification, severity: 'not-recorded', earliestWave,
      firstContributors: [...firstContributors].sort(), contributors: [...contributors].sort(), observationIds,
      nodeIds: [...finding.nodeIds].sort(), dissent: finding.dissent }
  }).sort((left, right) => left.id.localeCompare(right.id))
  const endedStages = new Set(state.stageEndReceipts.map(receipt => receipt.stageIndex))
  const stages: DashboardSnapshot['stages'] = definition.stages.map((stage, stageIndex) => ({
    id: stage.id, kind: stage.kind, label: text(stage.objective || stage.id),
    status: endedStages.has(stageIndex) || stageIndex < state.cursor.stageIndex ? 'complete'
      : stageIndex === state.cursor.stageIndex ? 'current' : 'pending',
    usage: sumDashboardUsage(usageRows.filter(row => row.stageId === stage.id).map(row => row.usage)),
    waveCount: views.filter(view => view.stage.id === stage.id).length,
    ...(state.discoveryScheduler?.stageId === stage.id ? { waveUnit: 'pool waves' as const } : {}), completedWaves: state.waveReceipts.filter(receipt => receipt.stageId === stage.id).length,
  }))
  // Join by stage + wave + task, never workspace alone: a lane can continue in later waves.
  const artifactsByTask = new Map(state.artifacts.map(item => [taskKey(item.stageId, item.waveId, item.taskId), item]))
  const rejectionsByTask = new Map<string, RunState['rejectedAttempts'][number][]>()
  const liveByTask = new Map<string, LiveCompletion[]>()
  const allReceiptsByTask = new Map<string, DashboardCompletion[]>()
  for (const item of [...uniqueLive.values(), ...inheritedReceipts]) {
    const key = taskKey(item.stageId, item.waveId, item.taskId)
    const group = allReceiptsByTask.get(key) ?? []
    group.push(item)
    allReceiptsByTask.set(key, group)
  }
  for (const item of state.rejectedAttempts) {
    const key = taskKey(item.stageId, item.waveId, item.taskId)
    const group = rejectionsByTask.get(key) ?? []
    group.push(item)
    rejectionsByTask.set(key, group)
  }
  for (const item of provisionalCompletions) {
    const key = taskKey(item.stageId, item.waveId, item.taskId)
    const group = liveByTask.get(key) ?? []
    group.push(item)
    liveByTask.set(key, group)
  }
  function taskProgress(stageId: string, waveId: string, task: TaskDefinition, waveStatus: DashboardSnapshot['waves'][number]['status'], startedAt: string | null, completedAt: string | null, singleTaskReceipt?: RunState['waveReceipts'][number]): DashboardWaveTask {
    const key = taskKey(stageId, waveId, task.id)
    const artifact = artifactsByTask.get(key)
    const rejections = rejectionsByTask.get(key) ?? []
    // Recovery carries old usage/rejections but restarts attempt numbering. Only
    // evidence from this wave admission may decide the current execution status.
    const currentRejections = rejections.filter(item => startedAt === null || Date.parse(item.rejectedAt) >= Date.parse(startedAt))
    const completions = (liveByTask.get(key) ?? []).filter(item => startedAt === null || Date.parse(item.recordedAt) >= Date.parse(startedAt))
    const inFlight = state.inFlightAgentAttempts?.find(item => taskKey(item.stageId, item.waveId, item.taskId) === key)
    const latest = completions.at(-1)
    const lastRejectedAttempt = Math.max(0, ...currentRejections.map(item => item.attempt))
    const lastObservedAttempt = Math.max(lastRejectedAttempt, ...completions.map(item => item.attempt))
    const latestAttempt = Math.max(lastObservedAttempt, inFlight?.attempt ?? 0)
    let status: DashboardWaveTask['status']
    if (artifact !== undefined) status = artifact.status === 'accepted' ? 'accepted' : 'unavailable'
    else if (waveStatus === 'current' && inFlight && inFlight.attempt > lastObservedAttempt) {
      status = state.status === 'running' ? 'awaiting-result' : 'interrupted'
    }
    else if (completions.some(item => item.attempt >= lastRejectedAttempt)) status = 'returned'
    else if (currentRejections.length > 0) status = 'rejected'
    else if (waveStatus === 'not-run') status = 'not-run'
    else if (waveStatus === 'complete') status = 'unknown'
    else if (waveStatus === 'current' && state.status === 'running') status = 'awaiting-result'
    else if (waveStatus === 'current' && (state.status === 'failed' || state.status === 'stopped')) status = 'interrupted'
    else if (state.status === 'failed' || state.status === 'stopped') status = 'not-run'
    else status = 'pending'
    // Accepted receipt timing survives accounting deduplication. Do not use another
    // attempt's return time, a later wave in the same workspace, or a child's revalidation.
    const matchingReceipts = (allReceiptsByTask.get(key) ?? []).filter(item => (
      item.model === task.model && item.provider === providerFor(task)
      && Date.parse(item.recordedAt) >= Date.parse(item.originTiming?.startedAt ?? startedAt ?? '')
      && Date.parse(item.recordedAt) <= Date.parse(item.originTiming?.endedAt ?? completedAt ?? generatedAt)
      && (artifact === undefined || (item.outputDigest === artifact.contentDigest && item.promptDigest === artifact.promptDigest && item.actorId === artifact.actorId))
    )).sort((a, b) => b.attempt - a.attempt || a.recordedAt.localeCompare(b.recordedAt))
    const returnedAt = artifact?.status === 'additive-unavailable' ? null : matchingReceipts[0]?.recordedAt ?? null
    const rejectedAt = [...currentRejections].sort((a, b) => b.attempt - a.attempt)[0]?.rejectedAt ?? null
    // Supervisor steps have no provider receipt. A sealed, single-task wave gives
    // their measured boundary (including persistence), not model execution time.
    const supervisorReceipt = task.providerClass === 'deterministic' && status === 'accepted' && returnedAt === null
      && artifact && singleTaskReceipt?.artifactDigests.includes(artifact.contentDigest) ? singleTaskReceipt : undefined
    const rejectionTiming = status === 'rejected' || (status === 'unavailable' && rejectedAt !== null)
    const finishedAt = status === 'accepted' || status === 'returned' ? returnedAt
      : rejectionTiming ? rejectedAt : status === 'interrupted' ? state.updatedAt : null
    const measuredStart = status === 'accepted' && matchingReceipts[0]?.originTiming
      ? matchingReceipts[0].originTiming.startedAt
      : rejectionTiming || ['accepted', 'returned', 'awaiting-result', 'interrupted'].includes(status) ? startedAt : null
    const timing = supervisorReceipt
      ? dashboardTiming(supervisorReceipt.startedAt, supervisorReceipt.completedAt, false, generatedAt, 'single-task-wave')
      : dashboardTiming(measuredStart, finishedAt, status === 'awaiting-result', generatedAt,
        rejectionTiming ? 'last-rejection' : ['accepted', 'returned'].includes(status) ? 'result' : 'wave')
    if (matchingReceipts[0]?.originTiming) timing.sourceRunId = matchingReceipts[0].originTiming.runId
    const usage = sumDashboardUsage([...rejections.map(item => item.usage), ...(artifact ? [artifact.usage] : [])])
    const provisionalUsage = sumDashboardUsage(completions.map(item => item.usage))
    return {
      taskId: task.id, agentId: task.workspaceKey, model: task.model, provider: providerFor(task),
      ...(typeof task.modelPool === 'string' ? { modelPool: task.modelPool } : {}),
      ...(Number.isSafeInteger(task.research?.wave) ? { localWave: task.research!.wave } : {}),
      promptKind: task.promptKind, providerClass: task.providerClass,
      ...(Number.isSafeInteger(task.research?.researcher) ? { researcher: task.research!.researcher } : {}),
      role: text(task.research?.role ?? task.logicalRole), status,
      workspace: task.providerClass === 'deterministic' ? undefined : { key: task.workspaceKey, policy: task.workspaceMode },
      lastAttempt: (Math.max(latestAttempt, matchingReceipts[0]?.attempt ?? 0) || null), lastReceiptAt: returnedAt ?? latest?.recordedAt ?? null,
      context: task.providerClass === 'deterministic' ? undefined : dashboardContext(matchingReceipts[0]?.originTiming && matchingReceipts[0].originTiming.runId !== state.runId ? { journal: [] } : state, {
        stageId, waveId, taskId: task.id, attempt: (Math.max(latestAttempt, matchingReceipts[0]?.attempt ?? 0) || undefined),
        promptDigest: inFlight?.promptDigest ?? artifact?.promptDigest ?? latest?.promptDigest,
        actorId: artifact?.actorId ?? (inFlight ? undefined : latest?.actorId),
      }),
      timing,
      throughput: status === 'unavailable' ? null : dashboardThroughput(sumDashboardUsage([usage, provisionalUsage]), timing,
        completions.length > 0, live.truncated || !['accepted', 'returned'].includes(status)),
      rejectedAttempts: rejections.length,
      usage, provisionalUsage,
    }
  }
  const waves: DashboardSnapshot['waves'] = views.map(({ stage, stageIndex, wave, sourceWaveId, localIndex,
    modelPool, independent, receipt, startedAt, admitted }) => {
    const status = receipt !== undefined ? 'complete' : endedStages.has(stageIndex) || stageIndex < state.cursor.stageIndex || state.status === 'completed'
      ? 'not-run' : independent ? admitted ? 'current' : 'pending'
      : stageIndex === state.cursor.stageIndex && localIndex === state.cursor.waveIndex ? 'current' : 'pending'
    const completedAt = receipt?.completedAt ?? null
    const interrupted = status === 'current' && ['failed', 'stopped'].includes(state.status)
    const taskIds = new Set(wave.tasks.map(task => task.id))
    const tasks = wave.tasks.map(task => taskProgress(stage.id, sourceWaveId, task, status, startedAt, completedAt,
      wave.tasks.length === 1 ? receipt : undefined))
    // Imported usage belongs to its original execution, not the child's short
    // recovery step. Keep admission-based task status separate from this span.
    const spanStartedAt = [startedAt, ...tasks.map(task => task.timing?.sourceRunId ? task.timing.startedAt : null)]
      .filter((at): at is string => at != null && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
    return { id: wave.id, stageId: stage.id, sourceWaveId,
      ...(modelPool === undefined ? {} : { modelPool }),
      index: waveOrdinals.get(JSON.stringify([stage.id, wave.id]))!,
      label: `${stage.id} / ${modelPool === undefined ? '' : `${modelPool} / `}${sourceWaveId}`, status,
      tasks,
      usage: sumDashboardUsage(usageRows.filter(row => row.stageId === stage.id && row.waveId === sourceWaveId && taskIds.has(row.taskId)).map(row => row.usage)),
      startedAt: spanStartedAt, completedAt,
      timing: dashboardTiming(spanStartedAt, completedAt ?? (interrupted ? state.updatedAt : null), status === 'current' && state.status === 'running', generatedAt, 'wave'),
      agentCount: new Set(wave.tasks.map(task => task.workspaceKey)).size,
      observationCount: [...nodes.values()].filter(node => node.kind === 'observation' && node.stageId === stage.id && node.waveId === wave.id).length }
  })
  for (const wave of waves) {
    const provisional = provisionalCompletions.filter(item => item.stageId === wave.stageId && item.waveId === wave.sourceWaveId
      && wave.tasks.some(task => task.taskId === item.taskId))
    wave.throughput = dashboardThroughput(sumDashboardUsage([wave.usage, ...provisional.map(item => item.usage)]),
      wave.timing, provisional.length > 0, live.truncated || wave.status !== 'complete')
  }
  for (const [index, stage] of stages.entries()) {
    const recorded = waves.filter(wave => wave.stageId === stage.id)
    const starts = recorded.map(wave => wave.startedAt).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at))).sort()
    const ends = recorded.map(wave => wave.completedAt).filter((at): at is string => at !== null && Number.isFinite(Date.parse(at))).sort()
    const endedAt = state.stageEndReceipts.findLast(item => item.stageIndex === index)?.endedAt
      ?? (stage.status === 'complete' ? ends.at(-1) : undefined)
      ?? (stage.status === 'current' && ['failed', 'stopped'].includes(state.status) ? state.updatedAt : null)
    stage.timing = dashboardTiming(starts[0] ?? null, endedAt, stage.status === 'current' && state.status === 'running', generatedAt, 'stage-span')
    const provisional = provisionalCompletions.filter(item => item.stageId === stage.id)
    // A later timed wave cannot supply the denominator for untimed earlier work.
    const untimedUsage = recorded.some(wave => wave.throughput == null && (
      wave.usage.inputTokens + (wave.usage.rawInputTokens ?? 0) + wave.usage.outputTokens > 0
      || provisional.some(item => item.waveId === wave.sourceWaveId && wave.tasks.some(task => task.taskId === item.taskId))))
    stage.throughput = untimedUsage ? null : dashboardThroughput(sumDashboardUsage([stage.usage, ...provisional.map(item => item.usage)]),
      stage.timing, provisional.length > 0, live.truncated || stage.status !== 'complete')
  }
  const timing = dashboardTiming(state.rootCreatedAt, ['completed', 'failed', 'stopped'].includes(state.status)
    ? state.updatedAt : null, state.status === 'running', generatedAt, 'run-span')
  return { schemaVersion: 1, generatedAt,
    timing, throughput: dashboardThroughput(sumDashboardUsage([recordedUsage, ...provisionalCompletions.map(item => item.usage)]),
      timing, provisionalCompletions.length > 0, live.truncated || state.status !== 'completed'),
    run: { id: state.runId, experimentId: state.experimentId, status: state.status, phase: state.phase,
      rootRunId: state.rootRunId, parentRunId: state.parentRunId, recoveryEpoch: state.recoveryEpoch,
      stateGeneration: state.stateGeneration, updatedAt: state.updatedAt, createdAt: state.createdAt,
      terminalReason: state.terminalReason },
    recordedUsage, provisionalUsage: sumDashboardUsage(provisionalCompletions.map(entry => entry.usage)), stages, waves,
    agents: [...agentMap.values()], activity: [...activity.values()], findings: projectedFindings, nodes: [...nodes.values()], edges: [...edges.values()], provisionalCompletions,
    freshness: { recordedAt: state.updatedAt, liveReceipts: uniqueLive.size, legacyReceipts: live.legacyCount,
      receiptsTruncated: live.truncated, inFlightTokensKnown: false }, limitations: [...limitations] }
}
