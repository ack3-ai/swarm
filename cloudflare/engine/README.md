# Engine operations

Run commands from the repository root. See [Run an audit](../../docs/running-audit.md)
for audit configuration and [Contributing](../../CONTRIBUTING.md) for local checks.

## Credentials

Use Cloudflare Secrets Store for reusable credentials and retrieve values into
process memory. Do not put values in Git, manifests, command arguments or logs.

| Credential | Use |
| --- | --- |
| `CONTROL_API_TOKEN` | Audit control and code publication; send only to the Swarm service at `ACK3_ENGINE_URL`. A random token you generate and store as `swarm-control-token`; keep a private copy. |
| Codex auth JSON | Optional, for audits with Codex pools. Dedicated login; default uses `ACK3_CODEX_WORKSPACE_ID`, named accounts use their auth JSON account ID. |
| Claude OAuth token | Run `claude setup-token` (Claude Code CLI) using the dedicated subscription; store it in a `CLAUDE_*OAUTH_TOKEN` binding. Renew before expiry. |
| Provider API key | DSH endpoint selected by the audit configuration. |
| `EXA_API_KEY` | Native Exa MCP search. |
| Cloudflare diagnostics token | Read native logs, analytics and container status. Terraform creates one for the engine and keeps it only in Secrets Store; for the commands under [Monitoring](#monitoring-and-diagnostics), use your own token with Workers Containers Read. |

Cloudflare commands additionally require `CLOUDFLARE_API_TOKEN` scoped to the
intended account and operation. Runtime renderers use `ACK3_SECRETS_STORE_ID` to
bind stored credentials. Declare provider API keys and subscription accounts in Terraform
`runtime_secret_bindings` and pass its JSON output as `ACK3_RUNTIME_SECRET_BINDINGS` when
rendering and deploying runtimes. See [Terraform credentials](../terraform/README.md#state-and-credentials).

The container runner replaces credential values with `<redacted:NAME>` in the agent
log, in the error output of the execution receipt and in the agent's output files.
It treats as credentials the variables whose names contain `AUTH`, `CREDENTIAL`,
`KEY`, `PASSWORD`, `SECRET` or `TOKEN`, or start with `TARGET_`, and each token in
the Codex login. Name a target variable accordingly (for example `GH_TOKEN`, not
`GH_ACCESS`), or its value is not redacted. An output file that contained a
credential value is rejected; the correction names the file and the variable, never
the value.

## Build and deployment

Deploy code through Wrangler/CLI/API. Infrastructure resources and new services
belong in Terraform, not dashboard edits. Coordinate one deployment owner and
preserve active audits' runtime versions and images.

| Change | Deployment path |
| --- | --- |
| Audit source, model configuration, limits or prompt catalog | [Publish an audit release](../../docs/running-audit.md#publish-and-start). |
| Front door or dashboard | Code-only publication below. |
| Supervisor, Workflow, prompt rendering or DSH runtime policy | Rotate an idle runtime; reuse an unchanged image. |
| Installed tools, runner or dependencies | Build an image locally, then update an idle runtime. |
| Account resources, Worker identities, new services or account-resource bindings | [Terraform](../terraform/README.md), coordinated with the runtime deployment configuration. |
| Per-Worker code classes and local Workflow/Sandbox/coordinator bindings or migrations | Reviewed private-runtime publication through Wrangler, coordinated with the infrastructure binding contract; verify namespaces before activation. |

### First-time setup

You need:

- a separate Cloudflare account with Workers Paid (R2 and Containers), a Zero Trust
  organization and a workers.dev subdomain;
- an Exa API key (needed even with search off), and a login or key for each model
  provider your audits use: Codex (a ChatGPT login whose plan includes Codex), Claude
  (a subscription token) or a DSH provider API key;
- Node and pnpm ([package.json](../../package.json)), Terraform 1.15.x, Docker with
  buildx, Git, `jq` and `zstd`.

Before you audit private code, know what stays: R2 lock rules keep uploaded target
source, releases, checkpoints and accepted results with no expiry, so Swarm cannot
delete them, and Terraform refuses to destroy its storage and credentials. Only an
account administrator can delete them, by removing the lock rules first; see
[Remove one audit's data](../../docs/remove-audit-data.md). For a trial, use an
account you can close afterwards.

Details are in the [Terraform prerequisites](../terraform/README.md). Keep your own
settings in `private/`, starting from the [private.example](../../private.example/README.md)
template. Then:

1. Provision the account with [Terraform](../terraform/README.md), including the
   service credentials in Secrets Store.
2. [Build and push the image](#local-container-builds).
3. For each runtime: write its declaration, render and deploy it, and set any
   `TARGET_*` secrets your audits use ([Worker and runtime publication](#worker-and-runtime-publication)).
   A first install needs only `runtime-01`; the other slots can stay empty.
4. Write the runtime catalog, render the front door, and deploy it with its
   `CONTROL_API_TOKEN` secret.
5. Optional, for code rotation: deploy every runtime slot (at least two) and
   [seed the slot pool](#runtime-slot-pool).
6. Check `curl -fsS "$ACK3_ENGINE_URL/health"` (expect `"ok":true` and `"role":"front-door"`)
   and dashboard sign-in, then [run an audit](../../docs/running-audit.md).

### Rotate runtime code

From a clean checkout of the reviewed commit, supply `ACK3_ENGINE_URL`,
`CONTROL_API_TOKEN` and `CLOUDFLARE_API_TOKEN`, then:

```sh
node cloudflare/engine/tools/rotate-runtime-code.mjs /path/to/private/rotation-intent.json COMMIT_SHA sha256:IMAGE_DIGEST ACCOUNT_ID
```

This first builds the bundle and runs the type check and a focused test; if one
fails, no slot is locked and the intent file is not written, so you can fix and run
it again. It then reserves the oldest idle slot, publishes code, verifies identity
and activates it. The slot must already have the required image, bindings and capacity; code
rotation preserves them. A slot without its own `COORDINATORS` binding (published
before runtimes had one) needs a full runtime publication instead; rotation refuses
it. If the result is ambiguous, reconcile the saved intent
instead of publishing again:

```sh
node cloudflare/engine/tools/reconcile-runtime-rotation.mjs /path/to/private/rotation-intent.json
```

For an audit release explicitly activated on that runtime, dispatch once with:

```sh
node cloudflare/engine/tools/start-audit-once.mjs RUN_ID EXPERIMENT_ID RELEASE_DIGEST RUNTIME_ID /path/to/private/audit-intent.json
```

Admission durably queues the exact launch on the coordinator alarm. A `202` response
with `dispatchPending: true` means dispatch is still being reconciled automatically;
it does not prove that a Workflow or model session has started. Do not launch another
run to compensate for a missing response. A proven routing or runtime-release
identity conflict is refused durably; an identical request returns that refusal
instead of silently selecting another runtime.

Record elapsed time and verify production state. The deploy, rotation and start tools
wait up to 30 seconds to observe the result. Set `ACK3_DEPLOY_DEADLINE_MS` to use a
different limit and fail when verification takes longer. A timeout does not prove failure;
inspect the exact run or intent before retrying.

### Code-only front-door publication

Set `CLOUDFLARE_API_TOKEN`, `CONTROL_API_TOKEN`, `ACK3_ENGINE_URL` and
`ACK3_CLOUDFLARE_ACCOUNT_ID`. Read the current Worker version from `/health`:

```sh
node cloudflare/engine/tools/deploy-code.mjs EXPECTED_WORKER_VERSION -- pnpm exec vitest run test/dashboard-browser-model.test.ts
```

The helper runs the supplied check from the engine directory, bundles, publishes
and verifies the version. It preserves bindings, secrets and runtime Workers.

### Worker and runtime publication

Use this path for initial provisioning, not routine code changes. Terraform owns
Worker identities; the [runtime renderer](tools/render-runtime-config.mjs) defines
the Workflow, agent sandbox and container bindings. Base bindings are in
[wrangler.jsonc](wrangler.jsonc).

Containers use Cloudflare's `durable_object` scheduling policy: each agent workspace
is a Durable Object ([agent-sandbox.ts](src/agent-sandbox.ts)) that starts its own
container, sized in [container-resource-diagnostics.ts](src/container-resource-diagnostics.ts)
(1 vCPU, 8 GiB memory, 6 GB disk). The policy has no per-runtime container cap and no
region placement, so an audit runs one container per agent workspace;
size audit configurations with that in mind.

| Renderer input | Source |
| --- | --- |
| `ACK3_CLOUDFLARE_ACCOUNT_ID` | Intended Cloudflare account. |
| `ACK3_RESOURCE_PREFIX` | Terraform `resource_prefix`, such as `swarm`; storage names start with it. |
| `ACK3_D1_DATABASE_ID` | Terraform database output. |
| `ACK3_RUNTIME_WORKERS_FILE` | File containing Terraform's `experiment_runtime_worker_names` JSON output. |
| `ACK3_CODEX_WORKSPACE_ID` | Optional: the Codex login's account ID. Leave unset for runtimes without Codex. |
| `ACK3_SECRETS_STORE_ID` | Secrets Store containing the runtime credentials. |
| `ACK3_BUILD_COMMIT_SHA` | Reviewed framework commit (`git rev-parse HEAD`), so deploy from a Git clone, not a downloaded archive. |
| `ACK3_RUNTIME_SECRET_BINDINGS` | Terraform `runtime_secret_bindings` output (runtimes). |
| `ACK3_RUNTIME_CATALOG_FILE` | Front-door runtime catalog. |
| `ACK3_DASHBOARD_ACCESS_ISSUER` | Access team issuer, `https://<team>.cloudflareaccess.com` (front door). |
| `ACK3_DASHBOARD_ACCESS_AUDIENCE` | Terraform `dashboard_access_audience` output (front door). |
| `ACK3_DASHBOARD_ACCESS_EMAILS` | Comma-separated dashboard addresses or `@domains`, matching the Access policy (front door). A Terraform `dashboard_email_domains` entry `example.com` is `@example.com` here. |
| `ACK3_DATA_JURISDICTION` | Optional: `eu` or `fedramp`, matching Terraform `data_jurisdiction`. |
| `ACK3_LOCATION_HINT` | Optional placement for Workflows and the coordinator, such as `enam`. |

Read the Terraform values after `apply`:

```sh
tf_output() { terraform -chdir=cloudflare/terraform output "$@"; }
export ACK3_D1_DATABASE_ID="$(tf_output -raw experiment_index_d1_database_id)"
export ACK3_SECRETS_STORE_ID="$(tf_output -raw secrets_store_id)"
export ACK3_RUNTIME_SECRET_BINDINGS="$(tf_output -json runtime_secret_bindings)"
export ACK3_DASHBOARD_ACCESS_AUDIENCE="$(tf_output -raw dashboard_access_audience)"
tf_output -json experiment_runtime_worker_names > /path/to/private/runtime-workers.json
export ACK3_RUNTIME_WORKERS_FILE=/path/to/private/runtime-workers.json
```

The runtime catalog lists every runtime the front door may route to; `latest` is
used for new audits while the slot pool is off. Each entry is a runtime declaration
plus its `RUNTIME_*` service binding name:

```json
{
  "schemaVersion": 1,
  "latest": "runtime-01",
  "releases": {
    "runtime-01": {
      "schemaVersion": 1, "id": "runtime-01", "binding": "RUNTIME_01",
      "workerService": "swarm-runtime-01", "workflowName": "audit-workflow-runtime-01",
      "frameworkCommit": "<40-hex commit>", "containerImageDigest": "sha256:<image digest>"
    }
  }
}
```

Prepare a runtime declaration (the same object without `binding`; `workerService`
must match the Terraform Worker name), then render its config:

```sh
pnpm --dir cloudflare/engine config:runtime /path/to/private/runtime-release.json
```

Deploy it with
`pnpm --dir cloudflare/engine deploy:runtime wrangler.runtime.RUNTIME_ID.jsonc --secrets-store-bindings`.
The helper refuses to overwrite a published Worker. If a first deploy fails after
Wrangler has uploaded the Worker, do not repeat initial publication. Inspect the exact deployed identity and
reconcile its state. Use [runtime rotation](#rotate-runtime-code) for an already
provisioned idle slot; preserve slots with active work or unsettled leases.
Terraform protects runtime Workers from deletion, so during a first install deploy to
an unused slot instead, and raise `runtime_slot_count` in Terraform if none is free.

A Codex login is needed only for audits with Codex pools. Without `ACK3_CODEX_WORKSPACE_ID`,
the runtime has no Codex binding and refuses Codex pools at start. To add one, install
the Codex CLI (`npm install -g @openai/codex@0.165.0`, the version in the image) and run
`codex login` (ChatGPT sign-in with a plan that includes Codex, no API key) with a
dedicated account, and keep the resulting `~/.codex/auth.json` private. Store it as
`swarm-codex-auth-json` with `codex_login = true` in
[Terraform](../terraform/README.md#state-and-credentials), and set
`ACK3_CODEX_WORKSPACE_ID` to its `tokens.account_id` before rendering. Secrets Store
values cannot be read back, so pipe the same file through stdin to `deploy:runtime`
with `ACK3_CODEX_ACCOUNT_EMAIL` set to the login's email; the helper checks that the
file matches that email and workspace.

Verify runtime identity, container readiness and cleanup before admitting audits.
Once the front door is deployed:

```sh
# Identity: the worker version, commit and image digest must match the declaration.
printf 'Authorization: Bearer %s\n' "$CONTROL_API_TOKEN" | \
  curl -fsS -H @- "$ACK3_ENGINE_URL/v1/runtime-slots/RUNTIME_ID/identity"
# Readiness: starts one test container on the catalog's latest runtime and removes it;
# expect "success": true and "disposed": true. Each check prints NAME=exit code; for
# example, agent-isolation=0 means an agent cannot read root-only files.
printf 'Authorization: Bearer %s\n' "$CONTROL_API_TOKEN" | \
  curl -fsS -X POST -H @- "$ACK3_ENGINE_URL/v1/readiness/container"
```

Audit `environmentBindings` read `TARGET_*` Worker secrets on each runtime; set them
from the engine directory with `pnpm exec wrangler secret put TARGET_NAME --config wrangler.runtime.RUNTIME_ID.jsonc`.
Each `secret put` publishes a new runtime version. Audits that ran on the earlier version
can then no longer be forked (`409 runtime release worker version changed`) unless you
roll the runtime back to that version, so set `TARGET_*` secrets before you start audits.

Render front-door configuration with `pnpm --dir cloudflare/engine config:deploy`.
The front door requires its `CONTROL_API_TOKEN` secret, the value stored as
`swarm-control-token`, and Wrangler refuses the first deploy without it. Pass it once
with a private secrets file containing `{"CONTROL_API_TOKEN": "…"}`, from the engine directory:
`pnpm exec wrangler deploy --config wrangler.deploy.jsonc --secrets-file /path/to/secrets/front-door-secrets.json`.
The rendered front door has no containers. Later deploys keep the secret; use
`pnpm deploy:worker` there.
Keep bindings for every runtime that still owns work, evidence access or pending cleanup.

Terminal zero-model fixtures can be retired through
`POST /v1/runtime-fixtures/:id/retire-terminal`. If native retention has expired,
the same command accepts `postRetention` evidence: the sealed fixture checkpoint,
exact native `10400` missing-instance receipts for both Workflows, and a complete
fresh inventory of the matching application and namespace with no instances or
assigned actors. The control service independently reads and matches the native
evidence using its `CLOUDFLARE_OBSERVABILITY_TOKEN` Secrets Store binding; caller
JSON alone cannot release a lease. Render that read-only binding with
`ACK3_SECRETS_STORE_ID` and `ACK3_CLOUDFLARE_ACCOUNT_ID`. Missing credentials or native
API errors refuse retirement. The checkpoint must be at least one day old. The archive records
`instance-not-found`, not a fabricated `complete` status, and releases only that
fixture's lease. It does not delete its checkpoint or route. A missing Workflow
alone is insufficient, and audit runs cannot use this fixture retirement path.

### Runtime slot pool

Code rotation uses the rotating pool (`ACK3_RUNTIME_SLOT_POOL_ENABLED=1`), which
requires every runtime slot bound in the catalog (at least two) and one D1 row per slot. Bootstrap the rows
once, after every runtime and a front door without the pool are deployed. List
slots oldest first; the last becomes the latest. The SQL refuses to replace an
existing pool. The tool reads `ACK3_ENGINE_URL` and `CONTROL_API_TOKEN`.

```sh
pnpm --silent --dir cloudflare/engine slots:seed-sql runtime-01 runtime-02 runtime-03 > /path/to/private/slots.sql
pnpm --dir cloudflare/engine exec wrangler d1 execute INDEX --config wrangler.deploy.jsonc --remote --file /path/to/private/slots.sql
```

Then render the front door with `ACK3_RUNTIME_SLOT_POOL_ENABLED=1` and publish it again.

### Local container builds

Rebuild only when the [Dockerfile](Dockerfile), installed tools or container files
change. Target source and project dependencies belong in the audit configuration.
You need Docker with buildx. The push step also runs Wrangler and `jq` on the Docker
host, from the repository's `pnpm install` or from a container (below). The image is
a few GB; on ARM hosts the `linux/amd64` build runs under emulation and is slower. Build for
`linux/amd64` using the engine directory as the build context:

```sh
export ACK3_CLOUDFLARE_ACCOUNT_ID="<account-id>"
SWARM_IMAGE="registry.cloudflare.com/${ACK3_CLOUDFLARE_ACCOUNT_ID}/swarm-sandbox:$(git rev-parse HEAD)"
docker buildx build --platform linux/amd64 --load \
  --file cloudflare/engine/Dockerfile --tag "$SWARM_IMAGE" cloudflare/engine
```

When updating a runner, keep Dockerfile versions and the
[harness dependencies](container/harness/package.json) consistent. Authenticate
Wrangler with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then push with
short-lived registry credentials:

```sh
(
  set -eu
  set +x
  umask 077
  SWARM_PUSH_DIR=$(mktemp -d)
  trap 'rm -rf "$SWARM_PUSH_DIR"' EXIT
  export DOCKER_CONFIG="$SWARM_PUSH_DIR/docker"
  mkdir "$DOCKER_CONFIG"
  # Large layers can time out. Each attempt gets fresh credentials, and Docker
  # skips layers that were already uploaded.
  attempt=1
  until
    pnpm --dir cloudflare/engine exec wrangler containers registries credentials \
      registry.cloudflare.com --expiration-minutes 30 --push --json \
      > "$SWARM_PUSH_DIR/credentials.json" &&
    jq -er '.password' "$SWARM_PUSH_DIR/credentials.json" | \
      docker login registry.cloudflare.com \
        --username "$(jq -er '.username' "$SWARM_PUSH_DIR/credentials.json")" --password-stdin &&
    docker push "$SWARM_IMAGE"
  do
    [ "$attempt" -lt 10 ] || exit 1
    attempt=$((attempt + 1))
    sleep 10
  done
  docker image inspect "$SWARM_IMAGE" --format '{{json .RepoDigests}}'
)
```

If the Docker host has no Node, replace `pnpm --dir cloudflare/engine exec wrangler` in
the loop with a containerized Wrangler at the repository's version:
`docker run --rm -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID -v swarm-npm-cache:/root/.npm node:22-slim npx --yes "wrangler@$(jq -er .devDependencies.wrangler cloudflare/engine/package.json)"`.

If the API token stays in a dev container and only the host has Docker, pass the host
a short-lived push credential instead. In the container, from the repository root:

```sh
(umask 077; pnpm --dir cloudflare/engine exec wrangler containers registries credentials \
  registry.cloudflare.com --expiration-minutes 60 --push --json > private/registry-push.json)
```

On the host, after the build, from the same repository folder:

```sh
(
  set -eu
  export DOCKER_CONFIG="$(mktemp -d)"
  # Runs on exit: after a successful push or after the last failed attempt.
  trap 'rm -rf "$DOCKER_CONFIG" private/registry-push.json' EXIT
  # Large layers can time out. Docker skips layers that were already uploaded.
  attempt=1
  until
    jq -er '.password' private/registry-push.json | docker login registry.cloudflare.com \
      --username "$(jq -er '.username' private/registry-push.json)" --password-stdin &&
    docker push "$SWARM_IMAGE"
  do
    [ "$attempt" -lt 10 ] || exit 1
    attempt=$((attempt + 1))
    sleep 10
  done
  docker image inspect "$SWARM_IMAGE" --format '{{json .RepoDigests}}'
)
```

This is the one secret that passes through `private/`. It can only push, expires
after an hour and is deleted once the push has succeeded or all ten attempts have
failed. If every attempt fails, mint a new one.

Use the resulting digest in both the runtime declaration and audit configuration.
To confirm it in the registry (for example with `docker manifest inspect`), request
credentials with both `--push` and `--pull`; push-only credentials cannot read manifests.
Pushing an image alone does not update a runtime. Build locally rather than in
GitHub Actions; remove only task-owned obsolete images and build artifacts.

## Checkpoints and recovery

Use [audit controls](../../docs/audit-controls.md) to pause admission, continue,
cancel or fork. Cancellation preserves accepted work, records interrupted evidence,
verifies native shutdown and releases the runtime lease. Wait for its settled
receipt before replacing failed work. A timeout or missing status response is not
proof of shutdown.

To change models or limits, publish an ordinary manifest and fork the exact saved
source state. A stage or checkpoint boundary reruns the selected suffix; a saved
frontier retains accepted partial-wave work and runs unfinished tasks. At a retired
discovery frontier, remove an unavailable pool from the manifest and assign its
later review role to another pool. Required output and independence checks still apply.

The source runtime exports saved work; the child verifies the export before
execution. Accepted and rejected evidence, original clocks and recorded usage
remain intact. Rejected output is not promoted into an accepted result, and inherited
failed attempts do not consume the new task's retry allowance. Cross-version
continuation requires an exporter on the source version.

Successful completion and cancellation reconcile cleanup autonomously. Status
GET requests only observe state; they do not archive runs or release leases.
Unavailable shutdown evidence leaves cancellation pending under the same command
ID. Preserve that ID when retrying; do not start a competing audit.

### Output limits

Agent files are limited to 4,000,000 UTF-8 bytes each; structured submission JSON
is limited to 1,000,000 bytes. Exceeding a limit is repairable within the configured
allowance. Integrity failures, including unsafe paths and provider identity
mismatches, remain fatal. The final seal may append its validated evidence suffix
to an otherwise size-valid report. These limits do not waive output validation.

## Monitoring and diagnostics

The dashboard is at `/dashboard` behind Cloudflare Access. It displays activity,
evidence and usage; controls use the authenticated API.

| Read-only route | Result |
| --- | --- |
| `GET /v1/monitor/runs` | Paginated audit index of runs with execution ownership. |
| `GET /v1/monitor/runs/:id` | Activity and saved evidence summary. |
| `GET /v1/monitor/runs/:id/artifacts/:digest` | Accepted artifact files. |
| `GET /v1/runs/:id` | Run state and Workflow status. |

Runs recorded before execution ownership are not listed, and the dashboard cannot
open them. Their saved state and artifacts remain in R2.

Saved activity can lag execution. Recorded usage includes rejected attempts and
inherited work; do not sum parent and child totals. Recorded cost is not a provider
invoice, and interrupted usage may be unknown.

For a stalled or failed task, correlate its runtime version, Sandbox ID and time
with native Cloudflare logs and agent receipts. Preserve evidence before recovery.
Memory metrics can suggest exhaustion but do not prove an OOM kill.

Use your own token with Workers Containers Read to list container applications
with their running instance counts:

```sh
pnpm --dir cloudflare/engine exec wrangler containers list --json
```

Resource sampling and failure classification are implemented in
[container-resource-diagnostics.ts](src/container-resource-diagnostics.ts).

## Subscription quota waits

A native Claude `rejected` quota event with a valid reset and session ID keeps
its admitted process pending. After the SDK finishes its error result, the runner
closes that query, waits until the reported reset (with a one-minute retry floor),
and uses `options.resume` with the same session and a continuation-only prompt.
It never opens a new session or enables extra usage. A Claude pool with
`fallbackCredentialSources` first resumes the same session at once on the next
account whose reset has passed or is unknown, and waits only when every account is
used up; each switch is stored as `subscriptionSwitches` on the receipt and usage.
After a wait or a switch, a task whose model has not answered yet in this attempt
resumes the same session with its own prompt instead of the continuation prompt,
since the rejected request may not have saved it.
The root agent runner runs that loop and starts one Claude runner per account, so
the agent's processes only ever hold the active account's token.
Unrelated SDK failures and quota responses without usable reset/session evidence
still fail closed. Normal Workflow polling slices do not impose a task timeout.

The wait has no maximum: a weekly limit can hold the task until that reset. The
agent runner writes a status line to the task's log capture when a wait starts
and ends. The redactor holds back the end of a silent stream, so this line carries
only the provider and reset time. The log index keeps the open wait until it ends
or the log completes, and the dashboard shows the task as waiting for
subscription quota with its reset time and counts waiting tasks in the run summary.

Completed waits travel with receipt usage into accepted or rejected work. The
discovery deadline adds their interval union, so parallel quota waits count once
and `modelStartedAt` remains unchanged. Pending admitted work always drains;
completed wait evidence adjusts subsequent admissions and phase completion.
Other pools may keep working while a pool waits. Token and cost limits remain in
force. Usage sums distinct native queries; incomplete samples remain incomplete.

Context is retained while the same container survives. Native session files
remain on its ephemeral disk: host loss is a separate custody failure and is not
recovered by this wait loop. Runner changes require a new image and runtime;
active audits keep their pinned versions.

## Native prompt transport

Codex and DSH receive complete prompts over stdin, including same-session
corrections. Claude receives its request over stdin through the SDK runner.
Prompt transport does not truncate validation diagnostics or apply an additional
command-line size limit.

### Runtime cleanup binding

Each runtime requires its own `COORDINATORS` binding to `ExperimentCoordinator`
and the renderer's `v3` SQLite-class migration. Its alarms reconcile commands and
terminal cleanup independently of dashboard requests. This namespace is separate
from the front-door coordinator.

Verify the Workflow, Sandbox and coordinator namespaces before activating a
runtime. Code-only rotation preserves bindings; use the runtime publication path
when bindings or migrations change. Keep older runtimes until their work and
cleanup have settled.

## Validation

[Local contributor checks](../../CONTRIBUTING.md#local-setup) cover types, tests and
bundling. Install `container/harness` dependencies with `npm ci --ignore-scripts`
and, from `cloudflare/engine`, run
`node --test test/native-claude.test.mjs test/subscription-limits.test.mjs`
for Claude/Codex subscription boundaries.

The image pins DSH 0.2.1-rc.2 and pi-ai 1.3.0. Its
[dependency patch](container/harness/patch-dsh-pi.mjs) preserves structured HTTP
status and provider retry delays and distinguishes reported usage from initialized
zero counters. Docker applies it after installation and checks exact source
digests. Apply the same patch to a separate local harness installation before
running native fixtures: `node cloudflare/engine/container/harness/patch-dsh-pi.mjs /path/to/harness`.
For prompt transport, run `tools/test-native-prompt-stdin.mjs` with the runner
path as its argument inside a disposable sandbox image with `--network none`.
It checks full UTF-8 prompts above the OS argument limit against native DSH
(new and resumed sessions) and checks Codex adapter stdin/session arguments
with a CLI double. It uses loopback fixtures and no provider credentials.

Then test the installed DSH runner:

```sh
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh.mjs
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh-exa.mjs
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh-recovery.mjs
```

These use local fixtures. `LIVE_EXA=1` with `EXA_API_KEY` enables a real Exa request
in the search test. Use `DSH_RUNNER_BIN` or `DSH_RECEIPT_WRAPPER_BIN` for tests of
the installed container runner. Fixture success does not establish provider availability.
