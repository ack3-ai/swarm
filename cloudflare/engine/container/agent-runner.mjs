#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chown, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { claudeUsage } from './claude-usage.mjs'
import { readCodexSubscription } from './codex-subscription.mjs'
import { latestSubscriptionLimits } from './subscription-limits.mjs'
import { codexUsage } from './codex-usage.mjs'
import { dshUsage } from './dsh-usage.mjs'
import { dshCost } from './dsh-cost.mjs'
import { claudeNativeSearchEvidence, codexNativeSearchEvidence, codexExaSearchEvidence, dshNativeSearchAttempted, dshNativeSearchEvidence,
  readCodexNativeJournal } from './native-search-evidence.mjs'
import { codexAuthCredentials, createAgentLogWriter } from './agent-log-writer.mjs'
import { renderDshReasoningPatch, validateCoreReasoning, codexExaConfig } from './reasoning-config.mjs'
import { collectAgentOutputFiles } from './output-files.mjs'

const [requestPath, resultPath] = process.argv.slice(2)
if (!requestPath || !resultPath) throw new Error('request and result paths are required')
const request = JSON.parse(await readFile(requestPath, 'utf8'))
for (const value of [request.prompt, request.model, request.taskId, request.runId]) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid agent request')
}
if (!/^[a-f0-9]{64}$/.test(request.requestDigest ?? '')) throw new Error('invalid agent request digest')
if (request.providerClass === 'core') validateCoreReasoning(request)
const subagents = request.subagents ?? { mode: 'disabled' }
if (subagents?.mode !== 'disabled'
    && !(subagents?.mode === 'native' && Number.isSafeInteger(subagents.maxConcurrent)
      && subagents.maxConcurrent >= 1 && subagents.maxConcurrent <= 8)) {
  throw new Error('invalid subagent configuration')
}
if (request.providerClass !== 'core' && subagents.mode === 'native') {
  throw new Error('native subagents are unsupported by the additive adapter')
}
if (!Array.isArray(request.expectedFiles) || request.expectedFiles.some(path => typeof path !== 'string' || path.includes('..'))) {
  throw new Error('invalid expected files')
}
if (!['/workspace/source', '/workspace/results'].includes(request.workingDirectory)) {
  throw new Error('invalid agent working directory')
}
if (!['new', 'resume'].includes(request.continuationMode)
    || (request.continuationMode === 'resume' && !/^[a-zA-Z0-9._:-]{8,200}$/.test(request.sessionId ?? ''))
    || (request.continuationMode === 'new' && request.sessionId !== null)) {
  throw new Error('invalid continuation contract')
}
if ((request.enableNativeSearch === true && request.providerClass !== 'core')
  || (request.searchConnection !== undefined && request.providerClass !== 'additive'
    && !(request.providerClass === 'core' && request.searchConnection.provider === 'exa'))) {
  throw new Error('native search must match the selected harness')
}
await Promise.all(request.expectedFiles.map(async path => {
  const directory = dirname(`/workspace/results/${path}`)
  await mkdir(directory, { recursive: true })
  await chown(directory, 10001, 10001)
}))

async function execute(command, args, env, input) {
  const fileCredentials = await codexAuthCredentials()
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: request.workingDirectory, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input) }
    const logWriter = createAgentLogWriter(
      `/workspace/private/agent-log-${request.requestDigest}.jsonl`, env, undefined, fileCredentials,
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = async value => {
      if (settled) return
      settled = true
      if (request.providerClass === 'core' && request.backend !== 'claude') {
        const limits = await readCodexSubscription(env, {
          command: 'setpriv', prefix: ['--reuid=10001', '--regid=10001', '--init-groups', 'codex'],
        })
        const text = `${JSON.stringify({ type: 'subscription_limits', limits })}\n`
        value.stdout += text
        logWriter.write('stdout', text)
      }
      await logWriter.close().catch(() => {})
      resolve(value)
    }
    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8')
      stdout += text
      logWriter.write('stdout', text)
    })
    child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8')
      stderr += text
      logWriter.write('stderr', text)
    })
    child.on('close', code => { void finish({ code: code ?? 1, stdout, stderr }) })
    child.on('error', error => { void finish({ code: 1, stdout, stderr: `${stderr}\n${error.message}` }) })
  })
}

let execution
let providerRequests = []
let nativeSearchEvidence
let usage = {
  inputTokens: 0, rawInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, actorId: null,
  cacheAccountingComplete: false, providerHttpStatus: null, providerErrorCode: null, provider: null, costUsd: null,
}
if (request.backend === 'claude') {
  execution = await execute('setpriv', ['--reuid=10001', '--regid=10001', '--init-groups',
    'node', '/usr/local/bin/claude-runner.mjs'], { ...process.env, HOME: '/workspace/home' }, JSON.stringify(request))
  usage = claudeUsage(execution.stdout)
  nativeSearchEvidence = claudeNativeSearchEvidence(execution.stdout)
} else if (request.providerClass === 'core') {
  const workspaceId = process.env.ACK3_CODEX_WORKSPACE_ID
  if (!/^[a-f0-9-]{36}$/i.test(workspaceId ?? '')) throw new Error('ACK3 organization workspace is not configured')
  const executionOptions = [
    '--model', request.model,
    ...(subagents.mode === 'native'
      ? ['--config', 'agents.enabled=true', '--config', `agents.max_concurrent_threads_per_session=${subagents.maxConcurrent}`]
      : ['--disable', 'multi_agent', '--disable', 'multi_agent_v2', '--config', 'agents.enabled=false']),
    '--disable', 'plugins', '--disable', 'apps', '--disable', 'plugin_sharing',
    ...(request.searchConnection?.provider === 'exa' ? codexExaConfig(request.searchConnection, request.searchAttribution)
      : request.enableNativeSearch === true ? ['--enable', 'standalone_web_search', '--config', 'web_search="live"']
      : ['--disable', 'standalone_web_search']),
    '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--json',
    '--config', `model_reasoning_effort="${request.reasoningEffort}"`, '--config', 'approval_policy="never"',
    '--config', 'sandbox_mode="danger-full-access"',
  ]
  const args = [
    '--config', 'forced_login_method="chatgpt"',
    '--config', `forced_chatgpt_workspace_id="${workspaceId}"`,
    'exec',
    ...(request.continuationMode === 'resume'
      ? ['resume', ...executionOptions, request.sessionId, request.prompt]
      : [...executionOptions, '--cd', request.workingDirectory, request.prompt]),
  ]
  execution = await execute('setpriv', ['--reuid=10001', '--regid=10001', '--init-groups', 'codex', ...args], {
    ...process.env, HOME: '/workspace/home', CODEX_HOME: '/codex-home',
  })
  usage = codexUsage(execution.stdout)
  if (request.searchConnection?.provider === 'exa') usage.costAccountingComplete = false
  if (request.enableNativeSearch === true) {
    const journal = request.searchConnection?.provider === 'exa' ? null
      : await readCodexNativeJournal('/codex-home/sessions', usage.actorId)
    nativeSearchEvidence = request.searchConnection?.provider === 'exa'
      ? codexExaSearchEvidence(execution.stdout) : codexNativeSearchEvidence(execution.stdout, journal,
      request.prompt, usage.actorId)
  }
} else if (request.providerClass === 'additive') {
  const apiKeyEnv = request.connection?.apiKeyEnv
  if (!/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv ?? '') || !process.env[apiKeyEnv]?.trim()) {
    throw new Error('native DSH provider credential is not configured')
  }
  // The supervisor's HOME layer owns native search plugins; do not insert them twice.
  await writeFile('/opt/dsh-home/profiles/native-worker/cordis.patch.yml',
    renderDshReasoningPatch({ ...request, searchConnection: undefined }), { mode: 0o600 })
  execution = await execute('setpriv', [
    '--reuid=10001', '--regid=10001', '--init-groups', 'dsh',
    '--profile', 'native-worker', '--json', request.prompt,
  ], {
    ...process.env,
    HOME: '/workspace/home', DSH_HOME: '/opt/dsh-home', DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_TOOLS_MODE: 'native', DEEPSEEK_SWARM_NATIVE_SEARCH: 'false',
  })
  const directUsage = dshUsage(execution.stdout)
  nativeSearchEvidence = dshNativeSearchEvidence(execution.stdout)
  usage = {
    ...directUsage,
    provider: request.provider ?? null,
    ...dshCost(directUsage, request.connection?.costRates,
      request.searchConnection !== undefined && dshNativeSearchAttempted(execution.stdout)),
  }
} else {
  throw new Error(`unsupported provider class: ${request.providerClass}`)
}

const files = await collectAgentOutputFiles(request.expectedFiles)
const result = {
  exitCode: execution.code,
  actorId: String(usage.actorId ?? `${request.providerClass}-${request.runId}-${request.taskId}-${request.attempt}-${randomUUID()}`),
  files,
  inputTokens: usage.inputTokens,
  rawInputTokens: usage.rawInputTokens,
  cachedInputTokens: usage.cachedInputTokens,
  cacheAccountingComplete: usage.cacheAccountingComplete,
  ...(usage.costAccountingComplete === undefined ? {} : { costAccountingComplete: usage.costAccountingComplete }),
  outputTokens: usage.outputTokens,
  providerHttpStatus: usage.providerHttpStatus,
  providerErrorCode: usage.providerErrorCode,
  providerRequests,
  ...(latestSubscriptionLimits(execution.stdout) === undefined ? {} : {
    subscriptionLimits: latestSubscriptionLimits(execution.stdout),
  }),
  ...(nativeSearchEvidence === undefined ? {} : { nativeSearchEvidence }),
  costUsd: request.providerClass === 'additive' && Number.isFinite(usage.costUsd) ? usage.costUsd : 0,
  stderr: execution.stderr.slice(-20_000),
}
await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 })
process.exitCode = execution.code
