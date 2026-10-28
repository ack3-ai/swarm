#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const commit = process.env.ACK3_EXPECTED_COMMIT ?? ''
const tree = process.env.ACK3_EXPECTED_TREE ?? ''
const privateDirectory = process.env.ACK3_PRIVATE_DIR ?? '/workspace/private'
const parseArray = (name) => {
  const value = JSON.parse(process.env[name] ?? 'null')
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return value
}

if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('ACK3_EXPECTED_COMMIT is invalid')
if (!/^[0-9a-f]{40}$/.test(tree)) throw new Error('ACK3_EXPECTED_TREE is invalid')
if (!existsSync(`${privateDirectory}/source-tree-${tree}`)) throw new Error('verified source marker is missing')

const requiredEnvironmentVariables = parseArray('ACK3_TARGET_REQUIRED_ENVIRONMENT_JSON')
const commands = parseArray('ACK3_TARGET_PREFLIGHT_COMMANDS_JSON')
if (commands.length === 0) throw new Error('target preflight command list is empty')
for (const name of requiredEnvironmentVariables) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !process.env[name]) {
    throw new Error(`required target environment variable is missing: ${name}`)
  }
}

const redactions = requiredEnvironmentVariables
  .map(name => [name, process.env[name]])
  .filter(([, value]) => value)
  .sort((left, right) => right[1].length - left[1].length)
const sanitize = (value) => {
  let text = String(value ?? '')
  for (const [name, secret] of redactions) text = text.replaceAll(secret, `<redacted:${name}>`)
  return text.slice(-16_384)
}
const execute = (command, args, timeout = 30_000) => spawnSync(command, args, {
  cwd: process.cwd(), env: process.env, encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 8 * 1024 * 1024,
})
const version = (command, alternatives = [['--version']]) => {
  for (const args of alternatives) {
    const result = execute(command, args)
    if (result.status === 0) return sanitize(result.stdout || result.stderr).trim().split('\n')[0]
  }
  throw new Error(`${command} version probe failed`)
}

const tools = {
  codex: version('codex'),
  dsh: version('dsh', [['--version'], ['-V']]),
  forge: version('forge'),
}
const baselines = []
for (const [index, command] of commands.entries()) {
  const started = performance.now()
  const result = execute('/bin/bash', ['-c', command], 600_000)
  const baseline = {
    index: index + 1,
    command,
    exitCode: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    timedOut: result.error?.code === 'ETIMEDOUT',
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  }
  baselines.push(baseline)
  if (baseline.exitCode !== 0 || baseline.signal !== null || result.error !== undefined) {
    process.stderr.write(`${JSON.stringify(baseline)}\n`)
    process.exit(1)
  }
}

process.stdout.write(`${JSON.stringify({
  valid: true,
  commit,
  tree,
  tools,
  requiredEnvironmentVariables,
  baselines,
})}\n`)
