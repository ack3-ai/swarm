import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compileExperimentConfig } from '../src/config-compiler.js'

/** Resolve the prompt and scope files relative to their config, then seal their contents with the release. */
export async function loadAuditConfig(path: string) {
  const configPath = resolve(path)
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  if (config === null || typeof config !== 'object' || !('promptFile' in config)
    || typeof config.promptFile !== 'string' || config.promptFile.trim() === '') throw new TypeError('promptFile is required')
  const prompts: unknown = JSON.parse(await readFile(resolve(dirname(configPath), config.promptFile), 'utf8'))
  const scope = 'scopeFile' in config && typeof config.scopeFile === 'string' && config.scopeFile.trim() !== ''
    ? await readFile(resolve(dirname(configPath), config.scopeFile), 'utf8') : undefined
  return compileExperimentConfig(config, prompts, scope)
}
