export const U64_MAX = 18_446_744_073_709_551_615n
export const SKR_MAINNET_MINT = 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3'
export const SKR_DECIMALS = 6
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'

export class MarketError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'MarketError'
  }
}

export function units(value: string, allowZero = false): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) {
    throw new MarketError('INVALID_AMOUNT', 'Use an integer string in token base units.')
  }
  const amount = BigInt(value)
  if (amount > U64_MAX || (!allowZero && amount === 0n)) {
    throw new MarketError('INVALID_AMOUNT', 'Amount must be positive and fit in u64.')
  }
  return amount
}

export function decimals(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 9) {
    throw new MarketError('INVALID_DECIMALS', 'Token decimals must be an integer from 0 to 9.')
  }
  return value
}

/** Converts a user-entered decimal without floating point or silent rounding. */
export function decimalToUnits(value: string, tokenDecimals: number): string {
  decimals(tokenDecimals)
  if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value) || value.length > 40) {
    throw new MarketError('INVALID_AMOUNT', 'Enter a positive decimal amount.')
  }
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > tokenDecimals) {
    throw new MarketError('INVALID_AMOUNT', `At most ${tokenDecimals} decimal places are supported.`)
  }
  const raw =
    BigInt(whole) * 10n ** BigInt(tokenDecimals) + BigInt(fraction.padEnd(tokenDecimals, '0') || '0')
  return units(raw.toString()).toString()
}

export function formatUnits(value: string, tokenDecimals: number): string {
  decimals(tokenDecimals)
  const raw = units(value, true).toString()
  if (tokenDecimals === 0) return raw
  const padded = raw.padStart(tokenDecimals + 1, '0')
  const fraction = padded.slice(-tokenDecimals).replace(/0+$/, '')
  return `${padded.slice(0, -tokenDecimals)}${fraction ? `.${fraction}` : ''}`
}

export function validateSlippage(value: number, maximum = 500): void {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MarketError('INVALID_SLIPPAGE', `Slippage must be between 1 and ${maximum} basis points.`)
  }
}

export function minOutput(output: string, slippageBps: number): string {
  validateSlippage(slippageBps, 500)
  const minimum = (units(output) * BigInt(10_000 - slippageBps)) / 10_000n
  return units(minimum.toString()).toString()
}

export function progressBps(reserve: string, threshold: string): number {
  const denominator = units(threshold)
  const value = (units(reserve, true) * 10_000n) / denominator
  return Number(value > 10_000n ? 10_000n : value)
}

export function marketStatus(
  migrated: boolean,
  successorExists: boolean,
  reserve: string,
  threshold: string,
) {
  if (migrated) return successorExists ? ('damm-v2' as const) : ('migration-pending' as const)
  return units(reserve, true) >= units(threshold) ? ('migration-required' as const) : ('dbc' as const)
}

export function validateMetadata(name: string, symbol: string, uri: string): void {
  if (!name.trim() || Buffer.byteLength(name) > 32 || !/^[A-Z0-9]{1,10}$/.test(symbol)) {
    throw new MarketError(
      'INVALID_METADATA',
      'Use a name of at most 32 bytes and a 1–10 character uppercase ticker.',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new MarketError('INVALID_METADATA', 'Metadata must be an HTTPS URL.')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || Buffer.byteLength(uri) > 200) {
    throw new MarketError(
      'INVALID_METADATA',
      'Metadata must be an HTTPS URL of at most 200 bytes without credentials.',
    )
  }
}
