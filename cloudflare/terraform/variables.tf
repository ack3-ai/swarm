variable "cloudflare_account_id" {
  description = "Dedicated Cloudflare account that hosts Swarm."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "Use the 32-character Cloudflare account ID."
  }
}

variable "service_hostname" {
  description = "Hostname of the front-door Worker, such as swarm.<workers-subdomain>.workers.dev."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9.-]+$", var.service_hostname))
    error_message = "Use a bare hostname without scheme or path."
  }
}

variable "dashboard_email_domains" {
  description = "Email domains allowed to sign in to the dashboard."
  type        = list(string)
  default     = []
}

variable "dashboard_emails" {
  description = "Individual email addresses allowed to sign in to the dashboard."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.dashboard_emails) + length(var.dashboard_email_domains) > 0
    error_message = "Allow at least one dashboard email or email domain."
  }
}

variable "account_members" {
  description = "Optional account members, granted account_member_role_ids."
  type        = set(string)
  default     = []
}

variable "account_member_role_ids" {
  description = "Cloudflare account role IDs for account_members; list them with the account roles API."
  type        = list(string)
  default     = []

  validation {
    condition     = length(var.account_members) == 0 || length(var.account_member_role_ids) > 0
    error_message = "Set account_member_role_ids when account_members is not empty."
  }
}

variable "runtime_slot_count" {
  description = "Number of runtime Workers (slots). Code rotation needs at least two."
  type        = number
  default     = 3

  validation {
    condition     = var.runtime_slot_count >= 1 && var.runtime_slot_count <= 50 && floor(var.runtime_slot_count) == var.runtime_slot_count
    error_message = "Use a whole number of runtime slots from 1 to 50."
  }
}

variable "data_jurisdiction" {
  description = "Optional R2 and D1 jurisdiction, eu or fedramp. Unset uses Cloudflare's default."
  type        = string
  default     = null

  validation {
    condition     = var.data_jurisdiction == null || contains(["eu", "fedramp"], coalesce(var.data_jurisdiction, "eu"))
    error_message = "Use eu or fedramp, or leave unset."
  }
}

variable "r2_location" {
  description = "Optional R2 location hint for the audit buckets, such as enam. Unset lets Cloudflare choose."
  type        = string
  default     = null
}
