# Security

Swarm is intended for authorized audits of pinned source in disposable,
non-production environments. An audit result is not a security guarantee.

## Report a vulnerability

Contact the repository maintainers privately. Use GitHub private vulnerability
reporting when available; do not disclose vulnerabilities or credentials in a
public issue. Include the affected revision and a minimal reproduction without
unrelated private source or audit results.

## Handle sensitive data

- Keep credentials, private target source, findings and raw audit artifacts out
  of Git and public issues. Use synthetic examples for bug reports.
- Store releases and evidence in private storage. Audit configurations reference
  secret bindings, not credential values; see [credential handling](cloudflare/engine/README.md#credentials).
- Agent tools execute source and contact model and search services. Configure
  access and provider data policies for the target before starting an audit.
- Search queries must exclude private target details. Benchmark answers must
  not be provided to agents when measuring independent discovery.
- Container isolation and credential scope are security boundaries; prompts are not.
  Treat target code, web results and agent output as untrusted input.
