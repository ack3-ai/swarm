import type { ModelBackend, ProviderIdentity, TaskDefinition } from './contracts.js'

export function taskBackend(task: Pick<TaskDefinition, 'backend' | 'providerClass'>): ModelBackend | 'deterministic' {
  if (task.backend !== undefined) return task.backend
  if (task.providerClass === 'core') return 'codex'
  if (task.providerClass === 'additive') return 'dsh-chat-completions'
  return 'deterministic'
}

export function providerIdentity(task: Pick<TaskDefinition, 'backend' | 'providerClass' | 'provider'>): ProviderIdentity {
  if (task.provider !== undefined) return task.provider
  switch (taskBackend(task)) {
    case 'claude': return 'anthropic-claude-subscription'
    case 'codex': return 'openai-codex-subscription'
    case 'dsh-chat-completions': return 'dsh-chat-completions'
    case 'deterministic': return 'deterministic-supervisor'
  }
}
