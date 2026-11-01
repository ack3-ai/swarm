import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { exaMcpUrl, exaSourceLabel, validateCoreReasoning } from './reasoning-config.mjs'
import { claudeSubscriptionLimits } from './subscription-limits.mjs'

/** Use the native SDK loop and session store; Swarm owns scheduling only. */
export function claudeOptions(request, environment) {
  validateCoreReasoning(request)
  if (request.subagents?.mode !== 'disabled') throw new Error('Claude requires disabled subagents')
  if (!environment.CLAUDE_CODE_OAUTH_TOKEN?.startsWith('sk-ant-oat')) {
    throw new Error('Claude subscription token is missing or invalid')
  }
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !/^(ANTHROPIC_|CLAUDE_|CLAUDECODE$|AWS_|GOOGLE_|GCLOUD_|AZURE_)/.test(key)))
  Object.assign(env, {
    CLAUDE_CODE_OAUTH_TOKEN: environment.CLAUDE_CODE_OAUTH_TOKEN,
    CLAUDE_CONFIG_DIR: `${environment.HOME}/.claude`,
    CLAUDECODE: '',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  })
  // Use the full native response allowance for these models; other defaults stay native.
  if (['claude-fable-5-1', 'claude-opus-5-5'].includes(request.model)) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '128000'
  }
  let mcpServers = {}
  if (request.searchConnection !== undefined) {
    const { provider, apiKeyEnv } = request.searchConnection
    if (provider !== 'exa' || !/^[A-Z][A-Z0-9_]*_API_KEY$/.test(apiKeyEnv)
      || !environment[apiKeyEnv]) throw new Error('invalid native Exa connection')
    mcpServers = { exa: { type: 'http', url: exaMcpUrl, headers: {
      Authorization: `Bearer ${environment[apiKeyEnv]}`,
      'x-exa-source': exaSourceLabel(request.searchAttribution),
    } } }
  } else if (request.enableNativeSearch) {
    throw new Error('Claude search requires the configured Exa MCP connection')
  }
  return {
    model: request.model, cwd: request.workingDirectory, env,
    ...(request.continuationMode === 'resume' ? { resume: request.sessionId } : {}),
    persistSession: true,
    settingSources: [], settings: { disableAllHooks: true, disableAutoMemory: true },
    tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    disallowedTools: ['Agent', 'Task', 'WebSearch', 'WebFetch'],
    permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
    strictMcpConfig: true, mcpServers,
    ...(request.reasoningEffort === 'none'
      ? { thinking: { type: 'disabled' } }
      : { effort: request.reasoningEffort, thinking: { type: 'adaptive' } }),
  }
}

const continuationPrompt = 'Continue the unfinished task from the saved session after the subscription quota reset. Preserve prior work and tool results; do not repeat completed actions. Subscription waiting does not consume the research time allowance.'
const sessionIdPattern = /^[a-zA-Z0-9._:-]{8,200}$/
const quotaResultError = error => error instanceof Error
  && (error.errorClass === 'error_result' || /\berror_result\b/.test(error.message))

export async function runClaude(request, environment, query, emit, stderr,
  { now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let current = request
  for (let queryIndex = 0; ; queryIndex += 1) {
    let sessionId = current.continuationMode === 'resume' ? current.sessionId : null
    let rejected = null
    let result = null
    emit({ type: 'claude_query_started', queryIndex })
    const session = query({ prompt: current.prompt, options: {
      ...claudeOptions(current, environment), stderr,
    } })
    const resumableQuota = () => rejected !== null && result?.is_error === true
      && sessionIdPattern.test(sessionId ?? '') && Number.isFinite(rejected.resetAt)
    try {
      for await (const message of session) {
        emit(message)
        if ((message.type === 'system' && message.subtype === 'init') || message.type === 'result' || message.type === 'rate_limit_event') {
          if (message.session_id !== undefined || message.type !== 'rate_limit_event') {
            if (!sessionIdPattern.test(message.session_id)
              || (sessionId !== null && sessionId !== message.session_id)) throw new Error('Claude native session identity changed')
            sessionId = message.session_id
          }
        }
        if (message.type === 'rate_limit_event') {
          const limits = claudeSubscriptionLimits(message.rate_limit_info, new Date(now()).toISOString())
          emit({ type: 'subscription_limits', limits })
          rejected = limits.exhausted ? { startedAt: now(),
            resetAt: Date.parse(limits.windows[0]?.resetsAt ?? '') } : null
        }
        if (message.type === 'result') result = message
      }
    } catch (error) {
      // The SDK marks terminal result errors with errorClass alongside a
      // human-readable message. Only an evidenced quota result can be
      // deferred; unrelated errors still fail.
      if (!resumableQuota() || !quotaResultError(error)) throw error
    } finally {
      try { await session.close() } catch (error) {
        if (!resumableQuota() || !quotaResultError(error)) throw error
      }
    }
    if (result?.subtype === 'success' && !result.is_error) return 0
    if (!resumableQuota()) return 1
    // Keep the one admitted process alive across Workflow observation slices.
    // Never resend the original task or open a fresh native session. A stale
    // reset returned after a re-rejection gets a bounded anti-spin delay.
    const wakeAt = Math.max(rejected.resetAt + 1_000, now() + 60_000)
    emit({ type: 'subscription_wait_started', provider: 'claude', sessionId,
      startedAt: new Date(rejected.startedAt).toISOString(), resetsAt: new Date(rejected.resetAt).toISOString() })
    while (now() < wakeAt) await sleep(Math.min(60_000, wakeAt - now()))
    emit({ type: 'subscription_wait', wait: { provider: 'claude', sessionId,
      startedAt: new Date(rejected.startedAt).toISOString(), resumedAt: new Date(now()).toISOString(),
      resetsAt: new Date(rejected.resetAt).toISOString() } })
    current = { ...request, continuationMode: 'resume', sessionId, prompt: continuationPrompt }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const require = createRequire('/opt/harness/package.json')
  const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  process.exitCode = await runClaude(JSON.parse(input), process.env, query,
    message => process.stdout.write(`${JSON.stringify(message)}\n`),
    data => process.stderr.write(data))
}
