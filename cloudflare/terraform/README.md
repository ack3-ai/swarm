# Swarm infrastructure

Terraform manages Worker identities, D1, R2, Secrets Store, credentials, dashboard
access and optional membership. Review [inputs](variables.tf), [state backend](versions.tf),
[access policy](access.tf) and [membership](members.tf) before provisioning.
Copy [terraform.tfvars.example](terraform.tfvars.example) to a private `.tfvars`
file for your account, hostname and dashboard users, for example
`private/terraform/swarm.tfvars` ([template](../../private.example/README.md)).

Prerequisites:

- Terraform 1.15.x ([versions.tf](versions.tf) pins `~> 1.15.0`; newer releases are refused).
  Download the newest 1.15 release from <https://releases.hashicorp.com/terraform/>.
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
  `CLOUDFLARE_ACCOUNT_ID`. To check an account-owned token, use
  `/accounts/<account-id>/tokens/verify`; `/user/tokens/verify` rejects it.
  This is the only token you create by hand (dashboard: Manage Account → Account API
  Tokens → Create Token → Create Custom Token). The state token is created from it with
  a command ([below](#state-and-credentials)), and Terraform creates the rest.
- `jq`. For Codex pools, the Codex CLI (`npm install -g @openai/codex@0.165.0`, the
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

- the bucket: `pnpm --dir cloudflare/engine exec wrangler r2 bucket create swarm-terraform-state --no-update-config`
  (add `--jurisdiction <data_jurisdiction>` when you set one);
- an account-owned API token named `Swarm Terraform state` with only Workers R2
  Storage Bucket Item Write, limited to that bucket. Create it with the management
  token (the same policy as [credentials.tf](credentials.tf); use your
  `data_jurisdiction` in place of `default` when you set one):

  ```sh
  (
    set -eu
    umask 077
    body=$(printf '{"name":"Swarm Terraform state","policies":[{"effect":"allow","permission_groups":[{"id":"2efd5506f9c8494dacb1fa10a3e7d5b6"}],"resources":{"com.cloudflare.edge.r2.bucket.%s_default_swarm-terraform-state":"*"}}]}' "$CLOUDFLARE_ACCOUNT_ID")
    printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" | curl -fsS -H @- \
      -H 'Content-Type: application/json' --data "$body" \
      "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/tokens" \
      > /path/to/secrets/state-token.json
  )
  ```

  Cloudflare returns the token value only once, so keep this file: `result.id` is the
  token ID and `result.value` its value (`STATE_TOKEN="$(jq -er .result.value /path/to/secrets/state-token.json)"`).
  A token created in the dashboard (Manage Account → Account API Tokens) also works;
  its ID is `result.id` from
  `printf 'Authorization: Bearer %s\n' "$STATE_TOKEN" | curl -fsS -H @- https://api.cloudflare.com/client/v4/accounts/<account-id>/tokens/verify`.

Import both after `init` (below). Import other existing resources instead of recreating
them. Cloudflare allows one Secrets Store per account, and new accounts often already
have one named `default_secrets_store`. Check with
`printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" | curl -fsS -H @- https://api.cloudflare.com/client/v4/accounts/<account-id>/secrets_store/stores`;
if it lists one, set `secrets_store_name` to its name and import it (below). If `apply` reports an
existing One-time PIN login method, import that too. The token's S3 credentials are its ID
(access key ID) and the SHA-256 of its value (secret access key:
`printf %s "$STATE_TOKEN" | sha256sum | cut -d' ' -f1`; on macOS without `sha256sum`,
use `shasum -a 256`). Use them through `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`: Terraform's S3 backend reads these names, but the values are
R2 credentials and no Amazon account is needed. Set the Swarm management token as
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

For example, read it from an owner-only file outside the repository:

```sh
export TF_VAR_service_credentials="$(cat /path/to/secrets/service-credentials.json)"
# {"swarm-control-token":"…","swarm-exa-api-key":"…", …}
```

Terraform state and saved plans contain sensitive credential values. Restrict
them to Swarm administrators, keep remote state in the private encrypted bucket,
and do not upload plans or state to Git, issues or build logs. The management
credential needs permissions for the declared resources, including Access,
account tokens and membership; Wrangler OAuth alone does not provide these.

```sh
# Use HTTP/1.1 for Cloudflare provider requests.
export GODEBUG=http2client=0
# With data_jurisdiction set, use https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com.
terraform -chdir=cloudflare/terraform init \
  -backend-config='endpoints={s3="https://<account-id>.r2.cloudflarestorage.com"}'
# First run only: import the state bucket and its token.
terraform -chdir=cloudflare/terraform import -var-file=/path/to/private/swarm.tfvars \
  cloudflare_r2_bucket.terraform_state '<account-id>/swarm-terraform-state/default'
# (use your data_jurisdiction in place of default when you set one)
terraform -chdir=cloudflare/terraform import -var-file=/path/to/private/swarm.tfvars \
  cloudflare_account_token.terraform_state '<account-id>/<token-id>'
# Only if the account already has a Secrets Store (with secrets_store_name set to its name).
terraform -chdir=cloudflare/terraform import -var-file=/path/to/private/swarm.tfvars \
  cloudflare_secrets_store.swarm '<account-id>/<store-id>'
terraform -chdir=cloudflare/terraform plan -var-file=/path/to/private/swarm.tfvars \
  -out=/path/to/secrets/swarm.tfplan
# Inspect the complete plan before applying it. If it would create the state bucket,
# the state token or an existing Secrets Store, an import is missing: delete the plan
# and fix the import.
terraform -chdir=cloudflare/terraform apply /path/to/secrets/swarm.tfplan
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
