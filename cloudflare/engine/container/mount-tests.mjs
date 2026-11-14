#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SCRATCH_DIRECTORY_PATTERN, SCRATCH_OMIT_REASONS, safeScratchPath } from './scratch-rules.mjs'

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) => record(value) && Object.keys(value).toSorted().join() === expected

function validTask(task) {
  return keys(task, 'bundle,lane,observations,pool,taskId,wave')
    && /^[A-Za-z0-9._-]{1,120}\.json$/.test(task.bundle) && task.bundle !== 'manifest.json'
    && /^[a-z0-9][a-z0-9._-]{0,99}$/.test(task.pool) && /^[A-Za-z0-9._-]{1,120}$/.test(task.taskId)
    && Number.isSafeInteger(task.lane) && task.lane >= 1 && task.lane <= 999
    && Number.isSafeInteger(task.wave) && task.wave >= 0
    && Array.isArray(task.observations) && task.observations.every(id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(id))
}

function validBundle(bundle, lane) {
  return keys(bundle, 'directory,files,omitted,schemaVersion') && bundle.schemaVersion === 1
    && bundle.directory === `/workspace/source/test/swarm/lane-${lane}` && SCRATCH_DIRECTORY_PATTERN.test(bundle.directory)
    && Array.isArray(bundle.files) && bundle.files.every(file => keys(file, 'bytes,content,path,sha256')
      && safeScratchPath(file.path) && typeof file.content === 'string')
    && Array.isArray(bundle.omitted) && bundle.omitted.every(file => keys(file, 'bytes,path,reason')
      && typeof file.path === 'string' && SCRATCH_OMIT_REASONS.includes(file.reason))
}

const order = (left, right) => left.pool < right.pool ? -1 : left.pool > right.pool ? 1
  : left.lane - right.lane || left.wave - right.wave

/**
 * Lay out accepted discovery PoC bundles for the verifier, outside its source tree:
 * <output>/<pool>/lane-<lane>/<path>, merged in wave order (a later wave wins on the
 * same path), plus an index of each research task's observations and files.
 */
export async function mountPocTests({
  bundles = '/workspace/private/poc-bundles',
  output = '/workspace/accepted/tests',
  index = '/workspace/accepted/tests-index.md',
} = {}) {
  const manifest = JSON.parse(await readFile(`${bundles}/manifest.json`, 'utf8'))
  if (!keys(manifest, 'schemaVersion,tasks') || manifest.schemaVersion !== 1 || !Array.isArray(manifest.tasks)
    || !manifest.tasks.every(validTask)) throw new Error('invalid PoC bundle manifest')
  const tasks = []
  for (const task of manifest.tasks.toSorted(order)) {
    const bundle = JSON.parse(await readFile(`${bundles}/${task.bundle}`, 'utf8'))
    if (!validBundle(bundle, task.lane)) throw new Error(`invalid PoC bundle: ${task.taskId}`)
    tasks.push({ task, bundle })
  }
  const merged = new Map()
  const replaced = new Map()
  for (const { task, bundle } of tasks) {
    for (const file of bundle.files) {
      const path = `${task.pool}/lane-${task.lane}/${file.path}`
      // A later file replaces the same path, and a file and a folder cannot share a name.
      for (const existing of [...merged.keys()].filter(other => other === path
        || other.startsWith(`${path}/`) || path.startsWith(`${other}/`))) {
        replaced.set(`${merged.get(existing).taskId}\n${existing}`, task.wave)
        merged.delete(existing)
      }
      merged.set(path, { content: file.content, taskId: task.taskId })
    }
  }
  const root = resolve(output)
  // A fresh folder: nothing the agent prepared can redirect these root-owned writes.
  await mkdir(root, { mode: 0o755 })
  for (const [path, file] of [...merged].toSorted(([left], [right]) => left < right ? -1 : 1)) {
    const destination = resolve(root, path)
    if (!destination.startsWith(`${root}/`)) throw new Error(`unsafe PoC test path: ${path}`)
    await mkdir(dirname(destination), { recursive: true, mode: 0o755 })
    await writeFile(destination, file.content, { mode: 0o644, flag: 'wx' })
  }
  const sections = tasks.map(({ task, bundle }) => [
    `## ${task.pool} lane ${task.lane}, wave ${task.wave} (${task.taskId})`,
    `Observations: ${task.observations.join(', ') || 'none'}`,
    'Files:',
    ...bundle.files.map(file => {
      const path = `${task.pool}/lane-${task.lane}/${file.path}`
      const later = replaced.get(`${task.taskId}\n${path}`)
      return `- ${root}/${path}${later === undefined ? '' : ` (replaced by wave ${later})`}`
    }),
    ...(bundle.files.length === 0 ? ['- none'] : []),
    ...(bundle.omitted.length === 0 ? [] : ['Not kept:',
      ...bundle.omitted.map(file => `- ${file.path} (${file.reason}, ${file.bytes} bytes)`)]),
  ].join('\n'))
  const text = ['# Discovery PoC tests', '',
    `PoC tests kept from discovery research, under ${root}/<pool>/lane-<lane>/. When several waves of one lane wrote the same path, the later wave's file is kept. A PoC is a lead, not proof.`,
    '', ...(sections.length === 0 ? ['No discovery PoC tests were kept.'] : [sections.join('\n\n')]), ''].join('\n')
  await writeFile(index, text, { mode: 0o644, flag: 'wx' })
  return { tasks: tasks.length, files: merged.size }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(`${JSON.stringify(await mountPocTests())}\n`)
}
