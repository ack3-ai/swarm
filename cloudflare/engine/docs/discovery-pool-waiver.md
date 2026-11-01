# Operator waiver after a discovery quota wait

This is a partial-run continuation with an explicit exception. It is not a successful execution of the waived task or an uninterrupted audit.

`POST /v1/experiments/:experimentId/discovery-waivers` creates one child at the next stage after discovery. The sealed definition, prompts, target, model clock, downstream tasks and reviewer quorum remain unchanged. All accepted source records and their bytes are retained. The unfinished attempt is recorded as waived, with one admitted call and unknown tokens/cost; numerical zeroes are not evidence of free usage. Native rejection/wait hashes and available log custody are retained in the stage receipt. A capture ending inside the native wait marker is explicitly marked partial, with no inferred wait timestamp; it requires the preceding complete matching native rejection and error result. This is not proof of a complete session log. No further discovery task is admitted.

The path deliberately accepts only a stopped root run with independent discovery, an elapsed recorded discovery deadline, one remaining required Claude task with a native subscription wait, and at least one completed cohort per pool. It rejects a pool used downstream. It does not alter a live run, repair output, change prompts, transfer active processes, or modify quotas.

## Preparation and activation

1. Read the exact source state and sealed definition. Wait for every other admitted task to finish. Recompute the deadline from the original clock plus recorded completed waits; a peer's late result can extend it. Preserve available native sessions and logs privately before stopping anything.
2. Review the implementation commit and the exact operation plan. Publish that code to a distinct idle runtime identity, reusing the same immutable container digest. Verify the runtime identity, distinct Workflow/Sandbox/application, readiness, and source release compatibility. Publish the development front-door route without changing the source runtime or unrelated active runs. Do not use production for a development recovery.
3. Immediately before stopping, read the source again. Require the sole admission to be the exact task/attempt/prompt/session being waived and the recorded deadline to have elapsed. If a terminal native receipt appeared, reconcile it instead of waiving it. Use the existing immediate-stop operation only after those checks. This terminates the source Workflow; it must not interrupt any healthy peer.
4. Verify terminal Workflow status and complete physical zero-work inventory. Preserve all accepted artifact bytes. Archive the source through the existing `terminal-stopped-custody` retirement endpoint. Catalog-only runtimes are eligible only when the pool was disabled at admission, remains disabled, and no slot row exists; exact route and lease checks still apply. A requested stop or a 404 is insufficient. Keep the old runtime and all evidence intact.
5. Send the waiver request below with the exact archived source generation/digest, its last checkpoint, the original native request digest, and the reviewed destination runtime ID. The authenticated route rechecks the retirement proof, immutable log and request custody, absence of a terminal execution receipt, every accepted artifact checksum, and the entire reconstructed checkpoint. It atomically claims that source for exactly one child before dispatch. Do not change child ID after a timeout: reconcile the same durable reservation and Workflow.
6. Independently verify the child starts at synthesis, preserves all source accepted records/bytes and the original clock, has no discovery admission, and retains the explicit waiver/unknown-usage receipt. Downstream required tasks and quorum must all finish normally. Deliver the operational exception with the final result.

Request fields:

```json
{
  "childRunId": "unique-child",
  "sourceRunId": "exact-stopped-source",
  "sourceStateGeneration": 123,
  "sourceStateDigest": "<sha256-of-exact-source-state>",
  "checkpointDigest": "<source-last-checkpoint-sha256>",
  "runtimeId": "distinct-reviewed-runtime",
  "poolId": "exact-discovery-pool",
  "requestDigest": "<exact-unfinished-native-request-sha256>"
}
```

This route does not provide a rollback that reopens the retired source. A rejected or ambiguous dispatch preserves its immutable claim. Investigate and reconcile it; never clear the claim to launch a competing child. Any remaining-stage failure follows the existing recovery policy and cannot silently remove another required task.
