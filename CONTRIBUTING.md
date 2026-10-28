# Contributing

For bugs, provide a minimal reproduction, expected behavior and the relevant
version. Discuss substantial changes in an issue before implementing them.
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Local setup

Use the Node.js and pnpm versions in [package.json](package.json); some tests also
need `python3`. Check `node --version` and `pnpm --version` before installing dependencies.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` runs type checking, Vitest and Node tests, and a Worker dry build.
It needs no cloud credentials, paid models or Docker build. For a smaller audit
flow check, run `pnpm audit0:acceptance`. The `dev` script uses remote Cloudflare
resources; it is not a local audit server.

## Make a change

Use a focused branch and pull request. Describe the user-visible change and how
it was validated. Add a regression test for behavior changes; documentation-only
changes need accuracy and link checks. Keep unrelated work out of the diff.

Update affected documentation and examples with the implementation. Explain the
current behavior and commands; put incident history and change rationale in the
PR. Keep terminology consistent across docs, configuration and dashboard. Link
to configuration or source for details that would otherwise be duplicated.
Never commit credentials, private target source, audit evidence or Terraform state.

Changes to an installed runner need its native harness tests in addition to
unit tests. See [harness validation](cloudflare/engine/README.md#validation).
Live audits and infrastructure changes require maintainer coordination.

## Code map

| Area | Entry point |
| --- | --- |
| Audit stages and validation | [security-audit-v1.ts](cloudflare/engine/src/methods/security-audit-v1.ts) |
| Agent prompts | [Prompt editing guide](cloudflare/engine/src/methods/prompt-sets/README.md) |
| Configuration | [config-compiler.ts](cloudflare/engine/src/config-compiler.ts) |
| Execution and state | [runner.ts](cloudflare/engine/src/runner.ts), [machine.ts](cloudflare/engine/src/machine.ts) |
| Containers and runners | [sandbox-provider.ts](cloudflare/engine/src/sandbox-provider.ts), [container](cloudflare/engine/container/) |
| API and dashboard | [worker.ts](cloudflare/engine/src/worker.ts), [dashboard.html](cloudflare/engine/src/dashboard.html) |
| Infrastructure | [Terraform](cloudflare/terraform/README.md) |
