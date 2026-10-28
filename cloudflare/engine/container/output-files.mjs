import { readFile } from 'node:fs/promises'

/** Collect only request-declared outputs from the runner's results directory. */
export async function collectAgentOutputFiles(expectedFiles, resultsRoot = '/workspace/results') {
  const files = {}
  for (const path of expectedFiles) {
    try { files[path] = await readFile(`${resultsRoot}/${path}`, 'utf8') } catch {}
  }
  return files
}
