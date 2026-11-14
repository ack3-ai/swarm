/** Shared artifact-storage double. Raw bytes remain editable for corruption tests;
 * spies allow failures before or after an otherwise real in-memory write. */
export function memoryR2() {
  const objects = new Map<string, { content: string; customMetadata: Record<string, string>; checksum: string }>()
  const r2 = {
    put: async (key: string, value: string | Uint8Array, options: R2PutOptions = {}) => {
      if (objects.has(key) && options.onlyIf !== undefined) return null
      objects.set(key, { content: typeof value === 'string' ? value : new TextDecoder().decode(value),
        customMetadata: options.customMetadata!, checksum: options.sha256 as string })
      return {}
    },
    get: async (key: string) => {
      const object = objects.get(key)
      return object === undefined ? null : { text: async () => object.content, customMetadata: object.customMetadata,
        checksums: { toJSON: () => ({ sha256: object.checksum }) } }
    },
    head: async (key: string): Promise<unknown> => r2.get(key),
  }
  return { objects, r2, bucket: r2 as unknown as R2Bucket }
}
