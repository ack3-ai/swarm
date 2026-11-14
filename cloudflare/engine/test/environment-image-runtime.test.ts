import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { assertReleaseEnvironmentMatchesRuntime } from '../src/environment-image.js'
import type { RuntimeRelease } from '../src/contracts.js'

const runtime: RuntimeRelease = {
  schemaVersion: 1,
  id: 'runtime-fixture', frameworkCommit: 'a'.repeat(40),
  workerService: 'runtime-fixture', workerVersionId: '11111111-1111-4111-8111-111111111111',
  workflowName: 'runtime-fixture', containerImageDigest: `sha256:${'b'.repeat(64)}`,
}

describe('private runtime image boundary', () => {
  it('refuses a direct internal audit start before creating a Workflow', async () => {
    const source = readFileSync(new URL('../src/runtime-service.ts', import.meta.url), 'utf8')
    const start = source.indexOf('async function createAuditRun(')
    const end = source.indexOf('async function auditRunStatus(', start)
    const code = stripTypeScriptTypes(source.slice(start, end))
    const startLocalAuditWorkflow = vi.fn(async () => ({ id: 'run-fixture', reused: false }))
    const body = {
      definition: { id: 'fixture', target: { runtime: { environmentBindings: {} } },
        stages: [{ waves: [{ tasks: [{ id: 'required-additive', providerClass: 'additive',
          backend: 'dsh-chat-completions', connection: { apiKeyEnv: 'PROVIDER_B_API_KEY' } }] }] }],
      },
      environment: {
        image: `registry.cloudflare.com/${'c'.repeat(32)}/swarm-sandbox@sha256:${'d'.repeat(64)}`,
      },
    }
    const createAuditRun = new Function(
      'runIdPattern', 'assertLocalRuntime', 'CloudflareRunStore', 'sameRuntimeRelease',
      'assertReleaseEnvironmentMatchesRuntime',
      'startLocalAuditWorkflow', 'response',
      `${code}; return createAuditRun;`,
    )(
      /^[a-z0-9][a-z0-9._-]{0,99}$/,
      (_env: unknown, release: RuntimeRelease) => release,
      class {
        async runRuntime() { return runtime }
        async getRelease() { return { body } }
      },
      (left: RuntimeRelease, right: RuntimeRelease) => left.containerImageDigest === right.containerImageDigest,
      assertReleaseEnvironmentMatchesRuntime,
      startLocalAuditWorkflow,
      (_env: unknown, value: unknown, status = 200) => Response.json(value, { status }),
    ) as (request: Request, env: unknown) => Promise<Response>
    const request = () => new Request('https://runtime.internal/internal/runtime/audit-runs', {
      method: 'POST', body: JSON.stringify({ mode: 'start', runId: 'run-fixture',
        experimentId: 'fixture', releaseDigest: 'e'.repeat(64), runtimeRelease: runtime }),
    })
    await expect(createAuditRun(request(), {})).rejects.toThrow('audit environment image does not match')
    expect(startLocalAuditWorkflow).not.toHaveBeenCalled()
    body.environment.image = `registry.cloudflare.com/${'c'.repeat(32)}/swarm-sandbox@${runtime.containerImageDigest}`
    // Readiness belongs to Workflow bootstrap, where retained work is known.
    expect((await createAuditRun(request(), {})).status).toBe(202)
    expect(startLocalAuditWorkflow).toHaveBeenCalledOnce()
    delete (body as { environment?: unknown }).environment
    expect((await createAuditRun(request(), { PROVIDER_B_API_KEY: 'test' })).status).toBe(202)
    expect(startLocalAuditWorkflow).toHaveBeenCalledTimes(2)
  })
})
