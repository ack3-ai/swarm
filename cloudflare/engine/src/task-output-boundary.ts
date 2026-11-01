import type { SandboxClient } from './agent-sandbox-client.js'

type OutputSandbox = Pick<SandboxClient, 'deleteFile' | 'exists'>

const safeOutputPath = /^[A-Za-z0-9.][A-Za-z0-9._/-]{0,239}$/

export async function clearUntrustedTaskOutputs(
  sandbox: OutputSandbox,
  requiredFiles: readonly string[],
  repairFiles: Readonly<Record<string, string>>,
): Promise<void> {
  // A bounded repair intentionally starts from the quarantined bytes copied by
  // the supervisor. Every other attempt must prove that it produced this
  // task's output after admission; a weak worker may have written a future-wave
  // path during an earlier continuation in the same lane.
  if (Object.keys(repairFiles).length > 0) return

  await Promise.all(requiredFiles.map(async path => {
    if (!safeOutputPath.test(path) || path.includes('..') || path.includes('//')) {
      throw new TypeError(`unsafe task output path: ${path}`)
    }
    const absolute = `/workspace/results/${path}`
    const present = await sandbox.exists(absolute)
    if (!present.success) throw new Error(`task output existence check failed: ${path}`)
    if (!present.exists) return
    const removed = await sandbox.deleteFile(absolute)
    if (!removed.success) throw new Error(`stale task output cleanup failed: ${path}`)
  }))
}
