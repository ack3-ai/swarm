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

export async function runClaude(request, environment, query, emit, stderr) {
  const session = query({ prompt: request.prompt, options: {
    ...claudeOptions(request, environment), stderr,
  } })
  let success = false
  try {
    for await (const message of session) {
      emit(message)
      if (message.type === 'rate_limit_event') {
        emit({ type: 'subscription_limits', limits: claudeSubscriptionLimits(message.rate_limit_info) })
      }
      if (message.type === 'result') success = message.subtype === 'success' && !message.is_error
    }
  } finally { session.close() }
  return success ? 0 : 1
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
