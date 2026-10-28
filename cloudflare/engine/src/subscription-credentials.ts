import type { TaskDefinition } from './contracts.js'
import { taskBackend } from './provider-identity.js'

/** Historical Codex labels resolve to the original binding; new pools can name an account. */
export function subscriptionCredentialSource(task: Pick<TaskDefinition, 'backend' | 'providerClass' | 'credentialSource'>): string | undefined {
  if (taskBackend(task) === 'claude') return task.credentialSource
  if (taskBackend(task) !== 'codex') return undefined
  return /^[A-Z][A-Z0-9_]{0,119}_AUTH_JSON$/.test(task.credentialSource ?? '')
    ? task.credentialSource : 'ACK3_CODEX_AUTH_JSON'
}

export function codexWorkspaceId(auth: string, fallback: string, explicitAccount: boolean): string {
  if (!explicitAccount) return fallback
  try {
    const value = JSON.parse(auth).tokens?.account_id
    if (typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value)) return value
  } catch {}
  throw new TypeError('selected Codex auth has no valid account ID')
}
