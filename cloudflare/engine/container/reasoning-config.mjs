const reasoningEfforts = new Set(['none', 'low', 'medium', 'high', 'max'])
const dshReasoningEfforts = new Set(['none', 'low', 'high', 'max'])
// DSH owns retry state inside one model step, so an incomplete stream can be
// replayed without restarting the lane or committing its partial assistant
// output. Every native DSH connection uses the same bounded retry policy;
// the provider changes only the connection and model identity.
const dshRetryableCodes = [
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'STREAM_CLOSED',
]

export function validateCoreReasoning(input) {
  if (!reasoningEfforts.has(input.reasoningEffort) || input.thinking !== undefined) {
    throw new Error('invalid core reasoning configuration')
  }
  return { reasoningEffort: input.reasoningEffort }
}

export function dshReasoningConfig(input) {
  const thinking = input.thinking === undefined && input.reasoningEffort === 'max'
    ? 'enabled'
    : input.thinking
  if (!dshReasoningEfforts.has(input.reasoningEffort)
    || !['enabled', 'disabled'].includes(thinking)
    || ((thinking === 'disabled') !== (input.reasoningEffort === 'none'))) {
    throw new Error('invalid additive reasoning configuration')
  }
  return {
    thinking,
    reasoningEffort: thinking === 'disabled' ? 'off' : input.reasoningEffort,
  }
}

export function renderDshReasoningPatch(input) {
  const config = dshReasoningConfig(input)
  const subagents = input.subagents ?? { mode: 'disabled' }
  if (subagents.mode !== 'disabled' || Object.keys(subagents).length !== 1) {
    throw new Error('native subagents are unsupported by the additive adapter')
  }
  const { baseUrl, apiKeyEnv } = input.connection ?? {}
  const endpoint = new URL(baseUrl)
  if ((endpoint.protocol !== 'https:'
      && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || !/^[A-Z][A-Z0-9_]*_API_KEY$/.test(apiKeyEnv ?? '')
    || typeof input.model !== 'string' || !input.model.trim()) {
    throw new Error('invalid native DSH connection')
  }
  const contextWindow = input.connection.contextWindow ?? 1000000
  const maxTokens = input.connection.maxTokens ?? 256000
  if (![contextWindow, maxTokens].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2000000)
    || maxTokens > contextWindow) throw new Error('invalid native DSH token limits')
  const searchPatch = [
    '- id: tool-web', '  disabled: true',
    '- id: web-search-deepseek', '  disabled: true',
  ]
  if (input.searchConnection !== undefined) {
    const { provider, apiKeyEnv: searchApiKeyEnv } = input.searchConnection
    if (provider !== 'exa' || !/^[A-Z][A-Z0-9_]*_API_KEY$/.test(searchApiKeyEnv ?? '')) {
      throw new Error('invalid native DSH search connection')
    }
    searchPatch.push(
      '- insert:',
      '    - id: exa-mcp',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: exa',
      '        transport: streamable-http',
      `        url: ${JSON.stringify(exaMcpUrl)}`,
      '        headers:',
      `          Authorization: !!js String("Bearer " + process.env.${searchApiKeyEnv})`,
      `          x-exa-source: ${JSON.stringify(exaSourceLabel(input.searchAttribution))}`,
      '        toolCallTimeoutMs: 120000',
      '        failOnStartupError: true',
      '',
    )
  }
  return [
    '- id: llm-deepseek',
    '  disabled: true',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      deepseek-official:',
    '        api: openai-completions',
    `        baseURL: ${JSON.stringify(endpoint.href.replace(/\/$/, ''))}`,
    `        apiKeyEnv: ${JSON.stringify(apiKeyEnv)}`,
    '        compat:',
    '          thinkingFormat: deepseek',
    '          supportsDeveloperRole: false',
    '          supportsStore: false',
    '          maxTokensField: max_tokens',
    '          requiresReasoningContentOnAssistantMessages: true',
    '        models:',
    `          - id: ${JSON.stringify(input.model)}`,
    '            input: [text]',
    `            contextWindow: ${input.connection.contextWindow ?? 1000000}`,
    `            maxTokens: ${input.connection.maxTokens ?? 256000}`,
    '            reasoningEfforts:',
    '              off: null',
    '              low: low',
    '              high: high',
    '              max: max',
    `        reasoning: ${config.reasoningEffort}`,
    '        retryPolicy:',
    '          mode: normal',
    '          maxRetries: 6',
    '          backoff:',
    '            initialDelayMs: 2500',
    // Native normal mode delegates provider Retry-After values above this cap.
    '            maxDelayMs: 3600000',
    '            jitterRatio: 0.2',
    '          retryableCodes:',
    ...dshRetryableCodes.map(code => `            - ${code}`),
    '',
    ...searchPatch,
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${JSON.stringify(input.model)}`,
    '',
    '# Keep provider requests standard; these optional contributors add vendor fields.',
    '- id: session-log-deepseek',
    '  disabled: true',
    '- id: plugin-package-inventory-deepseek',
    '  disabled: true',
    '# Audit tasks already have names; a title-generation LLM call adds no result.',
    '- id: session-title-llm',
    '  disabled: true',
    '',
    '- id: subagent',
    '  config:',
    '    maxDepth: 1',
    '    maxActiveSubagents: 1',
    '',
    '# Subagent availability is sealed into each task by the audit manifest.',
    '- id: tool-subagent',
    '  disabled: true',
    '- id: tool-subagent-fork',
    '  disabled: true',
    '- id: tool-subagent-control',
    '  disabled: true',
    '- id: tool-subagent-list-agents',
    '  disabled: true',
    '- id: subagent-spawn-in-process',
    '  disabled: true',
    '- id: subagent-fork-in-process',
    '  disabled: true',
    '',
    '# DSH workflows are a separate orchestration layer and remain disabled.',
    '- id: workflow-ptc',
    '  disabled: true',
    '- id: tool-workflow',
    '  disabled: true',
    '',
  ].join('\n')
}

export const exaMcpUrl = 'https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa'

/** Operational attribution only: never include target details, prompts or run identifiers. */
export function exaSourceLabel(attribution) {
  const fields = ['agent', 'stage', 'wave', 'task']
  if (!attribution || fields.some(name => typeof attribution[name] !== 'string'
    || !/^[A-Za-z0-9._/-]{1,160}$/.test(attribution[name]))) {
    throw new Error('invalid native Exa attribution')
  }
  const label = `swarm;${fields.map(name => `${name}=${attribution[name]}`).join(';')}`
  if (label.length > 256) throw new Error('native Exa attribution exceeds source limit')
  return label
}

/** Official remote Exa MCP; its key stays in the process environment. */
export function codexExaConfig(connection, attribution) {
  if (connection?.provider !== 'exa' || !/^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(connection.apiKeyEnv)) {
    throw new Error('invalid native Exa connection')
  }
  return [
    '--disable', 'standalone_web_search', '--config', 'web_search="disabled"',
    '--config', `mcp_servers.exa.url=${JSON.stringify(exaMcpUrl)}`,
    '--config', `mcp_servers.exa.bearer_token_env_var="${connection.apiKeyEnv}"`,
    '--config', 'mcp_servers.exa.tool_timeout_sec=120',
    '--config', `mcp_servers.exa.http_headers={"x-exa-source"=${JSON.stringify(exaSourceLabel(attribution))}}`,
  ]
}
