// Pinned native adapter compatibility patch. No provider proxy or task replay.
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
  {
    name: '@deepseek-ai/dsh-llm-retry', version: '0.2.1-rc.2',
    file: 'lib/index.js',
    digest: 'cbb99f1c5038e4a9167aedf333343cb3e3adfb5c9f45a37ef7562b024429d050',
    replacements: [
      // Keep journal attempt numbers monotonic, but count ordinary failures
      // separately. Rebuild the projection from the native journal on upgrade.
      ['stateVersion: 1,', 'stateVersion: 2,'],
      ['retry: z$1.number().int().nonnegative(),',
        'retry: z$1.number().int().nonnegative(),\n\tordinaryRetries: z$1.number().int().nonnegative(),'],
      ['retry: event.data.retry,',
        'retry: event.data.retry,\n\t\t\t\t\tordinaryRetries: (entry?.ordinaryRetries ?? entry?.retry ?? 0) + (event.data.subscriptionWait === true ? 0 : 1),'],
      ['const retry = previousRetry + 1;',
        'const retry = previousRetry + 1;\n\t\tconst ordinaryRetry = (previous?.ordinaryRetries ?? previousRetry) + 1;'],
      ['} else delayMs = failure.providerRetryAfterMs;\n\t\telse delayMs = localDelay(policy, retry, random);',
        '} else delayMs = failure.providerRetryAfterMs;\n\t\telse delayMs = localDelay(policy, ordinaryRetry, random);'],
      ['function cancellableDelay(delayMs, signal) {', `
// Only a native 429 with Retry-After proves a resetting provider window.
// Spend caps and exhausted credits have no reset evidence and retain the
// ordinary bounded retry policy.
function ack3ResettingWindow(failure) {
    return process.env.ACK3_PROVIDER_WINDOW_WAIT === "1"
        && failure.code === "RATE_LIMIT" && failure.status === 429
        && Number.isFinite(failure.providerRetryAfterMs)
        && failure.providerRetryAfterMs > 0 && failure.providerRetryAfterMs <= 86400000;
}
function cancellableDelay(delayMs, signal) {`.trimStart()],
      ['\t\tagent.session.append("llm/retry", eventData);\n\t\tif (!await cancellableDelay(delayMs, fusedSignal)) return;',
        `\t\tagent.session.append("llm/retry", { ...eventData,\n\t\t\t...(ack3ResettingWindow(failure) ? { subscriptionWait: true } : {}) });
\t\tconst windowStartedAt = ack3ResettingWindow(failure) ? Date.now() : null;
\t\tif (!await cancellableDelay(delayMs, fusedSignal)) return;
\t\tif (windowStartedAt !== null) process.stderr.write(JSON.stringify({
\t\t\ttype: "subscription_wait",
\t\t\twait: { provider: "dsh", sessionId: agent.id,
\t\t\t\tstartedAt: new Date(windowStartedAt).toISOString(),
\t\t\t\tresumedAt: new Date().toISOString(),
\t\t\t\tresetsAt: new Date(windowStartedAt + delayMs).toISOString() }
\t\t}) + "\\n");`],
      ['if (policy.mode === "normal" && previousRetry >= policy.maxRetries) return next();',
        'if (policy.mode === "normal" && (previous?.ordinaryRetries ?? previousRetry) >= policy.maxRetries && !ack3ResettingWindow(failure)) return next();'],
      ['if (policy.mode === "normal") return next();\n\t\t\tdelayMs = localDelay(policy, retry, random);',
        'if (policy.mode === "normal" && !ack3ResettingWindow(failure)) return next();\n\t\t\tdelayMs = ack3ResettingWindow(failure) ? failure.providerRetryAfterMs : localDelay(policy, ordinaryRetry, random);'],
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
console.log('Patched pinned native DSH/pi HTTP metadata, usage and window retry boundary')
