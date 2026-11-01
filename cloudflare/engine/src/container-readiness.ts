// The same user change as the agent runner (container/agent-runner.mjs).
const agentUser = 'setpriv --reuid=10001 --regid=10001 --init-groups --inh-caps=-all --ambient-caps=-all'

const checks = [
  ['dsh-app-boot', `node --input-type=module -e "import('@deepseek-ai/dsh-app-boot').then(module => { if (typeof module.prepareProfilePatches !== 'function') process.exit(1) })"`],
  ['dsh', '/opt/harness/node_modules/.bin/dsh --help'],
  ['dsh-mcp-profile', `(cd /opt/dsh-home/profiles/native-worker && ${agentUser} node --input-type=module -e "await import('@deepseek-ai/dsh-mcp-client')")`],
  ['codex', '/opt/harness/node_modules/.bin/codex --version'],
  ['forge', '/usr/local/bin/forge --version'],
  ['container-build-fingerprint', "test -s /opt/ack3/BUILD_FINGERPRINT && cat /opt/ack3/BUILD_FINGERPRINT"],
  // Commands receive the image's environment, not only PATH.
  ['command-environment', 'test "$XDG_DATA_HOME" = /workspace/home/.local/share && command -v codex'],
  // An agent cannot read a root-only file.
  ['agent-isolation', `(probe=$(mktemp -d) && printf x >"$probe/secret" && ${agentUser} sh -c 'test "$(id -u)" = 10001 && ! cat "$1" 2>/dev/null' sh "$probe/secret"; status=$?; rm -rf "$probe"; exit $status)`],
] as const

export const containerReadinessCommand = [
  'cd /opt/harness',
  'set +e',
  'failed=0',
  ...checks.flatMap(([name, command]) => [
    `${command} >/tmp/readiness-${name}.out 2>/tmp/readiness-${name}.err`,
    'code=$?',
    `printf '${name}=%s\\n' "$code"`,
    `tail -c 1000 /tmp/readiness-${name}.out`,
    `tail -c 1000 /tmp/readiness-${name}.err >&2`,
    'test "$code" -eq 0 || failed=1',
  ]),
  "printf 'container-build-fingerprint='",
  'cat /opt/ack3/BUILD_FINGERPRINT',
  'exit "$failed"',
].join('; ')
