import type { Env } from './env.js'
import type { TerminalFixtureRetirementProof } from './terminal-fixture-retirement.js'
import { resolveCredentialBinding } from './release-provider-credentials.js'

/** Read-only native evidence. An authenticated control caller cannot substitute receipts. */
export async function observeExpiredFixture(env: Env, proof: TerminalFixtureRetirementProof): Promise<
  Omit<NonNullable<TerminalFixtureRetirementProof['postRetention']>, 'checkpointDigest'>
> {
  const accountId = env.ACK3_CLOUDFLARE_ACCOUNT_ID
  if (typeof accountId !== 'string' || !/^[a-f0-9]{32}$/.test(accountId)) {
    throw new Error('native fixture observation account is not configured')
  }
  const token = await resolveCredentialBinding(env, 'CLOUDFLARE_OBSERVABILITY_TOKEN')
  if (token === null) throw new Error('native fixture observation credential is not configured')
  const signal = AbortSignal.timeout(15_000)
  const get = async (path: string) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'manual', cache: 'no-store', signal,
    })
    // Workers supports manual/follow only. Never forward this credential through
    // a redirect, even when its body resembles a successful native response.
    if (response.status >= 300 && response.status < 400) {
      throw new Error('native fixture observation redirected')
    }
    const body = await response.json() as any
    return { path: `/accounts/${accountId}${path}`, httpStatus: response.status, body }
  }
  const requireResult = (response: Awaited<ReturnType<typeof get>>) => {
    if (response.httpStatus !== 200 || response.body?.success !== true || response.body.result == null) {
      throw new Error('native fixture observation is unavailable')
    }
    return response.body.result
  }
  const runtime = proof.runtimeRelease
  const settings = requireResult(await get(`/workers/scripts/${runtime.workerService}/settings`))
  const bindings = Array.isArray(settings.bindings) ? settings.bindings : []
  if (!bindings.some((binding: any) => ['AGENT_SANDBOX', 'Sandbox'].includes(binding.name)
      && binding.type === 'durable_object_namespace' && binding.namespace_id === proof.sandboxNamespaceId)
    || !bindings.some((binding: any) => binding.name === 'AUDIT_WORKFLOW' && binding.workflow_name === runtime.workflowName)
    || !bindings.some((binding: any) => binding.name === 'RUNTIME_ISOLATION_WORKFLOW'
      && binding.workflow_name === `${runtime.workflowName}-isolation`)) {
    throw new Error('native fixture runtime bindings differ')
  }
  const audit = await get(`/workflows/${runtime.workflowName}/instances/${proof.runId}`)
  const isolation = await get(`/workflows/${runtime.workflowName}-isolation/instances/${proof.runId}`)
  const application = requireResult(await get(`/containers/applications/${proof.containerApplicationId}`))
  const pages: { pageToken: string | null, response: unknown }[] = []
  let pageToken: string | null = null
  do {
    const query = new URLSearchParams({ per_page: '100', ...(pageToken === null ? {} : { page_token: pageToken }) })
    const response = await get(`/containers/dash/applications/${proof.containerApplicationId}/instances?${query}`)
    requireResult(response)
    pages.push({ pageToken, response: response.body })
    const next = response.body.result_info?.next_page_token
    if (next != null && (typeof next !== 'string' || next.length === 0 || pages.some(page => page.pageToken === next))) {
      throw new Error('native fixture inventory pagination is invalid')
    }
    pageToken = next ?? null
    if (pages.length >= 100 && pageToken !== null) throw new Error('native fixture inventory exceeds read bound')
  } while (pageToken !== null)
  return { accountId, audit, isolation, inventory: { application, pages } }
}
