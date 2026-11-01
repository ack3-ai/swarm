locals {
  runtime_workers = { for slot in range(1, var.runtime_slot_count + 1) : format("runtime-%02d", slot) => format("swarm-runtime-%02d", slot) }
}

resource "cloudflare_worker" "experiment_engine" {
  account_id = var.cloudflare_account_id
  name       = "swarm"
  tags       = [var.resource_prefix, "experiments", "terraform-owned"]

  # Export destinations are provider-computed; setting [] causes perpetual drift.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
  }

  subdomain = {
    enabled          = true
    previews_enabled = false
  }

  # The front door binds every runtime, so it must be removed before them.
  depends_on = [cloudflare_worker.runtime]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_worker" "runtime" {
  for_each = local.runtime_workers

  account_id = var.cloudflare_account_id
  name       = each.value
  tags       = [var.resource_prefix, "experiments", "runtime-release", each.key, "terraform-owned"]

  # Export destinations are provider-computed.
  observability = {
    enabled            = true
    head_sampling_rate = 1
    logs = {
      enabled            = true
      head_sampling_rate = 1
      invocation_logs    = true
      persist            = true
    }
    traces = {
      enabled            = false
      head_sampling_rate = 1
      persist            = true
    }
  }

  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  lifecycle {
    prevent_destroy = true
  }
}
