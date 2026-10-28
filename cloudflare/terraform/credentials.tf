resource "cloudflare_secrets_store" "swarm" {
  account_id = var.cloudflare_account_id
  name       = "swarm"
  lifecycle {
    prevent_destroy = true
  }
}

variable "service_credentials" {
  description = "Swarm-only credential values supplied in memory, never in a tfvars file. Stored in the private encrypted Terraform backend."
  type        = map(string)
  sensitive   = true
}

variable "runtime_secret_bindings" {
  description = "Runtime binding name to Secrets Store secret name for model provider API keys and subscription accounts; values come from service_credentials."
  type        = map(string)
  default     = {}
  validation {
    condition = alltrue([for binding, name in var.runtime_secret_bindings :
      (can(regex("^CLAUDE_[A-Z0-9_]*OAUTH_TOKEN$", binding)) || can(regex("^CODEX_[A-Z0-9_]*AUTH_JSON$", binding))
      || (can(regex("^[A-Z][A-Z0-9_]{0,119}_API_KEY$", binding)) && binding != "EXA_API_KEY"))
      && can(regex("^swarm-[a-z0-9-]{1,100}$", name))
    ])
    error_message = "Use CLAUDE_*OAUTH_TOKEN, CODEX_*AUTH_JSON or *_API_KEY bindings (not EXA_API_KEY) and swarm-prefixed secret names."
  }
}

variable "codex_login" {
  description = "Store a default Codex login (swarm-codex-auth-json) for runtimes. Needed only for audits with Codex pools."
  type        = bool
  default     = false
}

output "runtime_secret_bindings" {
  value = var.runtime_secret_bindings
}

locals {
  service_secret_names = setunion(toset(values(var.runtime_secret_bindings)), toset(concat([
    "swarm-control-token",
    "swarm-exa-api-key",
    "swarm-cloudflare-tfstate-access-key-id",
    "swarm-cloudflare-tfstate-secret-access-key",
  ], var.codex_login ? ["swarm-codex-auth-json"] : [])))
}

resource "cloudflare_secrets_store_secret" "service" {
  for_each   = local.service_secret_names
  account_id = var.cloudflare_account_id
  store_id   = cloudflare_secrets_store.swarm.id
  name       = each.value
  value      = var.service_credentials[each.value]
  scopes     = ["workers"]
  comment    = startswith(each.value, "swarm-cloudflare-tfstate-") ? null : "Swarm service credential"
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_account_token" "diagnostics" {
  account_id = var.cloudflare_account_id
  name       = "Swarm runtime diagnostics"
  policies = [{
    effect = "allow"
    permission_groups = [
      { id = "cfd39eebc07c4e3ea849e4b3d2644637" }, # Workers Containers Read
      { id = "da1261c3d38544a4bba805b22566f8b6" }, # Workers Metadata Read-Only
      { id = "66c1ed49f4ed46098b75696a6d4ee3c9" }, # Workers Observability Read
      { id = "b89a480218d04ceb98b4fe57ca29dc1f" }, # Account Analytics Read
    ]
    resources = jsonencode({ "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*" })
  }]
}

resource "cloudflare_secrets_store_secret" "diagnostics" {
  account_id = var.cloudflare_account_id
  store_id   = cloudflare_secrets_store.swarm.id
  name       = "swarm-cloudflare-observability-token"
  value      = cloudflare_account_token.diagnostics.value
  scopes     = ["workers"]
}

# Bootstrap credential for the state bucket. Create it with the bucket before the
# first apply, then import it; never replace the live backend credential.
resource "cloudflare_account_token" "terraform_state" {
  account_id = var.cloudflare_account_id
  name       = "Swarm Terraform state"
  policies = [{
    effect            = "allow"
    permission_groups = [{ id = "2efd5506f9c8494dacb1fa10a3e7d5b6" }]
    resources         = jsonencode({ "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_${local.r2_jurisdiction}_${cloudflare_r2_bucket.terraform_state.name}" = "*" })
  }]
  lifecycle {
    prevent_destroy = true
  }
}
