import type { TaskDefinition } from './contracts.js'

export function agentWorkingDirectory(promptKind: TaskDefinition['promptKind']): '/workspace/source' | '/workspace/results' {
  return ['synthesis', 'verification', 'reporting'].includes(promptKind)
    ? '/workspace/results' : '/workspace/source'
}
