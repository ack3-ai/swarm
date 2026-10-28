terraform {
  required_version = "~> 1.15.0"

  backend "s3" {
    bucket = "swarm-terraform-state"
    key    = "production/swarm.tfstate"
    region = "auto"
    # Supply endpoints = { s3 = "https://<account-id>.r2.cloudflarestorage.com" } (or the
    # jurisdiction endpoint, such as <account-id>.eu.r2…) with -backend-config at init.

    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.25.0"
    }
  }
}

provider "cloudflare" {}
