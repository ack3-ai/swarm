#!/usr/bin/env node
// Run as root by the Worker when it is about to prepare a new agent launch in this sandbox:
// stop every agent-user process an earlier attempt left behind (T2). Prints one JSON line.
import { stopAgentProcesses } from './command-watch.mjs'

const { stopped, remaining } = await stopAgentProcesses({ uid: 10001 })
process.stdout.write(`${JSON.stringify({ stopped: new Set(stopped).size, remaining: remaining.length })}\n`)
