import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const script = new URL('../container/preflight.mjs', import.meta.url).pathname

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(failBuild = false, options: { commands?: readonly string[], buildRequired?: false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ack3-preflight-'))
  roots.push(root)
  const source = join(root, 'source')
  const privateDir = join(root, 'private')
  const bin = join(root, 'bin')
  mkdirSync(source)
  mkdirSync(privateDir)
  mkdirSync(bin)
  writeFileSync(join(source, 'foundry.toml'), '[profile.default]\n')
  writeFileSync(join(privateDir, `source-tree-${'b'.repeat(40)}`), 'verified\n')
  for (const command of ['codex', 'dsh']) {
    const path = join(bin, command)
    writeFileSync(path, `#!/bin/sh\nprintf '%s fixture\\n' '${command}'\n`)
    chmodSync(path, 0o755)
  }
  const jq = join(bin, 'jq')
  writeFileSync(jq, '#!/bin/sh\nvalue=$(cat)\nprintf \'"%s"\\n\' "$value"\n')
  chmodSync(jq, 0o755)
  const forge = join(bin, 'forge')
  writeFileSync(forge, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'forge fixture'; exit 0; fi
printf '%s\\n' "$*" > "$FORGE_ARGS_FILE"
if [ "\${FORGE_BUILD_FAIL:-0}" = 1 ]; then echo "fixture compile failure $API_KEY_ALCHEMY" >&2; exit 1; fi
echo 'fixture compile success'
`)
  chmodSync(forge, 0o755)
  const argsFile = join(root, 'forge-args')
  const result = spawnSync(process.execPath, [script], {
    cwd: source,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      ACK3_EXPECTED_COMMIT: 'a'.repeat(40),
      ACK3_EXPECTED_TREE: 'b'.repeat(40),
      ACK3_PRIVATE_DIR: privateDir,
      FORGE_ARGS_FILE: argsFile,
      FORGE_BUILD_FAIL: failBuild ? '1' : '0',
      API_KEY_ALCHEMY: 'fixture-secret-value',
      ACK3_TARGET_REQUIRED_ENVIRONMENT_JSON: '["API_KEY_ALCHEMY"]',
      ACK3_TARGET_PREFLIGHT_COMMANDS_JSON: JSON.stringify(options.commands
        ?? ['forge build --remappings @openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/']),
      ...(options.buildRequired === false ? { ACK3_TARGET_BUILD_REQUIRED: 'false' } : {}),
    },
  })
  return { result, argsFile, source }
}

describe('container preflight baseline', () => {
  it('executes the sealed target command with its declared environment', () => {
    const { result, argsFile } = fixture()
    expect(result.status, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt.requiredEnvironmentVariables).toEqual(['API_KEY_ALCHEMY'])
    expect(receipt.baselines).toEqual([expect.objectContaining({ exitCode: 0 })])
    expect(readFileSync(argsFile, 'utf8')).toBe('build --remappings @openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/\n')
  })

  it('returns the useful end of a failed build log', () => {
    const { result } = fixture(true)
    expect(result.status).toBe(1)
    expect(result.stderr, result.stdout).toContain('fixture compile failure')
    expect(result.stderr).toContain('<redacted:API_KEY_ALCHEMY>')
    expect(result.stderr).not.toContain('fixture-secret-value')
  })

  it('records a failed optional build, skips later commands and passes', () => {
    const { result, source } = fixture(true, { commands: ['forge build', 'touch second-command-ran'], buildRequired: false })
    expect(result.status, result.stderr).toBe(0)
    const receipt = JSON.parse(result.stdout)
    expect(receipt).toMatchObject({ valid: true, buildRequired: false, buildPassed: false })
    expect(receipt.baselines).toEqual([expect.objectContaining({ index: 1, exitCode: 1 })])
    expect(receipt.baselines[0].stderr).toContain('<redacted:API_KEY_ALCHEMY>')
    expect(existsSync(join(source, 'second-command-ran'))).toBe(false)
  })

  it('reports a passing optional build and allows no build commands only when optional', () => {
    expect(JSON.parse(fixture(false, { buildRequired: false }).result.stdout)).toMatchObject({ buildRequired: false, buildPassed: true })
    const none = fixture(false, { commands: [], buildRequired: false }).result
    expect(none.status, none.stderr).toBe(0)
    expect(JSON.parse(none.stdout)).toMatchObject({ baselines: [], buildPassed: false })
    const required = fixture(false, { commands: [] }).result
    expect(required.status).not.toBe(0)
    expect(required.stderr).toContain('target preflight command list is empty')
    expect(JSON.parse(fixture().result.stdout)).not.toHaveProperty('buildRequired')
  })
})
