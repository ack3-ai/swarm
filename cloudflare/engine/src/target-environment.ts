import { PermanentRunFailure } from './run-errors.js'

export function resolveTargetEnvironment(
  environmentBindings: Readonly<Record<string, string>>,
  workerEnvironment: object,
): Readonly<Record<string, string>> {
  const available = workerEnvironment as Readonly<Record<string, unknown>>
  return Object.fromEntries(Object.entries(environmentBindings).map(([name, binding]) => {
    const value = available[binding]
    if (binding === 'CLOUDFLARE_OBSERVABILITY_TOKEN' || typeof value !== 'string' || value === '') {
      throw new PermanentRunFailure(`target runtime Cloudflare secret is missing: ${binding}`, 'missing-credentials')
    }
    return [name, value]
  }))
}
