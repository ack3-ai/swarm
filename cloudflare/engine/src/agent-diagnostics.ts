export interface AgentDiagnostic {
  exitCode: number | null
  providerHttpStatus: number | null
  providerErrorCode: string | null
  stderr: string
  providerRequests: readonly Record<string, unknown>[]
}

interface AgentExecutionFailure {
  success: boolean
  exitCode: number
  stderr: string
}

export function agentResultReadFailure(execution: AgentExecutionFailure, readError: unknown): Error {
  const readMessage = readError instanceof Error ? readError.message : String(readError)
  const stderr = execution.stderr.slice(-2_000).trim()
  return new Error([
    `sandbox agent process ${execution.success ? 'exited without' : `failed (${execution.exitCode}) before writing`} result`,
    ...(stderr === '' ? [] : [stderr]),
    `result read: ${readMessage}`,
  ].join(': '))
}

export function parseAgentDiagnostic(content: string): AgentDiagnostic {
  const value = JSON.parse(content) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('agent result is invalid')
  const record = value as Record<string, unknown>
  const exitCode = typeof record.exitCode === 'number' && Number.isSafeInteger(record.exitCode) ? record.exitCode : null
  const providerHttpStatus = typeof record.providerHttpStatus === 'number' && Number.isSafeInteger(record.providerHttpStatus)
    ? record.providerHttpStatus
    : null
  const providerErrorCode = typeof record.providerErrorCode === 'string' && record.providerErrorCode.length <= 200
    ? record.providerErrorCode
    : null
  const stderr = typeof record.stderr === 'string' ? record.stderr.slice(-4_000) : ''
  const providerRequests = Array.isArray(record.providerRequests)
    ? record.providerRequests.slice(-1_000).filter((value): value is Record<string, unknown> => (
        value !== null && typeof value === 'object' && !Array.isArray(value)
      ))
    : []
  return { exitCode, providerHttpStatus, providerErrorCode, stderr, providerRequests }
}
