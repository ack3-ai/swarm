# Agent instructions

Follow [CONTRIBUTING.md](CONTRIBUTING.md). Preserve unrelated work, active audits
and saved evidence. Keep credentials, private targets, benchmark answers and raw
audit artifacts out of Git and public issues. Store reusable service credentials
in Secrets Store and retrieve them only into process memory.

Use a PR. Behavior and runtime-contract changes need review at the exact commit;
documentation changes need accuracy and link checks. Run `pnpm check` for engine
changes and native harness tests for runner changes. Keep instructions about the
current system; record history in PRs. Use the native Codex, DSH and Claude SDK runners;
keep subscription management shared and do not add provider proxies.

## Deployment

Deploy code through the existing Wrangler/CLI/API fast path; manage infrastructure
resources and new services in `cloudflare/terraform`, never the dashboard.
Read the relevant [deployment procedure](cloudflare/engine/README.md#build-and-deployment).

- Coordinate one deployment owner. Rotate the oldest idle runtime slot and
  preserve active runs' versions and images.
- Use manifests or code-only publication for routine changes. Keep CI,
  provisioning and image builds out of that path. Rebuild locally for
  `linux/amd64` only when installed container contents change.
- Save operation intents privately. Reconcile ambiguous results before retrying
  publication, activation or dispatch.
- For failures, correlate native Cloudflare logs with runtime, version, Sandbox
  and timestamps. Preserve evidence before recovery; verify physical cleanup
  after terminal work.
