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
