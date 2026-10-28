export function reusableSourceProvenance(
  metadata: Readonly<Record<string, string>>,
  storedSha256: string,
  expected: { tree: string, commit: string, packageVersion: string },
): boolean {
  return metadata.gitTree === expected.tree
    && metadata.gitCommit === expected.commit
    && metadata.sourcePackageVersion === expected.packageVersion
    && metadata.archiveSha256 === storedSha256
}

export interface SourceArchiveUpload {
  tree: string
  commit: string
  archiveSha256: string
  body: ReadableStream
}

// Source archives are write-once. Terraform locks this prefix in R2, and the
// conditional put keeps a concurrent upload from replacing the first archive.
export async function storeSourceArchive(
  bucket: Pick<R2Bucket, 'head' | 'put'>, upload: SourceArchiveUpload,
): Promise<{ status: 200 | 201 | 409, body: Record<string, unknown> }> {
  const { tree, commit, archiveSha256 } = upload
  const key = `sources/v2/git-tree/${tree}.tar.zst`
  const reuse = (existing: R2Object) => {
    const storedSha256 = existing.checksums.toJSON().sha256 ?? ''
    return reusableSourceProvenance(existing.customMetadata ?? {}, storedSha256, { tree, commit, packageVersion: '2' })
      ? { status: 200 as const, body: { tree, commit, archiveSha256: storedSha256, stored: false } }
      : { status: 409 as const, body: { error: 'immutable source key already exists with different provenance' } }
  }
  const existing = await bucket.head(key)
  if (existing !== null) return reuse(existing)
  const stored = await bucket.put(key, upload.body, {
    httpMetadata: { contentType: 'application/zstd' },
    customMetadata: { gitTree: tree, gitCommit: commit, sourcePackageVersion: '2', archiveSha256 },
    sha256: archiveSha256,
    onlyIf: { etagDoesNotMatch: '*' },
  })
  if (stored !== null) return { status: 201, body: { tree, commit, archiveSha256, stored: true } }
  const concurrent = await bucket.head(key)
  return concurrent === null
    ? { status: 409, body: { error: 'source archive write was not applied; retry the upload' } }
    : reuse(concurrent)
}
