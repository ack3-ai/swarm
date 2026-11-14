import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commandWatchPass, planAgentStop, planCommandWatch, readProcessTable, stopAgentProcesses } from '../container/command-watch.mjs'

const entry = (pid, ppid, comm, { uid = 10001, startTicks = 0 } = {}) => [pid, { pid, ppid, uid, comm, startTicks }]
// cli 10 -> claude 11 -> bash 12 -> forge 13 -> bash 14 (nested script); claude -> rg 15; orphan anvil 20; root 30
const table = new Map([
  entry(1, 0, 'sleep', { uid: 0 }), entry(10, 5, 'node'), entry(11, 10, 'claude'),
  entry(12, 11, 'bash', { startTicks: 1000 }), entry(13, 12, 'forge'), entry(14, 13, 'bash'), entry(15, 11, 'rg'),
  entry(20, 1, 'anvil', { startTicks: 9000 }), entry(30, 1, 'bash', { uid: 0 }),
])

test('marks shells the CLI started and processes left behind, never the CLI or other users', () => {
  const plan = planCommandWatch(table, { cliPid: 10, uid: 10001, uptimeMs: 100_000 })
  assert.deepEqual(plan.mark, [12, 13, 14, 20])
  assert.deepEqual(plan.stop, [])
  assert.deepEqual(planCommandWatch(table, { cliPid: 10, uid: 10001, uptimeMs: 100_000, includeOrphans: false }).mark, [12, 13, 14])
})

test('stops only command trees older than the limit', () => {
  // bash 12 started at 10 s and anvil 20 at 90 s of uptime; now 100 s.
  const plan = planCommandWatch(table, { cliPid: 10, uid: 10001, uptimeMs: 100_000, maxAgeMs: 60_000 })
  assert.deepEqual(plan.stop, [12, 13, 14])
  assert.deepEqual(plan.stopped, [{ pid: 12, comm: 'bash', ageMs: 90_000 }])
  assert.deepEqual(planCommandWatch(table, { cliPid: 10, uid: 10001, uptimeMs: 100_000, maxAgeMs: 5_000 }).stop, [12, 13, 14, 20])
})

test('reads /proc entries, including odd command names, and skips zombies', async () => {
  const proc = await mkdtemp(join(tmpdir(), 'ack3-proc-'))
  try {
    const add = async (pid, state, comm, ppid) => {
      await mkdir(join(proc, String(pid)))
      await writeFile(join(proc, String(pid), 'stat'),
        `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 500 0 0`)
      await writeFile(join(proc, String(pid), 'status'), `Name:\t${comm}\nUid:\t10001\t10001\t10001\t10001\n`)
    }
    await add(10, 'S', 'node', 5)
    await add(12, 'S', 'bash', 10)
    await add(13, 'R', 'a) b (c', 12)
    await add(14, 'Z', 'bash', 1)
    await writeFile(join(proc, 'uptime'), '20.00 10.00\n')
    const read = await readProcessTable(proc)
    assert.deepEqual([...read.keys()].sort(), [10, 12, 13])
    assert.deepEqual(read.get(13), { pid: 13, ppid: 12, uid: 10001, comm: 'a) b (c', startTicks: 500 })

    const killed = []
    const plan = await commandWatchPass({ cliPid: 10, uid: 10001, maxAgeMs: 1_000 }, { proc, kill: pid => killed.push(pid) })
    assert.deepEqual(killed, [12, 13])
    assert.deepEqual(plan.stopped, [{ pid: 12, comm: 'bash', ageMs: 15_000 }])
    await assert.rejects(readFile(join(proc, '12', 'oom_score_adj')))
    await commandWatchPass({ cliPid: 10, uid: 10001 }, { proc, kill: () => assert.fail('no limit, no stop') })
    assert.equal(await readFile(join(proc, '13', 'oom_score_adj'), 'utf8'), '1000')
  } finally { await rm(proc, { recursive: true, force: true }) }
})

test('on a real process tree, marks then stops a command the fake CLI started', async () => {
  const cli = spawn(process.execPath, ['-e', `require('child_process').spawn('bash', ['-c', 'sleep 30; true'], { stdio: 'ignore' }); setTimeout(() => {}, 30000)`],
    { stdio: 'ignore' })
  try {
    const uid = process.getuid()
    let plan
    for (let i = 0; i < 50 && !(plan?.mark.length > 0); i++) {
      await new Promise(resolve => setTimeout(resolve, 100))
      plan = await commandWatchPass({ cliPid: cli.pid, uid, includeOrphans: false })
    }
    const shell = plan.mark[0]
    assert.equal(await readFile(`/proc/${shell}/oom_score_adj`, 'utf8').then(value => value.trim()), '1000')
    const stopped = await commandWatchPass({ cliPid: cli.pid, uid, includeOrphans: false, maxAgeMs: 0 })
    assert.ok(stopped.stop.includes(shell))
    for (let i = 0; i < 50 && (await readProcessTable()).has(shell); i++) await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal((await readProcessTable()).has(shell), false)
  } finally { cli.kill('SIGKILL') }
})

test('the BASH_ENV hook makes every agent shell the first OOM victim', () => {
  const hook = new URL('../container/command-env.sh', import.meta.url).pathname
  const result = spawnSync('bash', ['-c', 'cat /proc/$$/oom_score_adj'], { encoding: 'utf8', env: { ...process.env, BASH_ENV: hook } })
  assert.equal(result.status, 0)
  assert.equal(result.stdout.trim(), '1000')
  assert.equal(result.stderr, '')
})

test('the runner watches every backend CLI and passes the hook to it', async () => {
  const runner = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
  assert.match(runner, /env: \{ \.\.\.env, BASH_ENV: commandEnvironmentPath \}/)
  assert.match(runner, /watchCommands\(\{ cliPid: child\.pid, uid: 10001, maxAgeMs: request\.commandTimeoutMs/)
  assert.match(runner, /settled = true\n {6}stopWatching\(\)/)
})

test('at the end of an attempt every agent-user process is stopped, never the runner or another user (T2)', () => {
  // The fixture table: root 1 and 30, the agent CLI 10 and everything under it, orphan anvil 20.
  assert.deepEqual(planAgentStop(table, { uid: 10001, self: 999 }), [10, 11, 12, 13, 14, 15, 20])
  // The runner never stops itself, even if it ran as the agent user.
  assert.deepEqual(planAgentStop(table, { uid: 10001, self: 10 }), [11, 12, 13, 14, 15, 20])
  assert.deepEqual(planAgentStop(new Map([entry(1, 0, 'sleep', { uid: 0 }), entry(30, 1, 'bash', { uid: 0 })]),
    { uid: 10001, self: 999 }), [])
  for (const uid of [0, -1, 1.5, '10001']) assert.throws(() => planAgentStop(table, { uid, self: 999 }), /agent user/)
})

test('stops agent-user processes round by round until none remain, with a bounded number of rounds (T2)', async () => {
  const root = [entry(1, 0, 'sleep', { uid: 0 }), entry(5, 1, 'node', { uid: 0 }), entry(30, 1, 'bash', { uid: 0 })]
  // Round 1 sees 10, 11 and 20; 11 forked 40 meanwhile; then nothing is left.
  const tables = [[entry(10, 5, 'node'), entry(11, 10, 'bash'), entry(20, 1, 'anvil')], [entry(40, 1, 'sleep')], []]
  const killed = []
  let slept = 0
  const outcome = await stopAgentProcesses({ uid: 10001, self: 5 }, {
    readTable: async () => new Map([...root, ...(tables.shift() ?? [])]),
    kill: (pid, signal) => { assert.equal(signal, 'SIGKILL'); killed.push(pid); if (pid === 20) throw new Error('ESRCH') },
    sleep: async () => { slept += 1 } })
  assert.deepEqual(killed, [10, 11, 20, 40])
  assert.deepEqual(outcome, { stopped: [10, 11, 20, 40], remaining: [], rounds: 2 })
  assert.equal(slept, 2)
  // Nothing to stop: one read, no kill, no pause.
  const idle = await stopAgentProcesses({ uid: 10001, self: 5 }, {
    readTable: async () => new Map(root), kill: () => assert.fail('nothing to stop'), sleep: async () => assert.fail('no pause') })
  assert.deepEqual(idle, { stopped: [], remaining: [], rounds: 0 })
  // A process that keeps coming back under a new PID: stop after the bound and report it.
  let next = 100
  const reads = []
  const stubborn = await stopAgentProcesses({ uid: 10001, self: 5, rounds: 3 }, {
    readTable: async () => { reads.push(next); return new Map([...root, entry(next++, 1, 'sh')]) },
    kill: pid => assert.ok(pid >= 100), sleep: async () => {} })
  assert.deepEqual(stubborn, { stopped: [100, 101, 102], remaining: [103], rounds: 3 })
  assert.equal(reads.length, 4)
})

test('the runner stops agent processes once, after its last launch and before it reads outputs (T2)', async () => {
  const runner = await readFile(new URL('../container/agent-runner.mjs', import.meta.url), 'utf8')
  const stopAt = runner.indexOf('await stopAgentProcesses({ uid: 10001 })')
  assert.equal(runner.split('stopAgentProcesses(').length, 2)
  // After every launch, including the whole Claude rotation loop, and outside execute().
  assert.ok(stopAt > runner.lastIndexOf("execute('setpriv'"))
  assert.ok(stopAt > runner.indexOf('await runClaudeAccounts('))
  assert.ok(stopAt < runner.indexOf('await collectAgentOutputFiles('))
})
