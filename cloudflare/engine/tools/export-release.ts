/// <reference types="node" />
import { chmod, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { canonicalJson } from '../src/canonical.js'
import { loadAuditConfig } from './load-audit-config.js'
import { sealReleasePackage } from '../src/release.js'

const [input, output] = process.argv.slice(2)
if (input === undefined) {
  throw new Error('usage: pnpm release:export <experiment.json> [sealed-release.json]')
}

const content = `${canonicalJson(await sealReleasePackage(await loadAuditConfig(input)))}\n`
if (output === undefined) process.stdout.write(content)
else {
  await writeFile(resolve(output), content, { mode: 0o600 })
  await chmod(resolve(output), 0o600)
}
