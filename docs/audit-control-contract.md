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
