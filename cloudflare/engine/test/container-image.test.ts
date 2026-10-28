import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import dockerfile from '../Dockerfile?raw'
import harnessLock from '../container/harness/package-lock.json'
import harnessPackage from '../container/harness/package.json'

describe('container image', () => {
  it('builds from the pinned Sandbox image alone', () => {
    expect(dockerfile.match(/^ARG SANDBOX_VERSION=.+$/gm)).toHaveLength(1)
    expect(dockerfile.match(/^FROM .+$/gm)).toEqual(['FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION}'])
    expect(dockerfile).not.toMatch(/wake/i)
  })

  it('locks the DSH runtime and fails the image build on the incompatible app-boot export', () => {
    const exact = {
      '@anthropic-ai/claude-agent-sdk': '0.3.304',
      '@deepseek-ai/dsh': '0.2.1-rc.2',
      '@deepseek-ai/dsh-app-boot': '0.2.1-rc.2',
      '@deepseek-ai/dsh-base': '0.2.1-rc.2',
      '@deepseek-ai/dsh-headless': '0.2.1-rc.2',
      '@deepseek-ai/dsh-web-search-exa': '0.2.1-rc.2',
      '@deepseek-ai/dsh-llm-pi-ai': '0.2.1-rc.2',
      '@openai/codex': '0.152.1',
    }
    expect(harnessPackage.dependencies).toEqual(exact)
    const lockedPackages = harnessLock.packages as Record<string, { version?: string }>
    for (const [name, version] of Object.entries(exact)) {
      expect(lockedPackages[`node_modules/${name}`]?.version).toBe(version)
    }
    expect(dockerfile).toContain('npm ci --ignore-scripts --prefix /opt/harness')
    expect(lockedPackages['node_modules/@earendil-works/pi-ai']?.version).toBe('1.3.0')
    expect(dockerfile).toContain('node /opt/harness/patch-dsh-pi.mjs /opt/harness')
    expect(dockerfile.indexOf('node /opt/harness/patch-dsh-pi.mjs')).toBeGreaterThan(dockerfile.indexOf('npm ci --ignore-scripts'))
    expect(dockerfile.indexOf('node /opt/harness/patch-dsh-pi.mjs')).toBeLessThan(dockerfile.indexOf('npm rebuild'))
    expect(dockerfile).toContain('/opt/harness/patch-dsh-pi.mjs \\')
    expect(dockerfile).toContain("typeof module.prepareProfilePatches !== 'function'")
    expect(dockerfile).toContain('/opt/harness/node_modules/.bin/dsh --help')
  })

  it('installs the runner token-accounting module beside the runner', () => {
    expect(dockerfile).toContain('COPY container/agent-runner.mjs /usr/local/bin/ack3-agent-runner')
    expect(dockerfile).toContain('COPY container/output-files.mjs /usr/local/bin/output-files.mjs')
    expect(dockerfile).toContain('/usr/local/bin/output-files.mjs \\')
    expect(dockerfile).toContain('COPY container/agent-log-writer.mjs /usr/local/bin/agent-log-writer.mjs')
    expect(dockerfile).toContain('COPY container/codex-usage.mjs /usr/local/bin/codex-usage.mjs')
    expect(dockerfile).toContain('COPY container/dsh-cost.mjs /usr/local/bin/dsh-cost.mjs')
    expect(dockerfile).toContain('COPY container/native-search-evidence.mjs /usr/local/bin/native-search-evidence.mjs')
  })

  it('exposes only a fixed privileged OS-package helper to the agent', () => {
    expect(dockerfile).toContain('COPY container/install-os-packages.py /usr/local/bin/ack3-install-os-packages')
    expect(dockerfile).toContain('ack3agent ALL=(root) NOPASSWD: /usr/local/bin/ack3-install-os-packages')
    expect(dockerfile).not.toContain('NOPASSWD: ALL')
    expect(dockerfile).not.toContain('NOPASSWD: /usr/bin/apt-get')
  })

  it('rejects package options, paths, files, removal suffixes and ambiguous names before privilege use', () => {
    const helper = fileURLToPath(new URL('../container/install-os-packages.py', import.meta.url))
    for (const name of ['--option', '../local', '/tmp/tool.deb', 'tool=1', 'tool*', 'tool-', 'tool+', 'tool..name', '']) {
      const result = spawnSync('python3', ['-I', helper, name], { encoding: 'utf8', timeout: 5_000 })
      expect(result.status, name).toBe(1)
      expect(result.stderr, name).toContain('invalid OS package name')
    }
    const many = spawnSync('python3', ['-I', helper, ...Array(9).fill('curl')], {
      encoding: 'utf8', timeout: 5_000,
    })
    expect(many.status).toBe(1)
    expect(many.stderr).toContain('specify 1 to 8')
  })
})
