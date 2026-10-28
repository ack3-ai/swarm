import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAgentOutputFiles } from '../container/output-files.mjs'

test('runner collects output only from its results directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ack3-output-'))
  try {
    const source = join(root, 'source')
    const results = join(root, 'results')
    const path = '.swarm/submission.json'
    await mkdir(join(source, '.swarm'), { recursive: true })
    await mkdir(join(results, '.swarm'), { recursive: true })
    const content = JSON.stringify({ complete: true })
    await writeFile(join(source, path), content)
    assert.deepEqual(await collectAgentOutputFiles([path], results), {})

    await writeFile(join(results, path), content)
    assert.deepEqual(await collectAgentOutputFiles([path], results), { [path]: content })

  } finally { await rm(root, { recursive: true, force: true }) }
})
