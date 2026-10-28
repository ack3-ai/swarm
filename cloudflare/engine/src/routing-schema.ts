// Created on demand by the store and emitted by tools/runtime-slot-seed.ts, which
// bootstraps the slot pool before the front door has served a routed request.
export const ROUTING_SCHEMA_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS run_runtime_routes (
    run_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    runtime_release_json TEXT NOT NULL,
    reserved_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS checkpoint_runtime_routes (
    checkpoint_digest TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    runtime_release_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_slots (
    slot_id TEXT PRIMARY KEY,
    runtime_release_json TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation > 0),
    deployed_at TEXT NOT NULL,
    last_rotation_intent TEXT UNIQUE
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_slot_control (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
    latest_slot_id TEXT,
    rotating_slot_id TEXT,
    rotation_intent TEXT UNIQUE,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runtime_slot_run_leases (
    run_id TEXT PRIMARY KEY,
    experiment_id TEXT NOT NULL,
    slot_id TEXT NOT NULL,
    runtime_release_json TEXT NOT NULL,
    admitted_at TEXT NOT NULL,
    admission_pool_enabled INTEGER NOT NULL CHECK(admission_pool_enabled IN (0, 1)),
    terminal_workflow_status TEXT,
    released_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS runtime_slot_active_run_leases
    ON runtime_slot_run_leases(slot_id, released_at)`,
  `CREATE TABLE IF NOT EXISTS retired_runtime_runs (
    run_id TEXT PRIMARY KEY,
    runtime_release_json TEXT NOT NULL,
    state_key TEXT NOT NULL,
    state_generation INTEGER NOT NULL,
    workflow_json TEXT NOT NULL,
    disposition TEXT NOT NULL CHECK(disposition IN ('terminal', 'retired-fenced')),
    fence_proof_digest TEXT,
    cleanup_proof_digest TEXT,
    retired_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS retired_unmaterialized_routes (
    run_id TEXT PRIMARY KEY,
    runtime_release_json TEXT NOT NULL,
    audit_workflow_status TEXT NOT NULL,
    isolation_workflow_status TEXT NOT NULL,
    proof_digest TEXT NOT NULL,
    retired_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS retained_native_workspace_claims (
    source_run_id TEXT NOT NULL,
    workspace_key TEXT NOT NULL,
    child_run_id TEXT NOT NULL,
    source_state_digest TEXT NOT NULL,
    snapshot_digest TEXT NOT NULL,
    sandbox_object_id TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    PRIMARY KEY(source_run_id, workspace_key)
  )`,
]
