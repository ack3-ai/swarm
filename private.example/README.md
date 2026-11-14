# Your private settings (template)

Copy this folder to `private/` at the repository root and fill in your values:

```sh
mkdir -p private
cp -R private.example/. private/
mkdir -p private/audits private/terraform
cp docs/examples/audit.json docs/examples/prompts.json private/audits/
cp cloudflare/terraform/terraform.tfvars.example private/terraform/swarm.tfvars
```

The public template's `.gitignore` excludes `private/`. In a private development
checkout, some files there may already be tracked; check `git status` before committing.
If your team shares them, keep them in a separate private repository or backup.
Never put secret values here (API tokens, keys, `auth.json`): Terraform stores them
in Cloudflare Secrets Store ([credentials](../cloudflare/terraform/README.md#state-and-credentials)).
Keep the few files that hold secrets (the Terraform credentials map, saved plans and
the front door's secrets file) in a separate owner-only folder outside the repository;
the docs write it as `/path/to/secrets/…`.

The docs write paths in this folder as `/path/to/private/…`. Use absolute paths,
for example `"$PWD/private/audits/audit.json"` from the repository root.

| File | Use |
| --- | --- |
| `deploy/swarm.env` | Settings for the config renderers and control tools. Load them from the repository root with `set -a; . private/deploy/swarm.env; set +a`. |
| `deploy/runtime-01.json` | A runtime declaration for `config:runtime` ([publication](../cloudflare/engine/README.md#worker-and-runtime-publication)). Add one per runtime. |
| `deploy/runtime-catalog.json` | The front door's runtime catalog (`ACK3_RUNTIME_CATALOG_FILE`). |
| `deploy/runtime-workers.json` | Not included: write it from Terraform with `terraform -chdir=cloudflare/terraform output -json experiment_runtime_worker_names`. |
| `terraform/backend.hcl` | The state backend endpoint for `terraform init -backend-config=…`. |
| `terraform/swarm.tfvars` | Your Terraform values, copied from the example above. |
| `audits/` | Your audit configs and prompt files ([Run an audit](../docs/running-audit.md#configure)). |
