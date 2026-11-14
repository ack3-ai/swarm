import type { TaskDefinition } from './contracts.js'

export function agentWorkingDirectory(promptKind: TaskDefinition['promptKind']): '/workspace/source' | '/workspace/results' {
  return ['recon', 'synthesis', 'verification', 'reporting'].includes(promptKind)
    ? '/workspace/results' : '/workspace/source'
}
