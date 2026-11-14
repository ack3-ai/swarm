// Credential values inside a JSON secret, such as the Codex login. Dependency-free: the Worker
// uses it for its own redaction list, the container log writer for the log's.
export const MIN_SECRET_LENGTH = 8

export function credentialsFromJson(source, prefix = 'ACK3_CODEX_AUTH') {
  let value
  try { value = JSON.parse(source) } catch { return [] }
  const credentials = []
  const visit = (item, path) => {
    if (credentials.length >= 256) return
    if (typeof item === 'string') {
      if (item.length >= MIN_SECRET_LENGTH) {
        const suffix = path.map(part => String(part).toUpperCase().replace(/[^A-Z0-9]+/g, '_')).filter(Boolean).join('_')
        credentials.push({ name: suffix === '' ? prefix : `${prefix}_${suffix}`, value: item })
      }
      return
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, [...path, index]))
      return
    }
    if (item !== null && typeof item === 'object') {
      for (const [name, entry] of Object.entries(item)) visit(entry, [...path, name])
    }
  }
  visit(value, [])
  return credentials
}
