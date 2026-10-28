# Run an audit

These commands control a provisioned service. Run them from the repository root and
pass absolute paths: `pnpm --dir cloudflare/engine` resolves relative paths from
`cloudflare/engine`. For local checks, see [Develop locally](../README.md#develop-locally).

## Set up

Install the versions in [package.json](../package.json) with
`pnpm install --frozen-lockfile`. Source publication also needs Git, `tar` and `zstd`.

```sh
export ACK3_ENGINE_URL="https://<your-swarm-service>"
```

For private controls, supply `CONTROL_API_TOKEN` (your private copy of
`swarm-control-token`) to the command process in memory; never echo it. Keep shell tracing off.
Install model and target secret bindings before starting; configuration files
contain binding names, never secret values.
[Credential setup →](../cloudflare/engine/README.md#credentials)

## Configure

Copy the [example configuration](examples/audit.json) and [prompts](examples/prompts.json) to a private directory.
Replace its source revision, runtime image, model connections and budgets; the example's
models, provider, commit and all-zero image digest are placeholders.

| Field | Value |
| --- | --- |
| `configVersion`, `kind` | Required: `2` and `"ack3-audit"` |
| `id`, `objective` | Experiment name and agent assignment |
| `method` | Engine execution contracts; `security-audit-v1` |
| `stages` | Ordered selection: `discovery`, `synthesis`, `coverage`, `negative-review`, `verification`, `reporting` |
| `forceSearch` | Enable mandatory native search; defaults to `true` |
| `forceSearchStages` | Stage IDs; defaults to `discovery`, `coverage`, `negative-review`. [Triggers by stage](#search) |
| `nativeSearch` | Exa connection using an `EXA_API_KEY` runtime binding; never put the key in the config. `searchConnection` also accepts optional `baseUrl` (HTTPS) and `model` |
| `promptFile` | JSON stage instructions, resolved relative to this config and sealed on publication. Optional `instructions` replace the engine's default agent instructions ([below](#agent-instructions)) |
| `target.repository`, `commit`, `tree` | Repository (`owner/name`) and exact revision to audit |
| `environment.image` | Approved immutable container image, including registry and digest |
| `environment.environmentBindings` | Target environment variable → `TARGET_*` Worker secret on each runtime ([how to set](../cloudflare/engine/README.md#worker-and-runtime-publication)) |
| `environment.preflightCommands` | Baseline build/test commands; `$SWARM_SOURCE_DIR` is the source checkout, here and in workspace preparation |
| `environment.workspacePreparation` | Setup commands for each source workspace |
| `modelPools` | Models, providers, researcher counts and required participation |
| `stageModelPools` | One pool per selected later stage; `negative-review` also accepts a list of independent reviewers |
| `limits` | `maxDiscoveryRuntimeMs`, `maxModelCalls`, `maxCostUsd`, and optional `maxInputTokens` and `maxOutputTokens` |
| `maxDiscoveryWaves` | Discovery wave ceiling per pool (1–64) |
| `stopOnSaturation` | Default `true`; set `false` to run all configured discovery waves unless time/spend runs out |
| `researchPlan` | Optional lane labels and peer evidence per discovery wave. [Research plan](#research-plan) |

Start with `discovery`. Negative review and verification require synthesis; reporting
requires verification. Other stages are optional. Preflight, evidence checks and cleanup
run automatically. Omitted stages make no model calls and are not claimed as completed.

### Agent runners and model pools

Define pools with `backend: "codex"`, `"dsh-chat-completions"` or `"claude"`.
At least one discovery pool must be required. Every pool needs `subagents`: set
`subagents.default.mode` to `"disabled"` for DSH and Claude; Codex also supports bounded
native subagents, `{"mode": "native", "maxConcurrent": 1–8}`.

| Pool setting | Effect |
| --- | --- |
| `agents` | Discovery researchers per wave; `0` reserves the pool for later stages |
| `required: true` | Every admitted discovery task must succeed |
| `required: false` | Optional DSH discovery; supported provider outages may be recorded as unavailable |

DSH pools use `provider`, `connection.baseUrl`, `connection.apiKeyEnv` and `model`.
Set `thinking` to `enabled` or `disabled`; `disabled` requires `reasoningEffort: "none"`,
and DSH does not accept `medium`.
`connection.contextWindow` and `connection.maxTokens` default to 1,000,000 and 256,000; set
them to your model's limits (for example GLM `glm-5.3`: 1,048,576 / 131,072; Kimi
`kimi-k3`: 1,048,576 / 262,144). Optional `connection.costRates`
(`uncachedInputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion`)
prices DSH calls; without it they count as zero toward `maxCostUsd` and are marked unpriced.
Claude pools use `credentialSource: "CLAUDE_CODE_OAUTH_TOKEN"` (a secret binding),
`model`, and `reasoningEffort`; omit `provider`, `connection` and `thinking`.
Codex pools require `credentialSource`: a `CODEX_*AUTH_JSON` binding selects that account;
any other label uses the default `ACK3_CODEX_AUTH_JSON` account. Codex pools need a runtime
with a Codex login ([setup](../cloudflare/engine/README.md#worker-and-runtime-publication)). `model` is any model
ID that pool's account or provider serves; `release:export` does not check it. Try a
Codex model with the same login first: `codex exec -m MODEL "Reply with OK."`.
`reasoningEffort` is `none`, `low`, `medium`, `high` or `max`.

Assign pool IDs to later stages:

```json
{
  "stageModelPools": {
    "synthesis": "primary",
    "coverage": "primary",
    "negative-review": ["primary", "second-reviewer"],
    "verification": "primary",
    "reporting": "primary"
  }
}
```

Unused stage routes are ignored. Every selected later-stage task is required;
reviewers may use any runner or the same pool in separate workspaces. Native
subagents do not count toward independent reviews or configured researcher counts.

To compare models in isolation, select `stages: ["discovery"]`, one required
pool with `agents: 1`, `maxDiscoveryWaves: 1`, `forceSearch: false` and
`nativeSearch: false`, and start one run per sample with a unique run ID. Fresh
runs share no audit evidence. To let research build up instead, start one run with
several waves and `stopOnSaturation: false`; later waves receive accepted research.
Equal task counts do not imply equal token usage.

### Agent instructions

Besides one prompt per stage, the prompt file may contain an `instructions` object.
Each entry replaces one of the engine's default agent instructions, such as
`researcherProtocol`, `searchQuestion` or `correctionFormat`; the names and default
texts are in [system-prompts.ts](../cloudflare/engine/src/methods/system-prompts.ts).
`{{NAME}}` placeholders are filled when a task is rendered. The complete set is
sealed with the release.

```json
{
  "discovery": "Focus on access control and fund flows.",
  "instructions": { "searchPrivacy": "Never include target names in queries." }
}
```

### Research plan

By default every discovery lane researches independently in every wave. A
`researchPlan` lists one entry per lane (the largest pool's `agents`) for wave
zero (`first`) and for later waves (`cycle`, repeated in order). Each entry has a
`role` label, shown only on the dashboard, and optionally
`buildsOn: "previous-wave/research-N"`. That lane then receives lane N's accepted
research from the previous wave as peer evidence. Wave zero cannot build on a
previous wave.

In this three-lane example, lanes 2 and 3 build on lane 1's previous wave:

```json
{
  "researchPlan": {
    "first": [{ "role": "anchor" }, { "role": "scout" }, { "role": "scout" }],
    "cycle": [[
      { "role": "anchor" },
      { "role": "satellite", "buildsOn": "previous-wave/research-1" },
      { "role": "satellite", "buildsOn": "previous-wave/research-1" }
    ]]
  }
}
```

### Tools and image

`environment.image` must match the selected runtime’s immutable image. The supplied
image includes Codex, DSH, Claude SDK and Foundry. To change those tools,
follow [local image building](../cloudflare/engine/README.md#local-container-builds)
and deploy an idle runtime with the new digest. Source changes and agent prompt
changes do not require an image build.

### Workspace preparation

Set `environment.workspacePreparation` when every agent needs project dependencies:

```json
{
  "schemaVersion": 1,
  "workingDirectory": ".",
  "commands": ["npm ci --ignore-scripts"],
  "integrityFiles": [
    {"path": "package-lock.json", "sha256": "<file SHA-256>"}
  ]
}
```

Use 1–4 commands and 1–8 integrity files. Each command has two minutes and runs
without model or target secrets. Declared file hashes must remain unchanged.
Preflight success does not prepare the other workspaces.

### Budget

`maxDiscoveryRuntimeMs: 18000000` allows five hours of discovery admission.
Other ceilings can end admission sooner; admitted tasks and later stages still finish.
Subscription quota appears in agent diagnostics when the native runner exposes it.
Unknown quota is not zero usage. Exhaustion fails with saved evidence, without an
agent repair or automatic account switch. Zero recorded cost is not a verified bill.

## Search

All runners use official Exa MCP search and page retrieval; DSH's direct web
search is disabled. The runtime needs an `EXA_API_KEY` secret binding.

```json
{
  "forceSearch": true,
  "forceSearchStages": ["discovery", "coverage", "negative-review"],
  "nativeSearch": {
    "searchConnection": { "provider": "exa", "apiKeyEnv": "EXA_API_KEY" }
  }
}
```

Defaults apply only to enabled stages:

| Stage ID (dashboard label) | When search is required |
| --- | --- |
| `discovery` (Discovery) | When a registered lead ends unresolved or refuted. |
| `coverage` (Coverage) | When a new observation ends unresolved or refuted. |
| `negative-review` (Negative review) | When a decision limits an observation; unchanged decisions need no further search. |

Adding `verification` requires search for exploitability refutations. Preflight
and reporting have no search-gated decisions. Set `forceSearch: false` and omit
`forceSearchStages` for optional search; also set `nativeSearch: false` to disable
search. An empty `forceSearchStages` list makes search optional too.

Agents are asked to search before the decisions above, using the search question
from the release's agent instructions. Public queries must omit private target
details. Exact successful queries are recorded in `researchQueries` on the
relevant decision.

The gate checks those citations against native tool results from the same
session, including correction turns. It does not judge relevance or prove that
results were investigated. A recorded search failure permits an unresolved lead,
but cannot justify dismissal or narrowing. See the shared
[search requirement and gate](../cloudflare/engine/src/native-research.ts).

## Publish and start

Use a local checkout at the commit selected in `target.commit`. Set `target.tree`
to the output of `git rev-parse 'HEAD^{tree}'` at that commit. The repository field
identifies the target; it is not a request to clone or upload it automatically.

Initialize recursive submodules in that checkout:

```sh
git -C /path/to/target submodule update --init --recursive
```

Publish the source and export the configuration:

```sh
pnpm --dir cloudflare/engine source:publish /path/to/target COMMIT_SHA
pnpm --dir cloudflare/engine release:export /path/to/private/audit.json /path/to/private/audit.sealed.json
```

Check target, stages, pools, limits and `body.definition.stagePrompts` in the sealed file.
Export is local. Source publication archives the selected commit, verifies each
submodule revision, and uploads the compressed source to private storage. It
excludes Git history and uncommitted files. Every agent workspace receives this
source package; do not bake target code into the image.

### Activate

```sh
pnpm --dir cloudflare/engine release:publish /path/to/private/audit.json
```

Publication activates the release for future runs using the latest runtime.
It does not start work or change existing runs.

To select a runtime explicitly, read `GET /v1/experiments/EXPERIMENT/release`,
then send its generation to `POST /v1/experiments/EXPERIMENT/activate`:

```json
{"digest": "RELEASE_SHA256", "expectedGeneration": 1, "runtimeId": "RUNTIME_ID"}
```

A generation conflict requires rereading the pointer before retrying.

### Start and observe

```sh
export ACK3_EXPERIMENT_ID=my-security-audit
pnpm audit0 start my-audit-001
pnpm audit0 status my-audit-001
```

`ACK3_EXPERIMENT_ID` is the config's `id`.

Use a unique run ID. After an interrupted request, inspect that ID before retrying.
Open `/dashboard` on your service URL and check fresh activity and accepted
output, not just the `running` label.

## Stop or resume

```sh
pnpm audit0 stop my-audit-001
pnpm audit0 resume my-audit-002 CHECKPOINT_SHA256
```

Take `CHECKPOINT_SHA256` from `pnpm audit0 status` (`checkpoints[].digest`).

Stop blocks new work, terminates the run’s Workflow and requests cleanup of its
owned containers without waiting for models. Confirm Workflow status and native
container absence separately: an accepted stop response is not proof that
physical shutdown has finished.

Resume creates a child from an existing sealed checkpoint; an immediate stop
does not create a new checkpoint. It does not resume the parent’s model
conversation. To re-check one quarantined output of a failed run without a model
call, use `pnpm audit0 resume-revalidate CHILD_RUN_ID CHECKPOINT_SHA256 FAILED_RUN_ID OUTPUT_SHA256`. For failed waves or runtime transitions, use [recovery controls](../cloudflare/engine/README.md#checkpoints-and-recovery).
