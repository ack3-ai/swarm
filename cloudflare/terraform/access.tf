resource "cloudflare_zero_trust_access_identity_provider" "email" {
  account_id = var.cloudflare_account_id
  name       = "Swarm email sign-in"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_policy" "dashboard" {
  account_id       = var.cloudflare_account_id
  name             = "Swarm dashboard"
  decision         = "allow"
  session_duration = "8h"
  include = concat(
    [for domain in var.dashboard_email_domains : { email_domain = { domain = domain } }],
    [for email in var.dashboard_emails : { email = { email = email } }],
  )
}

resource "cloudflare_zero_trust_access_application" "dashboard" {
  account_id                 = var.cloudflare_account_id
  name                       = "Swarm audit dashboard"
  type                       = "self_hosted"
  domain                     = "${var.service_hostname}/dashboard"
  session_duration           = "8h"
  app_launcher_visible       = false
  auto_redirect_to_identity  = true
  allowed_idps               = [cloudflare_zero_trust_access_identity_provider.email.id]
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  skip_interstitial          = true
  policies = [{
    id         = cloudflare_zero_trust_access_policy.dashboard.id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true
  }
}

output "dashboard_access_audience" {
  value = cloudflare_zero_trust_access_application.dashboard.aud
}
