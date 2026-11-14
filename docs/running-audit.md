# Run an audit

From a target commit to a running audit on a provisioned Swarm service:
credentials, manifest, model pools, search, publication and start. Run the
commands from the repository root with absolute paths; `pnpm --dir
cloudflare/engine` resolves relative paths from `cloudflare/engine`. To install
a service, see [first-time setup](../cloudflare/engine/README.md#first-time-setup).

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
| `stages` | Ordered selection: `recon` (optional, [below](#recon)), `discovery`, `synthesis`, `coverage`, `negative-review`, `verification`, `reporting` |
| `forceSearch` | Enable mandatory native search; defaults to `true` |
| `forceSearchStages` | Stage IDs; defaults to `discovery`, `coverage`, `negative-review`. [Triggers by stage](#search) |
| `nativeSearch` | Exa connection using an `EXA_API_KEY` runtime binding; never put the key in the config. `searchConnection` also accepts optional `baseUrl` (HTTPS) and `model` |
| `promptFile` | JSON stage instructions, resolved relative to this config and sealed on publication. Optional `instructions` replace the engine's default agent instructions ([below](#agent-instructions)) |
| `scopeFile` | Optional Markdown audit scope, resolved relative to this config and sealed on publication. [Audit scope](#audit-scope) |
| `keepPocs` | Optional `true`: keep the PoC tests discovery agents write and give them to the verifier. Needs `discovery` and `verification`. [Keep PoC tests](#keep-poc-tests) |
| `submitCheck` | On by default: agents check their output with `ack3-submit` and say when they are done. Set `false` to turn it off. [Submission check](#submission-check) |
| `target.repository`, `commit`, `tree` | Repository label in `owner/name` form (letters, digits, `_`, `.`, `-`; for a local repository any label such as `local/my-project` works), and the exact revision to audit |
| `environment.image` | Approved immutable container image, including registry and digest |
| `environment.environmentBindings` | Target environment variable → `TARGET_*` Worker secret on each runtime ([how to set](../cloudflare/engine/README.md#worker-and-runtime-publication)) |
| `environment.preflightCommands` | Baseline build/test commands; `$SWARM_SOURCE_DIR` is the source checkout, here and in workspace preparation |
| `environment.workspacePreparation` | Setup commands for each source workspace |
| `environment.buildRequired` | Default `true`; `false` lets the audit continue when the baseline build fails or has no commands. [Optional build](#optional-build) |
| `environment.commandTimeoutMinutes` | Optional, 1–720: agent commands, background jobs included, are stopped after this many minutes. [Command time limit](#command-time-limit) |
| `modelPools` | Models, providers, researcher counts and required participation |
| `stageModelPools` | One pool per selected later stage; `negative-review` also accepts a list of independent reviewers. `recon` is optional and defaults to the first required pool with agents |
| `limits` | `maxDiscoveryRuntimeMs`, `maxModelCalls`, `maxCostUsd` (priced DSH calls only; it does not limit Claude or Codex), and optional `maxInputTokens` and `maxOutputTokens` ([Budget](#budget)) |
| `maxDiscoveryWaves` | Discovery wave ceiling per pool (1–64); when every pool has run its waves, discovery ends with reason `safety-ceiling-reached` |
| `stopOnSaturation` | Default `true`; set `false` to run all configured discovery waves unless time/spend runs out |
| `researchPlan` | Optional lane labels and peer evidence per discovery wave. [Research plan](#research-plan) |

Start with `discovery`, or with `recon` directly followed by `discovery`. Negative
review and verification require synthesis; reporting requires verification. Other stages are optional. Preflight, evidence checks and cleanup
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
them to the limits documented by your model provider. Optional `connection.costRates`
(`uncachedInputUsdPerMillion`, `cachedInputUsdPerMillion`, `outputUsdPerMillion`)
prices DSH calls; without it they count as zero toward `maxCostUsd` and are marked unpriced.
Claude pools use `credentialSource: "CLAUDE_CODE_OAUTH_TOKEN"` (a secret binding),
`model` (a model ID supported by that account, such as `claude-sonnet-5-5`), and `reasoningEffort`; omit
`provider`, `connection` and `thinking`. `release:export` does not check model IDs.
Optional `fallbackCredentialSources` adds more Claude accounts to the pool
([Claude account rotation](#claude-account-rotation)).
Codex pools require `credentialSource`: a `CODEX_*AUTH_JSON` binding selects that account;
any other label uses the default `ACK3_CODEX_AUTH_JSON` account. Codex pools need a runtime
with a Codex login ([setup](../cloudflare/engine/README.md#worker-and-runtime-publication)). `model` is any model
ID that pool's account or provider serves; `release:export` does not check it. Try a
Codex model with the same login first: `codex exec -m MODEL "Reply with OK."`.
`reasoningEffort` is `none`, `low`, `medium`, `high` or `max`.
Optional `cyberAccessProgram` (Codex pools only; lowercase letters, digits and
underscores) is passed to Codex as `--cyber-access-program`; the runtime image must
include a Codex CLI that supports that program.

OpenAI-compatible endpoints, including self-hosted models, use the existing
`dsh-chat-completions` backend with `connection.baseUrl` and `connection.apiKeyEnv`.
Optional `connection.headersEnv` maps additional authentication header names to
existing `*_API_KEY` credential bindings, for example
`{"X-Service-Key": "SERVICE_API_KEY"}`. Values are loaded from Secrets Store into
the selected agent process. Custom headers require HTTPS; transport headers and
Authorization cannot be overridden. Keep endpoint-specific configuration local.
Set `connection.usageWindowWait: true` for a provider whose 429 responses with
`Retry-After` mark a usage window that resets: the agent waits for the window instead
of failing, and the wait extends the discovery deadline. Spend caps and exhausted
credits send no `Retry-After` and still fail.

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

`researchDelta` tells research agents what `materialHighCriticalDelta` means: set it
to `true` only for a new High or Critical observation, because it decides whether
discovery runs more waves. New releases always seal it; releases sealed before it
existed render their prompts as before.

The default texts change from time to time. A release compiled with newer default
texts renders different prompts, so a fork into it cannot keep stages that ran under
the older texts. Fork from the first stage whose prompts changed, usually
`discovery`, or start a new audit. An instruction that the prompt file sets does not
change with the defaults.

### Audit scope

Without a scope, agents audit the whole source package. To limit an audit, write
the scope in a Markdown file next to the config and set `"scopeFile": "scope.md"`:
what is in scope, what is not, and anything agents should know about the boundary.
[scope.md](examples/scope.md) is a template.

The scope is written for every model, including smaller ones. Each model task:

- starts with the scope, followed by short numbered `scopeRules`;
- ends with a one-line `scopeReminder`;
- has a copy of the scope at `/control/audit-scope.md`, to reread in long sessions.

The rules ask agents to:

- search the in-scope code;
- read out-of-scope code where in-scope code depends on it;
- start boundary findings with `Scope boundary:`;
- note problems that exist only in out-of-scope code in one sentence starting with
  `Out of scope:`;
- keep three sections when grouping or reporting: in scope, scope boundary and out of scope.

Fixed labels are easier for every model to follow, and they let later stages and
reviewers sort findings. List exact paths in the scope rather than patterns where you can.

A prompt file can replace either text with `instructions.scopeRules` or
`instructions.scopeReminder`. The scope is guidance, not a filter: agents still
receive the complete source, which builds and interaction checks need. The scope is
at most 32 KiB, is sealed with the release and is shown in the dashboard's run
configuration. A fork keeps only stages whose prompts are unchanged, so it cannot
keep work done under a different scope: after changing the scope, start a new audit
or fork from `discovery`.

Releases with a scope need a runtime and front door that include this feature;
releases without one are unchanged.

### Keep PoC tests

By default, PoC tests written during discovery stay in the research workspace, and
the verifier writes its own. Set `"keepPocs": true` to give them to the verifier as
leads. It needs the `discovery` and `verification` stages.

- Research agents write each PoC test under their lane scratch path,
  `/workspace/source/test/swarm/lane-N`, and start it with a comment that names the
  observation IDs it demonstrates. Files written anywhere else, for example next to
  the project's own tests, are not kept and are not listed as skipped.
- After each research task, the runner keeps that path's new text files: at most
  128 files, 256 KiB per file and 1 MiB per task. It skips files that earlier
  accepted research from the same lane already kept, symlinks, binary files, `.env`
  files, files that contain a credential value and build folders (`out`, `cache`,
  `lib`, `node_modules`, `broadcast`, `build`, `dist`, `target`, `artifacts`,
  `typechain*`, `.git`). The kept files and the list of skipped ones are saved with
  the accepted research as `waves/wave-W/research-N.tests.json`.
- The verifier finds the tests in `/workspace/accepted/tests/<pool>/lane-N/`,
  outside its source checkout, with an index at `/workspace/accepted/tests-index.md`
  that lists each research task's observation IDs and files. When several waves of
  one lane wrote the same file, the later wave's copy is used. Each file keeps its
  path inside the lane: `test/swarm/lane-1/poc/Drain.t.sol` becomes
  `/workspace/accepted/tests/<pool>/lane-1/poc/Drain.t.sol`.
- To run a PoC, the verifier should copy it back to the same path in its checkout,
  here `/workspace/source/test/swarm/lane-1/poc/Drain.t.sol`, so that its relative
  imports resolve. The default `pocReview` text says only to copy it into
  `/workspace/source`; a prompt file that wants the exact path said can replace
  `instructions.pocReview`. Two pools can each have a `lane-1`; copy and run their
  files one at a time.
- For each observation, the verifier first checks whether the PoC runs the real
  target code (not a mock or a copy) and asserts the claimed behavior. It reruns a
  good PoC and writes its own test otherwise. A PoC is never proof on its own.

A prompt file can replace the two texts with `instructions.pocCapture` (research)
and `instructions.pocReview` (verification). With `keepPocs`, the default
`verificationInstructions` leaves out its sentence that earlier tests are not in the
workspace; a `verificationInstructions` set in the prompt file is kept as written, so
it should not say so either. As with the scope, a fork cannot keep
stages that ran with a different `keepPocs` setting. Releases with `keepPocs` need
a runtime and a container image that include this feature; releases without it, or
with `false`, are unchanged.

### Submission check

Swarm checks every agent's output after the agent stops. A problem means one more
correction turn. The submission check is on by default, so agents find most problems
while they still work, and an agent that stops early is asked to continue. Set
`"submitCheck": false` to turn it off.

- Every model prompt ends with numbered steps: run `ack3-submit`, fix what it
  lists, run it again until it prints `OK: submission accepted`, then stop.
  A prompt file can replace this text with `instructions.submitCheck`.
- `ack3-submit` runs the checks Swarm runs on the output files in
  `/workspace/results` (it uses the same code). For research tasks it also checks
  the source tree: each observation ID in the submission appears in the research
  document, and each observation's evidence names a file under `/workspace/source`.
- A word in the evidence counts as a file when it has a folder (`/`) or a file
  extension, optionally followed by `:LINE`, `:START-END` or `#LSTART-LEND`. It
  matches a source file whose path is the same or ends with it, so `Vault.sol:42`
  matches `src/Vault.sol`. Every line it cites must exist. URLs, other absolute
  paths, symlinks and unknown package paths such as `@scope/pkg/File.sol` are not
  checked. A cited path without a file extension counts only when its first folder
  is at the top of `/workspace/source`, so `USDC/WETH:500` or
  `anvil-fork/mainnet:18000000` is not read as a file.
- When every check passes, `ack3-submit` writes `/workspace/results/.swarm/done.json`
  with the SHA-256 of each output file. When a check fails, it lists the problems
  and removes that file.
- After the agent stops, the runner runs the same checks again on the final files
  and reads `done.json`. Each problem it finds goes back to the agent in a
  correction turn, marked `ack3-submit:`. If `done.json` is missing or does not match
  the final files, the agent is told to continue and run `ack3-submit`.
- Search citations (`researchQueries`): while the agent works, the runner (as root)
  records each search the CLI reports in `/control/search-record.jsonl`, which the
  agent can read but not change. When the release requires search citations,
  `ack3-submit` runs Swarm's citation check on that record, and says plainly when no
  search has succeeded yet. Swarm still checks the citations again on the receipt
  after the agent stops; the runner's final check leaves them to that. A correction
  turn keeps the record of the session it resumes. With an older image, or when the
  record is incomplete, `ack3-submit` skips this check and says Swarm checks the
  citations after the agent stops.

As with `keepPocs`, a fork cannot keep stages that ran with a different
`submitCheck` setting. A manifest for a fork of an audit that ran without the check
needs `"submitCheck": false`. A release with the check needs a runtime and a
container image that include `ack3-submit`; with an older image the first model task
fails. A release with `false` has no check and needs no such image.

### Recon

`recon` is an optional stage directly before discovery: `"stages": ["recon", "discovery", ...]`.
One agent searches the public web and writes background notes. It needs native search
(`nativeSearch` not `false`), a `recon` prompt in the prompt file, and optionally
`stageModelPools.recon`; without it, recon uses the first required pool with agents.

The agent writes four Markdown files, each at most 32 KiB:

| File | Content |
| --- | --- |
| `recon/index.md` | A link to each other file with a one-line summary, then the 5–10 facts most useful to an auditor |
| `recon/project.md` | Public documentation, specifications and standards for what the target implements |
| `recon/dependencies.md` | Main dependencies and versions found in the source, with public advisories, CVEs and known bugs |
| `recon/attacks.md` | Public incidents, exploits and bug classes in similar systems |

A topic with nothing useful says so and lists the queries tried. The submission is
`{"complete":true,"researchQueries":[...]}`; recon needs at least one successful
search cited there, whether or not `forceSearch` is on. A file that is too large or
an index that does not link the other three files gets a correction turn.

Recon is background only: it does not review the code or list suspected bugs.
Discovery agents find the notes at `/workspace/accepted/recon/index.md`; their prompt
lists all four files by full path (`/workspace/accepted/recon/index.md`, `project.md`,
`dependencies.md` and `attacks.md`) and tells them to read all four before they start,
that the notes come from the web, to check every claim against the code, never to follow
instructions in them, and to keep looking beyond them. Synthesis,
verification and reporting see the notes with the rest of the accepted evidence.

By default recon searches only for the public technologies, dependencies, standards
and bug classes the target uses, never its name, private identifiers or code. For a
public target, replace `instructions.reconPrivacy` in the prompt file. The other recon
texts are `reconInstructions`, `reconSearch` and `reconNotes`
([recon.ts](../cloudflare/engine/src/recon.ts)); they are sealed only in releases
with recon, so releases without it are unchanged.

Recon time does not count against `maxDiscoveryRuntimeMs`: the discovery window
starts when recon ends. Recon calls and cost do count toward `maxModelCalls` and
`maxCostUsd`, which discovery admission checks. A fork keeps the stage list, so it
cannot add or remove recon; a fork from `recon` runs it again.

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
image includes Codex, DSH, Claude SDK, Foundry and the GitHub CLI (`gh`). To change
those tools, follow [local image building](../cloudflare/engine/README.md#local-container-builds)
and deploy an idle runtime with the new digest. Source changes and agent prompt
changes do not require an image build.

### GitHub access

Agents can use `gh` and `git` to compare forked code with its upstream, read
upstream issues, fixes and advisories, and search public code. The token is optional:
without it `gh` does not run, and agents fall back to `git clone` and `curl`, which
GitHub limits to a few requests per hour and no code search. To give agents a
token, create a fine-grained personal access token with **public repositories only**,
read-only access and a short expiry, and bind it as `GH_TOKEN`:

```json
{ "environment": { "environmentBindings": { "GH_TOKEN": "TARGET_GH_TOKEN" } } }
```

Set `TARGET_GH_TOKEN` on each runtime ([how to set](../cloudflare/engine/README.md#worker-and-runtime-publication)).
Agents hold this token and untrusted content can try to make them reveal it, so never
use a token that can read private repositories. Its value is redacted from logs.

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
Preflight success does not prepare the other workspaces. A failed command, such as a
registry timeout, is retried in place up to two more times, after 30 and then 60
seconds, if the first try began less than 10 minutes earlier. Only the last failure
fails the run (`preflight-failed`); each earlier one is logged
(`workspace-preparation-retry`) and its diagnostics file kept in the workspace.

### Optional build

By default a failed baseline command stops the audit before any model call. For
code that cannot be built, such as a partial delivery, missing private dependencies
or an unsupported toolchain, set `"buildRequired": false` in `environment`:

- Preflight runs the commands until one fails, records the results in `preflight.json`
  with `buildPassed`, and the audit continues.
- `preflightCommands` may be empty.
- Every agent is told that the build is optional and may fail, so it checks before
  relying on tests and otherwise works from the source.

Without a working build, agents cannot run tests or proofs of concept, and verification
falls back to source inspection. Workspace preparation, when configured, must still
succeed. Releases with an optional build need a runtime and image that include this
feature; releases without the setting are unchanged.

### Command time limit

Each agent container has 1 CPU, 8 GB of memory and 6 GB of disk. A command that hangs
or runs a long fuzz campaign holds that CPU for the rest of the session. To stop such commands,
set a limit in `environment`:

```json
{ "environment": { "commandTimeoutMinutes": 30 } }
```

- Every command an agent starts is stopped after that many minutes. This also covers
  background jobs and processes left over from earlier commands. The same limit applies
  to Codex, Claude and DSH agents.
- Agents still pick their own per-command wait. Claude agents cannot ask for a longer
  foreground wait than the limit.
- Every agent is told the limit, and told to split longer work.
- A stopped command shows in the agent log as `ack3: stopped a command at the
  N-minute command time limit`.

Memory needs no setting. In every audit, the commands an agent runs are the kernel's
first choice when memory runs out. A runaway build is then stopped instead of the agent
process, which used to fail the whole audit. Agents are also told the container size,
disk included, and to build one job at a time.

Releases with a limit need a runtime and image that include this feature; releases
without the setting are unchanged.

### Budget

`maxDiscoveryRuntimeMs: 18000000` allows five hours of discovery admission.
Other ceilings can end admission sooner; admitted tasks and later stages still finish.
Subscription quota appears in agent diagnostics when the native runner exposes it.
Unknown quota is not zero usage. A Claude task waits for its reported reset, which
for a weekly limit can be days away; the dashboard shows the task as waiting for
subscription quota with its reset time. A Claude pool with fallback accounts switches
account first and waits only when every account is used up
([Claude account rotation](#claude-account-rotation)). Codex exhaustion, and Claude exhaustion
without a usable reset, fail with saved evidence, without an agent repair or
automatic account switch. Zero recorded cost is not a verified bill.

`maxCostUsd` counts only priced DSH calls. Claude and Codex calls are recorded at $0,
so it does not limit them; bound those runs with `maxModelCalls` and the time limits.

`maxModelCalls` stops new discovery work; it is not a cap on the whole run. No new
discovery cohort starts once the calls made so far, plus one for each task of that
cohort, would pass it. A task that already started may still take correction turns
past it: in theory up to its attempt limits, in practice rarely. The later stages
always run.

### Provider outages

An attempt that ends because the model provider or its connection failed does not
count against the task's attempt limit. Swarm reads this from the runner's receipt:
for Claude, an `overloaded` or `server_error` result, or a 429 that is not a quota
limit; for Codex, a final turn that failed with a 5xx or 429 status, a dropped stream,
a connection failure, a timeout, or a capacity message; for DSH, the transport,
timeout, closed-stream, empty-response, 5xx and 429 failures it already resumes after.
The next launch then waits 1, 2, 5, 15, then 30 minutes. A task waits at most two
hours in total; after that, these failures count as attempts again, so a lasting
outage still ends the run. Quota limits keep their own handling (see Budget), and
optional lanes still drop out as unavailable instead of waiting.

During a wait the dashboard shows the task as rejected with "Provider backoff until
…". The rejected attempt in the run state, and `recentRejections` in the status
output, record `providerBackoff` (failure and delay; the wait ends at `rejectedAt`
plus the delay). Each failed attempt still counts as one model call. In discovery the
wait, like a quota wait, extends the discovery deadline.

### Claude account rotation

A Claude pool can list more subscription accounts. When the account in use reaches
its usage limit, the task continues at once on the next account instead of waiting
for the reset:

```json
{
  "id": "claude",
  "backend": "claude",
  "model": "claude-sonnet-5-5",
  "reasoningEffort": "high",
  "credentialSource": "CLAUDE_CODE_OAUTH_TOKEN",
  "fallbackCredentialSources": ["CLAUDE_SECOND_OAUTH_TOKEN", "CLAUDE_THIRD_OAUTH_TOKEN"],
  "agents": 2,
  "required": true,
  "subagents": { "default": { "mode": "disabled" } }
}
```

- `fallbackCredentialSources` lists 1–7 secret bindings named like
  `CLAUDE_*OAUTH_TOKEN`. They must differ from each other and from `credentialSource`;
  `CLAUDE_CODE_OAUTH_TOKEN` can only be the `credentialSource`. Add each binding to the
  runtimes like the first account
  ([credentials](../cloudflare/engine/README.md#credentials)). Other pools reject the key.
- Every task starts on `credentialSource` and uses the accounts in list order: the next
  account is used only once the current one is used up.
- When an account reports its usage limit with a reset time, the same session resumes
  at once on the next account whose reset has passed or is unknown. The agent is told
  to continue without repeating work. If the model had not answered yet in this
  attempt, the session gets the task's own prompt again instead, because the rejected
  request may not have saved it.
- The task waits only when every account is used up. It waits for the earliest reset,
  as described in [Budget](#budget), and then continues on that account.
- Each switch is recorded on the task's receipt and usage as `subscriptionSwitches`:
  the session, the two binding names, the time and the used-up account's reset, never
  token values. Switches take no time, so the discovery deadline does not change. The
  dashboard's configuration lists each pool's accounts in order.
- Every account's token is checked when the audit starts and before each task, like
  the first one; a missing or invalid token fails with its binding name.
- A revoked token, or a usage-limit response without a reset time, still fails the task.
- Codex pools are not covered.

Check your provider's terms before configuring more than one subscription account.

Releases with fallback accounts need a runtime and image that include this feature;
an older image fails the first Claude task with an integrity error. Releases without
the setting are unchanged.

## Search

All runners use official Exa MCP search and page retrieval; DSH's direct web
search is disabled. Agents get `web_search_exa`, `web_search_advanced_exa` (domain
and date filters, subpage crawling) and `web_fetch_exa`; both search tools count as
searches for the search requirement. The runtime needs an `EXA_API_KEY` secret binding.

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
and reporting have no search-gated decisions. [Recon](#recon) always requires one
successful search, whatever these settings say. Set `forceSearch: false` and omit
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

Use a local checkout at the commit selected in `target.commit`, or a ZIP archive
([below](#zip-source)). Set `target.tree` to the output of `git rev-parse 'HEAD^{tree}'`
at that commit. The repository field identifies the target; it is not a request to
clone or upload it automatically.

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
source package; do not bake target code into the image. The tool prints the upload
result with the `commit` and `tree` it published.

- Files keep the exact bytes Git stores. `.gitattributes` rules (`export-ignore`,
  `text`, `eol`, `export-subst`, filters) and your `core.autocrlf` setting change or drop nothing.
- Before the upload, the tool recomputes the tree from the exported files, as the agent
  workspace does, for the commit and for each submodule. If a tree differs, it uploads
  nothing and lists the paths that differ.
- A source with a root entry named `.ack3-source-package.json` (in any letter case) is
  refused; the tool writes its package manifest under that name.
- A tree's package is stored once and never replaced. If the server already holds a
  different package for the tree, the tool prints a warning and audits use the stored package.

### ZIP source

Source delivered as a ZIP archive needs no Git checkout:

```sh
pnpm --dir cloudflare/engine source:publish /path/to/source.zip
```

The tool commits the archive's files with a fixed author and date, so the same
archive always yields the same commit and tree. Put the printed `commit` and `tree`
into `target.commit` and `target.tree`.

- macOS metadata (the `__MACOSX/` folder and `.DS_Store` files that Finder adds) is dropped.
  Then a single top-level folder, as in repository downloads, is removed. The tool prints
  how many metadata files it dropped and the names left at the top level.
- Symlinks and executable bits are kept. Empty folders are dropped, as in Git.
- The commit holds the exact file bytes. No Git filters or attributes apply, then or when
  the package is built.
- The tool refuses archives with paths outside the archive root, Git metadata, encrypted
  entries, duplicate paths (ignoring letter case), a root entry named
  `.ack3-source-package.json` or data that fails its checksum.

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

`ACK3_EXPERIMENT_ID` is the config's `id`. Status reads `starting` until the run
saves its first state, and `recentRejections` shows why the latest attempts were rejected.

Use a unique run ID. After an interrupted request, inspect that ID before retrying.
Open `/dashboard` on your service URL and check fresh activity and accepted
output, not just the `running` label.

## Stop or continue from saved work

```sh
pnpm audit0 controls my-audit-001
pnpm audit0 control my-audit-001 '{"id":"cancel-1","expectedRevision":0,"action":"cancel","scope":{"kind":"audit"},"reason":"operator stop"}'
pnpm audit0 controls my-audit-001 cancel-1
```

Use the control revision returned by the first read. Preserve the command ID and
body when retrying an interrupted request. Cancellation closes native admission,
preserves accepted work and interrupted evidence, and reconciles physical stop
through the owning Workflow. A 202 response records the decision; it is not
proof of completed cleanup or of meeting the stop deadline. The applied command
contains the receipt digest after verified native settlement. See
[run controls](audit-controls.md) for pause, continue, cancel and fork commands.

To adjust tasks or models, cancel the audit, wait for retirement, then submit a
[fork command](audit-controls.md#change-models-prompts-or-budgets) with a
published manifest. Cancellation preserves saved work but does not create a checkpoint.

A fork carries the selected accepted prefix, original model clock and recorded
usage. A saved-frontier fork also retains accepted partial-wave work. A stage or
checkpoint fork reruns the selected suffix. To change models, remove an unavailable
discovery pool or extend admission time, change the ordinary manifest. Recovery
never silently resets the clock or promotes quarantined output.

The source runtime exports saved work after verified retirement. The child verifies
that export before starting. See [confirm the result](audit-controls.md#confirm-a-result)
for completion and cleanup checks.
