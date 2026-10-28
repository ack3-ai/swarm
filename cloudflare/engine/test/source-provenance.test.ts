import { describe, expect, it } from 'vitest'
import { reusableSourceProvenance, storeSourceArchive } from '../src/source-provenance.js'

describe('stored source provenance', () => {
  it('reuses intact bytes for the same Git identity even when a normalized republish has different archive bytes', () => {
    const storedSha256 = 'a'.repeat(64)
    const metadata = {
      gitTree: 'b'.repeat(40),
      gitCommit: 'c'.repeat(40),
      sourcePackageVersion: '2',
      archiveSha256: storedSha256,
    }
    const expected = { tree: metadata.gitTree, commit: metadata.gitCommit, packageVersion: '2' }
    expect(reusableSourceProvenance(metadata, storedSha256, expected)).toBe(true)
    expect(reusableSourceProvenance(metadata, 'd'.repeat(64), expected)).toBe(false)
    expect(reusableSourceProvenance(metadata, storedSha256, { ...expected, commit: 'e'.repeat(40) })).toBe(false)
  })

  it('stores a source archive once and never replaces it', async () => {
    const objects = new Map<string, { customMetadata: Record<string, string>, sha256: string }>()
    const puts: unknown[] = []
    let raceWinner: { customMetadata: Record<string, string>, sha256: string } | undefined
    const object = (value: { customMetadata: Record<string, string>, sha256: string }) =>
      ({ customMetadata: value.customMetadata, checksums: { toJSON: () => ({ sha256: value.sha256 }) } })
    const bucket = {
      head: async (key: string) => objects.has(key) ? object(objects.get(key)!) : null,
      put: async (key: string, _body: unknown, options: any) => {
        puts.push(options.onlyIf)
        if (raceWinner !== undefined) objects.set(key, raceWinner)
        if (options.onlyIf?.etagDoesNotMatch === '*' && objects.has(key)) return null
        const stored = { customMetadata: options.customMetadata, sha256: options.sha256 }
        objects.set(key, stored)
        return object(stored)
      },
    } as unknown as Pick<R2Bucket, 'head' | 'put'>
    const upload = { tree: 'b'.repeat(40), commit: 'c'.repeat(40), archiveSha256: 'a'.repeat(64), body: new ReadableStream() }

    expect(await storeSourceArchive(bucket, upload)).toMatchObject({ status: 201, body: { stored: true } })
    expect(puts).toEqual([{ etagDoesNotMatch: '*' }])
    expect([...objects.keys()]).toEqual([`sources/v2/git-tree/${upload.tree}.tar.zst`])
    expect(await storeSourceArchive(bucket, { ...upload, archiveSha256: 'd'.repeat(64) }))
      .toMatchObject({ status: 200, body: { archiveSha256: 'a'.repeat(64), stored: false } })
    expect(await storeSourceArchive(bucket, { ...upload, commit: 'e'.repeat(40) })).toMatchObject({ status: 409 })
    expect(puts).toHaveLength(1)

    objects.clear()
    raceWinner = { customMetadata: { gitTree: upload.tree, gitCommit: 'e'.repeat(40), sourcePackageVersion: '2',
      archiveSha256: 'f'.repeat(64) }, sha256: 'f'.repeat(64) }
    expect(await storeSourceArchive(bucket, upload)).toMatchObject({ status: 409 })
    expect(objects.get(`sources/v2/git-tree/${upload.tree}.tar.zst`)?.sha256).toBe('f'.repeat(64))
  })
})
