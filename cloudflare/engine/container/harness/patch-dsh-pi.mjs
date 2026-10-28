// Pinned native adapter compatibility patch. No provider proxy or hidden retry.
// Keep SDK HTTP facts before pi-ai flattens errors, and distinguish reported
// usage (including zero cache) from its initialized, unknown zero counters.
// Exact source digests fail the build closed when either dependency changes.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2]
if (!root) throw new Error('Usage: node patch-dsh-pi.mjs <harness-directory>')
const edits = [
  {
    name: '@earendil-works/pi-ai', version: '1.3.0',
    file: 'dist/api/openai-completions.js',
    digest: '4b3875e5ec18c5e2d06ce12409feb2554563fd2c392a5c1773af968b265e2bea',
    replacements: [
      ['export const stream = (model, context, options) => {', `
// ACK3: retain only validated provider facts, never the raw SDK error/headers.
function dshHttpFailure(error) {
    const status = error?.status;
    if (!Number.isInteger(status) || status < 400 || status > 599) return undefined;
    const retry = error.headers?.get?.("retry-after");
    const delay = typeof retry === "string"
        ? (/^\\d+(?:\\.\\d+)?$/.test(retry.trim()) ? Number(retry) * 1000 : Date.parse(retry) - Date.now())
        : NaN;
    const requestId = error.headers?.get?.("x-request-id") ?? error.headers?.get?.("x-deepseek-request-id");
    return {
        status,
        ...(Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {}),
        ...(typeof requestId === "string" && requestId.length > 0 ? { requestId } : {}),
    };
}
function dshReportedUsage(raw) {
    const read = raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens ?? 0;
    const write = raw.prompt_tokens_details?.cache_write_tokens ?? 0;
    return [raw.prompt_tokens, raw.completion_tokens, read, write].every(n => Number.isSafeInteger(n) && n >= 0)
        && raw.prompt_tokens >= read + write
        && (raw.total_tokens === undefined || raw.total_tokens === raw.prompt_tokens + raw.completion_tokens);
}
export const stream = (model, context, options) => {`.trimStart()],
      ['            usage: {\n                input: 0,', '            _dshUsageReported: false,\n            usage: {\n                input: 0,'],
      ['                    output.usage = parseChunkUsage(chunk.usage, model);',
        '                    output._dshUsageReported = dshReportedUsage(chunk.usage);\n                    output.usage = parseChunkUsage(chunk.usage, model);'],
      ['                    output.usage = parseChunkUsage(choice.usage, model);',
        '                    output._dshUsageReported = dshReportedUsage(choice.usage);\n                    output.usage = parseChunkUsage(choice.usage, model);'],
      ['            output.errorMessage = formatProviderError(normalizeProviderError(error));',
        '            output._dshHttpFailure = dshHttpFailure(error);\n            output.errorMessage = formatProviderError(normalizeProviderError(error));'],
    ],
  },
  {
    name: '@deepseek-ai/dsh-llm-pi-ai', version: '0.2.1-rc.2',
    file: 'lib/index.js',
    digest: '99b5c20830a52f69641df8a18a39206079b0c725201958cce2c4a934f1d4f7cd',
    replacements: [
      ['...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},', 'cacheReadTokens: usage.cacheRead,'],
      ['...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}', 'cacheWriteTokens: usage.cacheWrite'],
      ['function classifyPiAiError(message) {', `
// ACK3: classify actual SDK HTTP status; never reconstruct status from text.
function classifyDshHttpError(status, message) {
    if (status === 401 || status === 403) return "AUTH";
    if (status === 413) return "INVALID_REQUEST";
    if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
    if (status === 429) return "RATE_LIMIT";
    if (status === 400) return "INVALID_REQUEST";
    if (status >= 500) return "SERVER";
    return \`HTTP_\${status}\`;
}
function classifyPiAiError(message) {`.trimStart()],
      ['code: classifyPiAiError(text)', 'code: message._dshHttpFailure ? classifyDshHttpError(message._dshHttpFailure.status, text) : classifyPiAiError(text),\n\t\t\t\t\t...message._dshHttpFailure'],
      ['case "done":\n\t\t\tyield {\n\t\t\t\ttype: "usage",', 'case "done":\n\t\t\tif (event.message._dshUsageReported !== false) yield {\n\t\t\t\ttype: "usage",'],
      ['case "error":\n\t\t\tyield {\n\t\t\t\ttype: "usage",', 'case "error":\n\t\t\tif (event.error._dshUsageReported !== false) yield {\n\t\t\t\ttype: "usage",'],
    ],
  },
]

// Validate every input before writing either package.
const outputs = []
for (const edit of edits) {
  const directory = join(root, 'node_modules', edit.name)
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (pkg.version !== edit.version) throw new Error(`Unexpected ${edit.name} version`)
  const path = join(directory, edit.file)
  let source = await readFile(path, 'utf8')
  if (createHash('sha256').update(source).digest('hex') !== edit.digest) {
    throw new Error(`Unexpected ${edit.name} source; refusing to patch`)
  }
  for (const [before, after] of edit.replacements) {
    if (source.split(before).length !== 2) throw new Error(`Ambiguous ${edit.name} patch`)
    source = source.replace(before, () => after)
  }
  outputs.push({ path, source })
}
for (const { path, source } of outputs) await writeFile(path, source)
console.log('Patched pinned native DSH/pi HTTP metadata and usage boundary')
