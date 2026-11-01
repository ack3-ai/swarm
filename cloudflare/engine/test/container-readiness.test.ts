import { describe, expect, it } from 'vitest'
import { containerReadinessCommand } from '../src/container-readiness.js'

describe('container readiness probe', () => {
  it('smoke-loads both agent runtimes and the pinned audit tools without credentials', () => {
    expect(containerReadinessCommand).toContain("typeof module.prepareProfilePatches !== 'function'")
    expect(containerReadinessCommand).toContain('/node_modules/.bin/dsh --help')
    expect(containerReadinessCommand).toContain('cd /opt/dsh-home/profiles/native-worker')
    expect(containerReadinessCommand).toContain("await import('@deepseek-ai/dsh-mcp-client')")
    expect(containerReadinessCommand).toContain(
      'setpriv --reuid=10001 --regid=10001 --init-groups --inh-caps=-all --ambient-caps=-all node')
    expect(containerReadinessCommand).toContain('/node_modules/.bin/codex --version')
    expect(containerReadinessCommand).toContain('/usr/local/bin/forge --version')
    expect(containerReadinessCommand).toContain('container-build-fingerprint=')
    expect(containerReadinessCommand).toContain('/opt/ack3/BUILD_FINGERPRINT')
    expect(containerReadinessCommand).toContain("printf 'dsh=%s\\n'")
    expect(containerReadinessCommand).toContain('exit "$failed"')
    expect(containerReadinessCommand).toContain("printf 'command-environment=%s\\n'")
    expect(containerReadinessCommand).toContain('test "$XDG_DATA_HOME" = /workspace/home/.local/share')
    expect(containerReadinessCommand).toContain("printf 'agent-isolation=%s\\n'")
    expect(containerReadinessCommand).toContain("sh -c 'test \"$(id -u)\" = 10001 && ! cat \"$1\" 2>/dev/null'")
    expect(containerReadinessCommand).not.toMatch(/API_KEY|AUTH|TOKEN|SECRET/)
  })
})
