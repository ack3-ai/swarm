const jurisdictions = ['eu', 'fedramp']
const locationHints = ['wnam', 'enam', 'sam', 'weur', 'eeur', 'apac', 'oc', 'afr', 'me']
const containerRegions = ['ENAM', 'WNAM', 'EEUR', 'WEUR', 'APAC', 'SAM', 'ME', 'OC', 'AFR']

// Optional data jurisdiction, placement and container capacity for one deployment.
// Unset options keep Cloudflare's defaults.
export function applyDeploymentOptions(config, env, { containers }) {
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
  const container = config.containers[0]
  const maxInstances = env.ACK3_CONTAINER_MAX_INSTANCES
  if (maxInstances !== undefined) {
    if (!/^[1-9]\d{0,3}$/.test(maxInstances)) throw new Error('ACK3_CONTAINER_MAX_INSTANCES must be a positive integer when set')
    container.max_instances = Number(maxInstances)
  }
  const regions = env.ACK3_CONTAINER_REGIONS?.split(',').map(region => region.trim())
  if (regions !== undefined && regions.some(region => !containerRegions.includes(region))) {
    throw new Error(`ACK3_CONTAINER_REGIONS must list Cloudflare region codes (${containerRegions.join(', ')}) when set`)
  }
  if (regions !== undefined || jurisdiction !== undefined) {
    container.constraints = { ...(regions === undefined ? {} : { regions }), ...(jurisdiction === undefined ? {} : { jurisdiction }) }
  }
  return config
}
