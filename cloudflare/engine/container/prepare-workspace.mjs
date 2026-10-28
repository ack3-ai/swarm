#!/usr/bin/env node
// Run once per source workspace, before any model credential is installed.
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chownSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const root = process.env.ACK3_WORKSPACE_ROOT ?? '/workspace'
const source = resolve(root, 'source')
const privateDir = resolve(root, 'private')
const control = process.env.ACK3_CONTROL_DIR ?? '/control'
const commit = process.env.ACK3_EXPECTED_COMMIT ?? ''
const tree = process.env.ACK3_EXPECTED_TREE ?? ''
const profileDigest = process.env.ACK3_WORKSPACE_PREPARATION_DIGEST ?? ''
const requestDigest = process.env.ACK3_REQUEST_DIGEST ?? ''
const profile = JSON.parse(process.env.ACK3_WORKSPACE_PREPARATION_JSON ?? 'null')
const markerPath = resolve(privateDir, 'workspace-prepared.json')
const factsPath = resolve(control, 'workspace-environment.md')
const hex64 = /^[0-9a-f]{64}$/
const hex40 = /^[0-9a-f]{40}$/
const safePath = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)[A-Za-z0-9._/-]{1,240}$/
const fail = (message) => { throw new Error(`workspace preparation: ${message}`) }

if (!hex40.test(commit) || !hex40.test(tree) || !hex64.test(profileDigest) || !hex64.test(requestDigest)) {
  fail('invalid source, profile, or request identity')
}
if (!existsSync(resolve(privateDir, `source-tree-${tree}`))) fail('verified source marker is missing')
if (profile?.schemaVersion !== 1 || !safePath.test(profile.workingDirectory)
  || !Array.isArray(profile.commands) || profile.commands.length < 1 || profile.commands.length > 4
  || !Array.isArray(profile.integrityFiles) || profile.integrityFiles.length < 1 || profile.integrityFiles.length > 8) {
  fail('invalid sealed preparation profile')
}
if (profile.commands.some(value => typeof value !== 'string' || !value.trim() || value.length > 4096)) {
  fail('invalid preparation command')
}
const workspaceDirectory = resolve(source, profile.workingDirectory)
if (workspaceDirectory !== source && !workspaceDirectory.startsWith(source + sep)) fail('working directory escapes source')
if (realpathSync(workspaceDirectory) !== workspaceDirectory) fail('working directory is not a real source directory')
const integrity = () => profile.integrityFiles.map(file => {
  if (typeof file?.path !== 'string' || !safePath.test(file.path) || !hex64.test(file.sha256)) {
    fail('invalid integrity file declaration')
  }
  const path = resolve(source, file.path)
  if (!path.startsWith(source + sep) || realpathSync(path) !== path) fail(`integrity path is not a real source file: ${file.path}`)
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
  if (actual !== file.sha256) fail(`source integrity mismatch: ${file.path}`)
  return { path: file.path, sha256: actual }
})

const files = integrity()
if (existsSync(markerPath)) {
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  if (marker.schemaVersion !== 1 || marker.commit !== commit || marker.tree !== tree
    || marker.profileDigest !== profileDigest || JSON.stringify(marker.integrityFiles) !== JSON.stringify(files)
    || marker.status !== 'prepared') fail('existing workspace preparation identity mismatch')
  process.stdout.write(`${JSON.stringify({ status: 'reused', profileDigest })}\n`)
  process.exit(0)
}
// A partial setup is never represented as a successful marker. Do not run
// target-controlled commands if a previous attempt already mounted auth.
if (existsSync('/codex-home/auth.json') || existsSync(resolve(privateDir, 'codex-auth.json'))) {
  fail('credentials are present before target-controlled preparation')
}
// Container bootstrap can create HOME caches as root before the agent starts.
// Project commands run as UID 10001 and must be able to create compiler caches.
for (const name of ['.cache', '.npm', '.local', '.local/share']) {
  const path = resolve(root, 'home', name)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory()) fail(`agent cache path is not a directory: ${name}`)
  if (process.getuid?.() === 0) chownSync(path, 10001, 10001)
  chmodSync(path, 0o700)
}
const env = {
  HOME: resolve(root, 'home'), USER: 'ack3agent', LOGNAME: 'ack3agent',
  PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
  XDG_DATA_HOME: resolve(root, 'home', '.local', 'share'),
  npm_config_cache: resolve(root, 'home', '.npm'),
  SWARM_SOURCE_DIR: source, SWARM_VERIFIER_DIR: source, DEEPSEEK_SWARM_RUN_DIR: resolve(root, 'results'),
}
const execute = (program, args, timeout) => spawnSync(
  process.getuid?.() === 0 ? 'setpriv' : program,
  process.getuid?.() === 0 ? ['--reuid=10001', '--regid=10001', '--init-groups', program, ...args] : args,
  { cwd: workspaceDirectory, env, encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 1024 * 1024 },
)
const executePreparation = (command) => new Promise(resolveResult => {
  const program = process.getuid?.() === 0 ? 'setpriv' : '/bin/bash'
  const args = process.getuid?.() === 0
    ? ['--reuid=10001', '--regid=10001', '--init-groups', '/bin/bash', '-c', command]
    : ['-c', command]
  const child = spawn(program, args, {
    cwd: workspaceDirectory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let failure = null
  let settled = false
  let groupStopped = false
  const stopGroup = () => {
    if (child.pid && !groupStopped) {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
      groupStopped = true
    }
  }
  const collect = (key, chunk) => {
    const text = String(chunk)
    outputBytes += chunk.length
    if (key === 'stdout') stdout = (stdout + text).slice(-8192)
    else stderr = (stderr + text).slice(-8192)
    if (outputBytes > 1024 * 1024 && failure === null) {
      failure = 'output-limit'
      stopGroup()
    }
  }
  child.stdout.on('data', chunk => collect('stdout', chunk))
  child.stderr.on('data', chunk => collect('stderr', chunk))
  child.on('error', error => { failure = error.code ?? 'spawn-error' })
  const timer = setTimeout(() => { failure = 'timeout'; stopGroup() }, 120_000)
  child.on('exit', () => stopGroup()) // No background setup child may mutate a prepared workspace.
  child.on('close', (code, signal) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveResult({ status: code, signal, stdout, stderr, failure })
  })
})
const started = Date.now()
const results = []
for (const [index, command] of profile.commands.entries()) {
  const began = Date.now()
  const result = await executePreparation(command)
  results.push({ index: index + 1, command, exitCode: result.status, signal: result.signal,
    durationMs: Date.now() - began })
  if (result.status !== 0 || result.failure) {
    const code = result.failure ?? `exit-${result.status ?? 'unknown'}`
    writeFileSync(resolve(privateDir, `workspace-preparation-failure-${requestDigest}.json`), JSON.stringify({
      schemaVersion: 1, status: 'failed', commit, tree, profileDigest, requestDigest, results, code,
      // The setup subprocess receives an allowlisted environment without
      // provider or target secrets. Keep bounded diagnostics in private custody.
      stdout: result.stdout,
      stderr: result.stderr,
    }))
    fail(`command ${index + 1} failed (${code})`)
  }
}
integrity() // No command may rewrite an audited lockfile or project configuration.
const versions = Object.fromEntries(['node', 'npm', 'forge', 'cast', 'anvil', 'xxd'].map(tool => {
  const result = execute(tool, tool === 'xxd' ? ['-v'] : ['--version'], 10_000)
  return [tool, result.status === 0 ? (result.stdout || result.stderr).trim().split('\n')[0] : 'unavailable']
}))
const marker = { schemaVersion: 1, status: 'prepared', commit, tree, profileDigest,
  integrityFiles: files, workingDirectory: profile.workingDirectory, results, versions,
  durationMs: Date.now() - started }
const facts = [
  '# Workspace environment',
  '',
  'The verified source is an archive without Git history; `git status` is unavailable.',
  `Working directory: ${workspaceDirectory}`,
  `Preparation: completed (${profile.commands.length} sealed commands; ${marker.durationMs} ms).`,
  `Verified commands: ${profile.commands.map(value => `\`${value}\``).join('; ')}`,
  `Installed tools: ${Object.entries(versions).map(([name, value]) => `${name} ${value}`).join('; ')}.`,
  'Optional OS tools: `sudo -n /usr/local/bin/ack3-install-os-packages PACKAGE` installs literal packages from configured repositories in this workspace. Use project-local package managers for project dependencies.',
  'A successful build is environment readiness, not a security reproduction.',
  '',
].join('\n')
writeFileSync(`${factsPath}.tmp-${process.pid}`, facts)
renameSync(`${factsPath}.tmp-${process.pid}`, factsPath)
writeFileSync(`${markerPath}.tmp-${process.pid}`, JSON.stringify(marker))
renameSync(`${markerPath}.tmp-${process.pid}`, markerPath)
process.stdout.write(`${JSON.stringify({ status: 'prepared', profileDigest, durationMs: marker.durationMs })}\n`)
