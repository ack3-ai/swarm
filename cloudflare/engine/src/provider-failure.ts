import type { AgentExecutionReceipt } from './agent-execution-receipt.js'

export function providerDiagnosticsAreAgentActionable(result: Pick<AgentExecutionReceipt,
  'providerHttpStatus' | 'providerErrorCode' | 'providerRequests'>): boolean {
  const request = result.providerRequests?.at(-1)
  const status = request?.providerHttpStatus ?? result.providerHttpStatus
  return request?.errorCategory === undefined
    && !result.providerErrorCode
    && request?.abortedByClient !== true
    && !(status !== null && status !== undefined && status >= 400)
}
