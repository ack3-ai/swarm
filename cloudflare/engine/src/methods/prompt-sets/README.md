# Agent prompts

Set `promptFile` in the audit config to a JSON file keyed by stage, such as
[the example](../../../../../docs/examples/prompts.json). Paths are relative to
the config file. Each enabled stage needs non-empty instructions; unused stage
entries are allowed so one prompt file can serve several configurations.

```json
{ "discovery": "Focus on access control and fund flows." }
```

`stages: ["discovery"]` runs only research. For a reviewed report, include
`synthesis`, `verification` and `reporting`; `coverage` and `negative-review`
are optional. Stage names and order match [configuration](../../../../../docs/running-audit.md#configure).

The engine supplies [default instructions](../system-prompts.ts), output schemas,
source/evidence paths and correction prompts, and validates every output; the
prompt file controls research strategy. Editing it requires no engine or image build.

Publication resolves the file and seals selected prompts into the release.
Later file edits do not affect existing runs. Inspect `body.definition.stagePrompts`
with `pnpm --dir cloudflare/engine release:export /path/to/audit.json`.
