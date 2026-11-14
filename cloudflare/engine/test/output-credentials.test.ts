import { describe, expect, it } from 'vitest'
import type { AgentRequest, AgentResult, ExperimentDefinition } from '../src/contracts.js'
import { classifyAgentExecutionReceipt } from '../src/agent-execution-receipt.js'
import { agentResultFromExecutionReceipt } from '../src/late-upstream-handoff.js'
import { validateAgentResultDetailed } from '../src/protocol-validation.js'
import { providerIdentity } from '../src/provider-identity.js'
import { readSubmission, SUBMISSION_PATH } from '../src/submission.js'
import document from './fixtures/audit0-hello-vault.json' with { type: 'json' }
import { compileExperimentConfig } from './support/compile-config.js'

// The runner replaces a credential value found in an output and reports the file and the
// binding name (container/output-files.mjs); the Worker turns each report into a correction (T3).
const { definition } = compileExperimentConfig(document)
const task = (definition as ExperimentDefinition).stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
  .find(task => task.id === 'core-wave-0-research-1')!
const documentPath = 'waves/wave-0/research-1.md'
const files = {
  [documentPath]: '# Research\n\n## A1 Withdraw skips the share check\n\nForked with <redacted:GH_TOKEN>.\n',
  [SUBMISSION_PATH]: JSON.stringify({ complete: true, materialHighCriticalDelta: false, observations: [{
    id: 'A1', statement: 'withdraw skips the share check', conditions: [], consequence: 'loss', evidence: ['src/Vault.sol:1'] }],
  leadChecks: [], nextExperiment: 'none' }),
}
const digest = 'a'.repeat(64)
const receipt = (extra: Record<string, unknown> = {}) => ({ requestDigest: digest, exitCode: 0, actorId: 'actor', files,
  inputTokens: 1, outputTokens: 1, costUsd: 0, stderr: '', ...extra })

async function validate(report: unknown) {
  const { protocol } = await readSubmission(task, files, [])
  const result = { status: 'accepted', actorId: 'actor', model: task.model, provider: providerIdentity(task), files,
    assertions: [], protocol, inputTokens: 1, outputTokens: 1, costUsd: 0,
    ...(report === undefined ? {} : { outputCredentials: report }) } as unknown as AgentResult
  return validateAgentResultDetailed(task, result, [])
}

describe('credential values in output files (T3)', () => {
  it('asks for a correction that names the file and the binding, once per report entry', async () => {
    expect(await validate(undefined)).toEqual({ issues: [], repairable: [], integrity: [] })
    const reported = await validate([{ path: documentPath, name: 'GH_TOKEN' }, { path: SUBMISSION_PATH, name: 'EXA_API_KEY' }])
    expect(reported.integrity).toEqual([])
    expect(reported.repairable).toEqual([
      `${documentPath} contained the value of the credential GH_TOKEN; Swarm replaced it with <redacted:GH_TOKEN>. `
        + 'Remove it: never copy a credential, token or key into an output file.',
      `${SUBMISSION_PATH} contained the value of the credential EXA_API_KEY; Swarm replaced it with <redacted:EXA_API_KEY>. `
        + 'Remove it: never copy a credential, token or key into an output file.',
    ])
  })

  it('treats a malformed report as an integrity issue', async () => {
    for (const report of [null, {}, [], [{ path: documentPath }], [{ path: documentPath, name: '' }],
      [{ path: documentPath, name: 'GH TOKEN' }], [{ path: 'other.md', name: 'GH_TOKEN' }],
      [{ path: documentPath, name: 'GH_TOKEN', value: 'x' }], Array(257).fill({ path: documentPath, name: 'GH_TOKEN' })]) {
      expect((await validate(report)).integrity, JSON.stringify(report).slice(0, 80))
        .toEqual(['the runner output credential report is malformed'])
    }
  })

  it('carries the runner report from the receipt to the result; a receipt without one is unchanged', async () => {
    const request = { task, visibleArtifacts: [] } as unknown as AgentRequest
    const reported = [{ path: documentPath, name: 'GH_TOKEN' }]
    const match = classifyAgentExecutionReceipt(JSON.stringify(receipt({ outputCredentials: reported })), digest)
    if (match.status !== 'exact') throw new Error(`receipt with a report is ${match.status}`)
    const result = await agentResultFromExecutionReceipt(request, match.receipt, digest)
    expect(result.outputCredentials).toEqual(reported)
    expect((await validateAgentResultDetailed(task, result, [])).repairable).toHaveLength(1)
    const plain = await agentResultFromExecutionReceipt(request, receipt() as never, digest)
    expect(Object.hasOwn(plain, 'outputCredentials')).toBe(false)
  })
})
