export const SCRATCH_DIRECTORY_PATTERN: RegExp
export const SCRATCH_BUNDLE_PATTERN: RegExp
export const SCRATCH_RETAINED_PATH: string
export const SCRATCH_OMITTED_MAX: number
export const SCRATCH_ENTRY_MAX: number
export const SCRATCH_OMIT_REASONS: readonly string[]
export const SCRATCH_OMITTED_PATH_PATTERN: RegExp
export function scratchSkippedDirectory(name: string): boolean
export function safeScratchPath(path: unknown): path is string
export function scratchText(content: unknown): content is string
export function printableScratchPath(path: string): string
