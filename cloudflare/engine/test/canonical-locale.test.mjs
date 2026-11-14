import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const engine = fileURLToPath(new URL('..', import.meta.url))

test('the canonical writer gives the same text under a Czech locale (C1)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'ack3-canonical-locale-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // esbuild comes with the pinned wrangler devDependency, as in tools/build-submission-check.mjs.
  const esbuild = createRequire(createRequire(import.meta.url).resolve('wrangler/package.json'))('esbuild')
  const script = join(dir, 'canonical.mjs')
  await esbuild.build({ stdin: { resolveDir: engine, loader: 'ts', contents: `
    import { canonicalJson } from './src/canonical.ts'
    import { plainCanonicalJson } from './src/canonical-bytes.ts'
    const value = { sealedAt: 1, scope: { schemaVersion: 1, hash: 'h' }, schemaVersion: 2, hash: 'y',
      cursor: { stageIndex: 1 }, checkpoints: [{ hash: 'x', cursor: 0 }] }
    process.stdout.write(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale,
      plain: Object.keys(value).sort((left, right) => left.localeCompare(right)),
      canonical: canonicalJson(value), plainCanonical: plainCanonicalJson(value),
      // A function value is not plain data, so this takes the historical normalize-and-stringify path.
      normalized: canonicalJson({ ...value, skipped() {} }) }))` },
  bundle: true, format: 'esm', platform: 'node', target: 'node22', outfile: script, logLevel: 'silent' })
  const run = locale => JSON.parse(execFileSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...process.env, LANG: locale, LC_ALL: locale },
  }))
  const czech = run('cs_CZ.UTF-8'), english = run('en_US.UTF-8')
  // The child really sorts in Czech: plain localeCompare puts `checkpoints` after `hash`.
  assert.match(czech.locale, /^cs/)
  assert.deepEqual(czech.plain, ['cursor', 'hash', 'checkpoints', 'scope', 'sealedAt', 'schemaVersion'])
  const expected = '{"checkpoints":[{"cursor":0,"hash":"x"}],"cursor":{"stageIndex":1},"hash":"y",'
    + '"schemaVersion":2,"scope":{"hash":"h","schemaVersion":1},"sealedAt":1}'
  for (const output of [czech, english]) {
    assert.equal(output.canonical, expected)
    assert.equal(output.plainCanonical, expected)
    assert.equal(output.normalized, expected)
  }
})
