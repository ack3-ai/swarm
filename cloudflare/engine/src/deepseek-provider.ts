const creditExhaustionCodes = new Set([
  'insufficient_balance',
  'insufficient_credit',
  'insufficient_credits',
  'insufficient_quota',
  'quota_exceeded',
  'quota',
  'billing_hard_limit_reached',
  'billing_limit_reached',
  'hard_limit_reached',
  'credit_exhausted',
  'credits_exhausted',
  'credit_balance_exhausted',
  'credit_balance_too_low',
  'out_of_credits',
  '402',
])

interface DeepSeekFailureEvidence {
  exitCode: number
  providerHttpStatus?: number | null
  providerErrorCode?: string | null
}

function normalizedCode(value: string | null | undefined): string | null {
  if (value === null || value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/.test(value)) return null
  return value.toLowerCase().replace(/[.-]/g, '_')
}

export function classifyDeepSeekUnavailability(evidence: DeepSeekFailureEvidence): 'provider-credit' | null {
  const code = normalizedCode(evidence.providerErrorCode)
  if (evidence.providerHttpStatus === 402 || (code !== null && creditExhaustionCodes.has(code))) {
    return 'provider-credit'
  }
  return null
}
