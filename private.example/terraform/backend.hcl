# Remote state endpoint: terraform init -backend-config=/path/to/private/terraform/backend.hcl
# With data_jurisdiction set, use https://<account-id>.<jurisdiction>.r2.cloudflarestorage.com.
endpoints = {
  s3 = "https://00000000000000000000000000000000.r2.cloudflarestorage.com"
}
