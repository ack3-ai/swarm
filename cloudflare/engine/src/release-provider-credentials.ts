import type { ExperimentDefinition } from './contracts.js'
import type { Env } from './env.js'
import { taskBackend } from './provider-identity.js'
import { PermanentRunFailure, TransientRunFailure } from './run-errors.js'
import { subscriptionCredentialSource, codexWorkspaceId } from './subscription-credentials.js'

/** Runtime secrets may be direct Worker secrets or official Secrets Store bindings. */
export async function resolveCredentialBinding(env: Record<string, unknown>, name: string): Promise<string | null> {
  const binding = env[name]
  if (typeof binding === 'string') return binding.trim() === '' ? null : binding
  if (binding === null || typeof binding !== 'object' || typeof (binding as { get?: unknown }).get !== 'function') {
    return null
  }
  let value: unknown
  try { value = await (binding as { get(): Promise<unknown> }).get() }
  catch { throw new TransientRunFailure(`credential binding ${name} is temporarily unavailable`) }
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Check every sealed lane before a Workflow can admit paid model work. */
export async function assertReleaseProviderCredentials(
  definition: ExperimentDefinition,
  env: Pick<Env, 'ACK3_CODEX_AUTH_JSON' | 'ACK3_CODEX_WORKSPACE_ID'> & Record<string, unknown>,
): Promise<void> {
  const present = async (name: string): Promise<boolean> => (await resolveCredentialBinding(env, name)) !== null
  const tasks = definition.stages.flatMap(stage => stage.waves.flatMap(wave => wave.tasks))
  for (const task of tasks) {
    if (taskBackend(task) === 'codex') {
      const source = subscriptionCredentialSource(task)!
      const auth = await resolveCredentialBinding(env, source)
      if (!auth || (task.credentialSource === undefined && !(await present('ACK3_CODEX_WORKSPACE_ID')))) {
        throw new PermanentRunFailure('core provider credentials are missing', 'missing-credentials')
      }
      try { codexWorkspaceId(auth, '', task.credentialSource !== undefined) }
      catch { throw new PermanentRunFailure('selected Codex account is invalid', 'missing-credentials') }
      continue
    }
    if (taskBackend(task) === 'claude') {
      if (!/^CLAUDE_[A-Z0-9_]*OAUTH_TOKEN$/.test(task.credentialSource ?? '')) {
        throw new PermanentRunFailure('Claude subscription binding is invalid', 'invalid-configuration')
      }
      if (!(await resolveCredentialBinding(env, task.credentialSource!))?.startsWith('sk-ant-oat')) {
        throw new PermanentRunFailure('Claude subscription token is missing or invalid', 'missing-credentials')
      }
      continue
    }
    if (task.providerClass !== 'additive') continue
    const connection = task.connection
    if (taskBackend(task) !== 'dsh-chat-completions' || connection === undefined
      || !/^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(connection.apiKeyEnv)) {
      throw new PermanentRunFailure(`additive provider connection is invalid for ${task.id}`, 'invalid-configuration')
    }
    if (!(await present(connection.apiKeyEnv))) {
      throw new PermanentRunFailure(`additive provider credential is missing for ${task.id}`, 'missing-credentials')
    }
  }
  if (definition.forceSearch?.enabled === true || definition.nativeSearch?.enabled === true) {
    const connection = definition.nativeSearch?.searchConnection
    if (definition.nativeSearch?.enabled !== true || connection?.provider !== 'exa'
      || !/^[A-Z][A-Z0-9_]{0,119}_API_KEY$/.test(connection.apiKeyEnv)) {
      throw new PermanentRunFailure('native Exa connection is not configured', 'invalid-configuration')
    }
    if (!(await present(connection.apiKeyEnv))) {
      throw new PermanentRunFailure('native Exa credential is missing', 'missing-credentials')
    }
  }
}
