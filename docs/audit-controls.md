# Run controls

An audit schedules work, shares evidence between waves, retries transient
failures, corrects invalid outputs within the repair allowance, and finishes
reporting and cleanup on its own. Controls exist to pause, cancel or change the
remaining work.

All controls go through one authenticated endpoint, wrapped by the CLI:

`POST /v1/experiments/:experimentId/audits/:auditId/commands`

```sh
pnpm --dir cloudflare/engine audit0 status AUDIT_ID
pnpm --dir cloudflare/engine audit0 controls AUDIT_ID
pnpm --dir cloudflare/engine audit0 control AUDIT_ID 'COMMAND_JSON'
pnpm --dir cloudflare/engine audit0 controls AUDIT_ID COMMAND_ID
```

`ACK3_ENGINE_URL`, `ACK3_EXPERIMENT_ID` and `CONTROL_API_TOKEN` are set as in
[Run an audit](running-audit.md#set-up). `status` summarizes progress, holds
and fork lineage; `controls AUDIT_ID` returns the command revision and the
`stateReference` a fork needs; `controls AUDIT_ID COMMAND_ID` shows one
command's outcome.

## Commands

Every command carries a unique `id`, the `expectedRevision` read from
`controls`, and a `reason`. Resending an ID with the same body returns the same
result; the same ID with a different body is rejected. The revision counts
operator decisions, independently of agent progress. A new command whose
`expectedRevision` is not the current revision gets `409` with code
`revision-conflict` and is not recorded; read `controls` again and resend.

| Action | Effect |
| --- | --- |
| `pause` | Stops admitting tasks in its scope. Admitted tasks finish. |
| `continue` | Lifts the pause with exactly the same scope. If no active pause has that scope, the command is rejected with `no-matching-pause` and its detail lists the active pauses. |
| `cancel` | Fences the run, settles native work, keeps all evidence, stops the audit. Scope is the whole audit. |
| `fork` | Starts a child audit from saved work under a new manifest. The parent is unchanged. |

Pause and continue take a scope: the audit, a stage (`stageId`), a pool
(`poolId`) or tasks (`taskIds`). A `continue` with the audit scope does not lift
a stage, pool or task pause; send one `continue` per pause, with its scope as
listed under `pauses` in `controls`. A pause never waives required work. While a
pause holds all remaining work and nothing is in flight, the audit checks for
changes every 5 minutes instead of every 15 seconds, so after `continue` work
can take up to 5 minutes to resume.

```json
{
  "id": "pause-for-adjustment",
  "expectedRevision": 0,
  "action": "pause",
  "scope": { "kind": "audit" },
  "reason": "Prepare an operator-reviewed configuration change"
}
```

A `202` records the command. The applied command carries the settlement
receipt once the effect is verified.

## Change models, prompts or budgets

The manifest is the only configuration; commands carry no overrides.

1. Publish the new manifest. To drop an exhausted provider, remove its pool
   from discovery and assign its review role to another pool.
2. Bring the source run to rest. A completed run qualifies. A failed or
   cancelled run qualifies once its native work is retired and its runtime
   lease released; a pause, a timeout or a missing status response does not.
   A failed run keeps its native work until a `cancel` retires it, so cancel
   it first.
3. Read the source's `stateReference` from `controls AUDIT_ID` and submit
   `fork` with the published `releaseDigest`, the target `runtimeRelease` and
   one boundary:
   - `stageId`: rerun that stage and everything after it;
   - `checkpointDigest`: continue from that checkpoint;
   - `sourceFrontier: true`: keep all accepted work, including partial waves,
     and run only what is unfinished.

```json
{
  "id": "replace-review-models",
  "expectedRevision": 0,
  "action": "fork",
  "reason": "Rerun negative review with the selected reviewers",
  "source": {
    "runId": "source-audit",
    "state": { "generation": 123, "digest": "<exact state SHA-256>" }
  },
  "stageId": "negative-review",
  "releaseDigest": "<published manifest SHA-256>",
  "runtimeRelease": {
    "schemaVersion": 1,
    "id": "runtime-01",
    "workerService": "swarm-runtime-01",
    "workflowName": "audit-workflow-runtime-01",
    "frameworkCommit": "<40-hex commit>",
    "workerVersionId": "<published Worker version UUID>",
    "containerImageDigest": "sha256:<image SHA-256>"
  }
}
```

The source runtime exports its saved work; the child verifies the retained
artifact bytes, input evidence, manifest compatibility and retirement proof
before running. A refused fork returns the source's reason with a `code`, for
example `fork-source-unsettled` (HTTP 422). A fork across runtime versions
needs a source version that can export this evidence. A manifest the fork cannot
use is refused with `manifest-incompatible`, and the message names what differs:
the experiment id, the first differing key under `target` (for example
`target.runtime.commandTimeoutMinutes`; a fork keeps the original target), the
stage list, or a kept stage, wave or discovery pool with its first difference.
Change only work after the fork's boundary, or start a new audit.

A fork keeps accepted work with its provenance, the original model clocks,
recorded usage and unknown charges; inherited work is not dispatched or billed
again. The discovery clock keeps running through pauses and stops; only
recorded subscription quota waits and a [recon](running-audit.md#recon) stage
extend it. A discovery fork that needs more admission time raises
`maxDiscoveryRuntimeMs`. A fork that reruns discovery with the source's clock,
by `stageId` set to the discovery stage or by the `checkpointDigest` of the
start of discovery, is refused with `fork-discovery-window-elapsed` (HTTP 422)
when the source's discovery window has already ended, since it would admit no
research; the message gives the time the window ended, the smallest
`maxDiscoveryRuntimeMs` that gives the fork a full window from now, and a value
15 minutes above it (rounded up to a whole minute). The minimum grows by one minute
every minute, so use the larger value, which leaves time to publish the release and
send the fork. Any run whose discovery ends with no
accepted research in its first wave fails at once with
`completion contract failed: wave 0 is missing`, before the later stages
start. A fork cannot add or remove recon, because the stage
list must stay the same; a fork from `recon` starts the discovery window again
when the new recon ends.

A frontier fork may omit a whole pool absent from the new manifest; its
accepted outputs and usage stay in the record. Individual tasks cannot be
omitted. Stage dependencies and required outputs still apply.

## Status

`GET` on the commands endpoint returns the revision, each command's settled
outcome, active holds, the state reference and blocked work.
`settledRevision` counts commands the run's own execution applied; a cancel of
a failed run and a fork settle in their own operation, so it can stay below
`revision`.

Things the status does not show:

- A running Workflow label is not model progress. Check fresh activity and
  accepted output.
- An accepted start or fork is not a started Workflow. Launch stays pending
  until the Workflow records bootstrap or a native terminal observation records
  failure; startup failure keeps the accepted work and the runtime lease.
- A `202` on cancel is not finished cleanup. Wait for the settled receipt
  before replacing failed work.

Cleanup after completion verifies native workspace retirement, registers the
terminal state, observes the completed Workflow and releases the runtime lease.
It runs from the coordinator, independently of dashboard requests.

## Confirm a result

Check the command and the audit separately. For a fork, confirm the source
reference, retained stages, selected models and accepted outputs. A completed
audit has every selected required task and, with reporting selected, a sealed
report. Confirm terminal Workflow status and cleanup before reusing the runtime
slot. Report incomplete billing as unknown.
