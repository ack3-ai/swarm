# Agent instructions

When `private/AGENTS.md` exists, read it before working in this repository.

Follow [CONTRIBUTING.md](CONTRIBUTING.md). Preserve unrelated work, active audits
and saved evidence. Keep credentials, private targets, benchmark answers and raw
audit artifacts out of Git and public issues. Store reusable service credentials
in Secrets Store and retrieve them only into process memory.

Use a PR. Behavior and runtime-contract changes need review at the exact commit;
documentation changes need accuracy and link checks. Run `pnpm check` for engine
changes and native harness tests for runner changes. Keep instructions about the
current system; record history in PRs. Use the native Codex, DSH and Claude SDK runners;
keep subscription management shared and do not add provider proxies.

## First-time setup

Follow [First-time setup](cloudflare/engine/README.md#first-time-setup) in order.

- Ask the user before creating credentials or account resources. Never print
  secret values; report only whether each one is set.
- The user creates the management token in the dashboard. Outside Terraform, only
  the state bucket and its token are created, then imported: ask whether the user
  runs those commands or wants you to. Token values go to the owner-only secrets
  folder, never into the conversation.
- Read the whole Terraform plan before applying. If it creates the state bucket,
  the state token or an existing Secrets Store, an import is missing: discard the
  plan and fix the imports.
- The image build and push run on the Docker host. If only the user's host has
  Docker, the user runs that step.

## Deployment

Deploy code through the existing Wrangler/CLI/API fast path; manage infrastructure
resources and new services in `cloudflare/terraform`, never the dashboard.
Read the relevant [deployment procedure](cloudflare/engine/README.md#build-and-deployment).
Terraform owns account resources, Worker identities, and new services. Coordinate
changes to their runtime binding contract in the infrastructure repository.
Per-Worker code classes and their local bindings/migrations (Workflow, Sandbox,
and coordinator) are installed together by the reviewed private-runtime Wrangler
publication, following that contract; do not add a second Terraform code/version
publisher. Publish changed class bindings on a new or verified idle runtime,
verify the resulting namespaces and version, and preserve active runtimes.

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
