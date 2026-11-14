# Remove one audit's data

Swarm never deletes audit data, and no route or tool does it. When one audit's
data must go, for example because a client asks for its source and findings to
be removed, an account administrator removes it by hand with the steps below.
Nothing here can be undone. These steps follow the code and the Terraform
configuration but have not yet been run end to end on a live install; try them
on a test install first.

You need write access to the D1 database and both R2 buckets, and for the
locked prefixes the Terraform token that can edit bucket settings
([Terraform](../cloudflare/terraform/README.md)). The examples use the rendered
Wrangler config from [engine operations](../cloudflare/engine/README.md); add
`--jurisdiction J` to the R2 commands if your buckets have a data jurisdiction.

## What the lock rules allow and forbid

Terraform (`cloudflare/terraform/storage.tf`) sets four R2 lock rules, all
with no expiry (`Indefinite`):

| Bucket | Rule id | Prefix | Holds |
| --- | --- | --- | --- |
| `<prefix>-experiment-packages` | `immutable-releases` | `releases/sha256/` | sealed releases: target repository, commit, scope, prompts |
| `<prefix>-experiment-packages` | `immutable-sources` | `sources/v2/git-tree/` | source packages of the target code |
| `<prefix>-experiment-artifacts` | `immutable-checkpoints` | `checkpoints/sha256/` | checkpoints |
| `<prefix>-experiment-artifacts` | `immutable-model-artifacts` | `artifacts/` | accepted outputs: research, PoC tests, findings, the report |

- **Forbidden:** while a rule is enabled, nobody can delete or overwrite an
  object under its prefix: not Swarm, not an operator, not an administrator.
- **Allowed:** adding new objects under a locked prefix (Swarm does this), reading
  everything, and deleting any object under every other prefix.
- **Lifting a rule** needs a change to the bucket's lock settings, which only an
  administrator token can make. A rule covers its whole prefix, so while it is
  off, every audit's objects under that prefix can be deleted. There is no
  per-audit exception. Keep that window short.

## Which audits to remove together

An audit ID is also its run ID (one execution per audit; check with
`SELECT execution_id FROM audit_execution_authority WHERE audit_id = 'AUDIT_ID'`).

A fork is a separate audit, but it reads its source's accepted outputs,
checkpoints and saved work in place; nothing is copied. Find the forks of an
audit, and repeat for each of them:

```sql
SELECT DISTINCT json_extract(operation_json, '$.prepared.authority.auditId') AS fork
FROM audit_run_commands
WHERE audit_id = 'AUDIT_ID' AND json_extract(operation_json, '$.command.action') = 'fork';
```

A returned ID that has no row in `audit_execution_authority` was never started.
Remove an audit together with all its forks. To remove only a fork, keep every
object its source still uses (see the shared-object check below); the source's
command record of that fork stays, with IDs and digests only.

## Where one audit's data is

### Kept per run (artifacts bucket, not locked)

| Prefix | Holds |
| --- | --- |
| `runs/RUN_ID/` | every saved run state (all outputs' metadata, the journal) and the cleanup proof |
| `monitor/agent-executions/RUN_ID/` | agent logs, the prompt sent and workspace-preparation failures |
| `quarantine/execution-receipts/RUN_ID/` | runner receipts |
| `quarantine/execution-admissions/RUN_ID/` | launch admissions |
| `quarantine/execution-observation-health/RUN_ID/` | observation health records |
| `quarantine/native-sessions/RUN_ID/` | saved DSH agent sessions |
| `control/dispatches/RUN_ID/` | dispatched task requests |
| `control/cancellations/RUN_ID/` | cancellation evidence |
| `control/custody/AUDIT_ID/` | stop and custody evidence of run controls |

### Shared by content (find the keys through the run state)

These keys do not contain the run ID. Take them from the audit's latest run
state, which is the object named by `experiment_runs.state_key`.

| Key | Bucket | Locked | Taken from |
| --- | --- | --- | --- |
| `artifacts/<stage>/<wave>/<task>/<digest>.json` | artifacts | yes | `artifacts[].uri` |
| `checkpoints/sha256/<digest>.json` | artifacts | yes | `checkpoints[].digest` |
| `quarantine/<stage>/<wave>/<task>/attempt-N/<digest>.json` | artifacts | no | `rejectedAttempts[].quarantineUri` |
| `execution-inputs/sha256/<digest>.json` | artifacts | no | `execution.inputDigest` of each artifact and rejected attempt |
| `saved-work/sha256/<digest>.json` | artifacts | no | a fork's `forkOrigin.savedWorkDigest`; also any object there whose `sourceReference.runId` is the audit (an export for a fork that was refused) |
| `saved-work/selections/<digest>.json` | artifacts | no | the objects whose content is `{"digest":"<saved-work digest>"}` |
| `runtime-retirements/sha256/<digest>.json` | artifacts | no | `fence_proof_digest` in `retired_runtime_runs`, `proof_digest` in `retired_unmaterialized_routes`, if the run has such a row |
| `releases/sha256/<digest>.json` | packages | yes | `releaseDigest`, and `configuration.releaseDigest` in `stageEndReceipts` |
| `sources/v2/git-tree/<tree>.tar.zst` | packages | yes | `target.tree` in that release |

**Shared-object check.** Another audit can use the same object: every audit
started from the same release, every audit of the same source tree, and any
audit whose output had the same content. Before deleting a key from this table,
read the latest state of every other audit (all rows of `experiment_runs`) and
keep the key if any of them refers to it. If you remove an experiment's current
release, publish another one before starting a new audit for that experiment.

### D1 rows

| Table | Rows |
| --- | --- |
| `audit_run_commands` | `audit_id = AUDIT_ID` |
| `audit_execution_launches` | `audit_id = AUDIT_ID` |
| `audit_execution_authority` | `audit_id = AUDIT_ID` |
| `checkpoint_runtime_routes` | `checkpoint_digest` in the audit's checkpoints |
| `execution_bootstrap`, `run_runtime_routes`, `runtime_slot_run_leases`, `retired_runtime_runs`, `retired_unmaterialized_routes`, `run_state_selections`, `experiment_runs` | `run_id = RUN_ID` |

`run_state_selections` has a trigger that refuses every delete; the steps below
drop it and create it again.

### Not covered

The front door keeps a small record per audit ID (`run-reservation:<run ID>`,
IDs and digests only) that no route removes; do not reuse the audit ID.
Workflow instances, container logs and Worker logs follow Cloudflare's own
retention.

## Steps

1. **Check that nothing runs.** For the audit and each fork: the status is
   `completed` or `stopped` (cancel a `failed` audit first; it keeps its runtime
   lease until then), every command in `controls AUDIT_ID` has a settled
   outcome, and `released_at` is set:

   ```sh
   pnpm --dir cloudflare/engine exec wrangler d1 execute INDEX --config wrangler.deploy.jsonc --remote \
     --command "SELECT run_id, released_at FROM runtime_slot_run_leases WHERE run_id = 'RUN_ID'"
   ```

2. **Write the inventory.** Read the latest state (`state_key` from
   `experiment_runs`) with
   `wrangler r2 object get <prefix>-experiment-artifacts/STATE_KEY --remote --file state.json`,
   collect every key and checkpoint digest from the tables above, run the
   shared-object check, and save the list outside the repository. The later
   steps can then be repeated if one stops halfway.
3. **Delete the D1 rows**, with every ID from the inventory, in one file run with
   `wrangler d1 execute INDEX --config wrangler.deploy.jsonc --remote --file remove.sql`:

   ```sql
   DELETE FROM audit_run_commands WHERE audit_id = 'AUDIT_ID';
   DELETE FROM audit_execution_launches WHERE audit_id = 'AUDIT_ID';
   DELETE FROM audit_execution_authority WHERE audit_id = 'AUDIT_ID';
   DELETE FROM checkpoint_runtime_routes WHERE checkpoint_digest IN ('DIGEST_1', 'DIGEST_2');
   DELETE FROM execution_bootstrap WHERE run_id = 'RUN_ID';
   DELETE FROM runtime_slot_run_leases WHERE run_id = 'RUN_ID' AND released_at IS NOT NULL;
   DELETE FROM retired_runtime_runs WHERE run_id = 'RUN_ID';
   DELETE FROM retired_unmaterialized_routes WHERE run_id = 'RUN_ID';
   DELETE FROM run_runtime_routes WHERE run_id = 'RUN_ID';
   DROP TRIGGER IF EXISTS immutable_run_state_selection_delete;
   DELETE FROM run_state_selections WHERE run_id = 'RUN_ID';
   CREATE TRIGGER IF NOT EXISTS immutable_run_state_selection_delete
     BEFORE DELETE ON run_state_selections
     BEGIN SELECT RAISE(ABORT, 'state selection receipts are immutable'); END;
   DELETE FROM experiment_runs WHERE run_id = 'RUN_ID';
   ```

   Launches go before the authority rows they refer to. Afterwards
   `SELECT name FROM sqlite_master WHERE type = 'trigger'` must list
   `immutable_run_state_selection_delete` again. The audit is now gone from the
   dashboard and the API.
4. **Delete the unlocked objects:** the per-run prefixes and the unlocked keys
   of the inventory. Delete a key with
   `wrangler r2 object delete <prefix>-experiment-artifacts/KEY --remote`.
   Wrangler cannot list a prefix; use an S3-compatible client on the account's
   R2 endpoint to list or delete a whole prefix.
5. **Delete the locked objects**, one rule at a time. In
   `cloudflare/terraform/storage.tf`, set `enabled = false` on that rule only
   (keep the order of the rules), then plan and apply as in the
   [Terraform guide](../cloudflare/terraform/README.md); the plan must show only
   that change. Delete the inventory's keys under that prefix. Set
   `enabled = true` again and apply; a second plan must show no changes. Never
   commit the disabled rule.
6. **Check.** The audit ID is absent from `experiment_runs` and
   `audit_execution_authority`, and reading any inventory key returns nothing.
