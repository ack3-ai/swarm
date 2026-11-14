import type { AgentRequest } from '../../src/contracts.js'
import { R2ArtifactStore, stateWriter } from '../../src/cloudflare-storage.js'
import { executionRequestBody } from '../../src/native-request.js'
import { reserveNativeLaunch } from '../../src/native-launch-authority.js'
import { sha256 } from '../../src/canonical.js'
import { AgentAttemptFailure, AgentExecutionPending } from '../../src/run-errors.js'
import { advanceExperimentOneWave, audit0RunPolicy } from '../../src/runner.js'
import type { SandboxAgentProvider } from '../../src/sandbox-provider.js'
import { createExecutorSourceFixture } from './successor-fixture.js'
import { DeterministicAuditProvider } from './deterministic-audit-provider.js'

/** Admit a real current request before injecting transport/lifecycle failures. */
export async function admittedProviderRequest(provider: SandboxAgentProvider,
  registerClose: (close: () => void) => void, promptKind = 'research', options: {
    providerClass?: 'core' | 'additive'; retry?: 'transport' | 'format'; otherProvider?: boolean
    configure?: Parameters<typeof createExecutorSourceFixture>[4]
  } = {}): Promise<AgentRequest> {
  const sessionId = 'session-11111111-1111-4111-8111-111111111111'
  const f = await createExecutorSourceFixture(registerClose, false, undefined, 0, body => {
    options.configure?.(body)
    if (options.otherProvider) {
      const connection = { baseUrl: 'https://llm-b.example.com/v1', apiKeyEnv: 'PROVIDER_B_API_KEY' }
      for (const pool of body.definition.pools) if (pool.backend === 'dsh-chat-completions') {
        pool.provider = 'provider-b'
        pool.connection = connection
      }
      for (const stage of body.definition.stages) for (const wave of stage.waves) {
        for (const task of wave.tasks) if (task.providerClass === 'additive') {
          task.provider = 'provider-b'
          task.connection = connection
        }
      }
    }
  })
  const artifactStore = new R2ArtifactStore(f.bucket), deterministic = new DeterministicAuditProvider()
  const persist = await stateWriter(f.store, f.source)
  let request: AgentRequest | undefined, selectedTask: string | undefined
  for (let tick = 0; tick < 50 && request === undefined && f.machine.view().status === 'running'; tick++) {
    await advanceExperimentOneWave({ machine: f.machine, definition: f.machine.definition,
      artifactStore, onWaveAdmission: persist, policy: audit0RunPolicy, provider: { async run(current) {
        if (current.task.promptKind === promptKind && current.task.providerClass === (options.providerClass ?? 'core')) {
          selectedTask ??= current.task.id
          if (current.task.id !== selectedTask) return deterministic.run(current)
          if (current.attempt === 1 && options.retry === 'transport') {
            throw new AgentAttemptFailure('synthetic transport failure', { includeDiagnosticsInRepair: false,
              usage: { modelCalls: 1, inputTokens: 25, outputTokens: 4, costUsd: 0 },
              nativeTransport: { code: 'TRANSPORT', sourceRunId: current.runId, requestDigest: 'c'.repeat(64),
                snapshotDigest: 'd'.repeat(64), sessionId, workState: 'present' } })
          }
          if (current.attempt === 1 && options.retry === 'format') {
            const result = await deterministic.run(current)
            return { ...result, actorId: sessionId, sessionId,
              files: { ...result.files, '.swarm/submission.json': '{"invalid":"retained"}' }, protocol: {} }
          }
          request = structuredClone(current)
          throw new AgentExecutionPending(current.task.id)
        }
        return deterministic.run(current)
      } } })
    await persist(f.machine.view())
  }
  if (request === undefined) throw new Error('fixture did not reach requested native task')
  // Test transport doubles retain production state, owner and launch admission.
  const internal = provider as unknown as { env: { INDEX: D1Database; AGENT_SANDBOX: unknown; ACK3_CODEX_WORKSPACE_ID: string }; runs: typeof f.store }
  internal.env.INDEX = f.d1
  internal.env.AGENT_SANDBOX = { idFromName: () => ({ toString: () => "a".repeat(64) }) }
  internal.runs = f.store
  const digest = await sha256(executionRequestBody(request, internal.env.ACK3_CODEX_WORKSPACE_ID))
  await reserveNativeLaunch(f.store, f.owners, request, digest)
  return request
}
