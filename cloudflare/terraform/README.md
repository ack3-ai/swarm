# Swarm infrastructure

Terraform manages Worker identities, D1, R2, Secrets Store, credentials, dashboard
access and optional membership. Review [inputs](variables.tf), [state backend](versions.tf),
[access policy](access.tf) and [membership](members.tf) before provisioning.
Copy [terraform.tfvars.example](terraform.tfvars.example) to a private `.tfvars`
file for your account, hostname and dashboard users, for example
`private/terraform/swarm.tfvars` ([template](../../private.example/README.md)).

Prerequisites:

- Terraform 1.15.x ([versions.tf](versions.tf) pins `~> 1.15.0`; newer releases are refused).
- Node and pnpm from [package.json](../../package.json), with `pnpm install --frozen-lockfile`
  run at the repository root (the commands below use the repository's Wrangler).
- A dedicated Cloudflare account with Workers Paid, R2 and Containers.
- A Zero Trust organization, created in the Cloudflare dashboard. Its team domain is
  the dashboard Access issuer.
- A workers.dev subdomain, set in the Cloudflare dashboard. It forms
  `service_hostname` as `swarm.<subdomain>.workers.dev`.
- A management API token, used as `CLOUDFLARE_API_TOKEN`, with edit access to Workers
  Scripts, Workers Containers, Workers R2 Storage, D1, Secrets Store, Account API Tokens,
  Zero Trust Access (applications, policies and identity providers) and, if you manage
  members, Account Memberships. Wrangler uses the same token; also export
  `CLOUDFLARE_ACCOUNT_ID`.
- `jq`. For Codex pools, the Codex CLI (`npm install -g @openai/codex@0.152.1`, the
  version in the image) signed in with a dedicated ChatGPT account whose plan includes
  Codex; for a Claude token, the Claude Code CLI.
- The service credentials listed [below](#state-and-credentials).

[Deployment commands](../engine/README.md#build-and-deployment) publish Worker code,
Workflows, Durable Objects and containers. Bucket names and bindings must match
the engine configuration.

## State and credentials

Keep remote state in a private R2 bucket separate from audit data. The module
names it `swarm-terraform-state`, in `data_jurisdiction` (`default` when unset).
Create both first, matching the module so the import shows no changes:

- the bucket: `pnpm --dir cloudflare/engine exec wrangler r2 bucket create swarm-terraform-state`
  (add `--jurisdiction <data_jurisdiction>` when you set one);
- an account-owned API token (Manage Account → Account API Tokens) named
  `Swarm Terraform state` with only Workers R2 Storage Bucket Item Write, limited to
  that bucket. Its ID is `result.id` from
  `printf 'Authorization: Bearer %s\n' "$STATE_TOKEN" | curl -fsS -H @- https://api.cloudflare.com/client/v4/accounts/<account-id>/tokens/verify`.

Import both after `init` (below). Import other existing resources instead of recreating
them. If `apply` reports that a new account already has a Secrets Store or a
One-time PIN login method, import that too. The token's S3 credentials are its ID
(access key ID) and the SHA-256 of its value (secret access key:
`printf %s "$STATE_TOKEN" | sha256sum | cut -d' ' -f1`). Use them through `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, and a Swarm management token through
`CLOUDFLARE_API_TOKEN`. Supply existing service credentials in memory through
`TF_VAR_service_credentials`; never put values in Git, command arguments or
`.tfvars` files. The map needs one string value per Secrets Store name:

| Name | Value |
| --- | --- |
| `swarm-control-token` | A random token you generate, for example with `openssl rand -hex 32`. Keep a private copy: Secrets Store values cannot be read back, and the control tools need it. |
| `swarm-codex-auth-json` | Only with `codex_login = true`, for audits with Codex pools: the contents of `~/.codex/auth.json` after `codex login` with a dedicated ChatGPT account, as one JSON string (`jq -Rs . ~/.codex/auth.json`) ([details](../engine/README.md#worker-and-runtime-publication)). |
| `swarm-exa-api-key` | Your Exa API key; required even when search is off. |
| `swarm-cloudflare-tfstate-access-key-id`, `swarm-cloudflare-tfstate-secret-access-key` | The state token's S3 credentials (above). |
| Each secret name in `runtime_secret_bindings` | That provider key or subscription token. |

For example, read it from a private file:

```sh
export TF_VAR_service_credentials="$(cat /path/to/private/service-credentials.json)"
# {"swarm-control-token":"…","swarm-exa-api-key":"…", …}
```

Terraform state and saved plans contain sensitive credential values. Restrict
them to Swarm administrators, keep remote state in the private encrypted bucket,
and do not upload plans or state to Git, issues or build logs. The management
credential needs permissions for the declared resources, including Access,
account tokens and membership; Wrangler OAuth alone does not provide these.

```sh
# Work around empty POST bodies observed with the Cloudflare provider over HTTP/2.
export GODEBUG=http2client=0
# With data_jurisdiction set, use https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com.
terraform -chdir=cloudflare/terraform init \
  -backend-config='endpoints={s3="https://<account-id>.r2.cloudflarestorage.com"}'
# First run only: import the state bucket and its token.
terraform -chdir=cloudflare/terraform import -var-file=/path/to/private/swarm.tfvars \
  cloudflare_r2_bucket.terraform_state '<account-id>/swarm-terraform-state/<jurisdiction>'
terraform -chdir=cloudflare/terraform import -var-file=/path/to/private/swarm.tfvars \
  cloudflare_account_token.terraform_state '<account-id>/<token-id>'
terraform -chdir=cloudflare/terraform plan -var-file=/path/to/private/swarm.tfvars \
  -out=/path/to/private/swarm.tfplan
# Inspect the complete plan before applying it.
terraform -chdir=cloudflare/terraform apply /path/to/private/swarm.tfplan
terraform -chdir=cloudflare/terraform output -json experiment_runtime_worker_names
```

Use the runtime output with `ACK3_RUNTIME_WORKERS_FILE`, the database output
with `ACK3_D1_DATABASE_ID` and `secrets_store_id` with `ACK3_SECRETS_STORE_ID`. Runtime credentials belong in this account’s
Secrets Store and are managed by [credentials.tf](credentials.tf). Declare model
provider keys and subscription accounts used by audit configurations in
`runtime_secret_bindings`, and pass its output to the runtime renderer as
`ACK3_RUNTIME_SECRET_BINDINGS`. Membership is optional; account ownership is preserved.

## Provisioning

Enable Workers Paid and R2, configure dashboard Access and the public hostname,
and provision account-scoped credentials before deployment. Dashboard JWT
validation must match the Access application's issuer and audience: render the
front door with your Access team issuer and the `dashboard_access_audience` output.
Verify authenticated access, rejection of unauthenticated requests, runtime
startup and physical cleanup before switching traffic.
