resource "cloudflare_account_member" "developers" {
  for_each   = var.account_members
  account_id = var.cloudflare_account_id
  email      = each.value
  roles      = var.account_member_role_ids
}
