import { expect, it, vi } from 'vitest'
import type { AgentRequest } from '../src/contracts.js'
import { executionRequestBody } from '../src/native-request.js'
import { nativeSandboxName } from '../src/native-workspace.js'
import { SandboxAgentProvider } from '../src/sandbox-provider.js'

it.each(['workspaceAllocationRunId', 'retainedSandboxObjectId'])(
  'rejects historical %s before projecting or touching native work', async field => {
    const getByName = vi.fn(), credential = vi.fn()
    const provider = new SandboxAgentProvider({ AGENT_SANDBOX: { getByName } } as any)
    Object.assign(provider, { credential })
    // The field itself is forbidden, including an explicitly undefined value.
    for (const value of ['historical-allocation', undefined]) {
      const request = { [field]: value } as unknown as AgentRequest
      expect(() => executionRequestBody(request, 'workspace')).toThrow('historical app version')
      await expect(nativeSandboxName(request)).rejects.toThrow('historical app version')
      await expect(provider.run(request)).rejects.toThrow('historical app version')
    }
    expect(getByName).not.toHaveBeenCalled()
    expect(credential).not.toHaveBeenCalled()
  })

it('refuses unowned current-provider calls before credentials, receipts or actors', async () => {
  const provider = new SandboxAgentProvider({} as any)
  const touch = vi.fn(() => { throw new Error('must not touch native resources') })
  Object.assign(provider, { assertProviderCredentials: touch, executionReceipts: { get: touch }, runInSandbox: touch })
  await expect(provider.run({ runId: 'unowned' } as AgentRequest)).rejects.toMatchObject({
    category: 'integrity-failed', message: 'native request belongs to its historical app version',
  })
  expect(touch).not.toHaveBeenCalled()
})
