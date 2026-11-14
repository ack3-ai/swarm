#!/usr/bin/env node
// ack3-submit: agents run this before they finish. It runs the Worker's output
// checks on /workspace/results and writes the done marker when they all pass.
import { formatSubmitCheck, runSubmitCheck } from './submit-check.mjs'

try {
  const result = await runSubmitCheck()
  console.log(formatSubmitCheck(result))
  process.exitCode = result.issues.length === 0 ? 0 : 1
} catch (error) {
  console.log(`ack3-submit: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
