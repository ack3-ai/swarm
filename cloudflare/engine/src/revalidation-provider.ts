import type { AgentProvider, AgentRequest, AgentResult } from './contracts.js'
import type { QuarantinedRevalidation } from './env.js'
import type { R2ArtifactStore } from './cloudflare-storage.js'
import { readSubmission } from './submission.js'
import { providerIdentity } from './provider-identity.js'

export class QuarantinedRevalidationProvider implements AgentProvider {
  constructor(
    private readonly fallback: AgentProvider,
    private readonly artifacts: Pick<R2ArtifactStore, 'readRejected'>,
    private readonly candidate?: QuarantinedRevalidation,
    private readonly clockAmended = false,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    if (this.candidate === undefined
      || request.stage.id !== this.candidate.stageId
      || request.wave.id !== this.candidate.waveId
      || request.task.id !== this.candidate.taskId) return this.fallback.run(request)
    const files = await this.artifacts.readRejected(
      this.candidate.quarantineUri,
      this.candidate.outputDigest,
      this.candidate.taskId,
    )
    if (!this.clockAmended && request.promptDigest !== this.candidate.promptDigest) {
      throw new Error('revalidation prompt digest differs from the quarantined attempt')
    }
    const submission = await readSubmission(request.task, files, request.visibleArtifacts)
    return {
      status: 'accepted',
      actorId: `revalidated-${this.candidate.outputDigest.slice(0, 24)}`,
      model: request.task.model,
      provider: providerIdentity(request.task),
      files,
      assertions: [`revalidated-quarantine:${this.candidate.sourceRunId}:${this.candidate.outputDigest}`],
      protocol: submission.protocol,
      inputTokens: this.candidate.usage.inputTokens,
      ...(this.candidate.usage.rawInputTokens === undefined
        ? {}
        : { rawInputTokens: this.candidate.usage.rawInputTokens }),
      ...(this.candidate.usage.cachedInputTokens === undefined
        ? {}
        : { cachedInputTokens: this.candidate.usage.cachedInputTokens }),
      ...(this.candidate.usage.cacheAccountingComplete === undefined
        ? {}
        : { cacheAccountingComplete: this.candidate.usage.cacheAccountingComplete }),
      ...(this.candidate.usage.costAccountingComplete === undefined
        ? {} : { costAccountingComplete: this.candidate.usage.costAccountingComplete }),
      outputTokens: this.candidate.usage.outputTokens,
      costUsd: this.candidate.usage.costUsd,
      modelCalls: this.candidate.usage.modelCalls === 0 ? 0 : 1,
    }
  }

  async disposeWorkspace(input: { runId: string, workspaceKey: string, freshSuffix?: string }) {
    return this.fallback.disposeWorkspace?.(input)
  }


}
