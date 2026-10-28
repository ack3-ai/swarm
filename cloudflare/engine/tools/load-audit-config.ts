import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { compileExperimentConfig } from '../src/config-compiler.js'

/** Resolve the prompt file relative to its config, then seal its contents with the release. */
export async function loadAuditConfig(path: string) {
  const configPath = resolve(path)
  const config: unknown = JSON.parse(await readFile(configPath, 'utf8'))
  if (config === null || typeof config !== 'object' || !('promptFile' in config)
    || typeof config.promptFile !== 'string' || config.promptFile.trim() === '') throw new TypeError('promptFile is required')
  const prompts: unknown = JSON.parse(await readFile(resolve(dirname(configPath), config.promptFile), 'utf8'))
  return compileExperimentConfig(config, prompts)
}
