// PoC scratch capture rules shared by the runner, the test extractor and the Worker validator.
export const SCRATCH_DIRECTORY_PATTERN = /^\/workspace\/source\/test\/swarm\/lane-[1-9]\d{0,2}$/
export const SCRATCH_BUNDLE_PATTERN = /^waves\/wave-(0|[1-9]\d{0,3})\/research-([1-9]\d{0,2})\.tests\.json$/
export const SCRATCH_RETAINED_PATH = '/workspace/private/scratch-retained.json'
export const SCRATCH_OMITTED_MAX = 256
export const SCRATCH_ENTRY_MAX = 10_000
export const SCRATCH_OMIT_REASONS = [
  'binary', 'build-folder', 'credential', 'entry-limit', 'file-limit', 'file-size', 'not-regular', 'path', 'symlink',
  'task-limit', 'unreadable',
]
const skippedDirectories = new Set(['.git', 'artifacts', 'broadcast', 'build', 'cache', 'dist', 'lib', 'node_modules', 'out', 'target'])

export function scratchSkippedDirectory(name) {
  return skippedDirectories.has(name) || name.startsWith('typechain')
}

/** A relative path inside the lane directory, in the output-path charset. */
export function safeScratchPath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/.test(path)
    && !path.includes('..') && !path.includes('//') && !path.endsWith('/') && !/(?:^|\/)\.(?:\/|$)/.test(path)
}

/** Text that serializes to at most twice its size in JSON: no NUL and no control characters but tab, LF, FF and CR. */
export function scratchText(content) {
  return typeof content === 'string' && !/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)
}

/** Omitted paths are listed for the verifier; keep them short and printable. */
export function printableScratchPath(path) {
  return path.replace(/[^\x20-\x7e]/g, '?').slice(0, 240) || '?'
}
export const SCRATCH_OMITTED_PATH_PATTERN = /^[\x20-\x7e]{1,240}$/
