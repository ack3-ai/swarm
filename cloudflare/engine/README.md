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
| Infrastructure resources or bindings | [Terraform](../terraform/README.md), coordinated with the runtime deployment configuration. |

### First-time setup

You need:

- a separate Cloudflare account with Workers Paid (R2 and Containers), a Zero Trust
  organization and a workers.dev subdomain;
- an Exa API key (needed even with search off), and a login or key for each model
  provider your audits use: Codex (a ChatGPT login whose plan includes Codex), Claude
  (a subscription token) or a DSH provider API key;
- Node and pnpm ([package.json](../../package.json)), Terraform 1.15.x, Docker with
  buildx, Git, `jq` and `zstd`.

Details are in the [Terraform prerequisites](../terraform/README.md). Keep your own
settings in `private/`, starting from the [private.example](../../private.example/README.md)
template. Then:

1. Provision the account with [Terraform](../terraform/README.md), including the
   service credentials in Secrets Store.
2. [Build and push the image](#local-container-builds).
3. For each runtime: write its declaration, render and deploy it, and set any
   `TARGET_*` secrets your audits use ([Worker and runtime publication](#worker-and-runtime-publication)).
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

This reserves the oldest idle slot, publishes code, verifies identity and activates
it. The slot must already have the required image, bindings and capacity; code
rotation preserves them. If the result is ambiguous, reconcile the saved intent
instead of publishing again:

```sh
node cloudflare/engine/tools/reconcile-runtime-rotation.mjs /path/to/private/rotation-intent.json
```

For an audit release explicitly activated on that runtime, dispatch once with:

```sh
node cloudflare/engine/tools/start-audit-once.mjs RUN_ID EXPERIMENT_ID RELEASE_DIGEST RUNTIME_ID /path/to/private/audit-intent.json
```

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
the Workflow, Sandbox and container bindings. Container sizing and base bindings
are in [wrangler.jsonc](wrangler.jsonc).

| Renderer input | Source |
| --- | --- |
| `ACK3_CLOUDFLARE_ACCOUNT_ID` | Intended Cloudflare account. |
| `ACK3_D1_DATABASE_ID` | Terraform database output. |
| `ACK3_RUNTIME_WORKERS_FILE` | File containing Terraform's `experiment_runtime_worker_names` JSON output. |
| `ACK3_CODEX_WORKSPACE_ID` | Optional: the Codex login's account ID. Leave unset for runtimes without Codex. |
| `ACK3_SECRETS_STORE_ID` | Secrets Store containing the runtime credentials. |
| `ACK3_BUILD_COMMIT_SHA` | Reviewed framework commit. |
| `ACK3_RUNTIME_SECRET_BINDINGS` | Terraform `runtime_secret_bindings` output (runtimes). |
| `ACK3_RUNTIME_CATALOG_FILE` | Front-door runtime catalog. |
| `ACK3_DASHBOARD_ACCESS_ISSUER` | Access team issuer, `https://<team>.cloudflareaccess.com` (front door). |
| `ACK3_DASHBOARD_ACCESS_AUDIENCE` | Terraform `dashboard_access_audience` output (front door). |
| `ACK3_DASHBOARD_ACCESS_EMAILS` | Comma-separated dashboard addresses or `@domains`, matching the Access policy (front door). A Terraform `dashboard_email_domains` entry `example.com` is `@example.com` here. |
| `ACK3_DATA_JURISDICTION` | Optional: `eu` or `fedramp`, matching Terraform `data_jurisdiction`. |
| `ACK3_LOCATION_HINT` | Optional placement for Workflows and the coordinator, such as `enam`. |
| `ACK3_CONTAINER_REGIONS` | Optional comma-separated container regions, such as `ENAM` (runtimes). |
| `ACK3_CONTAINER_MAX_INSTANCES` | Optional container cap per runtime; the default is 4 (runtimes). |

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
The helper refuses to overwrite a published Worker.

A Codex login is needed only for audits with Codex pools. Without `ACK3_CODEX_WORKSPACE_ID`,
the runtime has no Codex binding and refuses Codex pools at start. To add one, install
the Codex CLI (`npm install -g @openai/codex@0.152.1`, the version in the image) and run
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
# expect "success": true and "disposed": true.
printf 'Authorization: Bearer %s\n' "$CONTROL_API_TOKEN" | \
  curl -fsS -X POST -H @- "$ACK3_ENGINE_URL/v1/readiness/container"
```

Audit `environmentBindings` read `TARGET_*` Worker secrets on each runtime; set them
from the engine directory with `pnpm exec wrangler secret put TARGET_NAME --config wrangler.runtime.RUNTIME_ID.jsonc`.

Render front-door configuration with `pnpm --dir cloudflare/engine config:deploy`.
The front door requires its `CONTROL_API_TOKEN` secret, the value stored as
`swarm-control-token`, and Wrangler refuses the first deploy without it. Pass it once
with a private secrets file containing `{"CONTROL_API_TOKEN": "…"}`, from the engine directory:
`pnpm exec wrangler deploy --config wrangler.deploy.jsonc --secrets-file /path/to/private/front-door-secrets.json`.
The rendered front door has no containers. Later deploys keep the secret; use
`pnpm deploy:worker` there.
Do not remove bindings used by active audits or supported recovery routes.

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
You need Docker with buildx, and `jq` for the push step. The image is a few GB; on ARM
hosts the `linux/amd64` build runs under emulation and is slower. Build for
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
  pnpm --dir cloudflare/engine exec wrangler containers registries credentials \
    registry.cloudflare.com --expiration-minutes 30 --push --json \
    > "$SWARM_PUSH_DIR/credentials.json"
  jq -er '.password' "$SWARM_PUSH_DIR/credentials.json" | \
    docker login registry.cloudflare.com \
      --username "$(jq -er '.username' "$SWARM_PUSH_DIR/credentials.json")" --password-stdin
  docker push "$SWARM_IMAGE"
  docker image inspect "$SWARM_IMAGE" --format '{{json .RepoDigests}}'
)
```

Use the resulting digest in both the runtime declaration and audit configuration.
Pushing an image alone does not update a runtime. Build locally rather than in
GitHub Actions; remove only task-owned obsolete images and build artifacts.

## Checkpoints and recovery

[Stop and resume commands](../../docs/running-audit.md#stop-or-resume) cover normal
controls. Stop terminates the Workflow and requests workspace cleanup; verify
native container absence separately. An immediate stop does not create a checkpoint.

Recovery preserves accepted evidence and ancestry in a child run. For failed
partial waves, use the [failed-wave recovery contract](src/failed-wave-recovery.ts);
for an interrupted final completion, use the
[terminal recovery contract](src/terminal-completion-recovery.ts).
Never alter checkpoints or count missing usage receipts as zero.

Before releasing a stopped run's runtime lease, preserve its state and prove
Workflow termination and physical cleanup through the
[stopped-run retirement contract](src/stopped-run-retirement.ts).

## Monitoring and diagnostics

The dashboard is at `/dashboard` behind Cloudflare Access. It displays activity,
evidence and usage; controls use the authenticated API.

| Read-only route | Result |
| --- | --- |
| `GET /v1/monitor/runs` | Paginated audit index. |
| `GET /v1/monitor/runs/:id` | Activity and saved evidence summary. |
| `GET /v1/monitor/runs/:id/artifacts/:digest` | Accepted artifact files. |
| `GET /v1/runs/:id` | Run state and Workflow status. |

Saved activity can lag execution. Recorded usage includes rejected attempts and
inherited work; do not sum parent and child totals. Recorded cost is not a provider
invoice, and interrupted usage may be unknown.

For a stalled or failed task, correlate its runtime version, Sandbox ID and time
with native Cloudflare logs and agent receipts. Preserve evidence before recovery.
Memory metrics can suggest exhaustion but do not prove an OOM kill.

Use your own token with Workers Containers Read for the native inventory commands:

```sh
pnpm --dir cloudflare/engine exec wrangler containers list --json
pnpm --dir cloudflare/engine exec wrangler containers instances APPLICATION_ID --json
```

Resource sampling and failure classification are implemented in
[container-resource-diagnostics.ts](src/container-resource-diagnostics.ts).

## Validation

[Local contributor checks](../../CONTRIBUTING.md#local-setup) cover types, tests and
bundling. Install `container/harness` dependencies with `npm ci --ignore-scripts`
and run `node --test test/native-claude.test.mjs test/subscription-limits.test.mjs`
for Claude/Codex subscription boundaries.

The image pins DSH 0.2.1-rc.2 and pi-ai 1.3.0. Its
[dependency patch](container/harness/patch-dsh-pi.mjs) preserves structured HTTP
status and provider retry delays and distinguishes reported usage from initialized
zero counters. Docker applies it after installation and checks exact source
digests. Apply the same patch to a separate local harness installation before
running native fixtures: `node cloudflare/engine/container/harness/patch-dsh-pi.mjs /path/to/harness`.
Then test the installed DSH runner:

```sh
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh.mjs
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh-exa.mjs
DSH_BIN=/path/to/dsh node cloudflare/engine/tools/test-native-dsh-recovery.mjs
```

These use local fixtures. `LIVE_EXA=1` with `EXA_API_KEY` enables a real Exa request
in the search test. Use `DSH_RUNNER_BIN` or `DSH_RECEIPT_WRAPPER_BIN` for tests of
the installed container runner. Fixture success does not establish provider availability.
