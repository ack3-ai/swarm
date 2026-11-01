const jurisdictions = ['eu', 'fedramp']
const bucketNames = { PACKAGES: 'experiment-packages', ARTIFACTS: 'experiment-artifacts' }
const locationHints = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']

// Storage names, and optional data jurisdiction and placement, for one deployment.
// Unset options keep Cloudflare's defaults.
export function applyDeploymentOptions(config, env, { containers }) {
  // Names are fixed once Terraform creates the storage, so there is no default.
  const prefix = env.ACK3_RESOURCE_PREFIX ?? ''
  if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(prefix)) {
    throw new Error('ACK3_RESOURCE_PREFIX is required and must match Terraform resource_prefix')
  }
  config.r2_buckets = config.r2_buckets.map(bucket => {
    const name = bucketNames[bucket.binding]
    if (name === undefined) throw new Error(`unknown R2 binding: ${bucket.binding}`)
    return { ...bucket, bucket_name: `${prefix}-${name}` }
  })
  config.d1_databases = config.d1_databases.map(database => ({ ...database, database_name: `${prefix}-experiment-index` }))
  const jurisdiction = env.ACK3_DATA_JURISDICTION
  if (jurisdiction !== undefined && !jurisdictions.includes(jurisdiction)) {
    throw new Error(`ACK3_DATA_JURISDICTION must be one of ${jurisdictions.join(', ')} when set`)
  }
  const hint = env.ACK3_LOCATION_HINT
  if (hint !== undefined && !locationHints.includes(hint)) {
    throw new Error(`ACK3_LOCATION_HINT must be one of ${locationHints.join(', ')} when set`)
  }
  if (jurisdiction !== undefined) config.r2_buckets = config.r2_buckets.map(bucket => ({ ...bucket, jurisdiction }))
  if (hint !== undefined) config.vars = { ...config.vars, LOCATION_HINT: hint }
  if (!containers) return config
  // Cloudflare's durable_object containers take no per-application cap or placement
  // constraints. Refuse the old settings rather than deploy without them.
  for (const name of ['ACK3_CONTAINER_MAX_INSTANCES', 'ACK3_CONTAINER_REGIONS']) {
    if ((env[name] ?? '') !== '') {
      throw new Error(`${name} is not supported by durable_object containers; unset it`)
    }
  }
  return config
}
