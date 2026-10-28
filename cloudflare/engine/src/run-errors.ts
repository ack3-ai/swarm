import type { NativeTerminalCustodyEvidence, NativeTransportEvidence, ProviderUsage } from './contracts.js'

export type RunFailureCategory =
  | 'transport'
  | 'invalid-configuration'
  | 'missing-credentials'
  | 'provider-rejected'
  | 'budget-exhausted'
  | 'preflight-failed'
  | 'agent-repair-exhausted'
  | 'resource-exhausted'
  | 'integrity-failed'
  | 'completion-contract-failed'
  | 'persisted-run-failed'
  | 'session-recovery-unavailable'

export class RunFailure extends Error {
  constructor(
    message: string,
    readonly category: RunFailureCategory,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = retryable ? 'TransientRunFailure' : 'PermanentRunFailure'
  }
}

export class TransientRunFailure extends RunFailure {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'transport', true, options)
  }
}

export class PermanentRunFailure extends RunFailure {
  constructor(message: string, category: Exclude<RunFailureCategory, 'transport'>, options?: ErrorOptions) {
    super(message, category, false, options)
  }
}

/** Control-plane observation ended, but the admitted process has no terminal custody. */
export class UnobservableAgentExecution extends PermanentRunFailure {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'session-recovery-unavailable', options)
    this.name = 'UnobservableAgentExecution'
  }
}

/** A completed provider process whose output may be repaired by the configured agent retry policy. */
export class AgentAttemptFailure extends Error {
  readonly usage: ProviderUsage | null
  readonly includeDiagnosticsInRepair: boolean
  readonly nativeTransport: NativeTransportEvidence | undefined
  readonly nativeTerminalCustody: NativeTerminalCustodyEvidence | undefined

  constructor(message: string, options?: ErrorOptions & {
    usage?: ProviderUsage
    includeDiagnosticsInRepair?: boolean
    nativeTransport?: NativeTransportEvidence
    nativeTerminalCustody?: NativeTerminalCustodyEvidence
  }) {
    super(message, options)
    this.name = 'AgentAttemptFailure'
    this.usage = options?.usage ?? null
    this.includeDiagnosticsInRepair = options?.includeDiagnosticsInRepair ?? true
    this.nativeTransport = options?.nativeTransport
    this.nativeTerminalCustody = options?.nativeTerminalCustody
  }
}

export function observedAgentAttemptUsage(error: unknown): ProviderUsage | null {
  const visited = new Set<Error>()
  let current = error
  while (current instanceof Error && !visited.has(current)) {
    visited.add(current)
    if (current instanceof AgentAttemptFailure && current.usage !== null) return current.usage
    current = current.cause
  }
  return null
}

/** An admitted agent execution has no terminal result and must be observed in a later durable step. */
export class AgentExecutionPending extends Error {
  constructor(
    readonly executionId: string,
    readonly observation: 'unfinished' | 'unavailable' = 'unfinished',
    options?: ErrorOptions,
  ) {
    super(
      observation === 'unfinished'
        ? `agent execution ${executionId} is awaiting a terminal result`
        : `agent execution ${executionId} status is temporarily unavailable`,
      options,
    )
    this.name = 'AgentExecutionPending'
  }
}

export function isPermanentRunFailure(error: unknown): error is RunFailure {
  return error instanceof RunFailure && !error.retryable
}

export function isTransientRunFailure(error: unknown): error is RunFailure {
  return error instanceof RunFailure && error.retryable
}
