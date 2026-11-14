import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildSubmissionCheckBundle, submissionCheckBundlePath } from '../tools/build-submission-check.mjs'

test('the committed ack3-submit bundle matches src/submission-check.ts', async () => {
  assert.ok(await readFile(submissionCheckBundlePath, 'utf8') === await buildSubmissionCheckBundle(),
    'container/submission-check.bundle.mjs is stale: run node tools/build-submission-check.mjs')
})
