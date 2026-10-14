export function toAtomic(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) throw new Error('Invalid token decimals')
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Enter a valid amount')
  const [whole, fraction = ''] = value.split('.')
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`)
  const amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  if (amount <= 0n || amount > 18446744073709551615n) throw new Error('Amount is outside the supported range')
  return amount.toString()
}
export function displayAtomic(value: string, decimals: number, precision = 4): string {
  const raw = BigInt(value)
  const base = 10n ** BigInt(decimals)
  const fraction = (raw % base).toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '')
  return `${raw / base}${fraction ? `.${fraction}` : ''}`
}
export function displaySignedAtomic(value: string, decimals: number, precision = 4): string {
  const raw = BigInt(value)
  return `${raw > 0n ? '+' : raw < 0n ? '−' : ''}${displayAtomic((raw < 0n ? -raw : raw).toString(), decimals, precision)}`
}
export function displayBps(value: string): string {
  const raw = BigInt(value)
  const absolute = raw < 0n ? -raw : raw
  const whole = absolute / 100n
  const fraction = (absolute % 100n).toString().padStart(2, '0').replace(/0+$/, '')
  return `${raw > 0n ? '+' : raw < 0n ? '−' : ''}${whole}${fraction ? `.${fraction}` : ''}%`
}
export function isQuoteExpired(expiresAt: string, now = Date.now()): boolean {
  const expiry = Date.parse(expiresAt)
  return !Number.isFinite(expiry) || expiry <= now
}
