import { CloudflareRunStore, stateWriter } from './cloudflare-storage.js'
import { materializeRootExecution, rootExecutionMachine } from './root-execution.js'
import { placement } from './placement.js'
import { assertLocalRuntime, RuntimeRouter } from './runtime-release.js'
import { engineRole } from './env.js'
import type { AuditWorkflowPayload, Env } from './env.js'

export async function ensureAuditWorkflow(
  binding: Workflow<AuditWorkflowPayload>,
  payload: AuditWorkflowPayload,
  location: { locationHint?: DurableObjectLocationHint },
): Promise<{ id: string, reused: boolean }> {
  let created: WorkflowInstance
  try {
    created = await binding.create({
      id: payload.runId,
      params: payload,
      ...location,
      retention: { successRetention: '30 days', errorRetention: '30 days' },
    })
  } catch (createError) {
    // A duplicate run ID or an ambiguous create is reconciled only against the
    // same durable Workflow identity. Never launch a second ID on uncertainty.
    try {
      const existing = await binding.get(payload.runId)
      await existing.status()
      if (existing.id !== payload.runId) throw new Error('existing Workflow identity differs')
      return { id: existing.id, reused: true }
    } catch {
      throw createError
    }
  }
  if (created.id !== payload.runId) throw new Error('created Workflow identity differs')
  return { id: created.id, reused: false }
}


export async function startLocalAuditWorkflow(env: Env, payload: AuditWorkflowPayload): Promise<{ id: string, reused: boolean }> {
  if (engineRole(env) === 'front-door') throw new Error('local Workflow dispatch requires an execution runtime')
  if (payload.runtimeRelease === undefined) throw new Error('runtime-bound audit payload is required')
  assertLocalRuntime(env, payload.runtimeRelease)
  const state = await materializeRootExecution(payload, new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX))
  if (state.status !== 'running') {
    const existing = await env.AUDIT_WORKFLOW.get(payload.runId)
    await existing.status()
    if (existing.id !== payload.runId) throw new Error('existing Workflow identity differs')
    return { id: existing.id, reused: true }
  }
  return ensureAuditWorkflow(env.AUDIT_WORKFLOW, payload, placement(env))
}

export async function dispatchAuditWorkflow(env: Env, payload: AuditWorkflowPayload): Promise<string> {
  if (engineRole(env) !== 'front-door') return (await startLocalAuditWorkflow(env, payload)).id
  if (payload.runtimeRelease === undefined) throw new Error('runtime-bound audit payload is required')
  const response = await new RuntimeRouter(env).fetch(payload.runtimeRelease, '/internal/runtime/audit-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw new Error(`runtime dispatch unavailable: ${response.status}`)
  const body = await response.json<{ workflowInstanceId?: string }>()
  if (typeof body.workflowInstanceId !== 'string' || body.workflowInstanceId !== payload.runId) {
    throw new Error('runtime release returned an invalid Workflow identity')
  }
  return body.workflowInstanceId
}


/** A created Workflow is not proof that its bootstrap step ran. Both root and
 * fork launch outboxes use this same bounded observation before retiring. */
export async function reconcileAuditStartup(env: Env, payload: AuditWorkflowPayload): Promise<boolean> {
  const store = new CloudflareRunStore(env.PACKAGES, env.ARTIFACTS, env.INDEX)
  const state = await store.getState(payload.runId)
  await store.assertExecutionPublication(state)
  if (await store.executionBootstrapped(state)) return true
  let status: string
  if (engineRole(env) === 'front-door') {
    if (payload.runtimeRelease === undefined) throw new Error('runtime-bound audit payload is required')
    const response = await new RuntimeRouter(env).fetch(payload.runtimeRelease,
      `/internal/runtime/audit-workflows/${payload.runId}`, { method: 'GET' })
    if (!response.ok) throw new Error(`native Workflow observation unavailable: ${response.status}`)
    const result = await response.json<{ runId: string; workflow: { status: string } }>()
    if (result.runId !== payload.runId) throw new Error('observed Workflow identity differs')
    status = result.workflow.status
  } else {
    if (engineRole(env) === 'runtime') assertLocalRuntime(env, payload.runtimeRelease!)
    const instance = await env.AUDIT_WORKFLOW.get(payload.runId)
    if (instance.id !== payload.runId) throw new Error('observed Workflow identity differs')
    status = (await instance.status()).status
  }
  if (!['complete', 'errored', 'terminated'].includes(status)) return false
  // A concurrent bootstrap may already have selected its witness. Otherwise the
  // normal CAS preserves any concurrent control or task-state transition.
  if (await store.executionBootstrapped(state)) return true
  const machine = await rootExecutionMachine(payload, store, state)
  if (machine.view().status === 'running') {
    const persist = await stateWriter(store, machine.view())
    await machine.fail(`native Workflow ${status} before confirmed bootstrap`)
    await persist(machine.view(), { unlessBootstrapped: true })
  }
  // This closes launch delivery only. Accepted bytes, native claims and the
  // runtime lease remain available to ordinary cancellation or fork controls.
  return true
}
