import { readdir, readFile, writeFile } from 'node:fs/promises'

// Linux USER_HZ: /proc start times are in clock ticks of 1/100 s.
const clockTicksPerSecond = 100
const shells = new Set(['bash', 'sh', 'dash', 'zsh'])

/** One /proc snapshot: pid -> { pid, ppid, uid, comm, startTicks }. Vanished processes are skipped. */
export async function readProcessTable(proc = '/proc') {
  const table = new Map()
  for (const name of await readdir(proc).catch(() => [])) {
    if (!/^\d+$/.test(name)) continue
    try {
      const [stat, status] = await Promise.all([
        readFile(`${proc}/${name}/stat`, 'utf8'), readFile(`${proc}/${name}/status`, 'utf8'),
      ])
      const close = stat.lastIndexOf(')')
      const fields = stat.slice(close + 2).split(' ')
      const uid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1])
      const process = { pid: Number(name), ppid: Number(fields[1]), uid,
        comm: stat.slice(stat.indexOf('(') + 1, close), startTicks: Number(fields[19]) }
      // Zombies are already dead; PID 1 here (`sleep infinity`) never reaps them.
      if (!['Z', 'X'].includes(fields[0])
        && [process.ppid, process.uid, process.startTicks].every(Number.isSafeInteger)) table.set(process.pid, process)
    } catch {}
  }
  return table
}

/**
 * Plan one pass. A command root is the topmost shell under the agent CLI (one per
 * command the CLI started) or an agent-user process left behind by an earlier command
 * (re-parented to PID 1). Every process under a root is marked as the kernel's
 * first OOM victim; roots older than maxAgeMs are stopped with their subtree.
 */
export function planCommandWatch(table, { cliPid, uid, maxAgeMs, uptimeMs, includeOrphans = true }) {
  const children = new Map()
  for (const entry of table.values()) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, [])
    children.get(entry.ppid).push(entry.pid)
  }
  const subtree = root => {
    const found = []
    const pending = [root]
    const seen = new Set()
    while (pending.length > 0) {
      const pid = pending.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      found.push(pid)
      pending.push(...(children.get(pid) ?? []))
    }
    return found
  }
  const cliTree = new Set(table.has(cliPid) ? subtree(cliPid) : [])
  // The topmost shell between the CLI and a process is the command it belongs to.
  const underShell = entry => {
    for (let parent = table.get(entry.ppid); parent !== undefined && parent.pid !== cliPid; parent = table.get(parent.ppid)) {
      if (shells.has(parent.comm)) return true
    }
    return false
  }
  const roots = [...table.values()].filter(entry => entry.uid === uid && entry.pid !== cliPid && (cliTree.has(entry.pid)
    ? shells.has(entry.comm) && !underShell(entry)
    : includeOrphans && entry.ppid === 1)).sort((left, right) => left.pid - right.pid)
  const mark = new Set()
  const stop = new Set()
  const stopped = []
  for (const root of roots) {
    const pids = subtree(root.pid).filter(pid => table.get(pid)?.uid === uid)
    for (const pid of pids) mark.add(pid)
    const ageMs = uptimeMs - root.startTicks * (1000 / clockTicksPerSecond)
    if (maxAgeMs !== undefined && ageMs > maxAgeMs) {
      for (const pid of pids) stop.add(pid)
      stopped.push({ pid: root.pid, comm: root.comm, ageMs: Math.round(ageMs) })
    }
  }
  return { mark: [...mark].sort((a, b) => a - b), stop: [...stop].sort((a, b) => a - b), stopped }
}

export async function commandWatchPass(options, { proc = '/proc', kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  const table = await readProcessTable(proc)
  const uptimeMs = Number((await readFile(`${proc}/uptime`, 'utf8')).split(' ')[0]) * 1000
  const plan = planCommandWatch(table, { ...options, uptimeMs })
  for (const pid of plan.stop) { try { kill(pid, 'SIGKILL') } catch {} }
  await Promise.all(plan.mark.filter(pid => !plan.stop.includes(pid))
    .map(pid => writeFile(`${proc}/${pid}/oom_score_adj`, '1000').catch(() => {})))
  return plan
}

/** The processes to stop when an attempt ends: every live process of the agent user, never
 * the runner itself and never another user's. readProcessTable already leaves out zombies. */
export function planAgentStop(table, { uid, self }) {
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error('the agent user must be a non-root UID')
  return [...table.values()].filter(entry => entry.uid === uid && entry.pid !== self)
    .map(entry => entry.pid).sort((left, right) => left - right)
}

/**
 * Once the attempt's last CLI launch has exited, SIGKILL every agent-user process, then look
 * again (one may fork while it is stopped) until none remain, for at most `rounds` rounds.
 * Returns the PIDs stopped and those still running after the last round.
 */
export async function stopAgentProcesses({ uid, self = process.pid, rounds = 10, pauseMs = 50 }, {
  readTable = () => readProcessTable(), kill = (pid, signal) => process.kill(pid, signal),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const stopped = []
  for (let round = 0; ; round += 1) {
    const pids = planAgentStop(await readTable(), { uid, self })
    if (pids.length === 0 || round === rounds) return { stopped, remaining: pids, rounds: round }
    for (const pid of pids) {
      try { kill(pid, 'SIGKILL') } catch {}
      stopped.push(pid)
    }
    await sleep(pauseMs)
  }
}

/** Poll until stopped. Errors in one pass never end the agent run. */
export function watchCommands({ intervalMs = 2_000, onStop = () => {}, io, ...options }) {
  let active = true
  let timer
  const tick = async () => {
    try {
      const plan = await commandWatchPass(options, io)
      if (active && plan.stopped.length > 0) onStop(plan.stopped)
    } catch {}
    if (active) { timer = setTimeout(tick, intervalMs); timer.unref?.() }
  }
  timer = setTimeout(tick, intervalMs)
  timer.unref?.()
  return () => { active = false; clearTimeout(timer) }
}
