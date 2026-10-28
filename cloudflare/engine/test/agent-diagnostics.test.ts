import { describe, expect, it } from 'vitest'
import { agentResultReadFailure, parseAgentDiagnostic } from '../src/agent-diagnostics.js'

describe('agent failure diagnostics', () => {
  it('exposes only bounded process failure fields', () => {
    const diagnostic = parseAgentDiagnostic(JSON.stringify({
      exitCode: 1,
      actorId: 'private-session',
      files: { 'finding.md': 'private output' },
      providerHttpStatus: 429,
      providerErrorCode: 'rate_limit',
      stderr: `discarded-${'x'.repeat(5_000)}`,
      providerRequests: [{ provider: 'provider-c', durationMs: 123, reasoningTokens: null }],
    }))

    expect(diagnostic).toEqual({
      exitCode: 1,
      providerHttpStatus: 429,
      providerErrorCode: 'rate_limit',
      stderr: 'x'.repeat(4_000),
      providerRequests: [{ provider: 'provider-c', durationMs: 123, reasoningTokens: null }],
    })
    expect(diagnostic).not.toHaveProperty('files')
    expect(diagnostic).not.toHaveProperty('actorId')
  })

  it('preserves the process error when no result file was written', () => {
    const failure = agentResultReadFailure({
      success: false, exitCode: 127, stderr: 'runner: command not found',
    }, new Error('File not found: agent-result.json'))

    expect(failure.message).toContain('failed (127) before writing result')
    expect(failure.message).toContain('runner: command not found')
    expect(failure.message).toContain('File not found: agent-result.json')
  })
})
