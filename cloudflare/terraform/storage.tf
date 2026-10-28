locals {
  r2_jurisdiction = coalesce(var.data_jurisdiction, "default")
}

resource "cloudflare_r2_bucket" "experiment_packages" {
  account_id    = var.cloudflare_account_id
  name          = "ack3-experiment-packages"
  jurisdiction  = local.r2_jurisdiction
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "experiment_packages" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.experiment_packages.name
  enabled      = false
  jurisdiction = local.r2_jurisdiction

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "experiment_packages" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.experiment_packages.name
  jurisdiction = local.r2_jurisdiction

  rules = [
    { id = "immutable-releases", enabled = true, prefix = "releases/sha256/", condition = { type = "Indefinite" } },
    { id = "immutable-sources", enabled = true, prefix = "sources/v2/git-tree/", condition = { type = "Indefinite" } },
  ]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "experiment_artifacts" {
  account_id    = var.cloudflare_account_id
  name          = "ack3-experiment-artifacts"
  jurisdiction  = local.r2_jurisdiction
  location      = var.r2_location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_managed_domain" "experiment_artifacts" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.experiment_artifacts.name
  enabled      = false
  jurisdiction = local.r2_jurisdiction

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_lock" "experiment_artifacts" {
  account_id   = var.cloudflare_account_id
  bucket_name  = cloudflare_r2_bucket.experiment_artifacts.name
  jurisdiction = local.r2_jurisdiction

  rules = [
    # Cloudflare returns these rules in checkpoint-first order.
    { id = "immutable-checkpoints", enabled = true, prefix = "checkpoints/sha256/", condition = { type = "Indefinite" } },
    { id = "immutable-model-artifacts", enabled = true, prefix = "artifacts/", condition = { type = "Indefinite" } },
  ]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_d1_database" "experiment_index" {
  account_id   = var.cloudflare_account_id
  name         = "ack3-experiment-index"
  jurisdiction = var.data_jurisdiction
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "terraform_state" {
  account_id    = var.cloudflare_account_id
  name          = "swarm-terraform-state"
  jurisdiction  = local.r2_jurisdiction
  storage_class = "Standard"
  lifecycle {
    prevent_destroy = true
  }
}
