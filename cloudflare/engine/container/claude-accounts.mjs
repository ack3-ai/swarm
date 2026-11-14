import { continuationPrompt, modelAnswer, quotaHandoffExitCode } from './claude-runner.mjs'

// Claude account rotation runs in the root agent runner. Each claude-runner
// launch runs as the agent's UID with only the active account's token; the
// fallback tokens never leave this process.
const switchPrompt = 'Continue the unfinished task from the saved session. The previous subscription account reached its usage limit, so the session continues on another account. Preserve prior work and tool results; do not repeat completed actions.'
const sessionIdPattern = /^[a-zA-Z0-9._:-]{8,200}$/
const iso = value => new Date(value).toISOString()

/** One launch's environment: no account binding, and the active token as CLAUDE_CODE_OAUTH_TOKEN. */
export function claudeAccountEnvironment(environment, accounts, index) {
  const token = index === 0 ? environment.CLAUDE_CODE_OAUTH_TOKEN : environment[accounts[index]]
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !accounts.includes(name)))
  env.CLAUDE_CODE_OAUTH_TOKEN = token
  return env
}

/** The quota rejection a handoff launch reported for its session, or null without usable evidence. */
function handoffRejection(stdout, sessionId) {
  let event = null
  for (const line of stdout.split('\n')) {
    if (!line.includes('"subscription_rejected"')) continue
    try {
      const value = JSON.parse(line)
      if (value?.type === 'subscription_rejected') event = value
    } catch {}
  }
  if (event?.provider !== 'claude' || !sessionIdPattern.test(event.sessionId ?? '')
    || (sessionId !== null && event.sessionId !== sessionId)
    || ![event.startedAt, event.resetsAt].every(value => typeof value === 'string' && Number.isFinite(Date.parse(value)))) {
    return null
  }
  return { sessionId: event.sessionId, startedAt: Date.parse(event.startedAt), resetAt: Date.parse(event.resetsAt) }
}

/** True when a launch got a model answer (`modelAnswer`). */
function modelAnswered(stdout) {
  return stdout.split('\n').some(line => {
    if (!line.includes('"assistant"')) return false
    try { return modelAnswer(JSON.parse(line)) } catch { return false }
  })
}

/** Fill-first: every task starts on account 1 and moves on only when one is used up.
 * `launch(env, request)` runs one claude-runner process; the result is the last launch's exit code. */
export async function runClaudeAccounts({ request, environment, launch, emit,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const accounts = request.claudeAccounts
  const { claudeAccounts: _, ...task } = request
  const exhaustedUntil = accounts.map(() => null)
  let active = 0
  let tried = new Set([active])
  let current = task
  // Until the model answers, the session may not hold this attempt's prompt: a request
  // rejected at once may not have saved it. The next launch then resumes the same
  // session (the switch evidence names it) with the task's own prompt.
  let answered = false
  // A handoff launch runs one query, so the launch count numbers the queries.
  for (let queryIndex = 0; ; queryIndex += 1) {
    const run = await launch(claudeAccountEnvironment(environment, accounts, active),
      { ...current, claudeQuotaHandoff: { queryIndex } })
    if (run.code !== quotaHandoffExitCode) return run.code
    answered ||= modelAnswered(run.stdout)
    const rejected = handoffRejection(run.stdout, current.continuationMode === 'resume' ? current.sessionId : null)
    if (rejected === null) return run.code
    const { sessionId } = rejected
    exhaustedUntil[active] = rejected.resetAt
    // Resume the same session at once on the next account, in list order, whose
    // reset has passed or is unknown. Each account is tried at most once before
    // the task waits, so stale resets cannot make this loop spin.
    const next = accounts.map((_, offset) => (active + 1 + offset) % accounts.length)
      .find(index => !tried.has(index) && !(exhaustedUntil[index] > now()))
    if (next !== undefined) {
      emit({ type: 'subscription_switch', switch: { provider: 'claude', sessionId, from: accounts[active],
        to: accounts[next], at: iso(now()), resetsAt: iso(rejected.resetAt) } })
      active = next
      tried.add(active)
      current = { ...task, continuationMode: 'resume', sessionId, prompt: answered ? switchPrompt : task.prompt }
      continue
    }
    // Every account is used up: wait for the earliest reset, then resume on that account.
    // A stale reset returned after a re-rejection gets the same one-minute floor as one account.
    active = exhaustedUntil.indexOf(Math.min(...exhaustedUntil))
    tried = new Set([active])
    const resetAt = exhaustedUntil[active]
    const wakeAt = Math.max(resetAt + 1_000, now() + 60_000)
    emit({ type: 'subscription_wait_started', provider: 'claude', sessionId,
      startedAt: iso(rejected.startedAt), resetsAt: iso(resetAt) })
    while (now() < wakeAt) await sleep(Math.min(60_000, wakeAt - now()))
    emit({ type: 'subscription_wait', wait: { provider: 'claude', sessionId,
      startedAt: iso(rejected.startedAt), resumedAt: iso(now()), resetsAt: iso(resetAt) } })
    current = { ...task, continuationMode: 'resume', sessionId, prompt: answered ? continuationPrompt : task.prompt }
  }
}
