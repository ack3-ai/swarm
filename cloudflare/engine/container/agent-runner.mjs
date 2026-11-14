#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { claudeUsage } from './claude-usage.mjs'
import { runClaudeAccounts } from './claude-accounts.mjs'
import { readCodexSubscription } from './codex-subscription.mjs'
import { attemptWaitWindow, latestSubscriptionLimits, subscriptionSwitches, subscriptionWaitStatusReader,
  subscriptionWaits } from './subscription-limits.mjs'
import { codexProviderFailure, codexUsage } from './codex-usage.mjs'
import { dshUsage } from './dsh-usage.mjs'
import { dshCost } from './dsh-cost.mjs'
import { claudeNativeSearchEvidence, codexNativeSearchEvidence, codexExaSearchEvidence, dshNativeSearchAttempted, dshNativeSearchEvidence,
  readCodexNativeJournal } from './native-search-evidence.mjs'
import { codexAuthCredentials, createAgentLogWriter, redactionCredentials, replaceCredentials } from './agent-log-writer.mjs'
import { renderDshReasoningPatch, validateCoreReasoning, codexExaConfig, modelHeaderCredentialNames, validClaudeAccounts,
  validCodexAccessProgram } from './reasoning-config.mjs'
import { collectAgentOutputFiles, prepareOutputFolders, redactOutputCredentials } from './output-files.mjs'
import { stopAgentProcesses, watchCommands } from './command-watch.mjs'
import { readScratchRetained, scratchEvidenceBundle, validateScratchCapture } from './scratch-evidence.mjs'
import { startSearchRecord } from './search-record.mjs'

// Agents run as UID 10001. Durable Object containers keep root capabilities across
// a user change unless they are dropped, and file permissions would not apply.
const agentUser = ['--reuid=10001', '--regid=10001', '--init-groups', '--inh-caps=-all', '--ambient-caps=-all']
// Every non-interactive bash the agent starts sources this, so its commands are the first OOM victims.
const commandEnvironmentPath = '/usr/local/lib/ack3/command-env.sh'

// Reported quota waits must lie within this attempt: from here to the end of the last launch.
const attemptWaits = attemptWaitWindow()
const [requestPath, resultPath] = process.argv.slice(2)
if (!requestPath || !resultPath) throw new Error('request and result paths are required')
const request = JSON.parse(await readFile(requestPath, 'utf8'))
for (const value of [request.prompt, request.model, request.taskId, request.runId]) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid agent request')
}
if (!/^[a-f0-9]{64}$/.test(request.requestDigest ?? '')) throw new Error('invalid agent request digest')
if (request.providerClass === 'core') validateCoreReasoning(request)
if (!validCodexAccessProgram(request.backend, request.cyberAccessProgram)) {
  throw new Error('invalid Codex cyber access program')
}
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
if (request.submitCheck !== undefined && request.submitCheck !== true) throw new Error('invalid submission check flag')
// Claude account rotation: the primary first, then fallbacks, each in its own binding.
if (request.claudeAccounts !== undefined && !(request.backend === 'claude' && validClaudeAccounts(request.claudeAccounts)
    && request.claudeAccounts[0] === request.credentialSource
    && request.claudeAccounts.slice(1).every(name => process.env[name]?.startsWith('sk-ant-oat')))) {
  throw new Error('invalid Claude account list')
}
// Only this runner sets the quota handoff, for its own claude-runner launches.
if (request.claudeQuotaHandoff !== undefined) throw new Error('invalid Claude quota handoff')
if (request.commandTimeoutMs !== undefined && !(Number.isSafeInteger(request.commandTimeoutMs)
    && request.commandTimeoutMs >= 60_000 && request.commandTimeoutMs <= 720 * 60_000 && request.commandTimeoutMs % 60_000 === 0)) {
  throw new Error('invalid command time limit')
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
// Memory events at the start of this attempt: the Worker blames a later failure on
// memory only if an OOM happened after this point (see container-resource-diagnostics.ts).
await readFile('/sys/fs/cgroup/memory.events', 'utf8')
  .then(events => writeFile(`/workspace/private/memory-events-${request.requestDigest}`, events, { mode: 0o600 }))
  .catch(() => {})
// Optional PoC capture: the runner, not the agent, writes this task's scratch bundle.
const scratchCapture = request.scratchCapture === undefined ? undefined : validateScratchCapture(request.scratchCapture)
const scratchRetained = scratchCapture === undefined ? [] : await readScratchRetained(scratchCapture.directory)
// Root works in the agent-owned results tree here: a planted symlink fails the attempt.
await prepareOutputFolders(request.expectedFiles)
// submitCheck: each search of this session, recorded as the CLI reports it, lets `ack3-submit` check search citations.
const searchRecord = request.submitCheck === true ? startSearchRecord(request) : undefined
// The Codex login as the log writer reads it now; Codex may rotate its tokens during the run.
const launchCodexCredentials = await codexAuthCredentials()

/** One log file and wait-status reader for every process of this attempt (a second
 * writer would truncate the log). `env` sets which credentials the log redacts. */
async function createCapture(env) {
  const logWriter = createAgentLogWriter(
    `/workspace/private/agent-log-${request.requestDigest}.jsonl`, env, undefined, await codexAuthCredentials(),
  )
  // Only the Claude runner holds its process across a subscription quota wait.
  const waitStatuses = request.backend === 'claude' ? subscriptionWaitStatusReader() : null
  return {
    logWriter,
    stdout(text) {
      logWriter.write('stdout', text)
      for (const status of waitStatuses?.(text) ?? []) logWriter.status(status)
      searchRecord?.push(text)
    },
  }
}

async function execute(command, args, env, input, shared) {
  const capture = shared ?? await createCapture(env)
  const { logWriter } = capture
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: request.workingDirectory, env: { ...env, BASH_ENV: commandEnvironmentPath },
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input) }
    // setpriv execs into the CLI, so child.pid is the agent CLI itself.
    const stopWatching = watchCommands({ cliPid: child.pid, uid: 10001, maxAgeMs: request.commandTimeoutMs,
      onStop: stopped => {
        for (const entry of stopped) {
          const text = `ack3: stopped a command at the ${request.commandTimeoutMs / 60_000}-minute command time limit: ${entry.comm} (pid ${entry.pid})\n`
          stderr += text
          logWriter.write('stderr', text)
        }
      } })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = async value => {
      if (settled) return
      settled = true
      stopWatching()
      attemptWaits.launchEnded()
      if (request.providerClass === 'core' && request.backend !== 'claude') {
        const limits = await readCodexSubscription(env, {
          command: 'setpriv', prefix: [...agentUser, 'codex'],
        })
        const text = `${JSON.stringify({ type: 'subscription_limits', limits })}\n`
        value.stdout += text
        logWriter.write('stdout', text)
      }
      // A shared capture stays open for the next launch; its owner closes it.
      if (shared === undefined) await logWriter.close().catch(() => {})
      resolve(value)
    }
    child.stdout.on('data', chunk => {
      const text = chunk.toString('utf8')
      stdout += text
      capture.stdout(text)
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

// Native CLIs read the full prompt from stdin: a single argv is bounded by
// Linux MAX_ARG_STRLEN, even when the model accepts a much larger context.
let execution
let providerRequests = []
let nativeSearchEvidence
let usage = {
  inputTokens: 0, rawInputTokens: 0, cachedInputTokens: 0, outputTokens: 0, actorId: null,
  cacheAccountingComplete: false, providerHttpStatus: null, providerErrorCode: null, provider: null, costUsd: null,
}
if (request.backend === 'claude' && request.claudeAccounts !== undefined) {
  // Account rotation runs here, as root, so each claude-runner launch holds only the
  // active token. The shared capture redacts every account's token, and the loop's
  // own status lines take the same path as the child's stdout.
  const environment = { ...process.env, HOME: '/workspace/home' }
  const capture = await createCapture(environment)
  execution = { code: 1, stdout: '', stderr: '' }
  const record = text => { execution.stdout += text; capture.stdout(text) }
  execution.code = await runClaudeAccounts({ request, environment,
    emit: event => record(`${/[^\n]$/.test(execution.stdout) ? '\n' : ''}${JSON.stringify(event)}\n`),
    launch: async (env, launchRequest) => {
      const run = await execute('setpriv', [...agentUser, 'node', '/usr/local/bin/claude-runner.mjs'], env,
        JSON.stringify(launchRequest), capture)
      execution.stdout += run.stdout
      execution.stderr += run.stderr
      return run
    } })
  await capture.logWriter.close().catch(() => {})
  usage = claudeUsage(execution.stdout)
  nativeSearchEvidence = claudeNativeSearchEvidence(execution.stdout)
} else if (request.backend === 'claude') {
  execution = await execute('setpriv', [...agentUser,
    'node', '/usr/local/bin/claude-runner.mjs'], { ...process.env, HOME: '/workspace/home' }, JSON.stringify(request))
  usage = claudeUsage(execution.stdout)
  nativeSearchEvidence = claudeNativeSearchEvidence(execution.stdout)
} else if (request.providerClass === 'core') {
  const workspaceId = process.env.ACK3_CODEX_WORKSPACE_ID
  if (!/^[a-f0-9-]{36}$/i.test(workspaceId ?? '')) throw new Error('ACK3 organization workspace is not configured')
  const executionOptions = [
    '--model', request.model,
    ...(request.cyberAccessProgram === undefined ? [] : ['--cyber-access-program', request.cyberAccessProgram]),
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
      ? ['resume', ...executionOptions, request.sessionId, '-']
      : [...executionOptions, '--cd', request.workingDirectory, '-']),
  ]
  execution = await execute('setpriv', [...agentUser, 'codex', ...args], {
    ...process.env, HOME: '/workspace/home', CODEX_HOME: '/codex-home',
  }, request.prompt)
  // A provider or transport failure of the last turn goes in the receipt, so the Worker can wait instead of retrying at once.
  usage = { ...codexUsage(execution.stdout), ...codexProviderFailure(execution.stdout) }
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
  for (const name of modelHeaderCredentialNames(request.connection)) {
    if (!process.env[name]?.trim()) throw new Error('model header credential is not configured')
  }
  // The supervisor's HOME layer owns native search plugins; do not insert them twice.
  await writeFile('/opt/dsh-home/profiles/native-worker/cordis.patch.yml',
    renderDshReasoningPatch({ ...request, searchConnection: undefined }), { mode: 0o600 })
  execution = await execute('setpriv', [
    ...agentUser, 'dsh',
    '--profile', 'native-worker', '--json', '-',
  ], {
    ...process.env,
    HOME: '/workspace/home', DSH_HOME: '/opt/dsh-home', DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_TELEMETRY_MODE: 'DISABLED', DSH_TOOLS_MODE: 'native', DEEPSEEK_SWARM_NATIVE_SEARCH: 'false',
    ACK3_PROVIDER_WINDOW_WAIT: request.connection?.usageWindowWait === true ? '1' : '0',
  }, request.prompt)
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

// No agent process may outlive the attempt: it could change the outputs read below or the
// workspace the Worker prepares next. Only here, after the last launch, never between the
// launches of the Claude rotation loop.
const leftover = await stopAgentProcesses({ uid: 10001 })
if (leftover.remaining.length > 0) {
  execution.stderr += `\nack3: ${leftover.remaining.length} agent processes were still running after ${leftover.rounds} stop rounds\n`
}
// The log writer's credential list, for every text this result carries (T3).
const credentials = redactionCredentials(process.env, [...launchCodexCredentials, ...await codexAuthCredentials()])
// A credential value in an output never leaves the container: replaced as in the log, reported by file and name.
const { files, hits: outputCredentials } = redactOutputCredentials(await collectAgentOutputFiles(request.expectedFiles), credentials)
// submitCheck: rerun `ack3-submit`'s checks on the exact files reported, before the runner adds its own.
const submitCheck = request.submitCheck === true
  ? await (await import('./submit-check.mjs')).runnerSubmitCheck(files, request.taskId) : undefined
if (scratchCapture !== undefined) {
  files[scratchCapture.bundlePath] = await scratchEvidenceBundle(scratchCapture, { retained: scratchRetained,
    credentials: credentials.map(item => item.value) })
}
const waits = attemptWaits.within(request.backend === 'claude' ? subscriptionWaits(execution.stdout)
  : request.backend === 'dsh-chat-completions' && request.connection?.usageWindowWait === true
    ? subscriptionWaits(execution.stderr) : undefined)
// Present, possibly empty, exactly with rotation: the Worker then knows this image switches accounts.
const switches = request.claudeAccounts === undefined ? undefined : subscriptionSwitches(execution.stdout)
const actorId = String(usage.actorId ?? `${request.providerClass}-${request.runId}-${request.taskId}-${request.attempt}-${randomUUID()}`)
// The receipt's session: a correction turn that resumes it keeps this session's search record.
searchRecord?.end(actorId)
const result = {
  exitCode: execution.code,
  actorId,
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
  ...(waits === undefined ? {} : { subscriptionWaits: waits }),
  ...(switches === undefined ? {} : { subscriptionSwitches: switches }),
  ...(nativeSearchEvidence === undefined ? {} : { nativeSearchEvidence }),
  ...(submitCheck === undefined ? {} : { submitCheck }),
  ...(outputCredentials.length === 0 ? {} : { outputCredentials }),
  costUsd: request.providerClass === 'additive' && Number.isFinite(usage.costUsd) ? usage.costUsd : 0,
  stderr: replaceCredentials(execution.stderr, credentials).slice(-20_000),
}
await writeFile(resultPath, JSON.stringify(result), { mode: 0o600 })
process.exitCode = execution.code
