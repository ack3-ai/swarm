import { compileExperimentConfig as compile } from '../../src/config-compiler.js'
import prompts from '../../../../docs/examples/prompts.json' with { type: 'json' }
export const compileExperimentConfig = (config: unknown) => compile(config, prompts)
