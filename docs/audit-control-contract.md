# Audit command contract

This module defines and validates commands. It does not install an HTTP endpoint
or execute them; admission, durable delivery and native execution are subsequent
parts of the control implementation.

Every command carries an `id`, `expectedRevision` and `reason`. The revision is an
operator-decision revision, independent of agent progress. Parsing validates the
wire format; admission must still check idempotency, revision, lifecycle and
whether a requested scope is supported.

- `pause`, `continue` and `cancel` carry an explicit audit, stage, pool or task
  scope. A valid scope is not permission to terminate native work.
- `fork` references an exact saved run state, a published release digest and an
  immutable runtime release. It selects exactly one boundary: a stage, a sealed
  checkpoint or the saved source frontier.

Models, prompts, tools, providers and budgets stay in the ordinary manifest.
Commands reject inline overrides. Changing those settings requires publishing a
manifest and referencing it from a continuation; it does not modify accepted
results or an executing manifest.

Runtime consumers must verify saved-work ownership, settle native work and
preserve accepted evidence before admitting a continuation. Command validation
alone proves none of those conditions.

## Execution ownership

`ExecutionAuthorityStore` records an execution's pinned runtime, launch claims,
and the transition from active to fenced to retired. A launch requires the exact
persisted run-state pointer. The caller must validate the task admission and root
Workflow startup; `activate` alone proves neither. At most one unsettled native
request may belong to a task occurrence; a settled attempt permits a retry. Pending cancellation and unacknowledged fork startup
block admission. Fencing closes admission; retirement additionally requires all
admitted launch claims to have terminal evidence.

This storage primitive does not stop containers or prove physical shutdown.
Its caller must verify native custody before supplying a retirement proof.
The runner and control endpoints are not wired to this primitive in this change;
the remaining control series supplies those boundaries. Historical executors are
not reassigned by this store, and activation retries cannot reopen retired work.

## Command journal

`RunCommandJournal` stores immutable versions of pause/continue decisions in the
existing D1 index. Admission atomically binds the command ID, content digest and
next operator revision. Repeating the same request returns its recorded decision;
reusing its ID for different content or racing a newer revision is rejected.
When the caller supplies execution authority, admission also requires that exact
active owner and a running audit in the same SQL statement.

An accepted decision is not an applied effect. Internal reconciliation advances
it with a version compare-and-swap; an applied outcome requires a receipt digest.
Lost write acknowledgements can be reconciled by repeating the same request or
transition. Readers verify row identity, command and record digests, and reject
unsupported record fields.

This slice does not expose an endpoint, pause a scheduler, validate receipt bytes,
or admit native cancellation or forks. Scope/lifecycle checks, effect verification
and durable delivery remain the responsibility of the following integration.

## Admission effects

Pause and continue operate on exact audit, stage, pool or task scopes. Continuing
one scope does not clear overlapping holds. The pure effect transition validates
the configured scope and command revision, then returns a receipt bound to the
previous state digest and resulting pauses. Repeating an already recorded decision
returns its original receipt; a different outcome is rejected. Rejected decisions
preserve all holds.

These functions do not persist state, acknowledge the command journal, stop running
agents or expose an endpoint. The following integration must persist the effect
under execution ownership, verify it before acknowledgement, and consult the
pauses before admitting new work. This PR alone does not enable operator controls.

## Selected state receipts

The run-index transaction now records the selected state key, generation, owner
and predecessor in an immutable receipt. An uploaded snapshot alone is not proof
that the state was selected. `assertStateSelected` checks this evidence without
changing the run head or granting permission to publish another state.

Installing the schema does not backfill receipts for historical heads. Those
records stay with their original application version. The control-system runtime
integration will consume these receipts; this step does not enable new commands.
